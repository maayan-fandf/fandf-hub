"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Per-page structured context that pages can register via
 * `useRegisterPageContext`. The chat drawer reads this on each turn
 * (alongside the auto-extracted DOM text) and sends it to Gemini so
 * the assistant knows which task / project / company you're looking
 * at without having to round-trip a tool call to find out.
 *
 * Pages opt in. Pages that don't register fall back to the auto-
 * extracted base (pathname + title + first ~3KB of visible text on
 * `.app-shell-main`). Both layers always ship with every chat turn.
 *
 *   label  → one short noun phrase ("task: T-abc123 / Acme Q3 video")
 *            shown to the LLM as a quick orientation cue.
 *   data   → JSON-serializable structured payload (full task, project
 *            roster, current filters + visible row IDs, etc.). Keep
 *            it lean — every byte rides every chat turn.
 */
export type PageContextPayload = {
  label?: string;
  data?: unknown;
};

type Ctx = {
  payload: PageContextPayload | null;
  setPayload: (p: PageContextPayload | null) => void;
};

const PageContextCtx = createContext<Ctx | null>(null);

export function PageContextProvider({ children }: { children: ReactNode }) {
  const [payload, setPayloadState] = useState<PageContextPayload | null>(null);
  const setPayload = useCallback(
    (p: PageContextPayload | null) => setPayloadState(p),
    [],
  );
  // Memoize the value so consumers that only read `payload` don't
  // rerender on every parent rerender.
  const value = useMemo(() => ({ payload, setPayload }), [payload, setPayload]);
  return (
    <PageContextCtx.Provider value={value}>{children}</PageContextCtx.Provider>
  );
}

/** Read the current registered payload + a setter. Most pages don't
 *  need this directly — use `useRegisterPageContext` to register-on-
 *  mount + clear-on-unmount in one line. The chat drawer is the only
 *  consumer that reads it. */
export function usePageContext(): Ctx {
  const ctx = useContext(PageContextCtx);
  if (!ctx) {
    // No-op fallback so isolated components / SSR snapshots don't
    // crash. The layout root mounts the provider for every
    // authenticated page.
    return { payload: null, setPayload: () => {} };
  }
  return ctx;
}

/**
 * Register a structured page context on mount, clear on unmount.
 *
 * Usage inside a client component (page or top-level page section):
 *
 *   useRegisterPageContext({
 *     label: `task: ${task.id} / ${task.title}`,
 *     data: { task, comments, assignees },
 *   });
 *
 * Pass `null` to explicitly clear (useful for surfaces that don't
 * want any context to leak from a previous page render).
 *
 * The dependency-tracked re-register uses a JSON.stringify of the
 * payload, so callers don't have to memoize their object — a stable
 * string identity covers the common case where the data is recomputed
 * each render but its content hasn't changed.
 */
export function useRegisterPageContext(
  payload: PageContextPayload | null,
): void {
  const { setPayload } = usePageContext();
  // JSON.stringify is the dirty-check key. Cheap for the small
  // payloads we expect (a task + 50 comments is ~5KB serialized).
  const key = useMemo(
    () => (payload ? JSON.stringify(payload) : ""),
    [payload],
  );
  useEffect(() => {
    setPayload(payload);
    return () => setPayload(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setPayload]);
}
