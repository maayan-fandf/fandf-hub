import Anthropic from "@anthropic-ai/sdk";

/**
 * Thin wrapper around the Anthropic SDK for short-form server-side
 * generations (Hebrew narratives, summaries, etc.). The wrapper:
 *
 *   1. Lazily instantiates the client per-process (`anthropic-ai/sdk`
 *      is heavy — defer until first call).
 *   2. Applies prompt caching (`cache_control: ephemeral`) on the
 *      system block so repeated calls with the same persona/glossary
 *      get the ~10x cheaper cache-read rate after warmup.
 *   3. Defaults thinking to disabled — these are 2-3 sentence outputs
 *      where adaptive thinking adds latency without changing quality
 *      (see shared/agent-design.md → Model Parameters).
 *   4. Surfaces failures as a typed `ClaudeError` so callers can
 *      gracefully degrade (UI silently drops the AI summary card)
 *      rather than crash the entire page render.
 *
 * Default model is `claude-opus-4-7` per house policy. Caller can
 * override per-call (e.g. drop to Haiku 4.5 for high-volume short
 * outputs once the prompt is mature).
 */

export class ClaudeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ClaudeError";
  }
}

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ClaudeError("ANTHROPIC_API_KEY not set");
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

export type ClaudeCallArgs = {
  /** System prompt — the stable part. Cached as `ephemeral` so
   *  repeated calls hit the prompt cache after the first warmup. */
  system: string;
  /** User-turn content. Volatile; not cached. */
  user: string;
  /** Override the default Opus 4.7. Common alternative: Haiku 4.5
   *  for high-volume short outputs (~5x cheaper). */
  model?: string;
  /** Default 350 — enough for a 2-3 sentence Hebrew narrative. */
  maxTokens?: number;
};

export type ClaudeCallResult = {
  /** Concatenated text from all output blocks. */
  text: string;
  /** Token usage — surfaces cache hit rate so we can see if the
   *  cache is actually working in production logs. */
  cacheReadTokens: number;
  cacheCreationTokens: number;
  inputTokens: number;
  outputTokens: number;
};

export async function callClaude(args: ClaudeCallArgs): Promise<ClaudeCallResult> {
  const c = client();
  try {
    const response = await c.messages.create({
      model: args.model || "claude-opus-4-7",
      max_tokens: args.maxTokens ?? 350,
      // Disable thinking — 2-3 sentence outputs don't benefit, and
      // every saved second matters for an in-page Suspense-bound
      // section. Caller can override by switching to a different
      // helper if a thoughtful flow is ever needed.
      thinking: { type: "disabled" },
      system: [
        {
          type: "text",
          text: args.system,
          // Prompt caching: any byte change in `system` invalidates,
          // so callers pass a stable persona/glossary and put all
          // per-render variation in `user`. See
          // shared/prompt-caching.md for the full audit checklist.
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: args.user }],
    });

    const text = response.content
      .filter((b): b is { type: "text"; text: string; citations: null } =>
        b.type === "text",
      )
      .map((b) => b.text)
      .join("\n")
      .trim();

    return {
      text,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  } catch (e) {
    // Translate SDK errors to our typed wrapper so callers can do a
    // single `instanceof ClaudeError` check.
    if (e instanceof Anthropic.APIError) {
      throw new ClaudeError(
        `Anthropic API error: ${e.message}`,
        e.status,
      );
    }
    throw new ClaudeError(
      e instanceof Error ? e.message : String(e),
    );
  }
}
