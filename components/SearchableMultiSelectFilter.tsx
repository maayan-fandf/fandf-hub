"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Searchable multi-select filter. UX mirrors the CRM funnel chart's
 * source filter (CrmFunnelClient.tsx):
 *
 *   [Label · N]       ← trigger pill (when N > 0 = count selected)
 *      ↓ click opens floating panel
 *   ┌─────────────────────────────┐
 *   │ 🔍 חפש…                      │  ← search input (autofocus)
 *   │ ✓ סמן את כל N ההתאמות        │  ← bulk-toggle for visible matches
 *   │ ─────────────────────        │
 *   │ ✓ option A             (12)  │
 *   │ ✓ option B             (3)   │
 *   │ □ option C             (7)   │
 *   │ ...                          │  ← list scrolls with thin custom scrollbar
 *   └─────────────────────────────┘
 *
 * State lives in the URL: this component writes the comma-separated
 * selected values into a hidden input named `name`, which the parent
 * GET form picks up on submit. That keeps state shareable + back-
 * button-friendly + no need for a state-management library.
 *
 * The selected/visible behavior is identical to the CRM funnel
 * pattern:
 *   - Click a row → toggle that single value (search query stays in
 *     place so you can multi-select within one query)
 *   - "סמן הכל" button → toggles ALL visible (search-filtered) rows
 *     at once
 *   - Enter on a non-empty search → same as "סמן הכל"
 *   - Click outside the popover → closes
 */
export default function SearchableMultiSelectFilter({
  name,
  label,
  options,
  defaultSelected,
  placeholder = "חפש…",
}: {
  /** Form field name. The hidden input that submits will have this
   *  name; value = comma-separated selected items. */
  name: string;
  /** Trigger pill label. Suffix " · N" appended when selected. */
  label: string;
  /** All possible options. Each `{ value, count? }` — count is the
   *  badge next to the value when present (use 0 to hide). */
  options: Array<{ value: string; count?: number }>;
  /** Initial selection — typically the URL's parsed value. */
  defaultSelected: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(defaultSelected),
  );
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close popover on outside click. Standard popover hygiene — same
  // pattern CrmFunnelClient uses for its multi-select.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Filter options by query — case-insensitive substring.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.value.toLowerCase().includes(q));
  }, [options, query]);

  function toggleOne(value: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }
  function toggleAllVisible() {
    const allSelected = visible.every((o) => selected.has(o.value));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const o of visible) next.delete(o.value);
      } else {
        for (const o of visible) next.add(o.value);
      }
      return next;
    });
  }
  function clearAll() {
    setSelected(new Set());
  }

  const hiddenValue = useMemo(
    () => Array.from(selected).filter(Boolean).join(","),
    [selected],
  );
  const count = selected.size;
  const summaryText = count > 0 ? `${label} · ${count}` : label;
  const allVisibleSelected =
    visible.length > 0 && visible.every((o) => selected.has(o.value));

  return (
    <div className="sms-filter" ref={wrapRef}>
      {/* Hidden input the parent <form> picks up on submit. Kept in
          sync with `selected` via React state. */}
      <input type="hidden" name={name} value={hiddenValue} />
      <button
        type="button"
        className={`sms-filter-trigger${count > 0 ? " is-active" : ""}${open ? " is-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="sms-filter-trigger-label">{summaryText}</span>
        <span className="sms-filter-chev" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="sms-filter-popover" role="dialog">
          <div className="sms-filter-search">
            <span className="sms-filter-search-icon" aria-hidden>
              🔍
            </span>
            <input
              type="text"
              className="sms-filter-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              onKeyDown={(e) => {
                if (e.key === "Enter" && query.trim() && visible.length > 0) {
                  e.preventDefault();
                  toggleAllVisible();
                } else if (e.key === "Escape") {
                  setOpen(false);
                }
              }}
              autoFocus
            />
            {query && (
              <button
                type="button"
                className="sms-filter-search-clear"
                onClick={() => setQuery("")}
                aria-label="נקה חיפוש"
              >
                ✕
              </button>
            )}
          </div>
          {visible.length > 0 && (
            <button
              type="button"
              className="sms-filter-toggle-all"
              onClick={toggleAllVisible}
              title={
                allVisibleSelected
                  ? "בטל סימון של כל ההתאמות"
                  : "סמן את כל ההתאמות"
              }
            >
              {allVisibleSelected
                ? `✓ בטל סימון של ${visible.length} ההתאמות`
                : `סמן את כל ${visible.length} ההתאמות`}
            </button>
          )}
          <ul
            className="sms-filter-list"
            role="listbox"
            aria-multiselectable="true"
          >
            {visible.length === 0 ? (
              <li className="sms-filter-empty">אין התאמות</li>
            ) : (
              visible.map((opt) => {
                const isChecked = selected.has(opt.value);
                return (
                  <li key={opt.value}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isChecked}
                      className={`sms-filter-row${isChecked ? " is-active" : ""}`}
                      onClick={() => toggleOne(opt.value)}
                    >
                      <span
                        className={`sms-filter-check${isChecked ? " is-checked" : ""}`}
                        aria-hidden
                      >
                        {isChecked ? "✓" : ""}
                      </span>
                      <span className="sms-filter-row-name" dir="auto">
                        {opt.value}
                      </span>
                      {typeof opt.count === "number" && opt.count > 0 && (
                        <span className="sms-filter-row-count">{opt.count}</span>
                      )}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
          {count > 0 && (
            <div className="sms-filter-footer">
              <button
                type="button"
                className="sms-filter-clear-all"
                onClick={clearAll}
              >
                נקה הכל ({count})
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
