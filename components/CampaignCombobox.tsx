"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  value: string;
  onChange: (v: string) => void;
  /** Existing campaign names — already sorted newest-first by the API.
   *  Sourced from `/api/tasks/campaigns` which now lists Drive folders
   *  under `<company>/<project>/` as the canonical menu. */
  options: string[];
  /** Project name — required for the create/rename API calls. When
   *  absent, the combobox stays read-only (no create/rename buttons
   *  surface). */
  project?: string;
  placeholder?: string;
  disabled?: boolean;
  /** When set, shown above the dropdown panel as a small caption. */
  hint?: string;
  /** Fired after a successful create or rename so the parent can
   *  refetch the options list. The combobox doesn't own that state. */
  onOptionsChanged?: () => void;
};

/**
 * Combobox for the קמפיין field. Free-text-friendly (the user can type
 * a brand-new campaign name) but with a visible chevron + clickable
 * dropdown panel listing existing campaigns sorted newest-first.
 *
 * Drive integration (added 2026-04-27):
 *   - Picking "+ צור קמפיין חדש: X" calls /api/campaigns/create which
 *     materializes the Drive folder upfront. The form's later save
 *     finds the folder already there (idempotent ensure) so no folder
 *     duplication.
 *   - Each existing option carries a ✏️ trigger that flips the row
 *     into rename mode. Submit → /api/campaigns/rename which renames
 *     the Drive folder AND bulk-updates every task row referencing
 *     the old name in this project. Drive ↔ hub stays synced.
 */
export default function CampaignCombobox({
  value,
  onChange,
  options,
  project,
  placeholder,
  disabled,
  hint,
  onOptionsChanged,
}: Props) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const trimmed = value.trim();
  const filtered = useMemo(() => {
    if (!trimmed) return options;
    // When the input value matches an existing option exactly, the user
    // is "settled" on a campaign — opening the dropdown should show all
    // options so they can switch to a different one without first
    // clearing the field. Only filter when the input is a partial query
    // that doesn't match any single option.
    const lc = trimmed.toLowerCase();
    if (options.some((o) => o.toLowerCase() === lc)) return options;
    return options.filter((o) => o.toLowerCase().includes(lc));
  }, [options, trimmed]);

  // Show a "create new" affordance when the typed value doesn't exactly
  // match any existing campaign. Picking it calls /api/campaigns/create
  // before commit so the Drive folder lands upfront.
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

  // Focus the rename input when entering rename mode.
  useEffect(() => {
    if (renamingName == null) return;
    requestAnimationFrame(() => {
      const el = renameInputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(0, el.value.length);
    });
  }, [renamingName]);

  function commit(v: string) {
    onChange(v);
    setOpen(false);
    setHighlight(-1);
    setErr(null);
  }

  async function commitNew(name: string) {
    if (!project) {
      // Without a project, can't create a Drive folder — fall back to
      // text-only commit. The form save will still try to materialize
      // the folder via ensureCampaignFolderId.
      commit(name);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/campaigns/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, name }),
      });
      const data = (await res.json()) as
        | { ok: true; folder: { name: string } }
        | { ok: false; error: string };
      if (!res.ok || !data.ok) {
        throw new Error("error" in data ? data.error : "Create failed");
      }
      commit(data.folder.name);
      onOptionsChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function commitRename(fromName: string) {
    const toName = renameDraft.trim();
    if (!toName || toName === fromName) {
      setRenamingName(null);
      setRenameDraft("");
      return;
    }
    if (!project) {
      setErr("Project is required to rename");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/campaigns/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, fromName, toName }),
      });
      const data = (await res.json()) as
        | { ok: true; taskCount: number }
        | { ok: false; error: string };
      if (!res.ok || !data.ok) {
        throw new Error("error" in data ? data.error : "Rename failed");
      }
      // If the user was on this campaign, follow the rename so the
      // form's selected value stays in sync with the menu.
      if (value === fromName) onChange(toName);
      setRenamingName(null);
      setRenameDraft("");
      onOptionsChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
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

  function onRenameKeyDown(
    e: React.KeyboardEvent<HTMLInputElement>,
    fromName: string,
  ) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename(fromName);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setRenamingName(null);
      setRenameDraft("");
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
          disabled={disabled || busy}
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
          {err && (
            <div className="combobox-error" role="alert">
              {err}
            </div>
          )}
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
                className={`combobox-option combobox-option-create${busy ? " is-busy" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (busy) return;
                  commitNew(trimmed);
                }}
              >
                <span className="combobox-option-icon">＋</span>
                <span>
                  {busy ? (
                    <>יוצר קמפיין…</>
                  ) : (
                    <>
                      צור קמפיין חדש: <strong>{trimmed}</strong>
                    </>
                  )}
                </span>
              </li>
            )}
            {filtered.length === 0 && !showCreateNew && (
              <li className="combobox-empty">אין קמפיינים קיימים בפרויקט זה</li>
            )}
            {filtered.map((opt, i) => {
              const isRenaming = renamingName === opt;
              return (
                <li
                  key={opt}
                  role="option"
                  aria-selected={highlight === i}
                  className={`combobox-option${highlight === i ? " is-highlight" : ""}${
                    opt === value ? " is-selected" : ""
                  }${isRenaming ? " is-renaming" : ""}`}
                  onMouseDown={(e) => {
                    if (isRenaming) {
                      // Don't commit when interacting with the rename
                      // input — let the input handle clicks itself.
                      return;
                    }
                    e.preventDefault();
                    commit(opt);
                  }}
                  onMouseEnter={() => !isRenaming && setHighlight(i)}
                >
                  <span className="combobox-option-icon">📁</span>
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      type="text"
                      className="combobox-rename-input"
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => onRenameKeyDown(e, opt)}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={() => {
                        // Blur cancels unless Enter triggered the commit
                        // first. Without this, clicking the row to commit
                        // a different option would race.
                        setRenamingName((cur) => (cur === opt ? null : cur));
                      }}
                      disabled={busy}
                      aria-label={`שם חדש לקמפיין ${opt}`}
                    />
                  ) : (
                    <span className="combobox-option-text">{opt}</span>
                  )}
                  {!isRenaming && i === 0 && options[0] === opt && !trimmed && (
                    <span className="combobox-option-tag">החדש ביותר</span>
                  )}
                  {!isRenaming && project && (
                    <button
                      type="button"
                      className="combobox-option-rename"
                      title="שנה שם קמפיין (כולל בדרייב)"
                      aria-label={`שנה שם לקמפיין ${opt}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setRenamingName(opt);
                        setRenameDraft(opt);
                      }}
                    >
                      ✏️
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
