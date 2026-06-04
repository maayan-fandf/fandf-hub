"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

/**
 * URL-driven project picker for the /stats page. Selecting a project
 * updates `?project=X` on the URL — the server re-renders that
 * project's metrics + diagnosis below. Searchable input so 40+
 * projects don't turn into an unmanageable native dropdown.
 *
 * Pattern matches /morning/forecast's SearchableMultiSelectFilter,
 * trimmed to single-select.
 */
export default function StatsProjectPicker({
  projects,
  selected,
}: {
  projects: string[];
  selected: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [isPending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.toLowerCase().includes(q));
  }, [projects, query]);

  const setProject = (name: string | null) => {
    const params = new URLSearchParams(searchParams?.toString() || "");
    if (name) params.set("project", name);
    else params.delete("project");
    const qs = params.toString();
    setOpen(false);
    setQuery("");
    startTransition(() => {
      router.push(qs ? `/stats?${qs}` : "/stats");
    });
  };

  return (
    <div className="stats-picker">
      <button
        type="button"
        className="stats-picker-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={isPending}
      >
        {selected ? (
          <span className="stats-picker-current">{selected}</span>
        ) : (
          <span className="stats-picker-placeholder">בחר פרויקט…</span>
        )}
        {isPending ? (
          <span className="stats-picker-caret">⏳</span>
        ) : (
          <span className="stats-picker-caret">{open ? "▴" : "▾"}</span>
        )}
      </button>
      {selected && (
        <button
          type="button"
          className="stats-picker-clear"
          onClick={() => setProject(null)}
          title="נקה בחירה"
          aria-label="נקה בחירה"
          disabled={isPending}
        >
          ×
        </button>
      )}
      {open && (
        <div className="stats-picker-panel" role="listbox">
          <input
            type="search"
            className="stats-picker-search"
            placeholder="חפש פרויקט…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <div className="stats-picker-list">
            {filtered.length === 0 ? (
              <div className="stats-picker-empty">אין התאמות</div>
            ) : (
              filtered.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="option"
                  aria-selected={p === selected}
                  className={
                    "stats-picker-item" +
                    (p === selected ? " is-active" : "")
                  }
                  onClick={() => setProject(p)}
                >
                  {p}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
