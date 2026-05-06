"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { TasksPerson } from "@/lib/appsScript";
import { displayNameOf } from "@/lib/personDisplay";
import Avatar from "./Avatar";
import RoleChip from "./RoleChip";

type Props = {
  /** CSV of selected emails — parsed for display, written back via
   *  onChange whenever the selection changes. Free-text emails (typed
   *  by hand for users not in the names-to-emails sheet) round-trip
   *  unchanged. */
  value: string;
  onChange: (csv: string) => void;
  options: TasksPerson[];
  placeholder?: string;
  disabled?: boolean;
};

/**
 * Multi-select sibling of `PersonCombobox`. Same visual chrome
 * (`.combobox` / `.combobox-input-wrap`) so the assignees field on
 * /tasks/new + /tasks/[id]?edit=1 reads the same as the single-person
 * fields beside it (גורם מאשר, מנהל פרויקט).
 *
 * Reported by Maayan 2026-05-06 — the previous textarea showed raw
 * emails (`felix@fandf.co.il, nadav@fandf.co.il`) which clashed with
 * the Hebrew naming used everywhere else in the form.
 *
 * Selected people render as removable chips INSIDE the box; the
 * unselected typeahead input lives after them so a click anywhere on
 * the box jumps focus to typing. Backspace on empty input removes
 * the last chip — standard chip-input convention. Free-text entry
 * stays supported via Enter / comma when the typed value isn't a
 * known person (admins still need to add new emails on the fly).
 *
 * The store-format is a CSV string (matches the textarea this
 * replaces) so the surrounding form doesn't need to change.
 */
export default function PeopleMultiCombobox({
  value,
  onChange,
  options,
  placeholder,
  disabled,
}: Props) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Parse CSV → distinct, lower-cased-deduped order. Keeps original
  // casing for display but the dedupe key is lower so re-adding
  // "Felix@..." after "felix@..." is a no-op.
  const emails = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of value.split(/[,;\n]/)) {
      const t = raw.trim();
      if (!t) continue;
      const lc = t.toLowerCase();
      if (seen.has(lc)) continue;
      seen.add(lc);
      out.push(t);
    }
    return out;
  }, [value]);
  const lcSet = useMemo(
    () => new Set(emails.map((e) => e.toLowerCase())),
    [emails],
  );

  // Filter options: hide already-selected, narrow by typed search
  // matching email, English name, OR Hebrew name (he_name on the
  // person record).
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return options.filter((p) => {
      if (lcSet.has(p.email.toLowerCase())) return false;
      if (!needle) return true;
      return (
        p.email.toLowerCase().includes(needle) ||
        (p.name || "").toLowerCase().includes(needle) ||
        (p.he_name || "").toLowerCase().includes(needle)
      );
    });
  }, [options, search, lcSet]);

  // Highlight a typed-but-not-in-list email-shaped string as a
  // "use as-is" affordance. Mirrors PersonCombobox's `isFreeText`.
  const isFreeText =
    search.trim().length > 0 &&
    search.includes("@") &&
    !options.some((o) => o.email.toLowerCase() === search.trim().toLowerCase());

  // Close on outside click. Same pattern as PersonCombobox.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Reset highlight whenever the candidate list shape changes.
  useEffect(() => {
    setHighlight(-1);
  }, [search, open, emails.length]);

  // Keep the highlighted option in view as the user arrows through.
  useEffect(() => {
    if (highlight < 0) return;
    const ul = listRef.current;
    if (!ul) return;
    const li = ul.querySelectorAll<HTMLLIElement>("li.combobox-option")[
      highlight
    ];
    if (li) li.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  function commitCsv(next: string[]) {
    onChange(next.join(", "));
  }

  function addEmail(rawEmail: string) {
    const e = rawEmail.trim();
    if (!e) return;
    if (lcSet.has(e.toLowerCase())) {
      // Already selected — just clear the search box, don't error.
      setSearch("");
      return;
    }
    commitCsv([...emails, e]);
    setSearch("");
    setHighlight(-1);
    inputRef.current?.focus();
  }

  function removeEmail(email: string) {
    const lc = email.toLowerCase();
    commitCsv(emails.filter((e) => e.toLowerCase() !== lc));
    inputRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && search === "" && emails.length > 0) {
      e.preventDefault();
      removeEmail(emails[emails.length - 1]);
      return;
    }
    if (e.key === "Enter" || e.key === ",") {
      // Comma + Enter both commit. The user's instinct on a "list of
      // people" field is to type-comma-type so we honor that even
      // without an autocomplete match.
      if (open && highlight >= 0 && filtered[highlight]) {
        e.preventDefault();
        addEmail(filtered[highlight].email);
      } else if (search.trim()) {
        e.preventDefault();
        addEmail(search);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, -1));
      return;
    }
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  }

  return (
    <div
      ref={wrapRef}
      className={`combobox${disabled ? " is-disabled" : ""}${open ? " is-open" : ""}`}
    >
      <div className="combobox-input-wrap">
        {/* Pure search input — visually identical to PersonCombobox.
            Selected people live ONLY in the bubble row below the
            field, never inside this wrap. The previous chip-inside-
            box rendering made the field disagree visually with its
            single-person siblings (גורם מאשר / מנהל פרויקט) on the
            same row; reported by Maayan 2026-05-06. The bubble row
            already gives the user a clear "who's selected" signal
            via its is-active state, so re-rendering chips here was
            redundant on top of being a visual mismatch. */}
        <input
          ref={inputRef}
          type="text"
          className="combobox-input"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => !disabled && setOpen(true)}
          onClick={() => !disabled && setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          aria-autocomplete="list"
          aria-expanded={open}
          role="combobox"
        />
        <button
          type="button"
          tabIndex={-1}
          className="combobox-chevron"
          aria-label={open ? "סגור" : "פתח"}
          onClick={(e) => {
            e.preventDefault();
            if (disabled) return;
            setOpen((v) => !v);
            inputRef.current?.focus();
          }}
        >
          ▾
        </button>
      </div>

      {open && !disabled && (
        <div className="combobox-panel">
          <ul ref={listRef} className="combobox-list" role="listbox">
            {filtered.length === 0 && !isFreeText && (
              <li className="combobox-empty">
                {emails.length === options.length
                  ? "כל האנשים כבר נבחרו"
                  : "לא נמצאו אנשים תואמים"}
              </li>
            )}
            {filtered.map((p, i) => (
              <li
                key={p.email}
                role="option"
                aria-selected={highlight === i}
                className={`combobox-option${highlight === i ? " is-highlight" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  addEmail(p.email);
                }}
                onMouseEnter={() => setHighlight(i)}
              >
                <span className="combobox-option-icon">
                  <Avatar name={p.email} size={22} />
                </span>
                <span className="combobox-option-text">
                  <span>{displayNameOf(p) || p.email}</span>
                  {p.role && <RoleChip role={p.role} />}
                </span>
                <span className="combobox-option-tag" dir="ltr">
                  {p.email}
                </span>
              </li>
            ))}
            {isFreeText && (
              <li
                className="combobox-option combobox-option-create"
                onMouseDown={(e) => {
                  e.preventDefault();
                  addEmail(search);
                }}
              >
                <span className="combobox-option-icon">＋</span>
                <span>
                  הוסף כתובת:{" "}
                  <strong dir="ltr">{search.trim()}</strong>
                </span>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
