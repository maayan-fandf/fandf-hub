"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  value: string;
  onChange: (v: string) => void;
  /** Existing campaign names — already sorted newest-first by the API. */
  options: string[];
  placeholder?: string;
  disabled?: boolean;
  /** When set, shown above the dropdown panel as a small caption. */
  hint?: string;
};

/**
 * Combobox for the קמפיין field. Free-text-friendly (the user can type
 * a brand-new campaign name) but with a visible chevron + clickable
 * dropdown panel listing existing campaigns sorted newest-first.
 *
 * Native <input list="..."> was too easy to miss — Chrome only reveals
 * the chevron when you click into the field, and external users had no
 * idea options existed. This component makes the dropdown explicit.
 */
export default function CampaignCombobox({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  hint,
}: Props) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const trimmed = value.trim();
  const filtered = useMemo(() => {
    if (!trimmed) return options;
    const needle = trimmed.toLowerCase();
    return options.filter((o) => o.toLowerCase().includes(needle));
  }, [options, trimmed]);

  // Show a "create new" affordance when the typed value doesn't exactly
  // match any existing campaign. The form treats both the same on save —
  // this is purely UX feedback so the user knows their text is novel.
  const showCreateNew =
    trimmed.length > 0 &&
    !options.some((o) => o.toLowerCase() === trimmed.toLowerCase());

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Reset highlight when filter changes.
  useEffect(() => {
    setHighlight(-1);
  }, [trimmed, open]);

  // Scroll highlighted item into view.
  useEffect(() => {
    if (highlight < 0) return;
    const ul = listRef.current;
    if (!ul) return;
    const li = ul.querySelectorAll<HTMLLIElement>("li.combobox-option")[
      highlight
    ];
    if (li) li.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  function commit(v: string) {
    onChange(v);
    setOpen(false);
    setHighlight(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, -1));
    } else if (e.key === "Enter") {
      if (open && highlight >= 0 && filtered[highlight]) {
        e.preventDefault();
        commit(filtered[highlight]);
      } else {
        // Let the form submit naturally with whatever's typed.
        setOpen(false);
      }
    } else if (e.key === "Escape") {
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
        <input
          ref={inputRef}
          type="text"
          className="combobox-input"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => !disabled && setOpen(true)}
          onClick={() => !disabled && setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls="combobox-listbox"
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
          {hint && <div className="combobox-hint">{hint}</div>}
          <ul
            ref={listRef}
            id="combobox-listbox"
            role="listbox"
            className="combobox-list"
          >
            {showCreateNew && (
              <li
                role="option"
                aria-selected={false}
                className="combobox-option combobox-option-create"
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(trimmed);
                }}
              >
                <span className="combobox-option-icon">＋</span>
                <span>
                  צור קמפיין חדש: <strong>{trimmed}</strong>
                </span>
              </li>
            )}
            {filtered.length === 0 && !showCreateNew && (
              <li className="combobox-empty">אין קמפיינים קיימים בפרויקט זה</li>
            )}
            {filtered.map((opt, i) => (
              <li
                key={opt}
                role="option"
                aria-selected={highlight === i}
                className={`combobox-option${highlight === i ? " is-highlight" : ""}${
                  opt === value ? " is-selected" : ""
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(opt);
                }}
                onMouseEnter={() => setHighlight(i)}
              >
                <span className="combobox-option-icon">📁</span>
                <span className="combobox-option-text">{opt}</span>
                {i === 0 && options[0] === opt && !trimmed && (
                  <span className="combobox-option-tag">החדש ביותר</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
