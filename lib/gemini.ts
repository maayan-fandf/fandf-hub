/**
 * Vertex AI / Gemini wrapper for the in-hub chat assistant.
 *
 * Modeled on lib/claude.ts (the Anthropic wrapper used for Clarity
 * narratives) but with three things the chat use case forces:
 *
 *   1. Streaming. Chat answers stream token-by-token into the drawer
 *      so the user sees progress instead of waiting for the full
 *      generation. Blocking helper kept for callers that just need
 *      a one-shot completion (e.g. background summarization).
 *
 *   2. Tool execution loop. Gemini decides to call tools (getTask,
 *      searchGmail, etc.); we run them, append the result as a
 *      `function` role turn, and re-send. Loop until the model
 *      returns text with no further function calls.
 *
 *   3. Auth via the existing SA, NOT DWD. Vertex AI checks the SA's
 *      own IAM role (`roles/aiplatform.user`) on the project — there's
 *      no per-user impersonation. Workspace TOOLS that the chat calls
 *      DO impersonate (the existing gmailReadClient / driveClient
 *      helpers in lib/sa.ts handle that), but the model call itself
 *      runs as the SA.
 *
 * Default model is `gemini-2.5-pro` (V1 quality bias). Switch to
 * `gemini-2.5-flash` later for high-volume short turns once the prompt
 * + tool catalog stabilize.
 */

import {
  VertexAI,
  type GenerativeModel,
  type Content,
  type Tool,
  type FunctionDeclaration,
  type GenerateContentRequest,
} from "@google-cloud/vertexai";

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

// ── Client construction ──────────────────────────────────────────────
//
// VertexAI SDK auths via `googleAuthOptions.credentials`. We reuse the
// SA JSON already loaded for the Workspace tools (TASKS_SA_KEY_JSON)
// so there's a single secret to manage. The SDK's GoogleAuth handles
// token refresh internally.

const PROJECT = "fandf-dashboard";
// europe-west4 matches the App Hosting backend region (no cross-region
// hop on every chat turn). Gemini 2.5 Pro/Flash are both available
// there as of 2025-Q4. Override via env if you ever want to point this
// at us-central1 for a model not yet in eu-west4.
const LOCATION = process.env.VERTEX_LOCATION || "europe-west4";

let _vertex: VertexAI | null = null;
function vertex(): VertexAI {
  if (_vertex) return _vertex;
  const raw = process.env.TASKS_SA_KEY_JSON;
  if (!raw) {
    throw new GeminiError(
      "TASKS_SA_KEY_JSON not set — required for Vertex AI auth",
    );
  }
  let key: { client_email: string; private_key: string };
  try {
    key = JSON.parse(raw);
  } catch (e) {
    throw new GeminiError(
      `TASKS_SA_KEY_JSON is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  _vertex = new VertexAI({
    project: PROJECT,
    location: LOCATION,
    googleAuthOptions: {
      credentials: {
        client_email: key.client_email,
        private_key: key.private_key,
      },
      // cloud-platform is the umbrella scope; Vertex tokens want it.
      // Narrower scopes (aiplatform.endpointPredictor) work too but
      // cloud-platform is what the SDK requests by default and matches
      // every Vertex doc example.
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    },
  });
  return _vertex;
}

function getModel(args: {
  model?: string;
  systemInstruction: string;
  tools?: FunctionDeclaration[];
}): GenerativeModel {
  const v = vertex();
  const model = args.model || "gemini-2.5-pro";
  const wrappedTools: Tool[] | undefined =
    args.tools && args.tools.length > 0
      ? [{ functionDeclarations: args.tools }]
      : undefined;
  return v.getGenerativeModel({
    model,
    systemInstruction: {
      role: "system",
      parts: [{ text: args.systemInstruction }],
    },
    tools: wrappedTools,
    // Lock generation params here so callers don't each pick their own.
    // Temperature 0.2 keeps replies grounded — the chat is more
    // assistant-y than creative-writing-y.
    generationConfig: {
      temperature: 0.2,
      topP: 0.95,
      maxOutputTokens: 2048,
    },
  });
}

// ── Public types ─────────────────────────────────────────────────────

/** A single function-call invocation Gemini emitted. The chat route's
 *  tool execution loop runs each one, appends the result as a
 *  `function` role turn, and re-sends. */
export type GeminiFunctionCall = {
  name: string;
  args: Record<string, unknown>;
};

/** A single function-result turn the chat route appends after running
 *  a tool. Sent back to Gemini so it can compose the final answer. */
export type GeminiFunctionResponse = {
  name: string;
  /** JSON-serializable result. Gemini parses this as the function's
   *  return value when generating the next turn. */
  response: unknown;
};

export type GeminiTurn =
  | { role: "user"; text: string }
  | { role: "model"; text: string }
  | { role: "model"; functionCalls: GeminiFunctionCall[] }
  | { role: "function"; results: GeminiFunctionResponse[] };

export type GeminiCallArgs = {
  /** System instruction — persona, available tools, response style. */
  system: string;
  /** Conversation so far, oldest first. The wrapper appends the next
   *  model turn on top and returns it. */
  history: GeminiTurn[];
  /** Function declarations exposed to the model. Empty array = chat-
   *  only, no tool use. */
  tools?: FunctionDeclaration[];
  /** Override the default 2.5 Pro. */
  model?: string;
};

/** A non-streaming generation result. For streaming, use `streamGemini`
 *  below — different shape because chunks arrive over time. */
export type GeminiCallResult = {
  /** Plain-text reply (empty when the model only emitted function calls). */
  text: string;
  /** Function calls the model wants the chat route to execute. Empty
   *  array = the model is done answering. */
  functionCalls: GeminiFunctionCall[];
  /** Token usage so we can see cost trajectory in production logs. */
  inputTokens: number;
  outputTokens: number;
};

// ── Conversion helpers ───────────────────────────────────────────────
//
// GeminiTurn (our shape) ↔ Vertex SDK Content[] (their shape). Kept as
// a thin layer so callers don't need to learn Vertex's part-array
// vocabulary, and so we can swap providers later by replacing this file.

function turnsToContents(history: GeminiTurn[]): Content[] {
  const contents: Content[] = [];
  for (const turn of history) {
    if (turn.role === "user") {
      contents.push({ role: "user", parts: [{ text: turn.text }] });
    } else if (turn.role === "model" && "text" in turn) {
      contents.push({ role: "model", parts: [{ text: turn.text }] });
    } else if (turn.role === "model" && "functionCalls" in turn) {
      contents.push({
        role: "model",
        parts: turn.functionCalls.map((fc) => ({
          functionCall: { name: fc.name, args: fc.args },
        })),
      });
    } else if (turn.role === "function") {
      // Vertex collapses multiple function results into one user turn
      // with multiple parts. The SDK's "function" role is actually
      // surfaced as a user-role turn carrying functionResponse parts.
      contents.push({
        role: "user",
        parts: turn.results.map((r) => ({
          functionResponse: {
            name: r.name,
            response: r.response as Record<string, unknown>,
          },
        })),
      });
    }
  }
  return contents;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * One non-streaming generation. Returns the next model turn — either
 * plain text, function calls the chat route should execute, or both.
 *
 * Callers that want token-by-token streaming should use `streamGemini`.
 */
export async function callGemini(
  args: GeminiCallArgs,
): Promise<GeminiCallResult> {
  const model = getModel({
    model: args.model,
    systemInstruction: args.system,
    tools: args.tools,
  });
  const request: GenerateContentRequest = {
    contents: turnsToContents(args.history),
  };
  try {
    const resp = await model.generateContent(request);
    const candidate = resp.response.candidates?.[0];
    if (!candidate) {
      throw new GeminiError("Gemini returned no candidates");
    }
    const parts = candidate.content?.parts || [];
    const text = parts
      .map((p) => ("text" in p ? p.text : ""))
      .filter(Boolean)
      .join("")
      .trim();
    const functionCalls: GeminiFunctionCall[] = parts
      .filter(
        (p): p is { functionCall: { name: string; args: object } } =>
          "functionCall" in p && !!p.functionCall,
      )
      .map((p) => ({
        name: p.functionCall.name,
        args: (p.functionCall.args || {}) as Record<string, unknown>,
      }));
    const usage = resp.response.usageMetadata;
    return {
      text,
      functionCalls,
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
    };
  } catch (e) {
    throw new GeminiError(
      e instanceof Error ? e.message : String(e),
      // Vertex SDK errors don't always carry a status; cast through
      // unknown for the optional pull.
      (e as { code?: number })?.code,
    );
  }
}

/**
 * Streaming generation. Yields { text } chunks as tokens arrive, and
 * a final { done, functionCalls, inputTokens, outputTokens } record
 * when the model finishes. The caller (chat route) is responsible for
 * forwarding chunks to the client and, if functionCalls is non-empty,
 * looping back through this function with the function results
 * appended as a new turn.
 *
 * Yields `{ text }` mid-stream and a single `{ done: true, ... }` at
 * the end. Errors throw GeminiError synchronously after the stream
 * completes (or partway, depending on where Vertex chokes).
 */
export async function* streamGemini(args: GeminiCallArgs): AsyncGenerator<
  | { text: string }
  | {
      done: true;
      functionCalls: GeminiFunctionCall[];
      inputTokens: number;
      outputTokens: number;
    }
> {
  const model = getModel({
    model: args.model,
    systemInstruction: args.system,
    tools: args.tools,
  });
  const request: GenerateContentRequest = {
    contents: turnsToContents(args.history),
  };
  const result = await model.generateContentStream(request);
  const collectedFunctionCalls: GeminiFunctionCall[] = [];
  for await (const chunk of result.stream) {
    const candidate = chunk.candidates?.[0];
    if (!candidate) continue;
    const parts = candidate.content?.parts || [];
    for (const part of parts) {
      if ("text" in part && part.text) {
        yield { text: part.text };
      } else if ("functionCall" in part && part.functionCall) {
        collectedFunctionCalls.push({
          name: part.functionCall.name,
          args: (part.functionCall.args || {}) as Record<string, unknown>,
        });
      }
    }
  }
  // After the stream completes, the SDK exposes the aggregated
  // response (with usage metadata) on `response`.
  const finalResp = await result.response;
  const usage = finalResp.usageMetadata;
  yield {
    done: true,
    functionCalls: collectedFunctionCalls,
    inputTokens: usage?.promptTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0,
  };
}
