"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { TasksPerson } from "@/lib/appsScript";
import { displayNameOf } from "@/lib/personDisplay";
import Avatar from "./Avatar";
import RoleChip from "./RoleChip";

type Props = {
  /** Currently selected email (free-text allowed for people not in the list). */
  value: string;
  onChange: (email: string) => void;
  options: TasksPerson[];
  /** Optional role filter — when set, only people whose `role` matches
   *  any of these strings appear at the top. Other people are still
   *  shown below a divider so admins can still pick anyone. */
  roleFilter?: string[];
  placeholder?: string;
  disabled?: boolean;
  hint?: string;
};

/**
 * Combobox for the gorem-measher / project-manager fields. Same shape
 * as `CampaignCombobox` but tailored to people — typeahead matches on
 * BOTH name and email, the dropdown shows name + role + email, and the
 * selected value is the email.
 *
 * Free-text entry stays supported (admins occasionally need to enter
 * an email that isn't in the names-to-emails sheet yet).
 */
export default function PersonCombobox({
  value,
  onChange,
  options,
  roleFilter,
  placeholder,
  disabled,
  hint,
}: Props) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  // Dropdown direction. Default opens DOWN (most callers have plenty of
  // space below). When the input is near the viewport bottom — e.g. on
  // the sticky TasksBulkBar at the foot of /tasks — the panel would
  // overflow off-screen with most rows hidden behind it. We flip to
  // open UPWARD in that case. Recomputed on every `open` transition so
  // a scrolled-into-view input gets the right direction without a
  // resize/scroll listener. Reported by Maayan 2026-05-12.
  const [flipUp, setFlipUp] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const trimmed = value.trim();

  // Filter + split into "matching role" / "everyone else" so the
  // department-narrowed list is visually grouped.
  const { primary, secondary } = useMemo(() => {
    const needle = trimmed.toLowerCase();
    const matchesText = (p: TasksPerson) =>
      !needle ||
      p.email.toLowerCase().includes(needle) ||
      (p.name || "").toLowerCase().includes(needle) ||
      (p.he_name || "").toLowerCase().includes(needle);
    const inRole = (p: TasksPerson) =>
      !roleFilter ||
      roleFilter.length === 0 ||
      roleFilter.some(
        (r) => (p.role || "").toLowerCase() === r.toLowerCase(),
      );
    const matched = options.filter(matchesText);
    if (!roleFilter || roleFilter.length === 0) {
      return { primary: matched, secondary: [] as TasksPerson[] };
    }
    return {
      primary: matched.filter(inRole),
      secondary: matched.filter((p) => !inRole(p)),
    };
  }, [options, trimmed, roleFilter]);

  const flat = useMemo(() => [...primary, ...secondary], [primary, secondary]);

  // Highlight a typed-but-not-in-list email as a "use as-is" affordance.
  const isFreeText =
    trimmed.length > 0 &&
    !options.some((o) => o.email.toLowerCase() === trimmed.toLowerCase());

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Pick dropdown direction on open. ~320px matches the panel's
  // max-height in globals.css; if below has less than that AND above
  // has more, flip up. Otherwise leave it pointing down (the default
  // behavior for the vast majority of call sites — task form, project
  // page filters, etc.).
  useEffect(() => {
    if (!open) return;
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const PANEL_MAX = 320;
    const below = window.innerHeight - rect.bottom;
    const above = rect.top;
    setFlipUp(below < PANEL_MAX && above > below);
  }, [open]);

  useEffect(() => {
    setHighlight(-1);
  }, [trimmed, open]);

  useEffect(() => {
    if (highlight < 0) return;
    const ul = listRef.current;
    if (!ul) return;
    const li = ul.querySelectorAll<HTMLLIElement>("li.combobox-option")[
      highlight
    ];
    if (li) li.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  function commit(email: string) {
    onChange(email);
    setOpen(false);
    setHighlight(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setHighlight((h) => Math.min(h + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, -1));
    } else if (e.key === "Enter") {
      if (open && highlight >= 0 && flat[highlight]) {
        e.preventDefault();
        commit(flat[highlight].email);
      } else {
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  }

  // Resolve a display label for the typed value when it matches a known
  // person (so the input shows email but the user sees the name in the
  // selected indicator).
  const matchedPerson = options.find(
    (p) => p.email.toLowerCase() === trimmed.toLowerCase(),
  );

  return (
    <div
      ref={wrapRef}
      className={`combobox${disabled ? " is-disabled" : ""}${open ? " is-open" : ""}${
        open && flipUp ? " is-flipped-up" : ""
      }`}
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
          aria-controls="person-combobox-listbox"
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
      {matchedPerson && !open && (
        <div className="combobox-selected-name" dir="auto">
          {matchedPerson.name}
          {matchedPerson.role ? ` · ${matchedPerson.role}` : ""}
        </div>
      )}

      {open && !disabled && (
        <div className="combobox-panel">
          {hint && <div className="combobox-hint">{hint}</div>}
          <ul
            ref={listRef}
            id="person-combobox-listbox"
            role="listbox"
            className="combobox-list"
          >
            {primary.length === 0 && secondary.length === 0 && !isFreeText && (
              <li className="combobox-empty">לא נמצאו אנשים תואמים</li>
            )}
            {primary.map((p, i) => (
              <li
                key={p.email}
                role="option"
                aria-selected={highlight === i}
                className={`combobox-option${highlight === i ? " is-highlight" : ""}${
                  p.email.toLowerCase() === trimmed.toLowerCase()
                    ? " is-selected"
                    : ""
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(p.email);
                }}
                onMouseEnter={() => setHighlight(i)}
              >
                <span className="combobox-option-icon">
                  <Avatar
                    name={p.email}
                    title={displayNameOf(p) || p.email}
                    role={p.role}
                    size={22}
                  />
                </span>
                <span className="combobox-option-text">
                  <span>{displayNameOf(p) || p.email}</span>
                  {p.role && <RoleChip role={p.role} />}
                </span>
              </li>
            ))}
            {secondary.length > 0 && (
              <li className="combobox-divider" aria-hidden>
                שאר האנשים
              </li>
            )}
            {secondary.map((p, i) => {
              const idx = primary.length + i;
              return (
                <li
                  key={p.email}
                  role="option"
                  aria-selected={highlight === idx}
                  className={`combobox-option combobox-option-secondary${
                    highlight === idx ? " is-highlight" : ""
                  }${
                    p.email.toLowerCase() === trimmed.toLowerCase()
                      ? " is-selected"
                      : ""
                  }`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commit(p.email);
                  }}
                  onMouseEnter={() => setHighlight(idx)}
                >
                  <span className="combobox-option-icon">👤</span>
                  <span className="combobox-option-text">
                    <span>{displayNameOf(p) || p.email}</span>
                    {p.role && (
                      <span className="combobox-option-meta"> · {p.role}</span>
                    )}
                  </span>
                </li>
              );
            })}
            {isFreeText && (
              <li
                className="combobox-option combobox-option-create"
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(trimmed);
                }}
              >
                <span className="combobox-option-icon">＋</span>
                <span>
                  השתמש בכתובת: <strong dir="ltr">{trimmed}</strong>
                </span>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
