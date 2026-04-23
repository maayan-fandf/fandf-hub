"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  currentKind: string; // "" | "comment" | "task"
  showResolved: boolean;
  counts: { all: number; comments: number; tasks: number };
  /** Distinct authors present in this project's visible feed. Built server-
   *  side so the dropdown reflects only people who've actually commented
   *  here. */
  authors: string[];
  /** Currently-selected author filter (full name or email). "" = all. */
  currentAuthor: string;
  /** Current text-search query. "" = none. Debounced locally before pushing. */
  currentQuery: string;
};

const Q_DEBOUNCE_MS = 240;

export default function TimelineFilterBar({
  currentKind,
  showResolved,
  counts,
  authors,
  currentAuthor,
  currentQuery,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Local mirror of the text-search input so typing feels instant; we push
  // to the URL on a short debounce so server-side re-render happens after
  // the user stops typing.
  const [query, setQuery] = useState(currentQuery);
  const debounceRef = useRef<number | null>(null);
  useEffect(() => {
    setQuery(currentQuery);
  }, [currentQuery]);

  const pushParams = useCallback(
    (mutate: (p: URLSearchParams) => void) => {
      const p = new URLSearchParams(searchParams.toString());
      mutate(p);
      const qs = p.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname, searchParams],
  );

  function updateParam(key: string, value: string | null) {
    pushParams((p) => {
      if (value === null || value === "") p.delete(key);
      else p.set(key, value);
    });
  }

  function onQueryChange(v: string) {
    setQuery(v);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      updateParam("q", v.trim() || null);
    }, Q_DEBOUNCE_MS);
  }

  function clearQuery() {
    setQuery("");
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    updateParam("q", null);
  }

  return (
    <div className="timeline-filter-bar">
      <div className="filter-bar">
        <button
          type="button"
          className={currentKind === "" ? "active" : ""}
          onClick={() => updateParam("kind", null)}
        >
          הכל <span className="count-inline">{counts.all}</span>
        </button>
        <button
          type="button"
          className={currentKind === "comment" ? "active" : ""}
          onClick={() => updateParam("kind", "comment")}
        >
          הערות <span className="count-inline">{counts.comments}</span>
        </button>
        <button
          type="button"
          className={currentKind === "task" ? "active" : ""}
          onClick={() => updateParam("kind", "task")}
        >
          משימות <span className="count-inline">{counts.tasks}</span>
        </button>
        <span className="filter-sep" />
        <button
          type="button"
          className={showResolved ? "active" : ""}
          onClick={() => updateParam("resolved", showResolved ? null : "1")}
        >
          {showResolved ? "מציג הכל" : "כולל סגורים"}
        </button>
      </div>

      <div className="timeline-filter-row">
        <div className="timeline-search">
          <span className="timeline-search-icon" aria-hidden>🔍</span>
          <input
            type="search"
            className="timeline-search-input"
            placeholder="חפש בטקסט ההערות…"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            aria-label="חיפוש טקסט בהערות"
          />
          {query && (
            <button
              type="button"
              className="timeline-search-clear"
              onClick={clearQuery}
              title="נקה חיפוש"
              aria-label="נקה חיפוש"
            >
              ✕
            </button>
          )}
        </div>
        <select
          className="inbox-project-select"
          value={currentAuthor}
          onChange={(e) => updateParam("author", e.target.value || null)}
          aria-label="סנן לפי מחבר"
        >
          <option value="">כל המשתתפים</option>
          {authors.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
