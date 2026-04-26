"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type FolderPickerValue =
  | { mode: "new"; name: string }
  | { mode: "existing"; folderId: string; folderName?: string };

type Props = {
  company: string;
  project: string;
  campaign: string;
  defaultNewName: string;
  value: FolderPickerValue;
  onChange: (v: FolderPickerValue) => void;
  /** Notifies the parent whether the campaign folder already exists in
   *  Drive ("exists"), is missing and will be auto-created on save
   *  ("missing"), or hasn't been resolved yet (no callback fired).
   *  Lets the parent tweak its UX — e.g. default the new-folder name
   *  to the campaign name when no campaign folder exists yet. */
  onCampaignFolderState?: (state: "exists" | "missing") => void;
  disabled?: boolean;
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
  onCampaignFolderState,
  disabled,
  compact,
}: Props) {
  type CampaignState =
    | null
    | { id: string; viewUrl: string }
    | { pending: true }
    | { error: string };
  const [campaignFolder, setCampaignFolder] = useState<CampaignState>(null);
  const [resolving, setResolving] = useState(false);
  const [children, setChildren] = useState<ChildrenState>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState<string | null>(null);
  const [newChildName, setNewChildName] = useState("");
  // In-flight guard for createSubfolder. Without this, a fast user that
  // either double-clicks "צור" or hits Enter twice (or one of each)
  // before the API resolves ends up creating two identical folders in
  // Drive — confirmed bug 2026-04-25 (see screenshot in this session).
  const [submittingNew, setSubmittingNew] = useState(false);
  const lastNewName = useRef<string>(value.mode === "new" ? value.name : "");

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
        | { ok: true; folderId: string | null; viewUrl: string | null }
        | { ok: false; error: string };
      if (!res.ok || !("ok" in data) || !data.ok) {
        throw new Error(("error" in data && data.error) || `HTTP ${res.status}`);
      }
      if (data.folderId && data.viewUrl) {
        setCampaignFolder({ id: data.folderId, viewUrl: data.viewUrl });
        onCampaignFolderState?.("exists");
      } else {
        setCampaignFolder({ pending: true });
        onCampaignFolderState?.("missing");
      }
    } catch (e) {
      setCampaignFolder({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setResolving(false);
    }
  }, [company, project, campaign, onCampaignFolderState]);

  useEffect(() => {
    if (disabled) return;
    if (lastKey.current === resolveKey) return;
    lastKey.current = resolveKey;
    setChildren({});
    setExpanded(new Set());
    const handle = setTimeout(() => {
      void resolveCampaign();
    }, 350);
    return () => clearTimeout(handle);
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

  useEffect(() => {
    if (!campaignFolder) return;
    if ("error" in campaignFolder || "pending" in campaignFolder) return;
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
    if (submittingNew) return; // in-flight guard — see useState comment
    setSubmittingNew(true);
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
      setCreating(null);
      setNewChildName("");
      await loadChildren(parentId);
      onChange({
        mode: "existing",
        folderId: data.folder.id,
        folderName: data.folder.name,
      });
      setExpanded((s) => new Set(s).add(parentId));
    } catch (e) {
      setChildren((c) => ({
        ...c,
        [parentId]: { error: e instanceof Error ? e.message : String(e) },
      }));
    } finally {
      setSubmittingNew(false);
    }
  }

  if (disabled) {
    return (
      <div className={`drive-folder-picker is-disabled${compact ? " is-compact" : ""}`}>
        <div className="drive-folder-hint">בחר פרויקט כדי לבחור תיקייה</div>
      </div>
    );
  }

  const rootId =
    campaignFolder && !("error" in campaignFolder) && !("pending" in campaignFolder)
      ? campaignFolder.id
      : null;
  const isPending = !!campaignFolder && "pending" in campaignFolder;
  const mode = value.mode;
  const selectedExistingId =
    value.mode === "existing" ? value.folderId : "";
  const selectedExistingName =
    value.mode === "existing" ? value.folderName || "" : "";

  if (value.mode === "new" && value.name) {
    lastNewName.current = value.name;
  }

  function switchMode(target: "new" | "existing") {
    if (target === mode) return;
    if (target === "new") {
      onChange({
        mode: "new",
        name: lastNewName.current || defaultNewName,
      });
    } else {
      onChange({ mode: "existing", folderId: "", folderName: "" });
    }
  }

  const contextLabel = campaign
    ? `תחת קמפיין: ${campaign}`
    : `תחת פרויקט: ${project || "—"}`;

  return (
    <div className={`drive-folder-picker${compact ? " is-compact" : ""}`}>
      {!compact && (
        <div className="drive-folder-head">
          <strong>תיקיית Drive</strong>
        </div>
      )}

      <div
        className="drive-folder-mode-switch"
        role="radiogroup"
        aria-label="בחר תיקייה"
      >
        <button
          type="button"
          role="radio"
          aria-checked={mode === "new"}
          className={`drive-folder-mode-btn${mode === "new" ? " is-active" : ""}`}
          onClick={() => switchMode("new")}
        >
          <span className="drive-folder-mode-icon">➕</span>
          תיקייה חדשה
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === "existing"}
          className={`drive-folder-mode-btn${mode === "existing" ? " is-active" : ""}`}
          onClick={() => switchMode("existing")}
        >
          <span className="drive-folder-mode-icon">📁</span>
          השתמש בקיימת
        </button>
      </div>

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

      {mode === "new" && (
        <div className="drive-folder-new-block">
          <label className="drive-folder-new-label">
            <span className="drive-folder-new-label-text">שם התיקייה החדשה</span>
            <input
              type="text"
              className="drive-folder-new-name"
              value={value.mode === "new" ? value.name : ""}
              onChange={(e) =>
                onChange({ mode: "new", name: e.target.value })
              }
              placeholder={defaultNewName || "שם תיקייה חדשה"}
            />
          </label>
          <div className="drive-folder-context">
            תיווצר {contextLabel}
            {isPending && " (התיקייה תיפתח אוטומטית בעת שמירה)"}
          </div>
        </div>
      )}

      {mode === "existing" && (
        <div className="drive-folder-existing-block">
          {isPending && (
            <div className="drive-folder-hint">
              עדיין אין תיקיית קמפיין — אין מה לבחור. עבור ל&quot;תיקייה חדשה&quot; או שמור עם הטקסט המוצע.
            </div>
          )}
          {rootId && (
            <>
              <div className="drive-folder-breadcrumb">
                <span className="drive-folder-breadcrumb-root">📂 Drive</span>
                {company && (
                  <>
                    <span className="drive-folder-breadcrumb-sep">›</span>
                    <span>{company}</span>
                  </>
                )}
                {project && (
                  <>
                    <span className="drive-folder-breadcrumb-sep">›</span>
                    <span>{project}</span>
                  </>
                )}
                {campaign && (
                  <>
                    <span className="drive-folder-breadcrumb-sep">›</span>
                    <span className="drive-folder-breadcrumb-current">{campaign}</span>
                  </>
                )}
              </div>
              <div className="drive-folder-tree">
                <div
                  role="button"
                  tabIndex={0}
                  className={`drive-folder-row drive-folder-root-row${
                    selectedExistingId === rootId ? " is-selected" : ""
                  }`}
                  onClick={() =>
                    onChange({
                      mode: "existing",
                      folderId: rootId,
                      folderName: campaign || project || "תיקייה",
                    })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onChange({
                        mode: "existing",
                        folderId: rootId,
                        folderName: campaign || project || "תיקייה",
                      });
                    }
                  }}
                  title="בחר את תיקיית הקמפיין עצמה (ללא תת־תיקייה)"
                >
                  <span className="drive-folder-chevron drive-folder-chevron-fixed">▾</span>
                  <span className="drive-folder-icon">📁</span>
                  <span className="drive-folder-name">
                    {campaign || project || "תיקייה"}
                  </span>
                  <span className="drive-folder-root-tag">
                    {campaign ? "תיקיית קמפיין" : "תיקיית פרויקט"}
                  </span>
                </div>
                <div className="drive-folder-sub">
                  {renderBranch(rootId, 1, campaign || project || "תיקייה")}
                </div>
              </div>
              <div className="drive-folder-tip">
                💡 לחץ על תיקייה כדי לשמור בה את קבצי המשימה. כדי לארגן, ניתן גם להוסיף תת־תיקייה חדשה.
              </div>
              {selectedExistingId && (
                <div className="drive-folder-selected-pill">
                  <span className="drive-folder-icon">📁</span>
                  <span>נבחרה: {selectedExistingName || campaign || "תיקייה"}</span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );

  function renderBranch(
    parentId: string,
    depth: number,
    parentName: string,
  ): React.ReactNode {
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
        {creating === parentId && (
          <li className="drive-folder-li drive-folder-creating-block" data-depth={depth}>
            <div className="drive-folder-creating-caption">
              תת־תיקייה חדשה תחת <strong>{parentName}</strong>
            </div>
            <div className="drive-folder-creating">
              <input
                autoFocus
                type="text"
                value={newChildName}
                onChange={(e) => setNewChildName(e.target.value)}
                placeholder="לדוגמה: גרסאות, מקור, מאושר"
                disabled={submittingNew}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (submittingNew) return;
                    void createSubfolder(parentId);
                  } else if (e.key === "Escape") {
                    if (submittingNew) return;
                    setCreating(null);
                    setNewChildName("");
                  }
                }}
              />
              <button
                type="button"
                className="drive-folder-btn"
                disabled={submittingNew || !newChildName.trim()}
                onClick={() => void createSubfolder(parentId)}
              >
                {submittingNew ? "יוצר…" : "צור"}
              </button>
              <button
                type="button"
                className="drive-folder-btn-ghost"
                disabled={submittingNew}
                onClick={() => {
                  setCreating(null);
                  setNewChildName("");
                }}
              >
                בטל
              </button>
            </div>
          </li>
        )}

        {items.length === 0 && creating !== parentId && (
          <li className="drive-folder-li drive-folder-empty" data-depth={depth}>
            <span className="drive-folder-hint">
              אין תת־תיקיות תחת &quot;{parentName}&quot;
            </span>
            <button
              type="button"
              className="drive-folder-btn-ghost"
              title={`תיווצר תת־תיקייה חדשה תחת "${parentName}"`}
              onClick={() => {
                setCreating(parentId);
                setNewChildName("");
              }}
            >
              ➕ צור תת־תיקייה תחת &quot;{parentName}&quot;
            </button>
          </li>
        )}

        {items.map((f) => {
          const isSelected = selectedExistingId === f.id;
          const isOpen = expanded.has(f.id);
          return (
            <li key={f.id} className="drive-folder-li" data-depth={depth}>
              <div
                role="button"
                tabIndex={0}
                className={`drive-folder-row${isSelected ? " is-selected" : ""}`}
                onClick={() =>
                  onChange({
                    mode: "existing",
                    folderId: f.id,
                    folderName: f.name,
                  })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onChange({
                      mode: "existing",
                      folderId: f.id,
                      folderName: f.name,
                    });
                  }
                }}
              >
                <button
                  type="button"
                  className="drive-folder-chevron"
                  aria-label={isOpen ? "סגור" : "פתח"}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleExpanded(f.id);
                  }}
                  disabled={!f.hasChildren}
                >
                  {f.hasChildren ? (isOpen ? "▾" : "▸") : ""}
                </button>
                <span className="drive-folder-icon">📁</span>
                <span className="drive-folder-name">{f.name}</span>
              </div>
              {isOpen && (
                <div className="drive-folder-sub">
                  {renderBranch(f.id, depth + 1, f.name)}
                </div>
              )}
            </li>
          );
        })}

        {items.length > 0 && creating !== parentId && (
          <li className="drive-folder-li drive-folder-add" data-depth={depth}>
            <button
              type="button"
              className="drive-folder-btn-ghost"
              title={`תיווצר תת־תיקייה חדשה תחת "${parentName}"`}
              onClick={() => {
                setCreating(parentId);
                setNewChildName("");
              }}
            >
              ➕ תת־תיקייה חדשה תחת &quot;{parentName}&quot;
            </button>
          </li>
        )}
      </ul>
    );
  }
}
