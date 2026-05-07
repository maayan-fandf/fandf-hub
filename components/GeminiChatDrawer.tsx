"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePageContext } from "@/components/PageContextProvider";
import { capturePageContext } from "@/lib/pageContextSnapshot";
import GoogleIcon from "@/components/GoogleIcon";

/**
 * Gemini chat assistant drawer.
 *
 * Renders two things:
 *   1. A floating action button (✨) in the bottom-INLINE-end corner
 *      of the viewport. Click → drawer opens.
 *   2. A right-side drawer (~400px) with the conversation thread,
 *      streaming responses, and an input area at the bottom.
 *
 * Each user message:
 *   - Captures the current page context (URL + title + visible text +
 *     whatever the page registered via `useRegisterPageContext`).
 *   - POSTs to /api/gemini/chat as SSE.
 *   - Streams the model's text into a placeholder assistant bubble.
 *   - Surfaces tool calls as chips above the text so the user can see
 *     "the assistant is searching Gmail…" instead of an empty wait.
 *
 * Conversation history is kept in `localStorage` per-user so a refresh
 * doesn't lose the thread. New chat = clear button in the header.
 *
 * Hidden for client users (the layout's `isClientUser` gate decides
 * whether to mount the drawer at all). Server-side auth in the route
 * handler is the actual security boundary; the client gate is just UX.
 */

type Role = "user" | "model";
type GroundingSource = { uri: string; title: string };
type Message = {
  id: string;
  role: Role;
  text: string;
  /** Only on assistant messages: tool-call indicators we surfaced
   *  while streaming. Persisted so a reload still shows what the
   *  assistant did to compose the answer. */
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  /** Google Search queries the model ran while composing this turn.
   *  Persisted alongside toolCalls for the same "see what the
   *  assistant did" reason. */
  searchQueries?: string[];
  /** Web sources Vertex grounded against, surfaced as a "Sources:"
   *  footer on the bubble. */
  sources?: GroundingSource[];
  /** Reason the model stopped this turn. Empty / "STOP" = clean.
   *  Anything else (MAX_TOKENS / SAFETY / RECITATION / OTHER) is
   *  surfaced as a small banner under the bubble. */
  finishReason?: string;
};

const STORAGE_KEY_PREFIX = "hub:gemini:chat:";

export default function GeminiChatDrawer() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [streamTools, setStreamTools] = useState<
    { name: string; args: Record<string, unknown> }[]
  >([]);
  const [streamSearchQueries, setStreamSearchQueries] = useState<string[]>([]);
  const [streamSources, setStreamSources] = useState<GroundingSource[]>([]);
  // Per-turn mode toggle. When false (default) the next message ships
  // the hub function tools (getTask, readSheetTab, …) and the model
  // can't search the web. When true, the next message ships
  // googleSearch ONLY (Vertex rejects combining the two — see
  // lib/gemini.ts comment). Conversation history rides along either
  // way, so the model still has full context when you flip mid-thread.
  const [webMode, setWebMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { payload: registeredContext } = usePageContext();
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Restore conversation from localStorage on first mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_PREFIX + "history");
      if (raw) {
        const parsed = JSON.parse(raw) as Message[];
        if (Array.isArray(parsed)) setMessages(parsed);
      }
    } catch {
      // best effort
    }
  }, []);

  // Persist on every change.
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY_PREFIX + "history",
        JSON.stringify(messages),
      );
    } catch {
      // localStorage might be full; best-effort
    }
  }, [messages]);

  // Auto-scroll to bottom on new content.
  useEffect(() => {
    if (!threadRef.current) return;
    threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages, streamText, open]);

  // Focus the input when the drawer opens.
  useEffect(() => {
    if (open) {
      // Tiny defer so the textarea exists in the DOM before we focus.
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Close on Escape (only when drawer is open + input not focused).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !streaming) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, streaming]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || streaming) return;
    setError(null);
    setDraft("");
    const userMsg: Message = {
      id: `u-${Date.now()}`,
      role: "user",
      text,
    };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setStreaming(true);
    setStreamText("");
    setStreamTools([]);
    setStreamSearchQueries([]);
    setStreamSources([]);

    const ac = new AbortController();
    abortRef.current = ac;

    const pageContext = capturePageContext(registeredContext);

    try {
      const res = await fetch("/api/gemini/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages.map((m) => ({ role: m.role, text: m.text })),
          pageContext,
          mode: webMode ? "web" : "tools",
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        let errMsg = `chat failed: HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.error) errMsg = j.error;
        } catch {
          /* leave default */
        }
        throw new Error(errMsg);
      }
      // Parse SSE stream.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accText = "";
      let accTools: { name: string; args: Record<string, unknown> }[] = [];
      let accSearchQueries: string[] = [];
      let accSources: GroundingSource[] = [];
      let finishReason = "";
      let aborted = false;

      while (!aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE events terminate on \n\n
        const events = buffer.split("\n\n");
        buffer = events.pop() || ""; // last fragment may be incomplete
        for (const block of events) {
          if (!block.trim()) continue;
          const lines = block.split("\n");
          let event = "message";
          let dataStr = "";
          for (const line of lines) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
          }
          if (!dataStr) continue;
          let data: unknown = null;
          try {
            data = JSON.parse(dataStr);
          } catch {
            continue;
          }
          if (event === "text" && typeof (data as { text?: string }).text === "string") {
            accText += (data as { text: string }).text;
            setStreamText(accText);
          } else if (event === "tool" && (data as { name?: string }).name) {
            const tool = data as { name: string; args: Record<string, unknown> };
            accTools = [...accTools, tool];
            setStreamTools(accTools);
          } else if (event === "search" && (data as { query?: string }).query) {
            const q = (data as { query: string }).query;
            if (!accSearchQueries.includes(q)) {
              accSearchQueries = [...accSearchQueries, q];
              setStreamSearchQueries(accSearchQueries);
            }
          } else if (event === "sources") {
            const chunks = (data as { chunks?: GroundingSource[] }).chunks || [];
            // Dedup by URI as we go, since sources can stream in
            // multiple events across the iteration.
            const seen = new Set(accSources.map((s) => s.uri));
            for (const c of chunks) {
              if (!seen.has(c.uri)) {
                seen.add(c.uri);
                accSources.push(c);
              }
            }
            setStreamSources([...accSources]);
          } else if (event === "done") {
            const fr = (data as { finishReason?: string }).finishReason;
            if (typeof fr === "string") finishReason = fr;
            aborted = true;
            break;
          } else if (event === "error") {
            throw new Error(
              (data as { error?: string }).error || "stream error",
            );
          }
        }
      }

      // Finalize: flush stream into a real message.
      const cleanFinish =
        finishReason === "" ||
        finishReason === "STOP" ||
        finishReason === "FINISH_REASON_UNSPECIFIED";
      const assistantMsg: Message = {
        id: `m-${Date.now()}`,
        role: "model",
        text: accText,
        ...(accTools.length > 0 ? { toolCalls: accTools } : {}),
        ...(accSearchQueries.length > 0
          ? { searchQueries: accSearchQueries }
          : {}),
        ...(accSources.length > 0 ? { sources: accSources } : {}),
        ...(cleanFinish ? {} : { finishReason }),
      };
      setMessages((cur) => [...cur, assistantMsg]);
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") {
        // User clicked stop — just clear the in-progress state.
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setStreaming(false);
      setStreamText("");
      setStreamTools([]);
      setStreamSearchQueries([]);
      setStreamSources([]);
      abortRef.current = null;
    }
  }, [draft, messages, registeredContext, streaming]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    if (streaming) return;
    setMessages([]);
    setError(null);
  }, [streaming]);

  return (
    <>
      <button
        type="button"
        className={`gemini-fab${open ? " is-open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "סגור עוזר" : "פתח עוזר"}
        title={open ? "סגור" : "שאל את ה-Hub (Gemini)"}
      >
        ✨
      </button>
      {open && (
        <aside className="gemini-drawer themed-scrollbar" role="dialog">
          <header className="gemini-drawer-head">
            <span className="gemini-drawer-title">✨ עוזר Hub</span>
            <button
              type="button"
              className="gemini-drawer-clear"
              onClick={clear}
              disabled={streaming || messages.length === 0}
              title="נקה שיחה"
              aria-label="נקה שיחה"
            >
              🧹
            </button>
            <button
              type="button"
              className="gemini-drawer-close"
              onClick={() => setOpen(false)}
              aria-label="סגור"
              title="סגור (Esc)"
            >
              ×
            </button>
          </header>
          <div ref={threadRef} className="gemini-drawer-thread themed-scrollbar">
            {messages.length === 0 && !streaming && (
              <div className="gemini-empty">
                <div className="gemini-empty-icon">✨</div>
                <div className="gemini-empty-title">איך אפשר לעזור?</div>
                <div className="gemini-empty-hint">
                  אני מכיר את ה‑Hub, את הג׳ימייל שלך ואת ה‑Drive. שאל למשל:
                </div>
                <ul className="gemini-empty-examples">
                  <li>״מה המייל האחרון מלורה ב‑Gindy?״</li>
                  <li>״מי על הפרויקט הזה?״</li>
                  <li>״מצא מסמכים על ה‑landing page של גוהרי״</li>
                </ul>
              </div>
            )}
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
            {streaming && (
              <div className="gemini-msg gemini-msg-model gemini-msg-streaming">
                {(streamTools.length > 0 || streamSearchQueries.length > 0) && (
                  <div className="gemini-tool-chips">
                    {streamTools.map((t, i) => (
                      <span key={`t${i}`} className="gemini-tool-chip" title={JSON.stringify(t.args)}>
                        {toolEmoji(t.name)} {t.name}
                      </span>
                    ))}
                    {streamSearchQueries.map((q, i) => (
                      <span
                        key={`s${i}`}
                        className="gemini-tool-chip gemini-search-chip"
                        title={`Google Search: ${q}`}
                      >
                        🌐 {q}
                      </span>
                    ))}
                  </div>
                )}
                <div className="gemini-msg-text">
                  {streamText ? (
                    renderRichText(streamText)
                  ) : (
                    <span className="gemini-thinking">
                      <span className="gemini-dot" />
                      <span className="gemini-dot" />
                      <span className="gemini-dot" />
                    </span>
                  )}
                </div>
                {streamSources.length > 0 && (
                  <SourcesFooter sources={streamSources} />
                )}
              </div>
            )}
            {error && <div className="gemini-error">{error}</div>}
          </div>
          <form
            className="gemini-input-row"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <button
              type="button"
              className={`gemini-mode-toggle${webMode ? " is-on" : ""}`}
              onClick={() => setWebMode((m) => !m)}
              disabled={streaming}
              title={
                webMode
                  ? "מצב חיפוש באינטרנט — Google Search על השאלה הבאה. לחץ כדי לחזור למצב כלי-Hub."
                  : "מצב כלי-Hub — קורא ממשימות / פרויקטים / Gmail / Drive / גיליונות. לחץ כדי לעבור לחיפוש Google."
              }
              aria-pressed={webMode}
              aria-label={webMode ? "מצב web פעיל" : "מצב כלים פעיל"}
            >
              <span className="gemini-mode-toggle-icon" aria-hidden>
                {webMode ? <GoogleIcon size={14} /> : "🛠️"}
              </span>
              <span>{webMode ? "web" : "hub"}</span>
            </button>
            <textarea
              ref={inputRef}
              className="gemini-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                webMode
                  ? "שאל את האינטרנט (Google Search)..."
                  : "שאל משהו..."
              }
              rows={2}
              disabled={streaming}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter newline. Mirrors most chat UIs.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {streaming ? (
              <button
                type="button"
                className="gemini-stop-btn"
                onClick={stop}
                title="עצור"
              >
                ⏹
              </button>
            ) : (
              <button
                type="submit"
                className="gemini-send-btn"
                disabled={!draft.trim()}
                title="שלח (Enter)"
              >
                ↑
              </button>
            )}
          </form>
        </aside>
      )}
    </>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const hasChips =
    (message.toolCalls && message.toolCalls.length > 0) ||
    (message.searchQueries && message.searchQueries.length > 0);
  return (
    <div className={`gemini-msg gemini-msg-${message.role}`}>
      {hasChips && (
        <div className="gemini-tool-chips">
          {(message.toolCalls || []).map((t, i) => (
            <span key={`t${i}`} className="gemini-tool-chip" title={JSON.stringify(t.args)}>
              {toolEmoji(t.name)} {t.name}
            </span>
          ))}
          {(message.searchQueries || []).map((q, i) => (
            <span
              key={`s${i}`}
              className="gemini-tool-chip gemini-search-chip"
              title={`Google Search: ${q}`}
            >
              🌐 {q}
            </span>
          ))}
        </div>
      )}
      <div className="gemini-msg-text">
        {message.role === "user" ? message.text : renderRichText(message.text)}
      </div>
      {message.finishReason && (
        <FinishReasonBanner reason={message.finishReason} />
      )}
      {message.sources && message.sources.length > 0 && (
        <SourcesFooter sources={message.sources} />
      )}
    </div>
  );
}

/** Small banner under a bubble whose finishReason was non-clean.
 *  MAX_TOKENS = the assistant ran out of room and was cut off; user
 *  can ask "המשך" to continue. SAFETY/RECITATION = Vertex's content
 *  filter blocked something. Anything else = unknown but not STOP. */
function FinishReasonBanner({ reason }: { reason: string }) {
  const label =
    reason === "MAX_TOKENS"
      ? "ההודעה נחתכה — חרגה ממכסת הפלט. שאל \"המשך\" כדי להשלים."
      : reason === "SAFETY" || reason === "RECITATION"
        ? "המודל עצר את התשובה (מסנן תוכן של Vertex)."
        : `המודל סיים בלי STOP (${reason}).`;
  return <div className="gemini-finish-banner">⚠️ {label}</div>;
}

/** Footer block listing the web sources Vertex grounded against.
 *  Rendered under the assistant text bubble when Google Search was
 *  used. Hostname-only labels keep the list compact; full URL goes
 *  on hover via title. */
function SourcesFooter({ sources }: { sources: GroundingSource[] }) {
  return (
    <div className="gemini-sources">
      <div className="gemini-sources-head">🌐 מקורות:</div>
      <ol className="gemini-sources-list">
        {sources.map((s, i) => {
          let host = s.uri;
          try {
            host = new URL(s.uri).hostname.replace(/^www\./, "");
          } catch {
            /* leave raw URI as fallback */
          }
          return (
            <li key={`${s.uri}-${i}`}>
              <a
                href={s.uri}
                target="_blank"
                rel="noreferrer"
                title={s.title || s.uri}
              >
                {s.title || host}
                <span className="gemini-source-host"> · {host}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * Tiny markdown-ish renderer for assistant messages. Handles four
 * patterns inline:
 *   - **bold**                → <strong>
 *   - [label](url)            → clickable link (target=_blank for absolute, in-app for relative)
 *   - bare https://...        → clickable link (target=_blank)
 *   - bare /tasks|/projects/… → in-app link
 *
 * Anything else passes through as plain text. Newlines are preserved
 * by the parent's `white-space: pre-wrap` CSS, so we don't need to
 * split into lines here. Returns React nodes interleaved with strings.
 *
 * Why not pull in a markdown library: the assistant emits short
 * answers (a few sentences plus a list at most), and we already have
 * full control over the prompt to keep the formatting predictable.
 * Adding `react-markdown` + `remark-gfm` would balloon the bundle for
 * a handful of patterns.
 */
function renderRichText(text: string): React.ReactNode[] {
  // Single regex with five alternations — capture group 1 = bold body,
  // 2 = markdown link label + 3 = its url, 4 = bare http(s) URL,
  // 5 = bare hub-internal path. The character classes for URLs
  // exclude common trailing punctuation so a sentence-ending period
  // doesn't get sucked into the link.
  const regex =
    /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)|(https?:\/\/[^\s<>"'),]+)|(\/(?:tasks|projects|companies|campaigns|admin|notifications|inbox)\/[^\s<>"'),]+)/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(<strong key={`k${key++}`}>{m[1]}</strong>);
    } else if (m[2] !== undefined && m[3] !== undefined) {
      const href = m[3];
      const internal = href.startsWith("/");
      out.push(
        <a
          key={`k${key++}`}
          href={href}
          {...(internal ? {} : { target: "_blank", rel: "noreferrer" })}
        >
          {m[2]}
        </a>,
      );
    } else if (m[4] !== undefined) {
      out.push(
        <a key={`k${key++}`} href={m[4]} target="_blank" rel="noreferrer">
          {m[4]}
        </a>,
      );
    } else if (m[5] !== undefined) {
      out.push(
        <a key={`k${key++}`} href={m[5]}>
          {m[5]}
        </a>,
      );
    }
    last = regex.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Tiny emoji map for tool-call chips so the user gets a quick visual
 *  of what the assistant is doing without having to read the tool name. */
function toolEmoji(name: string): string {
  switch (name) {
    case "getTask":
      return "📋";
    case "getProject":
      return "📁";
    case "getCompanyContacts":
      return "👥";
    case "searchGmail":
    case "readGmailThread":
      return "📧";
    case "searchDrive":
    case "readDoc":
      return "📄";
    default:
      return "🔧";
  }
}
