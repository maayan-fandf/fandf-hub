"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePageContext } from "@/components/PageContextProvider";
import { capturePageContext } from "@/lib/pageContextSnapshot";

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
type Message = {
  id: string;
  role: Role;
  text: string;
  /** Only on assistant messages: tool-call indicators we surfaced
   *  while streaming. Persisted so a reload still shows what the
   *  assistant did to compose the answer. */
  toolCalls?: { name: string; args: Record<string, unknown> }[];
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
          } else if (event === "done") {
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
      const assistantMsg: Message = {
        id: `m-${Date.now()}`,
        role: "model",
        text: accText,
        ...(accTools.length > 0 ? { toolCalls: accTools } : {}),
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
                {streamTools.length > 0 && (
                  <div className="gemini-tool-chips">
                    {streamTools.map((t, i) => (
                      <span key={i} className="gemini-tool-chip" title={JSON.stringify(t.args)}>
                        {toolEmoji(t.name)} {t.name}
                      </span>
                    ))}
                  </div>
                )}
                <div className="gemini-msg-text">
                  {streamText || (
                    <span className="gemini-thinking">
                      <span className="gemini-dot" />
                      <span className="gemini-dot" />
                      <span className="gemini-dot" />
                    </span>
                  )}
                </div>
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
            <textarea
              ref={inputRef}
              className="gemini-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="שאל משהו..."
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
  return (
    <div className={`gemini-msg gemini-msg-${message.role}`}>
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="gemini-tool-chips">
          {message.toolCalls.map((t, i) => (
            <span key={i} className="gemini-tool-chip" title={JSON.stringify(t.args)}>
              {toolEmoji(t.name)} {t.name}
            </span>
          ))}
        </div>
      )}
      <div className="gemini-msg-text">{message.text}</div>
    </div>
  );
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
