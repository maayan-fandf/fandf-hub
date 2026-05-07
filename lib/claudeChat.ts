/**
 * Anthropic-Claude streaming wrapper for the in-hub chat assistant's
 * WEB MODE. The Gemini wrapper (lib/gemini.ts) handles HUB MODE with
 * function calling on Workspace tools — but Vertex's googleSearch
 * tool can't be combined with functionDeclarations in one request,
 * so the chat's per-turn mode toggle routes web-search turns through
 * Claude with Anthropic's `web_search` tool instead. Claude runs the
 * search server-side and includes the cited sources directly in the
 * response stream.
 *
 * Stream events emitted are intentionally the SAME shape as
 * lib/gemini.ts's `streamGemini` so the chat route can consume both
 * without branching on provider:
 *
 *   { text }                 — incremental text from the model
 *   { searchQuery }          — a search query Claude just ran
 *   { done, … }              — final chunk (groundingChunks +
 *                              token usage + finishReason)
 *
 * No function-tool execution loop on this side — Claude finishes the
 * web search + composes the answer in a single streaming call. The
 * route's tool-execution loop is bypassed when mode === "web".
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  GeminiTurn,
  GeminiGroundingChunk,
} from "@/lib/gemini";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set — required for Claude web mode");
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

export type ClaudeChatArgs = {
  /** System prompt (plain text). */
  system: string;
  /** Conversation history in the shared GeminiTurn shape. We filter
   *  to text-only turns at the boundary — function-call / function-
   *  result turns from prior hub-mode turns are dropped, since Claude
   *  in web mode has no function tools and would just be confused
   *  by them. The corresponding text turn that surrounded the tool
   *  call still passes through, so the conversation thread reads
   *  coherently to Claude. */
  history: GeminiTurn[];
  /** Override the default Opus 4.7. */
  model?: string;
};

function turnsToAnthropicMessages(
  history: GeminiTurn[],
): { role: "user" | "assistant"; content: string }[] {
  // Drop function-call / function-result turns; keep user + model
  // text turns. Map "model" → "assistant" (Anthropic's role name).
  // Skip empty-text turns so we don't send blank assistant messages
  // (which Claude rejects).
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const t of history) {
    if (!("text" in t) || typeof t.text !== "string" || t.text.length === 0) {
      continue;
    }
    out.push({
      role: t.role === "user" ? "user" : "assistant",
      content: t.text,
    });
  }
  return out;
}

/** Map Anthropic stop reasons onto the same finishReason vocabulary
 *  the Gemini wrapper uses, so the UI's banner logic doesn't need to
 *  branch on provider. STOP / MAX_TOKENS are the cases the UI cares
 *  about; everything else passes through verbatim for diagnostics. */
function mapStopReason(claudeReason: string | null | undefined): string {
  switch (claudeReason) {
    case "end_turn":
    case "stop_sequence":
    case "tool_use":
      return "STOP";
    case "max_tokens":
      return "MAX_TOKENS";
    default:
      return String(claudeReason || "");
  }
}

export async function* streamClaudeChat(
  args: ClaudeChatArgs,
): AsyncGenerator<
  | { text: string }
  | { searchQuery: string }
  | {
      done: true;
      groundingChunks: GeminiGroundingChunk[];
      inputTokens: number;
      outputTokens: number;
      finishReason: string;
    }
> {
  const c = client();
  const messages = turnsToAnthropicMessages(args.history);
  // Anthropic requires the LAST message to be from "user". If the
  // history somehow ends with an assistant message (shouldn't happen
  // in our flow but defensive), append a no-op user prompt so the
  // request is valid.
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    messages.push({ role: "user", content: "(continue)" });
  }

  // The web_search tool config is server-side; Claude runs the
  // searches itself and embeds results in the stream. `max_uses`
  // caps how many distinct queries the model can fire per turn —
  // 5 is generous enough for "find their digital presence + main
  // competitors" without runaway searches. SDK typing for the new
  // tool kind is conservative; cast through unknown here so we can
  // pass the documented shape today.
  const tools = [
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 5,
    },
  ] as unknown as Anthropic.Messages.Tool[];

  const stream = c.messages.stream({
    model: args.model || "claude-opus-4-7",
    // 4096 matches the Gemini side. Web search answers can be long
    // (multi-source synthesis), so don't be stingy.
    max_tokens: 4096,
    system: args.system,
    messages,
    tools,
  });

  const sources: GeminiGroundingChunk[] = [];
  const seenUris = new Set<string>();
  let finishReason = "";

  function harvestSources(block: unknown) {
    // web_search_tool_result blocks land in the stream as Claude
    // performs each search. Their `content` array carries the search
    // result entries we want to surface as citations.
    const b = block as {
      type?: string;
      content?: { type?: string; url?: string; title?: string }[];
    };
    if (b.type !== "web_search_tool_result") return;
    for (const r of b.content || []) {
      if (
        r.type === "web_search_result" &&
        typeof r.url === "string" &&
        !seenUris.has(r.url)
      ) {
        seenUris.add(r.url);
        sources.push({ uri: r.url, title: r.title || r.url });
      }
    }
  }

  for await (const event of stream) {
    // The SDK's typing union spans many event types. We only care
    // about a few; cast through unknown when poking at fields the
    // public types don't expose for newer block kinds.
    const e = event as {
      type: string;
      delta?: { type?: string; text?: string; stop_reason?: string };
      content_block?: { type?: string; name?: string; input?: { query?: string } };
    };
    if (e.type === "content_block_start" && e.content_block) {
      // tool_use blocks where name === "web_search" carry the query
      // as input.query — surface it immediately so the UI shows the
      // "🌐 query" chip while Claude is still mid-search.
      if (
        e.content_block.type === "tool_use" &&
        e.content_block.name === "web_search" &&
        typeof e.content_block.input?.query === "string"
      ) {
        yield { searchQuery: e.content_block.input.query };
      }
      // web_search_tool_result blocks come pre-baked with the
      // results from the server-side search. Harvest source URIs.
      if (e.content_block.type === "web_search_tool_result") {
        harvestSources(e.content_block);
      }
    } else if (
      e.type === "content_block_delta" &&
      e.delta?.type === "text_delta" &&
      typeof e.delta.text === "string"
    ) {
      yield { text: e.delta.text };
    } else if (e.type === "message_delta" && e.delta?.stop_reason) {
      finishReason = mapStopReason(e.delta.stop_reason);
    }
  }

  // Resolve final message for usage stats + a last source-harvest pass
  // (some providers only attach grounding metadata to the aggregated
  // response, not per-chunk).
  const finalMessage = await stream.finalMessage();
  for (const block of finalMessage.content) {
    harvestSources(block);
  }
  if (!finishReason) {
    finishReason = mapStopReason(finalMessage.stop_reason);
  }

  yield {
    done: true,
    groundingChunks: sources,
    inputTokens: finalMessage.usage.input_tokens,
    outputTokens: finalMessage.usage.output_tokens,
    finishReason,
  };
}
