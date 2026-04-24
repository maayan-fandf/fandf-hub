"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type FolderPickerValue =
  | { mode: "new"; name: string }
  | { mode: "existing"; folderId: string; folderName?: string };

type Props = {
  company: string;
  project: string;
  campaign: string;
  /** Name pre-filled into the "create new" input. Usually
   *  `<task-id> — <title>` so it matches the current auto-naming. */
  defaultNewName: string;
  value: FolderPickerValue;
  onChange: (v: FolderPickerValue) => void;
  /** When true the picker renders in a disabled / placeholder state.
   *  Expected when the create form doesn't have a project picked yet. */
  disabled?: boolean;
  /** Compact render for tight spaces (no outer title, slimmer padding). */
  compact?: boolean;
};

type Child = {
  id: string;
  name: string;
  modifiedTime: string;
  hasChildren: boolean;
};

type ChildrenState = Record<string, Child[] | "loading" | { error: string }>;

export default function DriveFolderPicker({
  company,
  project,
  campaign,
  defaultNewName,
  value,
  onChange,
  disabled,
  compact,
}: Props) {
  // Root folder ID at the campaign level. Null until resolve-campaign
  // returns; "error" carries the failure message for display.
  const [campaignFolder, setCampaignFolder] = useState<
    { id: string; viewUrl: string } | null | { error: string }
  >(null);
  const [resolving, setResolving] = useState(false);
  const [children, setChildren] = useState<ChildrenState>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState<string | null>(null); // parent id being created under
  const [newChildName, setNewChildName] = useState("");

  // Reset state when company/project/campaign change.
  const resolveKey = `${company}::${project}::${campaign}`;
  const lastKey = useRef<string>("");

  const resolveCampaign = useCallback(async () => {
    if (!project) {
      setCampaignFolder(null);
      return;
    }
    setResolving(true);
    try {
      const res = await fetch("/api/drive/folders/resolve-campaign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ company, project, campaign }),
      });
      const data = (await res.json()) as
        | { ok: true; folderId: string; viewUrl: string }
        | { ok: false; error: string };
      if (!res.ok || !data.ok) throw new Error(("error" in data && data.error) || `HTTP ${res.status}`);
      setCampaignFolder({ id: data.folderId, viewUrl: data.viewUrl });
    } catch (e) {
      setCampaignFolder({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setResolving(false);
    }
  }, [company, project, campaign]);

  useEffect(() => {
    if (disabled) return;
    if (lastKey.current === resolveKey) return;
    lastKey.current = resolveKey;
    setChildren({});
    setExpanded(new Set());
    void resolveCampaign();
  }, [resolveKey, disabled, resolveCampaign]);

  const loadChildren = useCallback(async (parentId: string) => {
    setChildren((c) => ({ ...c, [parentId]: "loading" }));
    try {
      const res = await fetch(
        `/api/drive/folders/children?parent=${encodeURIComponent(parentId)}`,
      );
      const data = (await res.json()) as
        | { ok: true; children: Child[] }
        | { ok: false; error: string };
      if (!res.ok || !data.ok) throw new Error(("error" in data && data.error) || `HTTP ${res.status}`);
      setChildren((c) => ({ ...c, [parentId]: data.children }));
    } catch (e) {
      setChildren((c) => ({
        ...c,
        [parentId]: { error: e instanceof Error ? e.message : String(e) },
      }));
    }
  }, []);

  // Load the campaign folder's immediate children once resolved.
  useEffect(() => {
    if (!campaignFolder || "error" in campaignFolder) return;
    if (children[campaignFolder.id] != null) return;
    void loadChildren(campaignFolder.id);
  }, [campaignFolder, children, loadChildren]);

  function toggleExpanded(id: string) {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) {
        n.delete(id);
      } else {
        n.add(id);
        if (children[id] == null) void loadChildren(id);
      }
      return n;
    });
  }

  async function createSubfolder(parentId: string) {
    const name = newChildName.trim();
    if (!name) return;
    try {
      const res = await fetch("/api/drive/folders/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parent: parentId, name }),
      });
      const data = (await res.json()) as
        | { ok: true; folder: { id: string; name: string; viewUrl: string } }
        | { ok: false; error: string };
      if (!res.ok || !data.ok) throw new Error(("error" in data && data.error) || `HTTP ${res.status}`);
      // Refresh the parent's child list + auto-select the new folder.
      setCreating(null);
      setNewChildName("");
      await loadChildren(parentId);
      onChange({
        mode: "existing",
        folderId: data.folder.id,
        folderName: data.folder.name,
      });
      // Expand the parent so the user sees the new row.
      setExpanded((s) => new Set(s).add(parentId));
    } catch (e) {
      setChildren((c) => ({
        ...c,
        [parentId]: { error: e instanceof Error ? e.message : String(e) },
      }));
    }
  }

  if (disabled) {
    return (
      <div className={`drive-folder-picker is-disabled${compact ? " is-compact" : ""}`}>
        <div className="drive-folder-hint">בחר פרויקט כדי לבחור תיקייה</div>
      </div>
    );
  }

  const rootId = campaignFolder && !("error" in campaignFolder) ? campaignFolder.id : null;
  const isNewMode = value.mode === "new";
  const selectedExistingId =
    value.mode === "existing" ? value.folderId : "";

  return (
    <div className={`drive-folder-picker${compact ? " is-compact" : ""}`}>
      {!compact && (
        <div className="drive-folder-head">
          <strong>תיקיית Drive</strong>
          <span className="drive-folder-subtle">
            בחר תיקייה קיימת או ייצור תיקייה חדשה
          </span>
        </div>
      )}

      {resolving && <div className="drive-folder-hint">טוען תיקיית קמפיין…</div>}

      {campaignFolder && "error" in campaignFolder && (
        <div className="drive-folder-error">
          שגיאה בטעינת תיקיית הקמפיין: {campaignFolder.error}
          <button
            type="button"
            className="drive-folder-link"
            onClick={() => void resolveCampaign()}
          >
            נסה שוב
          </button>
        </div>
      )}

      {rootId && (
        <>
          {/* Create-new row */}
          <label
            className={`drive-folder-row drive-folder-new${
              isNewMode ? " is-selected" : ""
            }`}
          >
            <input
              type="radio"
              name="drive-folder-mode"
              checked={isNewMode}
              onChange={() => onChange({ mode: "new", name: defaultNewName })}
            />
            <span className="drive-folder-icon">➕</span>
            <input
              type="text"
              className="drive-folder-new-name"
              value={isNewMode ? value.name : defaultNewName}
              onChange={(e) =>
                onChange({ mode: "new", name: e.target.value })
              }
              onFocus={() =>
                !isNewMode &&
                onChange({ mode: "new", name: defaultNewName })
              }
              placeholder="שם תיקייה חדשה"
            />
          </label>

          <div className="drive-folder-tree">
            {renderBranch(rootId, 0)}
          </div>
        </>
      )}
    </div>
  );

  function renderBranch(parentId: string, depth: number): React.ReactNode {
    const state = children[parentId];
    if (state === "loading") {
      return <div className="drive-folder-hint indent" data-depth={depth}>טוען…</div>;
    }
    if (state && "error" in state) {
      return (
        <div className="drive-folder-error indent" data-depth={depth}>
          {state.error}
          <button
            type="button"
            className="drive-folder-link"
            onClick={() => void loadChildren(parentId)}
          >
            נסה שוב
          </button>
        </div>
      );
    }
    const items = Array.isArray(state) ? state : [];

    return (
      <ul className="drive-folder-ul">
        {/* Inline "+ new subfolder here" input (shown only when creating=parentId). */}
        {creating === parentId && (
          <li className="drive-folder-li drive-folder-creating" data-depth={depth}>
            <input
              autoFocus
              type="text"
              value={newChildName}
              onChange={(e) => setNewChildName(e.target.value)}
              placeholder="שם תיקייה חדשה"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void createSubfolder(parentId);
                } else if (e.key === "Escape") {
                  setCreating(null);
                  setNewChildName("");
                }
              }}
            />
            <button
              type="button"
              className="drive-folder-btn"
              onClick={() => void createSubfolder(parentId)}
            >
              צור
            </button>
            <button
              type="button"
              className="drive-folder-btn-ghost"
              onClick={() => {
                setCreating(null);
                setNewChildName("");
              }}
            >
              בטל
            </button>
          </li>
        )}

        {items.length === 0 && creating !== parentId && (
          <li className="drive-folder-li drive-folder-empty" data-depth={depth}>
            <span className="drive-folder-hint">אין תיקיות — תוכל ליצור חדשה</span>
            <button
              type="button"
              className="drive-folder-btn-ghost"
              onClick={() => {
                setCreating(parentId);
                setNewChildName("");
              }}
            >
              + תיקייה כאן
            </button>
          </li>
        )}

        {items.map((f) => {
          const isSelected = selectedExistingId === f.id;
          const isOpen = expanded.has(f.id);
          return (
            <li key={f.id} className="drive-folder-li" data-depth={depth}>
              <div
                className={`drive-folder-row${isSelected ? " is-selected" : ""}`}
              >
                <input
                  type="radio"
                  name="drive-folder-mode"
                  checked={isSelected}
                  onChange={() =>
                    onChange({
                      mode: "existing",
                      folderId: f.id,
                      folderName: f.name,
                    })
                  }
                />
                <button
                  type="button"
                  className="drive-folder-chevron"
                  aria-label={isOpen ? "סגור" : "פתח"}
                  onClick={() => toggleExpanded(f.id)}
                  disabled={!f.hasChildren}
                >
                  {f.hasChildren ? (isOpen ? "▾" : "▸") : ""}
                </button>
                <span className="drive-folder-icon">📁</span>
                <button
                  type="button"
                  className="drive-folder-name"
                  onClick={() =>
                    onChange({
                      mode: "existing",
                      folderId: f.id,
                      folderName: f.name,
                    })
                  }
                >
                  {f.name}
                </button>
              </div>
              {isOpen && <div className="drive-folder-sub">{renderBranch(f.id, depth + 1)}</div>}
            </li>
          );
        })}

        {/* "+ add subfolder here" action — shown once per level, below children. */}
        {items.length > 0 && creating !== parentId && (
          <li className="drive-folder-li drive-folder-add" data-depth={depth}>
            <button
              type="button"
              className="drive-folder-btn-ghost"
              onClick={() => {
                setCreating(parentId);
                setNewChildName("");
              }}
            >
              + תיקייה משנה
            </button>
          </li>
        )}
      </ul>
    );
  }
}
