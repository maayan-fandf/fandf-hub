"use client";

import { useEffect, useState } from "react";

/**
 * Interactive "first hour" checklist for /onboarding. Each item is a
 * real action the new hire performs in the Hub; checking it persists
 * to localStorage so progress survives refreshes and return visits.
 *
 * Deliberately localStorage (not server prefs): the checklist is a
 * personal learning aid, not tracked state — no API surface, no
 * privacy questions, works before the user appears in any roster.
 *
 * Methodology note (2026-06-12 guide rebuild): the guide moved from
 * "read about features" to "do these actions" — doing beats reading
 * for retention, and the checklist is the doing part.
 */

export type ChecklistItem = {
  id: string;
  /** Rich label — rendered as-is (may contain <kbd>, links). */
  label: React.ReactNode;
};

const STORAGE_KEY = "hub_onboarding_checklist_v1";

function loadDone(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export default function OnboardingChecklist({
  items,
}: {
  items: ChecklistItem[];
}) {
  // null until hydrated — avoids a server/client checked-state mismatch.
  const [done, setDone] = useState<Set<string> | null>(null);

  useEffect(() => {
    setDone(loadDone());
  }, []);

  const toggle = (id: string) => {
    setDone((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        /* storage full/blocked — checklist still works in-memory */
      }
      return next;
    });
  };

  const doneCount = done ? items.filter((i) => done.has(i.id)).length : 0;
  const allDone = done !== null && doneCount === items.length;

  return (
    <div className="onb-checklist" data-all-done={allDone || undefined}>
      <div className="onb-checklist-progress" aria-live="polite">
        {allDone ? (
          <span className="onb-checklist-done-msg">
            🎉 סיימת את השעה הראשונה — מכאן והלאה ה-Hub כבר ירגיש כמו בית.
          </span>
        ) : (
          <>
            <span className="onb-checklist-count">
              {doneCount}/{items.length}
            </span>
            <span className="onb-checklist-bar" aria-hidden>
              <span
                className="onb-checklist-bar-fill"
                style={{ width: `${(doneCount / items.length) * 100}%` }}
              />
            </span>
          </>
        )}
      </div>
      <ol className="onb-checklist-items">
        {items.map((item) => {
          const checked = done?.has(item.id) ?? false;
          return (
            <li key={item.id} data-checked={checked || undefined}>
              <label>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(item.id)}
                  disabled={done === null}
                />
                <span className="onb-checklist-label">{item.label}</span>
              </label>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
