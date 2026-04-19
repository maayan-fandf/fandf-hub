"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Project } from "@/lib/appsScript";

type Command =
  | {
      kind: "project";
      key: string;
      label: string;
      sublabel: string;
      href: string;
      haystack: string;
    }
  | {
      kind: "action";
      key: string;
      label: string;
      sublabel: string;
      href: string;
      haystack: string;
      hint?: string;
    };

const STATIC_ACTIONS: Command[] = [
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

/**
 * ⌘K / Ctrl+K command palette. Projects are lazy-loaded via /api/projects
 * on first open. Supports substring match on project name + company in both
 * Hebrew and Latin — no fuzzy lib dependency.
 *
 * Global keyboard:
 *   ⌘/Ctrl+K  — toggle open
 *   /         — open (when not already in an input)
 *   Esc       — close
 *   ↑/↓       — navigate results
 *   Enter     — run selected
 *   g p / g i — jump nav chords (non-modifier)
 */
export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

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

      // ⌘/Ctrl + K — always toggle
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      // Slash — open, but only when not typing in a field
      if (!typing && e.key === "/") {
        e.preventDefault();
        setOpen(true);
        return;
      }
      // "g p" / "g i" chord — Linear-style nav
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
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const projectCmds: Command[] =
      projects?.map((p) => ({
        kind: "project" as const,
        key: `project:${p.name}`,
        label: p.name,
        sublabel: p.company || "ללא חברה",
        href: `/projects/${encodeURIComponent(p.name)}`,
        haystack: `${p.name} ${p.company ?? ""}`.toLowerCase(),
      })) ?? [];
    return [...STATIC_ACTIONS, ...projectCmds];
  }, [projects]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands.slice(0, 50);
    // Substring match on a pre-lowered haystack. Projects with the query in
    // their name rank above matches that only hit the company.
    const scored = commands
      .map((c) => {
        const hay = c.haystack;
        const idx = hay.indexOf(q);
        if (idx < 0) return null;
        const nameHit = c.label.toLowerCase().indexOf(q);
        // Earlier hit in label = higher (smaller) rank.
        const score = nameHit >= 0 ? nameHit : 100 + idx;
        return { c, score };
      })
      .filter((x): x is { c: Command; score: number } => x !== null)
      .sort((a, b) => a.score - b.score)
      .slice(0, 50)
      .map((x) => x.c);
    return scored;
  }, [commands, query]);

  // Clamp selection into range as results change.
  useEffect(() => {
    if (selected >= results.length) setSelected(Math.max(0, results.length - 1));
  }, [results, selected]);

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
    router.push(cmd.href);
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(results.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = results[selected];
      if (cmd) runCommand(cmd);
    }
  }

  if (!open) return null;

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
            placeholder="חפש פרויקט, פעולה…"
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
          {!loading && !loadError && results.length === 0 && (
            <div className="palette-empty">לא נמצאו תוצאות</div>
          )}
          {results.map((cmd, i) => (
            <button
              type="button"
              key={cmd.key}
              data-palette-idx={i}
              className={`palette-item ${i === selected ? "is-selected" : ""}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => runCommand(cmd)}
            >
              <span className="palette-item-kind" aria-hidden>
                {cmd.kind === "project" ? "◉" : "→"}
              </span>
              <span className="palette-item-text">
                <span className="palette-item-label" dir="auto">
                  {cmd.label}
                </span>
                <span className="palette-item-sub" dir="auto">
                  {cmd.sublabel}
                </span>
              </span>
              {cmd.kind === "action" && cmd.hint && (
                <kbd className="palette-hint">{cmd.hint}</kbd>
              )}
            </button>
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
