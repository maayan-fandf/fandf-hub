"use client";

import { useEffect, useState } from "react";

type Shortcut = { keys: string[]; desc: string };

/**
 * Opens on `?` (Shift+/). Shows the keyboard cheatsheet modal.
 * Closes on Esc, click-outside, or another `?`.
 *
 * All descriptions are Hebrew to match the app's UI language.
 */
const SHORTCUTS: Shortcut[] = [
  { keys: ["⌘", "K"], desc: "פתח לוח הפקודות" },
  { keys: ["Ctrl", "K"], desc: "פתח לוח הפקודות (Windows / Linux)" },
  { keys: ["/"], desc: "פתח חיפוש" },
  { keys: ["g", "p"], desc: "מעבר לפרויקטים" },
  { keys: ["g", "i"], desc: "מעבר לתיוגים" },
  { keys: ["g", "n"], desc: "פתח הערה אישית חדשה" },
  { keys: ["Ctrl/⌘", "Shift", "M"], desc: "פתח הערה אישית חדשה" },
  { keys: ["?"], desc: "פתח עזרה זו" },
  { keys: ["Esc"], desc: "סגור חלון קופץ" },
  { keys: ["⌘/Ctrl", "Enter"], desc: "שלח תגובה או משימה חדשה" },
];

export default function KeyboardHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const active = document.activeElement;
      const typing =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable);
      if (typing) return;

      // Shift+/ on US layout produces "?". Some layouts send just "?" directly.
      if (e.key === "?" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="help-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="help-modal" role="dialog" aria-modal="true">
        <div className="help-head">
          <h2>קיצורי מקלדת</h2>
          <button
            type="button"
            className="create-task-close"
            onClick={() => setOpen(false)}
            aria-label="סגור"
          >
            ×
          </button>
        </div>
        <ul className="help-list">
          {SHORTCUTS.map((s, i) => (
            <li key={i} className="help-item">
              <span className="help-keys">
                {s.keys.map((k, j) => (
                  <kbd key={j}>{k}</kbd>
                ))}
              </span>
              <span className="help-desc">{s.desc}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
