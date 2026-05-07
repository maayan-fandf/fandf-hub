/**
 * Anthropic-Claude streaming wrapper for the in-hub chat assistant's
 * WEB MODE — now also handles function tools alongside web_search,
 * because Anthropic accepts both in a single request (unlike Vertex,
 * which is what drove the dual-provider split in the first place).
 *
 * This means: in web mode, Claude can answer questions that need both
 * the public web AND hub data. Concrete case: "find their digital
 * presence and tell me which גוהרי this is" — Claude calls
 * getProject('גוהרי') first to disambiguate, then web_search with the
 * right context.
 *
 * Stream events emitted are intentionally the SAME shape as
 * lib/gemini.ts's `streamGemini` so the chat route can consume both
 * without branching on provider:
 *
 *   { text }                 — incremental text from the model
 *   { searchQuery }          — a search query Claude just ran
 *   { toolCall: {name,args} }— a hub function tool Claude wants to use
 *                              (UI surfaces it as a chip immediately)
 *   { done, … }              — final chunk (groundingChunks +
 *                              token usage + finishReason)
 *
 * The function-tool execution loop runs INSIDE this generator — caller
 * passes an `executeTool(name, args)` callback. Loop bound at 8 iters
 * to mirror the Gemini-side loop in the chat route.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { FunctionDeclaration } from "@google-cloud/vertexai";
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

/** Result of executing a hub function tool — handed back to Claude
 *  as the content of a `tool_result` block. JSON-serializable. */
export type ClaudeToolResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
};

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
  /** Override the default Haiku 4.5. */
  model?: string;
  /** Hub function tool declarations (Vertex shape). When present,
   *  they're translated to Anthropic's tool shape and exposed
   *  alongside web_search. Pass an empty array (or omit) to give
   *  Claude only web_search. */
  tools?: FunctionDeclaration[];
  /** Server-side executor for hub function tools. Receives the
   *  tool name + parsed args, returns a JSON-serializable result.
   *  Required when `tools` is non-empty. */
  executeTool?: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<ClaudeToolResult>;
};

// ── Schema conversion: Vertex FunctionDeclaration → Anthropic Tool ──
//
// Both formats describe a JSON-schema-style parameters object, but with
// surface differences:
//   - Vertex uses an enum (`SchemaType.OBJECT`) for `type`; Anthropic
//     uses lowercase strings (`"object"`).
//   - Vertex names the wrapper `parameters`; Anthropic names it
//     `input_schema`.
//   - Vertex's `properties[k]` may have nested object types that need
//     the same enum-to-string conversion recursively.

type AnthropicCustomTool = {
  name: string;
  description?: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

function vertexTypeToAnthropic(t: unknown): string | undefined {
  if (typeof t !== "string") return undefined;
  const lc = t.toLowerCase();
  // SchemaType enum stringifies to UPPERCASE in the @google-cloud/vertexai
  // SDK; runtime values that are already lowercase (rare, but possible
  // if hand-rolled) pass through.
  return lc;
}

function convertSchema(s: unknown): unknown {
  if (!s || typeof s !== "object") return s;
  const obj = s as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if ("type" in obj) {
    const converted = vertexTypeToAnthropic(obj.type);
    if (converted) out.type = converted;
  }
  if ("description" in obj && typeof obj.description === "string") {
    out.description = obj.description;
  }
  if ("properties" in obj && obj.properties && typeof obj.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj.properties)) {
      props[k] = convertSchema(v);
    }
    out.properties = props;
  }
  if ("required" in obj && Array.isArray(obj.required)) {
    out.required = obj.required;
  }
  if ("items" in obj) {
    out.items = convertSchema(obj.items);
  }
  if ("enum" in obj && Array.isArray(obj.enum)) {
    out.enum = obj.enum;
  }
  return out;
}

function vertexToolToAnthropic(decl: FunctionDeclaration): AnthropicCustomTool {
  const params = (decl.parameters as unknown) || {
    type: "object",
    properties: {},
  };
  const inputSchema = convertSchema(params) as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return {
    name: decl.name,
    description: decl.description,
    input_schema: {
      type: "object",
      properties: inputSchema.properties || {},
      ...(inputSchema.required ? { required: inputSchema.required } : {}),
    },
  };
}

// ── Message conversion ─────────────────────────────────────────────

/** Initial conversion: prior conversation (text turns only). Tool turns
 *  from prior hub-mode iterations are dropped; the surrounding text
 *  context is preserved. Within a single web-mode turn, intermediate
 *  tool_use / tool_result messages live in a local array (see below)
 *  and don't go back through this function. */
function turnsToAnthropicMessages(
  history: GeminiTurn[],
): { role: "user" | "assistant"; content: string }[] {
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

// ── Internal: shape of a tool_use we collected from the stream ─────

type CollectedToolUse = {
  id: string;
  name: string;
  /** Accumulated JSON string built up from input_json_delta events.
   *  Parsed to an object after the block stops. */
  partialJson: string;
};

// ── Public API ─────────────────────────────────────────────────────

export async function* streamClaudeChat(
  args: ClaudeChatArgs,
): AsyncGenerator<
  | { text: string }
  | { searchQuery: string }
  | { toolCall: { name: string; args: Record<string, unknown> } }
  | {
      done: true;
      groundingChunks: GeminiGroundingChunk[];
      inputTokens: number;
      outputTokens: number;
      finishReason: string;
    }
> {
  const c = client();
  // Type-loose Anthropic message array — simpler than wrestling the
  // SDK's nested generic types for content blocks across iterations.
  // We only construct shapes the API documents.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = turnsToAnthropicMessages(args.history);
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    messages.push({ role: "user", content: "(continue)" });
  }

  // Tool list = built-in web_search + any custom function tools the
  // caller passed. Both forms ride in the same `tools` array.
  const customTools: AnthropicCustomTool[] = (args.tools || []).map(
    vertexToolToAnthropic,
  );
  const tools = [
    { type: "web_search_20250305", name: "web_search", max_uses: 5 },
    ...customTools,
  ] as unknown as Anthropic.Messages.Tool[];

  const sources: GeminiGroundingChunk[] = [];
  const seenUris = new Set<string>();

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalFinishReason = "";

  // Tool-execution loop. Mirrors the Gemini side's bound — generous
  // for "search → readDoc → getProject → another search" chains
  // without letting a runaway loop burn tokens.
  const MAX_ITERATIONS = 8;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const stream = c.messages.stream({
      model: args.model || "claude-haiku-4-5",
      max_tokens: 4096,
      system: args.system,
      messages,
      tools,
    });

    // Per-iteration accumulators. We need to track tool_use blocks
    // by their (numeric) content-block index so input_json_delta
    // events can be correlated back to the right block.
    const toolUseByIndex = new Map<number, CollectedToolUse>();
    let iterationStopReason: string | null = null;

    function harvestSources(block: unknown) {
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
        index?: number;
        delta?: {
          type?: string;
          text?: string;
          partial_json?: string;
          stop_reason?: string;
        };
        content_block?: {
          type?: string;
          id?: string;
          name?: string;
          input?: unknown;
        };
      };

      if (e.type === "content_block_start" && e.content_block && typeof e.index === "number") {
        const block = e.content_block;
        if (block.type === "tool_use" && block.id && block.name) {
          // Track the tool_use; its `input` field is empty here and
          // gets filled in via subsequent input_json_delta events.
          toolUseByIndex.set(e.index, {
            id: block.id,
            name: block.name,
            partialJson: "",
          });
        }
        // web_search_tool_result blocks come pre-baked with the
        // results from the server-side search. Harvest source URIs.
        if (block.type === "web_search_tool_result") {
          harvestSources(block);
        }
      } else if (e.type === "content_block_delta" && typeof e.index === "number") {
        if (e.delta?.type === "text_delta" && typeof e.delta.text === "string") {
          yield { text: e.delta.text };
        } else if (
          e.delta?.type === "input_json_delta" &&
          typeof e.delta.partial_json === "string"
        ) {
          // Tool-use args stream in as JSON fragments. Build them up
          // per content-block index so we can parse the complete JSON
          // when the block stops.
          const tu = toolUseByIndex.get(e.index);
          if (tu) tu.partialJson += e.delta.partial_json;
        }
      } else if (e.type === "content_block_stop" && typeof e.index === "number") {
        const tu = toolUseByIndex.get(e.index);
        if (tu) {
          // Block done — try to parse the accumulated JSON. Empty
          // string is valid (no args).
          let parsedArgs: Record<string, unknown> = {};
          if (tu.partialJson) {
            try {
              const parsed = JSON.parse(tu.partialJson);
              if (parsed && typeof parsed === "object") {
                parsedArgs = parsed as Record<string, unknown>;
              }
            } catch {
              // Malformed JSON shouldn't happen with Anthropic, but
              // be defensive — leave args empty so the executor
              // returns a clean error.
            }
          }
          // Surface the call to the UI immediately:
          //   - web_search → "🌐 query" chip
          //   - custom function → "🔧 toolName" chip
          if (tu.name === "web_search") {
            const q = typeof parsedArgs.query === "string" ? parsedArgs.query : "";
            if (q) yield { searchQuery: q };
          } else {
            yield { toolCall: { name: tu.name, args: parsedArgs } };
          }
          // Stash the parsed args on the entry so the post-stream
          // execution loop has them.
          (tu as CollectedToolUse & {
            parsedArgs?: Record<string, unknown>;
          }).parsedArgs = parsedArgs;
        }
      } else if (e.type === "message_delta" && e.delta?.stop_reason) {
        iterationStopReason = e.delta.stop_reason;
      }
    }

    // Resolve the aggregated final message for usage stats + a final
    // source-harvest pass + the assistant content blocks we'll need
    // to feed back if tool execution is required.
    const finalMessage = await stream.finalMessage();
    totalInputTokens += finalMessage.usage.input_tokens;
    totalOutputTokens += finalMessage.usage.output_tokens;
    if (!iterationStopReason) iterationStopReason = finalMessage.stop_reason;
    finalFinishReason = mapStopReason(iterationStopReason);
    for (const block of finalMessage.content) {
      harvestSources(block);
    }

    // If Anthropic stopped because it wants tool execution, run the
    // custom tools (web_search results land server-side, no execution
    // needed on our side). Otherwise we're done.
    if (iterationStopReason !== "tool_use") {
      yield {
        done: true,
        groundingChunks: sources,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        finishReason: finalFinishReason,
      };
      return;
    }

    // Need to run the custom tools. Append the assistant's full
    // content (including all the tool_use blocks) to history, then
    // append a user turn with the corresponding tool_result blocks.
    messages.push({
      role: "assistant",
      content: finalMessage.content,
    });

    // Collect every custom (non-web_search) tool_use block.
    const customCalls: { id: string; name: string; input: unknown }[] = [];
    for (const block of finalMessage.content) {
      const b = block as { type?: string; id?: string; name?: string; input?: unknown };
      if (b.type === "tool_use" && b.name && b.id && b.name !== "web_search") {
        customCalls.push({ id: b.id, name: b.name, input: b.input });
      }
    }

    if (customCalls.length === 0) {
      // stop_reason was tool_use but no custom calls? Likely just
      // web_search (server-handled) — treat as done.
      yield {
        done: true,
        groundingChunks: sources,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        finishReason: finalFinishReason,
      };
      return;
    }

    if (!args.executeTool) {
      throw new Error(
        "Claude emitted custom tool_use blocks but no executeTool callback was provided",
      );
    }

    // Execute each custom tool call and build the tool_result blocks.
    const toolResultBlocks: {
      type: "tool_result";
      tool_use_id: string;
      content: string;
    }[] = [];
    for (const call of customCalls) {
      let result: ClaudeToolResult;
      try {
        result = await args.executeTool(
          call.name,
          (call.input || {}) as Record<string, unknown>,
        );
      } catch (e) {
        result = {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: "user", content: toolResultBlocks });
    // Loop back — Claude sees the results and continues composing.
  }

  // Hit the iteration cap without a clean finish.
  yield {
    done: true,
    groundingChunks: sources,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    finishReason: "MAX_ITERATIONS",
  };
}
