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

  // Coerce "new" → "existing" on mount. The mode switch UI was removed
  // 2026-05-02; if a parent still initialises with `{ mode: "new" }`
  // (TaskEditPanel does for tasks without a drive_folder_id), flip it
  // immediately so the existing-tree renders. The auto-select effect
  // below then picks the campaign folder as the default.
  useEffect(() => {
    if (value.mode === "new") {
      onChange({ mode: "existing", folderId: "", folderName: "" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resolveKey = `${company}::${project}::${campaign}`;
  const lastKey = useRef<string>("");
  // Tracks the folder ID our auto-select effect last applied, so the
  // campaign-change effect knows when to wipe a stale selection. Used
  // by both effects below — declared up here to avoid a temporal-
  // dead-zone reference from the campaign-change effect.
  const autoSelectedFor = useRef<string>("");

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
      } else {
        setCampaignFolder({ pending: true });
      }
    } catch (e) {
      setCampaignFolder({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setResolving(false);
    }
  }, [company, project, campaign]);

  useEffect(() => {
    if (disabled) return;
    if (lastKey.current === resolveKey) return;
    const isFirstRun = lastKey.current === "";
    lastKey.current = resolveKey;
    setChildren({});
    setExpanded(new Set());
    // Reset the folder selection on campaign change. Without this, a
    // user who picks campaign A → auto-selects A's folder → then
    // switches to a new campaign B would submit with B's name but A's
    // folderId. The server reuses that pinned folder and never creates
    // B's folder at all. Skip on the very first run so we don't clobber
    // an explicit `value` passed in by the parent (e.g. edit mode).
    if (!isFirstRun && value.mode === "existing" && value.folderId) {
      onChange({ mode: "existing", folderId: "", folderName: "" });
    }
    autoSelectedFor.current = "";
    const handle = setTimeout(() => {
      void resolveCampaign();
    }, 350);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Auto-select the campaign folder when it resolves AND the parent
  // hasn't picked anything yet. Default UX: "use the campaign folder"
  // is the implicit choice so the form's submit just sends drive_folder_id
  // = campaign folder ID. Only fires once per resolved folder ID.
  // (autoSelectedFor ref is declared up top; both this effect and the
  // campaign-change effect read/write it.)
  useEffect(() => {
    if (!campaignFolder) return;
    if ("error" in campaignFolder || "pending" in campaignFolder) return;
    if (autoSelectedFor.current === campaignFolder.id) return;
    if (value.mode !== "existing") return;
    if (value.folderId) return;
    autoSelectedFor.current = campaignFolder.id;
    onChange({
      mode: "existing",
      folderId: campaignFolder.id,
      folderName: campaign || project || "תיקייה",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignFolder]);

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

      {/* Mode switch removed 2026-05-02 per user feedback — the
          "תיקייה חדשה" half just created another sub-folder under the
          campaign, which is redundant with the inline ➕ buttons in
          the tree below. The picker now always renders in "existing"
          mode; folder creation goes through the per-level "+" entry. */}

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

      {/* Always render the existing-tree block. The "new" mode block
          (a single text input for a sub-folder name) was redundant
          with the inline ➕ buttons in the tree, so the parent's
          `value` is coerced to "existing" on mount via the effect
          above. Old "new" code paths (switchMode, lastNewName) are
          preserved for type compatibility but unreachable in UI. */}
      <div className="drive-folder-existing-block">
          {isPending && (
            <div className="drive-folder-hint">
              ✅ תיקיית הקמפיין תיווצר אוטומטית בעת שמירה ותשמש כתיקיית המשימה.
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
          <li className="drive-folder-li drive-folder-empty" data-depth={depth + 1}>
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
          <li className="drive-folder-li drive-folder-add" data-depth={depth + 1}>
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
