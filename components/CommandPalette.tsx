"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Project, SearchResult } from "@/lib/appsScript";

type ActionCmd = {
  kind: "action";
  key: string;
  label: string;
  sublabel: string;
  href: string;
  haystack: string;
  hint?: string;
};

type ProjectCmd = {
  kind: "project";
  key: string;
  label: string;
  sublabel: string;
  href: string;
  haystack: string;
};

type ContentCmd = {
  kind: "content";
  key: string;
  label: string; // body excerpt
  sublabel: string; // project · author · relative time
  /** Deep link back into the dashboard where the comment lives. */
  href: string;
  /** If true, render as <a target="_blank"> instead of router.push. */
  external: boolean;
  resolved: boolean;
  hasTasks: boolean;
};

type Command = ActionCmd | ProjectCmd | ContentCmd;

type Section = { title: string; items: Command[] };

const STATIC_ACTIONS: ActionCmd[] = [
  {
    kind: "action",
    key: "nav:projects",
    label: "פרויקטים",
    sublabel: "רשימת כל הפרויקטים",
    href: "/",
    haystack: "projects פרויקטים home",
    hint: "g p",
  },
  {
    kind: "action",
    key: "nav:inbox",
    label: "תיוגים",
    sublabel: "אזכורים שלי מכל הפרויקטים",
    href: "/inbox",
    haystack: "inbox mentions תיוגים אזכורים",
    hint: "g i",
  },
];

const SEARCH_DEBOUNCE_MS = 220;

export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [contentResults, setContentResults] = useState<SearchResult[]>([]);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);

  // Global key listener — opens the palette and handles the "g _" chord.
  useEffect(() => {
    let chordTimer: number | null = null;
    let chordActive = false;

    function onKeyDown(e: KeyboardEvent) {
      const active = document.activeElement;
      const typing =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (!typing && e.key === "/") {
        e.preventDefault();
        setOpen(true);
        return;
      }
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === "g") {
          e.preventDefault();
          chordActive = true;
          if (chordTimer) window.clearTimeout(chordTimer);
          chordTimer = window.setTimeout(() => {
            chordActive = false;
          }, 1200);
          return;
        }
        if (chordActive) {
          if (e.key === "p") {
            e.preventDefault();
            chordActive = false;
            router.push("/");
            return;
          }
          if (e.key === "i") {
            e.preventDefault();
            chordActive = false;
            router.push("/inbox");
            return;
          }
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (chordTimer) window.clearTimeout(chordTimer);
    };
  }, [router]);

  // Lazy-fetch projects when the palette first opens.
  useEffect(() => {
    if (!open || projects !== null || loading) return;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const res = await fetch("/api/projects");
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        const data = (await res.json()) as { projects: Project[] };
        setProjects(data.projects);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [open, projects, loading]);

  // Reset state when opening.
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      setContentResults([]);
      setContentError(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Debounced content search. Kicks in at ≥2 chars, cancels any in-flight
  // request when the query changes.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setContentResults([]);
      setContentLoading(false);
      setContentError(null);
      searchAbortRef.current?.abort();
      return;
    }

    const t = window.setTimeout(() => {
      searchAbortRef.current?.abort();
      const ctrl = new AbortController();
      searchAbortRef.current = ctrl;
      setContentLoading(true);
      setContentError(null);
      (async () => {
        try {
          const res = await fetch(
            `/api/search?q=${encodeURIComponent(q)}&limit=20`,
            { signal: ctrl.signal },
          );
          if (!res.ok) {
            const data = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(data.error || `Request failed (${res.status})`);
          }
          const data = (await res.json()) as { results: SearchResult[] };
          if (!ctrl.signal.aborted) {
            setContentResults(data.results ?? []);
          }
        } catch (err) {
          if ((err as Error)?.name === "AbortError") return;
          setContentError(err instanceof Error ? err.message : String(err));
          setContentResults([]);
        } finally {
          if (!ctrl.signal.aborted) setContentLoading(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(t);
  }, [query, open]);

  const sections = useMemo<Section[]>(() => {
    const q = query.trim().toLowerCase();

    // Local match on actions + projects (same ranking as before).
    const projectCmds: ProjectCmd[] =
      projects?.map((p) => ({
        kind: "project" as const,
        key: `project:${p.name}`,
        label: p.name,
        sublabel: p.company || "ללא חברה",
        href: `/projects/${encodeURIComponent(p.name)}`,
        haystack: `${p.name} ${p.company ?? ""}`.toLowerCase(),
      })) ?? [];
    // Local entries are the ones with a `haystack` we can substring-match
    // against. Content results come from the server and don't participate
    // in this scoring.
    const local: (ActionCmd | ProjectCmd)[] = [...STATIC_ACTIONS, ...projectCmds];

    const scored: (ActionCmd | ProjectCmd)[] = q
      ? local
          .map((c) => {
            const idx = c.haystack.indexOf(q);
            if (idx < 0) return null;
            const nameHit = c.label.toLowerCase().indexOf(q);
            return { c, score: nameHit >= 0 ? nameHit : 100 + idx };
          })
          .filter(
            (x): x is { c: ActionCmd | ProjectCmd; score: number } =>
              x !== null,
          )
          .sort((a, b) => a.score - b.score)
          .map((x) => x.c)
      : local.slice(0, 50);

    // Remote content matches → "content" commands, opened via deep link.
    const contentCmds: ContentCmd[] = contentResults.map((r) => ({
      kind: "content",
      key: `content:${r.comment_id}`,
      label: truncate(r.body, 120),
      sublabel: `${r.project} · ${r.author_name || r.author_email} · ${formatRelative(r.timestamp)}`,
      href: r.deep_link || `/projects/${encodeURIComponent(r.project)}/timeline`,
      external: !!r.deep_link,
      resolved: r.resolved,
      hasTasks: r.has_tasks,
    }));

    const actions = scored.filter((c) => c.kind === "action");
    const proj = scored.filter((c) => c.kind === "project");

    const out: Section[] = [];
    if (actions.length) out.push({ title: "פעולות", items: actions });
    if (proj.length) out.push({ title: "פרויקטים", items: proj });
    if (q.length >= 2) {
      const title = contentLoading
        ? "תוכן · מחפש…"
        : `תוכן${contentResults.length ? ` · ${contentResults.length} תוצאות` : ""}`;
      out.push({ title, items: contentCmds });
    }
    return out;
  }, [projects, contentResults, contentLoading, query]);

  // Flatten for keyboard navigation (section dividers are skipped).
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  // Clamp selection into range as results change.
  useEffect(() => {
    if (selected >= flat.length) setSelected(Math.max(0, flat.length - 1));
  }, [flat, selected]);

  // Scroll selected into view.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-palette-idx="${selected}"]`,
    );
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [open, selected]);

  function runCommand(cmd: Command) {
    setOpen(false);
    if (cmd.kind === "content" && cmd.external) {
      // Deep links point into the Apps Script dashboard in another tab.
      window.open(cmd.href, "_blank", "noopener,noreferrer");
    } else {
      router.push(cmd.href);
    }
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(flat.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = flat[selected];
      if (cmd) runCommand(cmd);
    }
  }

  if (!open) return null;

  let runningIdx = 0;

  return (
    <div
      className="palette-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        className="palette-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="palette-input-row">
          <span className="palette-input-icon" aria-hidden>
            ⌕
          </span>
          <input
            ref={inputRef}
            className="palette-input"
            type="text"
            value={query}
            placeholder="חפש פרויקט, פעולה, או תוכן…"
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={onInputKeyDown}
            dir="auto"
            aria-label="Search"
          />
          <kbd className="palette-esc">Esc</kbd>
        </div>

        <div className="palette-results" ref={listRef}>
          {loading && (
            <div className="palette-empty">טוען פרויקטים…</div>
          )}
          {loadError && (
            <div className="palette-error">
              כישלון בטעינה: {loadError}
            </div>
          )}
          {contentError && (
            <div className="palette-error">
              שגיאת חיפוש: {contentError}
            </div>
          )}
          {!loading && !loadError && flat.length === 0 && (
            <div className="palette-empty">
              {query.trim().length >= 2 && !contentLoading
                ? "לא נמצאו תוצאות"
                : "התחל להקליד…"}
            </div>
          )}
          {sections.map((section) => (
            <div key={section.title} className="palette-section">
              <div className="palette-section-title">{section.title}</div>
              {section.items.length === 0 && (
                <div className="palette-section-empty">אין תוצאות</div>
              )}
              {section.items.map((cmd) => {
                const idx = runningIdx++;
                return (
                  <button
                    type="button"
                    key={cmd.key}
                    data-palette-idx={idx}
                    className={`palette-item ${idx === selected ? "is-selected" : ""} ${cmd.kind === "content" && cmd.resolved ? "is-faded" : ""}`}
                    onMouseEnter={() => setSelected(idx)}
                    onClick={() => runCommand(cmd)}
                  >
                    <span className="palette-item-kind" aria-hidden>
                      {cmd.kind === "project"
                        ? "◉"
                        : cmd.kind === "content"
                          ? "💬"
                          : "→"}
                    </span>
                    <span className="palette-item-text">
                      <span className="palette-item-label" dir="auto">
                        {cmd.label}
                      </span>
                      <span className="palette-item-sub" dir="auto">
                        {cmd.sublabel}
                      </span>
                    </span>
                    {cmd.kind === "content" && cmd.hasTasks && (
                      <span
                        className="palette-badge"
                        title="יש משימות מקושרות"
                      >
                        משימה
                      </span>
                    )}
                    {cmd.kind === "content" && cmd.resolved && (
                      <span className="palette-badge palette-badge-muted">
                        פתור
                      </span>
                    )}
                    {cmd.kind === "action" && cmd.hint && (
                      <kbd className="palette-hint">{cmd.hint}</kbd>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> לניווט
          </span>
          <span>
            <kbd>Enter</kbd> לבחירה
          </span>
          <span>
            <kbd>?</kbd> עזרה
          </span>
        </div>
      </div>
    </div>
  );
}

/* ─── Helpers ────────────────────────────────────────────────────── */

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const now = Date.now();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return "עכשיו";
  const mins = Math.round(diffSec / 60);
  if (mins < 60) return `לפני ${mins} ד׳`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `לפני ${hrs} ש׳`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `לפני ${days} י׳`;
  const months = Math.round(days / 30);
  if (months < 12) return `לפני ${months} חו׳`;
  const years = Math.round(days / 365);
  return `לפני ${years} ש׳`;
}
