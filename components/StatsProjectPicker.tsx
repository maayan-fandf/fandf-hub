"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

/**
 * URL-driven searchable single-select picker for the /stats page.
 * Generic so the same component drives both the project picker
 * (paramName="project") and the city picker (paramName="city").
 *
 * Updating the selection rewrites the search params and triggers a
 * server re-render — the page-level data fetch keys off the same
 * params, so the drill-down + highlights update together.
 */
export default function StatsPicker({
  paramName,
  items,
  selected,
  icon,
  placeholder,
  searchPlaceholder,
}: {
  /** URL query parameter to read/write — "project" or "city". */
  paramName: string;
  /** Available options. Order is preserved; the picker is searchable. */
  items: string[];
  /** Currently selected value, or null. */
  selected: string | null;
  /** Optional icon prefix shown inside the trigger button. */
  icon?: string;
  /** Placeholder when nothing is selected. */
  placeholder: string;
  /** Placeholder inside the search input when the panel is open. */
  searchPlaceholder?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [isPending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((p) => p.toLowerCase().includes(q));
  }, [items, query]);

  const setValue = (value: string | null) => {
    const params = new URLSearchParams(searchParams?.toString() || "");
    if (value) params.set(paramName, value);
    else params.delete(paramName);
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
        {icon && <span className="stats-picker-icon" aria-hidden>{icon}</span>}
        {selected ? (
          <span className="stats-picker-current">{selected}</span>
        ) : (
          <span className="stats-picker-placeholder">{placeholder}</span>
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
          onClick={() => setValue(null)}
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
            placeholder={searchPlaceholder || "חפש…"}
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
                  onClick={() => setValue(p)}
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
