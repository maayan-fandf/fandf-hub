"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { TasksPerson, WorkTask } from "@/lib/appsScript";
import CampaignCombobox from "./CampaignCombobox";
import DatePicker from "./DatePicker";
import PersonCombobox from "./PersonCombobox";
import PeopleMultiCombobox from "./PeopleMultiCombobox";
import TimePicker from "./TimePicker";
import Avatar, { avatarHoverText } from "./Avatar";
import DrivePickerButton from "./DrivePickerButton";
import TaskFilesPanel from "./TaskFilesPanel";
import { displayNameOf } from "@/lib/personDisplay";
import DriveFolderPicker, {
  type FolderPickerValue,
} from "./DriveFolderPicker";
import {
  CHAIN_TEMPLATES,
  type ChainTemplate,
} from "@/lib/chainTemplates";
import { roleEmoji } from "./RoleChip";
import {
  resolvePricing,
  type PricingRow,
} from "@/lib/pricingMatch";

/** Hardcoded fallback used only when the names-to-emails sheet has no
 *  Role column populated. Real departments come from the people list
 *  (see `departmentOptions` below) so they stay in sync with the sheet. */
const DEPARTMENTS_FALLBACK = ["מדיה", "קריאייטיב", "UI/UX", "תכנון", "אחר"];
const KINDS = [
  { val: "ad_creative", label: "קריאייטיב פרסומי" },
  { val: "landing_page", label: "דף נחיתה" },
  { val: "video", label: "וידאו" },
  { val: "copy", label: "קופי" },
  { val: "campaign_launch", label: "השקת קמפיין" },
  { val: "revision", label: "סבב תיקונים" },
  { val: "other", label: "אחר" },
];

/** Tomorrow's calendar date (YYYY-MM-DD) in Asia/Jerusalem — the
 *  default due date for new tasks + chain steps. Computed as a plain
 *  calendar date (today-in-Jerusalem + 1 day) so it's DST-safe and
 *  matches every other Asia/Jerusalem date compare in the app. */
function tomorrowJerusalem(): string {
  const todayJ = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
  }).format(new Date());
  const [y, m, d] = todayJ.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

/** localStorage key for the resumable new-task draft (per browser). */
const TASK_DRAFT_KEY = "fandf:newTaskDraft";

type ProjectOption = {
  name: string;
  company: string;
  /** Keys col D "EMAIL Manager" — stored as a display name like
   *  "Itay Stein". Resolved to an email client-side via the people list. */
  projectManagerFull: string;
};

export default function TaskCreateForm({
  projects,
  defaultProject,
  defaultCompany: defaultCompanyProp = "",
  defaultDescription = "",
  defaultAssignees = "",
  defaultTitle = "",
  fromComment = "",
  cleanupGmailTaskId = "",
  people,
  currentUserEmail,
  formSchema = null,
  chainTemplates,
  driveAccessToken,
  drivePickerApiKey,
  driveName = "",
  editingTask = null,
  pricing = [],
  showPricing = false,
}: {
  projects: ProjectOption[];
  defaultProject: string;
  /** Pre-fill the company picker WITHOUT pre-selecting a project. Used
   *  by the Gmail-origin task convert flow: the email's sender resolves
   *  to a known client company, but clients are spread across multiple
   *  projects so we let the user pick which project applies. */
  defaultCompany?: string;
  /** Pre-fill the description textarea — used by the "convert comment
   *  to task" flow on /tasks/new?from_comment=X. */
  defaultDescription?: string;
  /** Pre-fill the assignees field as a CSV. The comment's `mentions`
   *  field maps directly here. */
  defaultAssignees?: string;
  /** Pre-fill the title — typically the first line of the source
   *  comment, truncated. The user almost always edits this before
   *  saving, but a starting point beats an empty field. */
  defaultTitle?: string;
  /** When set, the create payload includes `from_comment` so the
   *  server migrates the source comment + its replies under the new
   *  task. Empty string skips the migration (plain create). */
  fromComment?: string;
  /** Google Task id (on user's default tasklist) to mark complete after
   *  successful task creation, IF the user clicks the "צור ונקה" submit
   *  button instead of the regular one. Set only by the Gmail-origin
   *  convert flow. Empty string hides the second submit button. */
  cleanupGmailTaskId?: string;
  people: TasksPerson[];
  currentUserEmail: string;
  /** Optional schema from the TaskFormSchema sheet. When non-null, the
   *  form's department + kind dropdowns are sourced from it (kinds
   *  filtered to those configured under the selected department).
   *  When null, the form falls back to the legacy behavior — every
   *  KIND from the hardcoded list, every department derived from
   *  names-to-emails roles. Server-loaded in app/tasks/new/page.tsx. */
  formSchema?: {
    departments: string[];
    allKinds: string[];
    kindsByDepartment: Record<string, string[]>;
  } | null;
  /** Phase 10 — chain templates from the sheet-backed admin store
   *  (or the hardcoded CHAIN_TEMPLATES seed when the sheet is empty).
   *  Falls back to the hardcoded set when omitted, preserving the
   *  pre-phase-10 behavior. */
  chainTemplates?: ChainTemplate[];
  /** Drive Picker test-drive (2026-05-05). User's Google OAuth access
   *  token (drive.file scope) forwarded from the NextAuth session via
   *  the new-task page's server-side `auth()` call. Empty when the
   *  user signed in before the scope was added — falls back to the
   *  inline picker only. */
  driveAccessToken?: string;
  /** Browser API key for the Drive Picker SDK. Comes from
   *  `NEXT_PUBLIC_GOOGLE_PICKER_API_KEY`. Empty disables the
   *  experimental button without breaking the rest of the form. */
  drivePickerApiKey?: string;
  /** Shared-drive name — forwarded to the folder picker so each folder
   *  row can build its local "open in Explorer/Finder" path. */
  driveName?: string;
  /** When supplied, the form switches to EDIT mode: every initial state
   *  is seeded from the existing task, the chain / multi-mode UI is
   *  hidden, and submit POSTs to /api/worktasks/update with a patch
   *  derived from the form. The page that renders this should also
   *  pre-fill defaultProject/defaultCompany/defaultTitle/etc. so those
   *  fall through to the same code paths as create.
   *
   *  This is the unification path — replaces the legacy TaskEditPanel.
   *  Both surfaces now go through TaskCreateForm so departments / kind /
   *  people-picker behavior never drifts again. */
  editingTask?: WorkTask | null;
  /** Rows from the Pricingsetup tab. Server-loaded in
   *  app/tasks/new/page.tsx; the form resolves the price reactively
   *  from the current company/project/department/kind. Empty → the
   *  pricing panel renders a "not configured" hint. */
  pricing?: PricingRow[];
  /** Gate for the pricing panel — only the new-task page sets this.
   *  Edit mode (app/tasks/[id]) renders the same form but doesn't load
   *  pricing, so the panel must stay hidden there. */
  showPricing?: boolean;
}) {
  // Edit mode shorthand. Used in many places below to fork initial
  // state, hide create-only UI sections, and route the submit handler.
  const isEditing = !!editingTask;
  const router = useRouter();
  // Default due date for new tasks + chain steps = tomorrow (Asia/
  // Jerusalem). Computed once per mount.
  const tomorrowIso = useMemo(() => tomorrowJerusalem(), []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tracks which submit button the user pressed last. The form only has
  // one onSubmit handler, so the buttons set this ref *before* the
  // submit fires (onClick precedes form submission in the DOM event
  // ordering). After a successful create we read this to decide whether
  // to also clean up the originating Google Task.
  const submitModeRef = useRef<"plain" | "cleanup">("plain");

  // Company → list-of-projects index, for the cascading dropdowns.
  const byCompany = useMemo(() => {
    const m = new Map<string, ProjectOption[]>();
    for (const p of projects) {
      const co = p.company || "";
      if (!m.has(co)) m.set(co, []);
      m.get(co)!.push(p);
    }
    return m;
  }, [projects]);

  // Resolve a Keys display-name (like "Itay Stein") to an email by
  // matching against the people list by name. Lower-cased exact match;
  // falls back to empty so the user can type the address manually.
  const nameToEmail = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of people) {
      const k = String(p.name || "").trim().toLowerCase();
      if (k && !m.has(k)) m.set(k, p.email);
    }
    return m;
  }, [people]);

  // Email → role (department), for auto-deriving a chain step's מחלקה
  // from its picked assignee — the person already implies their
  // department, so the user shouldn't have to pick it too.
  const emailToRole = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of people) {
      const e = String(p.email || "").trim().toLowerCase();
      if (e) m.set(e, String(p.role || "").trim());
    }
    return m;
  }, [people]);

  const defaultProjectOpt = projects.find((p) => p.name === defaultProject);
  // Company defaults: project pick wins (auto-derived); else the explicit
  // ?company param; else empty.
  const defaultCompany = defaultProjectOpt?.company || defaultCompanyProp || "";
  const defaultPm = defaultProjectOpt
    ? nameToEmail.get(defaultProjectOpt.projectManagerFull.trim().toLowerCase()) || ""
    : "";

  // Initial state seeds from `editingTask` when in edit mode; falls
  // through to the create-flow defaults otherwise. The page that
  // renders the form is expected to forward editingTask values into
  // the matching `default*` props for the fields that are uncontrolled
  // (description, kind, priority, requested_date, brief) — the rest
  // are seeded directly here.
  const [company, setCompany] = useState(
    isEditing ? editingTask!.company || "" : defaultCompany,
  );
  // Pseudo-project rows (`__personal__`) start with an EMPTY project
  // field even though the row's stored value is `__personal__`. Lets
  // the user pick a real project to promote the personal note onto.
  const [project, setProject] = useState(
    isEditing
      ? editingTask!.project.startsWith("__")
        ? ""
        : editingTask!.project || ""
      : defaultProject,
  );
  const [departments, setDepartments] = useState<string[]>(
    isEditing ? editingTask!.departments || [] : [],
  );
  const [projectManager, setProjectManager] = useState(
    isEditing ? editingTask!.project_manager_email || "" : defaultPm,
  );
  const [approver, setApprover] = useState(
    isEditing ? editingTask!.approver_email || "" : "",
  );
  const [assignees, setAssignees] = useState(
    isEditing
      ? (editingTask!.assignees || []).join(", ")
      : defaultAssignees,
  );
  const [campaign, setCampaign] = useState(
    isEditing ? editingTask!.campaign || "" : "",
  );
  const [title, setTitle] = useState(
    isEditing ? editingTask!.title || "" : defaultTitle,
  );
  // Controlled so a saved draft can restore it (and so the draft
  // snapshot can read it without poking the DOM).
  const [description, setDescription] = useState(
    isEditing ? editingTask!.description || "" : defaultDescription,
  );
  // Phase 5b — chain mode. When the user opts in, the form switches
  // to a multi-step picker: the title is the umbrella's title, and
  // the body becomes a list of step rows (title + assignees per step).
  // Submit goes to /api/worktasks/create-chain instead of /create.
  // Default OFF preserves the standard single-task UX as the dominant
  // path (per the locked design — most quick client requests are NOT
  // chains).
  const [chainMode, setChainMode] = useState(false);
  // Multi-assignee mode picker — only meaningful when assignees has
  // 2+ emails AND chainMode is off. "joined" preserves the historical
  // single-task semantics (today's default; multiple people, one
  // shared row); "parallel" splits into N peer children under a
  // shared umbrella, no dependency edges. The third option from the
  // user-facing picker (chain) is handled by flipping `chainMode`
  // directly — it's an action, not a persistent state on this picker.
  const [multiMode, setMultiMode] = useState<"joined" | "parallel">("joined");
  // Phase 10 follow-up — explicit umbrella toggle. Default ON because
  // the umbrella's rollup (the parent task in /tasks/[id] showing
  // aggregate progress) is what most users want for chains. Turning
  // it OFF creates a flat-linked chain: N peer tasks linked sideways
  // via blocks/blocked_by, no rollup row in the project view. Users
  // who don't want the umbrella's noise in their lists can opt out
  // here per-creation.
  const [withUmbrella, setWithUmbrella] = useState(true);
  type ChainStep = {
    title: string;
    assignees: string;
    assigneeHint?: string;
    /** When set, the step's assignee picker filters to people whose
     *  Role on names-to-emails matches this value (case-insensitive).
     *  Seeded from the template; now ALSO user-editable per step so
     *  per-step pricing can resolve (rate card keys on department). */
    department?: string;
    /** Per-step סוג. Drives this child's kind AND its price lookup
     *  (resolvePricing on company/project/step.department/step.kind). */
    kind?: string;
    /** Per-step price (₪) as a string for the input. Undefined =
     *  "follow the resolved rate"; once the user edits it,
     *  priceTouched pins the manual value even as dept/kind change. */
    price?: string;
    priceTouched?: boolean;
    /** Optional per-step due date (YYYY-MM-DD). Defaults to tomorrow
     *  for new steps; the chain create endpoint applies it per child. */
    requested_date?: string;
  };
  const [steps, setSteps] = useState<ChainStep[]>([
    { title: "", assignees: "", requested_date: tomorrowIso },
    { title: "", assignees: "", requested_date: tomorrowIso },
  ]);
  // Phase 8 polish — chain template picker. Selecting a template
  // pre-fills the umbrella title + step rows so users only need to
  // supply assignees. Empty string = "no template, manual setup"
  // (the default — preserves the from-scratch flow).
  const [chainTemplateId, setChainTemplateId] = useState("");
  // Effective list — prop wins when present (sheet-backed via /admin),
  // else fall back to the hardcoded seed.
  const effectiveChainTemplates = chainTemplates ?? CHAIN_TEMPLATES;
  function applyChainTemplate(id: string) {
    setChainTemplateId(id);
    if (!id) return;
    const tpl = effectiveChainTemplates.find((t) => t.id === id);
    if (!tpl) return;
    // Only overwrite the umbrella title if it's empty — respects
    // user typing-ahead-of-picker. Steps always overwrite (the whole
    // point of picking a template is to reset the step list).
    if (!title.trim()) setTitle(tpl.defaultUmbrellaTitle);
    setSteps(
      tpl.steps.map((s) => ({
        title: s.title,
        assignees: "",
        assigneeHint: s.assigneeHint,
        department: s.department,
        requested_date: tomorrowIso,
      })),
    );
  }
  // Folder selection. Default is "use existing campaign folder" with
  // an empty folderId — the picker auto-selects the campaign folder
  // when it resolves (or, when the campaign folder doesn't exist yet,
  // the server creates it on save and uses it directly — no leaf
  // sub-folder gets created in either case unless the user opts into
  // "תיקייה חדשה" mode and types a name. This was the previous source
  // of duplicate sub-folders matching the campaign name.
  const suggestedFolderName = useMemo(
    () => title.trim().slice(0, 60),
    [title],
  );
  const [folderSelection, setFolderSelection] = useState<FolderPickerValue>({
    mode: "existing",
    folderId: "",
    folderName: "",
  });
  // Track whether the user has manually edited the new-folder name.
  // Once edited, stop overwriting it with the title-derived suggestion.
  const [folderNameUserEdited, setFolderNameUserEdited] = useState(false);
  useEffect(() => {
    if (folderNameUserEdited) return;
    setFolderSelection((cur) =>
      cur.mode === "new"
        ? { mode: "new", name: suggestedFolderName }
        : cur,
    );
  }, [suggestedFolderName, folderNameUserEdited]);
  function handleFolderChange(v: FolderPickerValue) {
    if (
      v.mode === "new" &&
      v.name !== suggestedFolderName &&
      v.name !== ""
    ) {
      setFolderNameUserEdited(true);
    }
    setFolderSelection(v);
  }

  // Resolve the Drive folder the Picker should open at:
  //   - When the user has picked a בריף → that בריף's folder (drill in
  //     so they're choosing a sub-folder or file inside it).
  //   - When no בריף is picked → the project parent folder (browse all
  //     בריפים).
  // Mirrors the same /api/drive/folders/resolve-campaign endpoint the
  // inline DriveFolderPicker uses internally. Yes this is a duplicate
  // call while both pickers coexist during the test-drive — drops away
  // when we pick a winner.
  const [pickerParentFolderId, setPickerParentFolderId] = useState<
    string | null
  >(null);
  useEffect(() => {
    let cancelled = false;
    setPickerParentFolderId(null);
    if (!project) return;
    void fetch("/api/drive/folders/resolve-campaign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ company, project, campaign: campaign || "" }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { ok?: boolean; folderId?: string | null } | null) => {
        if (cancelled) return;
        if (d?.ok && d.folderId) setPickerParentFolderId(d.folderId);
      })
      .catch(() => {
        // Non-fatal — Picker just opens at My Drive root in this case.
      });
    return () => {
      cancelled = true;
    };
  }, [company, project, campaign]);
  // Existing campaigns for the selected project — populates the
  // datalist autocomplete. Refetched whenever the project changes,
  // and explicitly after CampaignCombobox creates / renames one
  // (it owns the API calls; we own the cached list).
  const [campaignOptions, setCampaignOptions] = useState<string[]>([]);
  const [campaignReloadNonce, setCampaignReloadNonce] = useState(0);
  useEffect(() => {
    if (!project) {
      setCampaignOptions([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/tasks/campaigns?project=${encodeURIComponent(project)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const list = (data?.campaigns ?? []) as string[];
        setCampaignOptions(list);
      })
      .catch(() => {
        /* ignore; free-text still works */
      });
    return () => {
      cancelled = true;
    };
  }, [project, campaignReloadNonce]);

  // Filter projects by selected company, deduped by name. Defensive
  // dedupe protects against the rare case where the source data has
  // duplicate (name, company) pairs (e.g. accidental double-seed of a
  // company-level "כללי" project).
  const companyProjects = (() => {
    const source = company
      ? projects.filter((p) => p.company === company)
      : projects;
    const seen = new Set<string>();
    return source.filter((p) => {
      if (seen.has(p.name)) return false;
      seen.add(p.name);
      return true;
    });
  })();

  // Project-manager candidates — narrowed from the full people list to
  // role values containing "manager" (case-insensitive). Today that's
  // "manager" + "client manager" per names-to-emails. The previous
  // unfiltered list dumped every employee (designers, copywriters,
  // video editors) into the autocomplete, which is wrong: the מנהל
  // פרויקט slot is meant for the actual PM, not "anyone in the agency".
  // Reported by Maayan 2026-05-06. Falls back to the full people list
  // when no role on names-to-emails matches — better to show too many
  // than show none if the column hasn't been populated yet.
  const projectManagerCandidates = useMemo(() => {
    const matches = people.filter((p) =>
      (p.role || "").toLowerCase().includes("manager"),
    );
    return matches.length > 0 ? matches : people;
  }, [people]);

  // Departments — schema sheet wins when provided; falls back to the
  // live `Role` column on names-to-emails; falls back to the hardcoded
  // list. The schema is the authoritative source once admin has shaped
  // it via /admin/task-form-schema.
  const departmentOptions = useMemo(() => {
    if (formSchema && formSchema.departments.length > 0) {
      return formSchema.departments;
    }
    // Dedupe on a lowercased key so the same role spelled with
    // different casing in names_to_emails ("Media" vs "media")
    // collapses to a single chip. The DISPLAY value is the first
    // casing we encounter (preserves what the sheet owner typed)
    // — we just don't render the same role twice. Reported by
    // Maayan 2026-05-06 after the roster revision introduced
    // mixed casing.
    const seen = new Map<string, string>();
    for (const p of people) {
      const r = (p.role || "").trim();
      if (!r) continue;
      const key = r.toLowerCase();
      if (!seen.has(key)) seen.set(key, r);
    }
    if (seen.size === 0) return DEPARTMENTS_FALLBACK;
    return Array.from(seen.values()).sort((a, b) =>
      a.localeCompare(b, "he"),
    );
  }, [people, formSchema]);

  // Kind dropdown — schema-driven, filtered by selected department(s).
  // Behavior:
  //   - No schema → use legacy hardcoded KINDS list (full set).
  //   - Schema present + no department selected → union of every kind
  //     in the schema (so user sees all options).
  //   - Schema present + department(s) selected → union of kinds for
  //     each selected department.
  // Each option carries both a display label (= sheet value) and a
  // value string (= same as label). The form submits the label as
  // the kind, free-text — backend accepts any string.
  const kindOptions = useMemo(() => {
    if (!formSchema || formSchema.allKinds.length === 0) {
      return KINDS.map((k) => ({ val: k.val, label: k.label }));
    }
    if (departments.length === 0) {
      return formSchema.allKinds.map((k) => ({ val: k, label: k }));
    }
    const kinds: string[] = [];
    const seen = new Set<string>();
    for (const d of departments) {
      const list = formSchema.kindsByDepartment[d] ?? [];
      for (const k of list) {
        if (!seen.has(k)) {
          seen.add(k);
          kinds.push(k);
        }
      }
    }
    // Edge case: selected department has no kinds in schema. Surface
    // SOMETHING so the dropdown isn't empty — fall back to all kinds.
    if (kinds.length === 0) {
      return formSchema.allKinds.map((k) => ({ val: k, label: k }));
    }
    return kinds.map((k) => ({ val: k, label: k }));
  }, [formSchema, departments]);

  // Controlled kind state — was previously uncontrolled (read via
  // FormData on submit), but the inline-template feature needs to
  // react to (dept, kind) changes mid-form. Initialized from the
  // editing task's kind in edit mode, otherwise from the first
  // available option.
  const [kind, setKind] = useState<string>(() =>
    isEditing
      ? editingTask!.kind || "other"
      : kindOptions[0]?.val ?? "ad_creative",
  );
  // When departments change, kindOptions may shrink. If the current
  // kind is no longer in the list, snap to the first option (matches
  // the prior `key={...}`-driven select remount behavior). Skip in
  // edit mode so an existing task's kind is preserved verbatim even
  // when not in the schema-derived list.
  useEffect(() => {
    if (isEditing) return;
    if (kindOptions.length === 0) return;
    if (!kindOptions.some((k) => k.val === kind)) {
      setKind(kindOptions[0].val);
    }
  }, [kindOptions, kind, isEditing]);

  // ── Inline template draft ────────────────────────────────────────
  // Two-step picker model: (dept, kind) selection populates a list of
  // template files (one per file inside the resolved kind folder).
  // The issuer then picks WHICH template to use — which triggers a
  // materialize-draft call that copies the picked file into a fresh
  // per-user draft folder. The form embeds the draft copy inline so
  // the issuer can fill it before submitting; on submit the draft
  // folder is re-parented into the task's permanent Drive folder.
  //
  // Skipped entirely in edit mode (the draft is a creation-time
  // affordance; existing tasks already have their folder).
  type TemplateOption = { id: string; name: string; mimeType: string };
  type DraftRef = {
    draftFolderId: string;
    copyDocId: string;
    copyDocUrl: string;
    copyDocName: string;
    copyDocMimeType: string;
  };
  const [templateOptions, setTemplateOptions] = useState<TemplateOption[]>([]);
  const [pickedTemplateFileId, setPickedTemplateFileId] = useState<string>("");
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [draft, setDraft] = useState<DraftRef | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  // Title is read inside the materialize effect ONLY for the context
  // label baked into the draft folder name. We don't want title to be
  // a re-trigger dep (every keystroke would otherwise re-materialize),
  // so we route it through a ref.
  const draftRef = useRef<DraftRef | null>(null);
  const titleRef = useRef(title);
  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  function cancelExistingDraft() {
    const previous = draftRef.current;
    if (!previous) return;
    void fetch("/api/worktasks/draft-cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draftFolderId: previous.draftFolderId }),
    }).catch(() => {
      /* GC cron will handle orphans */
    });
    draftRef.current = null;
    setDraft(null);
  }

  // Effect A — (dept, kind) change → fetch the template-options list
  // for the picker. Resets any picked file + cancels any existing
  // draft when the underlying (dept, kind) changes.
  const primaryDept = departments[0] || "";
  useEffect(() => {
    if (isEditing) {
      setTemplateOptions([]);
      setPickedTemplateFileId("");
      return;
    }
    cancelExistingDraft();
    setPickedTemplateFileId("");
    if (!primaryDept || !kind) {
      setTemplateOptions([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setOptionsLoading(true);
      try {
        const r = await fetch(
          `/api/worktasks/template-options?department=${encodeURIComponent(
            primaryDept,
          )}&kind=${encodeURIComponent(kind)}`,
        );
        const data = (await r.json()) as
          | {
              ok: true;
              noTemplate: false;
              folderId: string;
              folderName: string;
              files: TemplateOption[];
            }
          | { ok: true; noTemplate: true }
          | { ok: false; error: string };
        if (cancelled) return;
        if (
          "ok" in data &&
          data.ok &&
          !("noTemplate" in data && data.noTemplate)
        ) {
          const success = data as Extract<
            typeof data,
            { ok: true; noTemplate: false }
          >;
          setTemplateOptions(success.files || []);
        } else {
          setTemplateOptions([]);
        }
      } catch {
        if (!cancelled) setTemplateOptions([]);
      } finally {
        if (!cancelled) setOptionsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isEditing, primaryDept, kind]);

  // Effect B — pickedTemplateFileId change → materialize the draft.
  // Cancels any previously-materialized draft so a re-pick doesn't
  // leave orphans behind.
  useEffect(() => {
    if (isEditing) return;
    cancelExistingDraft();
    if (!pickedTemplateFileId || !primaryDept || !kind) {
      return;
    }
    let cancelled = false;
    (async () => {
      setDraftLoading(true);
      try {
        const r = await fetch("/api/worktasks/draft-template", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            department: primaryDept,
            kind,
            templateFileId: pickedTemplateFileId,
            contextLabel: titleRef.current.slice(0, 60),
          }),
        });
        const data = (await r.json()) as
          | {
              ok: true;
              noTemplate: false;
              draftFolderId: string;
              copyDocId: string;
              copyDocUrl: string;
              copyDocName: string;
              copyDocMimeType: string;
            }
          | { ok: true; noTemplate: true }
          | { ok: false; error: string };
        if (cancelled) return;
        if (
          "ok" in data &&
          data.ok &&
          !("noTemplate" in data && data.noTemplate)
        ) {
          const success = data as Extract<
            typeof data,
            { ok: true; noTemplate: false }
          >;
          const ref: DraftRef = {
            draftFolderId: success.draftFolderId,
            copyDocId: success.copyDocId,
            copyDocUrl: success.copyDocUrl,
            copyDocName: success.copyDocName,
            copyDocMimeType: success.copyDocMimeType || "",
          };
          draftRef.current = ref;
          setDraft(ref);
        } else {
          setDraft(null);
        }
      } catch {
        if (!cancelled) setDraft(null);
      } finally {
        if (!cancelled) setDraftLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // titleRef intentionally not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, pickedTemplateFileId, primaryDept, kind]);

  // Best-effort cleanup on unmount + page unload. The GC cron handles
  // anything that slips through. sendBeacon is preferred because the
  // browser will queue it independently of fetch(), surviving the
  // tab close.
  useEffect(() => {
    function cancelOnUnload() {
      const ref = draftRef.current;
      if (!ref) return;
      if (typeof navigator !== "undefined" && navigator.sendBeacon) {
        const blob = new Blob(
          [JSON.stringify({ draftFolderId: ref.draftFolderId })],
          { type: "application/json" },
        );
        navigator.sendBeacon("/api/worktasks/draft-cancel", blob);
      }
    }
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", cancelOnUnload);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("beforeunload", cancelOnUnload);
      }
    };
  }, []);

  // Worker chips (and the assignee combobox secondary list) narrow to
  // people whose role matches one of the selected departments. Empty
  // selection = show everyone, keeping the existing behavior.
  const filteredPeople = useMemo(() => {
    if (departments.length === 0) return people;
    const wanted = new Set(departments.map((d) => d.toLowerCase()));
    return people.filter((p) => wanted.has((p.role || "").toLowerCase()));
  }, [people, departments]);

  function toggleDept(d: string) {
    setDepartments((cur) =>
      cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d],
    );
  }

  function onProjectChange(name: string) {
    setProject(name);
    const opt = projects.find((x) => x.name === name);
    if (opt) {
      // Auto-fill company if user picked project first.
      if (!company && opt.company) setCompany(opt.company);
      // Auto-fill project manager from the project's Keys roster, BUT
      // only if the user hasn't already typed something. This respects
      // manual entry if they're ahead of the cascade.
      const pmEmail = nameToEmail.get(
        opt.projectManagerFull.trim().toLowerCase(),
      );
      if (pmEmail && !projectManager) setProjectManager(pmEmail);
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const fd = new FormData(e.currentTarget);

    // ── EDIT MODE BRANCH ─────────────────────────────────────────────
    // When `editingTask` is supplied, the form is updating an existing
    // task instead of creating one. Build a `patch` object covering
    // every field the form exposes, POST to /api/worktasks/update,
    // then strip ?edit=1 and refresh so the read-only detail view
    // reflects the saved values. Replaces the legacy TaskEditPanel
    // submit path verbatim — same endpoint, same patch shape, same
    // navigation. The chain / multi-mode / cleanup-Gmail branches
    // below are skipped entirely in edit mode.
    if (isEditing && editingTask) {
      const assigneeList = assignees
        .split(/[,;\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const dateRaw = String(fd.get("requested_date") || "").trim();
      const timeRaw = String(fd.get("requested_time") || "").trim();
      const requestedDateCombined =
        dateRaw && timeRaw ? `${dateRaw}T${timeRaw}` : dateRaw;

      const patch: Record<string, unknown> = {
        title,
        description: description,
        brief: String(fd.get("brief") || editingTask.brief || ""),
        departments,
        kind: String(fd.get("kind") || editingTask.kind || "other"),
        priority: Number(fd.get("priority") || editingTask.priority || 2),
        requested_date: requestedDateCombined,
        approver_email: approver,
        project_manager_email: projectManager,
        assignees: assigneeList,
        campaign: campaign.trim(),
      };
      // Only include `project` in the patch when the user actually
      // moved the task. The server treats project changes specially
      // (validates access + backfills Drive folder when leaving
      // __personal__); we only want those side effects when the value
      // really changed. Same gate as the legacy TaskEditPanel had.
      const projectTrimmed = project.trim();
      const companyTrimmed = company.trim();
      const projectChanging =
        !!projectTrimmed && projectTrimmed !== editingTask.project;
      const companyChanging =
        !!companyTrimmed && companyTrimmed !== (editingTask.company || "");
      if (projectChanging) {
        patch.project = projectTrimmed;
      }
      // Include `company` whenever it was changed OR whenever the
      // project is changing — the server's resolveCompany() looks up
      // the new project in Keys and returns the FIRST matching row,
      // which is wrong for non-unique project names like `כללי` (one
      // row per company by design). Sending the form's explicit
      // company short-circuits that resolver. Server's SIMPLE_DIRECT
      // diff check makes this a no-op when the value hasn't changed.
      if (companyTrimmed && (companyChanging || projectChanging)) {
        patch.company = companyTrimmed;
      }
      // Drive folder — only include when the user picked a different
      // existing folder. "new" mode isn't supported from the edit path
      // (matches legacy behavior).
      if (
        folderSelection.mode === "existing" &&
        folderSelection.folderId &&
        folderSelection.folderId !== editingTask.drive_folder_id
      ) {
        patch.drive_folder_id = folderSelection.folderId;
      }

      try {
        const res = await fetch("/api/worktasks/update", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: editingTask.id, patch }),
        });
        const data = (await res.json()) as
          | { ok: true; changed: boolean }
          | { ok: false; error: string };
        if (!res.ok || !data.ok) {
          throw new Error(
            "error" in data ? data.error : "Failed to save changes",
          );
        }
        router.replace(`/tasks/${encodeURIComponent(editingTask.id)}`);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setSaving(false);
      }
      return;
    }

    // Phase 5b chain branch — when the user opted into "צור כשרשרת",
    // build the chain payload and POST to the chain endpoint instead
    // of the standalone-create endpoint. Validation: at least one
    // step with a title (the orchestrator throws otherwise; we surface
    // it earlier for nicer UX).
    if (chainMode) {
      const trimmedSteps = steps
        .map((s) => {
          const eff = effectiveStepPrice(s).replace(/[^\d.-]/g, "");
          const priceNum = Number(eff);
          return {
            title: s.title.trim(),
            assignees: s.assignees
              .split(/[,;\n]/)
              .map((x) => x.trim())
              .filter(Boolean),
            department: (s.department || "").trim(),
            kind: (s.kind || "").trim(),
            price: eff && Number.isFinite(priceNum) ? priceNum : undefined,
            requested_date: (s.requested_date || "").trim() || undefined,
          };
        })
        .filter((s) => s.title); // drop blank rows
      if (trimmedSteps.length === 0) {
        setError("יש להוסיף לפחות שלב אחד עם כותרת");
        setSaving(false);
        return;
      }
      if (!title.trim()) {
        setError("כותרת השרשרת חובה");
        setSaving(false);
        return;
      }
      const chainPayload = {
        project,
        company,
        brief: String(fd.get("brief") || ""),
        campaign: campaign.trim(),
        departments,
        // Phase 10 follow-up — withUmbrella toggle. Server defaults to
        // creating an umbrella container; pass false to skip and get
        // a flat-linked chain (children only, no rollup row).
        withUmbrella,
        umbrella: {
          title: title.trim(),
          description: description,
        },
        steps: trimmedSteps.map((s) => ({
          title: s.title,
          assignees: s.assignees,
          approver_email: approver,
          // Per-step department (falls back to the chain departments),
          // per-step kind, and the resolved/manual price — drive this
          // child's row + its own PricingLog ledger entry.
          departments: s.department ? [s.department] : departments,
          kind: s.kind || undefined,
          price: s.price,
          // Per-step due date (optional) — the orchestrator applies it
          // to each child row.
          requested_date: s.requested_date,
        })),
      };
      try {
        const res = await fetch("/api/worktasks/create-chain", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(chainPayload),
        });
        const data = (await res.json()) as
          | {
              ok: true;
              umbrella: { id: string } | null;
              children: { id: string }[];
            }
          | { ok: false; error: string };
        if (!res.ok || !data.ok) {
          throw new Error("error" in data ? data.error : "Failed to create chain");
        }
        // Land on the umbrella detail page when there is one;
        // otherwise (flat-linked mode), land on the first child so
        // the user sees the start of the chain.
        clearDraft();
        const dest = data.umbrella?.id ?? data.children[0]?.id ?? "";
        if (dest) router.push(`/tasks/${encodeURIComponent(dest)}`);
        else router.push("/tasks");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setSaving(false);
      }
      return;
    }

    const assigneeList = assignees
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);

    // Combine optional time-of-day with the date. Stored as either
    // "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" depending on whether a time
    // was entered. The Google-Tasks side only respects the date; the
    // hub-side renders the time when present.
    const dateRaw = String(fd.get("requested_date") || "").trim();
    const timeRaw = String(fd.get("requested_time") || "").trim();
    const requestedDate =
      dateRaw && timeRaw ? `${dateRaw}T${timeRaw}` : dateRaw;

    // Parallel-umbrella branch — when the user picked 2+ assignees and
    // chose "מטריה עם משימות מקבילות", route through the chain
    // orchestrator with mode=parallel. Builds 1 umbrella + N peer
    // children (one per assignee) that share title/brief/etc.; no
    // dependency edges between children. The umbrella's status rolls
    // up via lib/umbrellaRecompute.ts (which enumerates by umbrella_id
    // — no graph traversal — so the empty edges are fine).
    if (multiMode === "parallel" && assigneeList.length >= 2) {
      if (!title.trim()) {
        setError("כותרת חובה");
        setSaving(false);
        return;
      }
      const parallelPayload = {
        project,
        company,
        brief: String(fd.get("brief") || ""),
        campaign: campaign.trim(),
        departments,
        mode: "parallel" as const,
        // Parallel mode forces the umbrella server-side; sending
        // withUmbrella explicitly keeps the intent obvious in logs.
        withUmbrella: true,
        umbrella: {
          title: title.trim(),
          description: description,
        },
        // One step per assignee — same title, single-email assignees.
        // Parallel children replicate the SAME task per person, so each
        // carries the form's kind + the resolved/entered single-task
        // price (each peer is its own billable unit → one PricingLog
        // row per child, like the chain children).
        steps: assigneeList.map((email) => {
          const pn = Number(String(priceInput).replace(/[^\d.-]/g, ""));
          return {
            title: title.trim(),
            assignees: [email],
            approver_email: approver,
            requested_date: requestedDate,
            departments,
            kind: String(fd.get("kind") || "") || undefined,
            price:
              priceInput.trim() && Number.isFinite(pn) ? pn : undefined,
          };
        }),
      };
      try {
        const res = await fetch("/api/worktasks/create-chain", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(parallelPayload),
        });
        const data = (await res.json()) as
          | {
              ok: true;
              umbrella: { id: string } | null;
              children: { id: string }[];
            }
          | { ok: false; error: string };
        if (!res.ok || !data.ok) {
          throw new Error(
            "error" in data ? data.error : "Failed to create parallel umbrella",
          );
        }
        clearDraft();
        const dest = data.umbrella?.id ?? data.children[0]?.id ?? "";
        if (dest) router.push(`/tasks/${encodeURIComponent(dest)}`);
        else router.push("/tasks");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setSaving(false);
      }
      return;
    }

    const payload: Record<string, unknown> = {
      project: project,
      company: company, // falls back to Keys lookup server-side if empty
      brief: String(fd.get("brief") || ""),
      title: title,
      description: description,
      departments,
      kind: String(fd.get("kind") || ""),
      priority: Number(fd.get("priority") || "2"),
      approver_email: approver,
      project_manager_email: projectManager,
      assignees: assigneeList,
      requested_date: requestedDate,
      campaign: campaign.trim(),
    };
    // Price: the resolved rate-card total or the manual amount typed
    // into the open field. Omit when blank/invalid so the server
    // records no price rather than 0.
    {
      const p = Number(String(priceInput).replace(/[^\d.-]/g, ""));
      if (priceInput.trim() && Number.isFinite(p)) payload.price = p;
    }
    if (fromComment) {
      // Server re-parents the source comment + its replies under the
      // newly-created task id (Flavor C migration).
      payload.from_comment = fromComment;
    }
    if (folderSelection.mode === "existing" && folderSelection.folderId) {
      payload.drive_folder_id = folderSelection.folderId;
    } else if (folderSelection.mode === "new") {
      const name = folderSelection.name.trim();
      if (name) payload.drive_folder_name = name;
    }
    // Inline-template path: when the user filled a draft template,
    // hand the server the draftFolderId so it can re-parent that
    // folder into the campaign hierarchy instead of creating a new
    // (empty) task folder. Stash the ref locally so we can restore
    // it on POST failure (otherwise the beforeunload cleanup loses
    // its handle to the orphan).
    let restoreDraftOnFailure: DraftRef | null = null;
    if (draftRef.current) {
      payload.existing_draft_folder_id = draftRef.current.draftFolderId;
      restoreDraftOnFailure = draftRef.current;
      // Null out for the POST window so a beforeunload that fires
      // mid-flight doesn't try to cancel the folder we're committing
      // to permanent storage.
      draftRef.current = null;
    }

    try {
      const res = await fetch("/api/worktasks/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as
        | { ok: true; task: { id: string } }
        | { ok: false; error: string };
      if (!res.ok || !data.ok) {
        throw new Error(
          "error" in data ? data.error : "Failed to create task",
        );
      }
      // GT cleanup if the user clicked "צור ונקה". Awaited (not fire-
      // and-forget) because router.push races the request — a navigation
      // that fires before the fetch handshake completes will sometimes
      // cancel it mid-flight, which would silently skip the dismiss.
      // Errors here don't block navigation — the hub task creation is
      // already committed.
      if (
        submitModeRef.current === "cleanup" &&
        cleanupGmailTaskId
      ) {
        try {
          await fetch("/api/gmail-tasks/dismiss", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ taskId: cleanupGmailTaskId }),
          });
        } catch {
          /* navigate anyway */
        }
      }
      clearDraft();
      router.push(`/tasks/${encodeURIComponent(data.task.id)}`);
    } catch (e) {
      // Restore the draft ref on failure so a subsequent (dept, kind)
      // change OR a beforeunload event can still clean up the folder.
      if (restoreDraftOnFailure) {
        draftRef.current = restoreDraftOnFailure;
      }
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  const companies = Array.from(byCompany.keys()).filter(Boolean).sort();

  // Reactive pricing — recomputed whenever the keying fields change.
  // project is optional: resolvePricing falls back to the company-level
  // row (blank project cell) when no project-specific row exists.
  const pricingResult = useMemo(
    () =>
      resolvePricing(pricing, {
        company,
        project,
        departments,
        kind,
      }),
    [pricing, company, project, departments, kind],
  );
  const fmtILS = (n: number) =>
    "₪" + Math.round(n).toLocaleString("he-IL");

  // Per-step (chain) helpers — kinds scoped to the step's department,
  // and the rate-card price for a single (department, kind) pair.
  const kindsForDept = (dept: string): string[] => {
    if (formSchema && dept && (formSchema.kindsByDepartment[dept]?.length ?? 0) > 0)
      return formSchema.kindsByDepartment[dept];
    if (formSchema && formSchema.allKinds.length > 0) return formSchema.allKinds;
    return KINDS.map((k) => k.label);
  };
  const resolveStepPrice = (step: ChainStep): number | null => {
    const dept = (step.department || "").trim();
    if (!dept || !step.kind) return null;
    const r = resolvePricing(pricing, {
      company,
      project,
      departments: [dept],
      kind: step.kind,
    });
    return r.hasAny ? r.total : null;
  };
  /** Value shown in a step's price input: the manual override once
   *  touched, otherwise the resolved rate (blank when unresolved →
   *  open field, same rule as the single-task panel). */
  const effectiveStepPrice = (step: ChainStep): string => {
    if (step.priceTouched) return step.price ?? "";
    const r = resolveStepPrice(step);
    return r != null ? String(r) : "";
  };
  const chainPriceTotal = chainMode
    ? steps.reduce((sum, s) => {
        const v = Number(effectiveStepPrice(s).replace(/[^\d.-]/g, ""));
        return sum + (Number.isFinite(v) ? v : 0);
      }, 0)
    : 0;

  // Editable price field. Authoritative value submitted with the task.
  // Auto-prefills from the resolved rate-card total UNTIL the user
  // edits it (then their override sticks even as company/dept/kind
  // change). When nothing resolves it's simply an open field — exactly
  // the "no תמחור setup → open field" behavior requested.
  const [priceInput, setPriceInput] = useState<string>("");
  const priceTouched = useRef(false);
  useEffect(() => {
    if (priceTouched.current) return;
    setPriceInput(pricingResult.hasAny ? String(pricingResult.total) : "");
  }, [pricingResult.hasAny, pricingResult.total]);

  // ── Draft (save & resume) ─────────────────────────────────────────
  // A local snapshot of the form so a half-filled NEW task can be
  // resumed later (same browser). Saved on demand via "שמור טיוטה",
  // offered for restore via a banner on the next visit, and cleared on
  // a successful create. Edit / comment-convert / gmail-convert flows
  // opt out (they carry their own seeded context).
  const draftEligible = !isEditing && !fromComment && !cleanupGmailTaskId;
  type TaskDraft = {
    savedAt: string;
    company: string;
    project: string;
    campaign: string;
    title: string;
    description: string;
    departments: string[];
    kind: string;
    approver: string;
    projectManager: string;
    assignees: string;
    chainMode: boolean;
    withUmbrella: boolean;
    multiMode: "joined" | "parallel";
    steps: ChainStep[];
    priceInput: string;
  };
  const [pendingDraft, setPendingDraft] = useState<TaskDraft | null>(null);
  const [draftFlash, setDraftFlash] = useState(false);

  // Offer restore on mount when a saved draft exists. Reading
  // localStorage in an effect (not in a useState initializer) keeps
  // the server render and the first client render identical — no
  // hydration mismatch.
  useEffect(() => {
    if (!draftEligible) return;
    try {
      const raw = localStorage.getItem(TASK_DRAFT_KEY);
      if (raw) setPendingDraft(JSON.parse(raw) as TaskDraft);
    } catch {
      /* ignore a malformed/blocked draft */
    }
  }, [draftEligible]);

  function saveDraft() {
    const draft: TaskDraft = {
      savedAt: new Date().toISOString(),
      company,
      project,
      campaign,
      title,
      description,
      departments,
      kind,
      approver,
      projectManager,
      assignees,
      chainMode,
      withUmbrella,
      multiMode,
      steps,
      priceInput,
    };
    try {
      localStorage.setItem(TASK_DRAFT_KEY, JSON.stringify(draft));
      setError(null);
      setDraftFlash(true);
      setTimeout(() => setDraftFlash(false), 1800);
      // A freshly-saved draft shouldn't also prompt to restore itself.
      setPendingDraft(null);
    } catch {
      setError("שמירת הטיוטה נכשלה (אחסון מקומי חסום בדפדפן)");
    }
  }
  function clearDraft() {
    try {
      localStorage.removeItem(TASK_DRAFT_KEY);
    } catch {
      /* best-effort */
    }
  }
  function applyDraft(d: TaskDraft) {
    setCompany(d.company || "");
    setProject(d.project || "");
    setCampaign(d.campaign || "");
    setTitle(d.title || "");
    setDescription(d.description || "");
    setDepartments(Array.isArray(d.departments) ? d.departments : []);
    if (d.kind) setKind(d.kind);
    setApprover(d.approver || "");
    setProjectManager(d.projectManager || "");
    setAssignees(d.assignees || "");
    setChainMode(!!d.chainMode);
    setWithUmbrella(d.withUmbrella !== false);
    setMultiMode(d.multiMode === "parallel" ? "parallel" : "joined");
    if (Array.isArray(d.steps) && d.steps.length > 0) setSteps(d.steps);
    setPriceInput(d.priceInput || "");
    priceTouched.current = !!(d.priceInput && d.priceInput.trim());
    setPendingDraft(null);
  }

  return (
    <form className="task-form" onSubmit={onSubmit}>
      {error && <div className="error">{error}</div>}

      {pendingDraft && (
        <div className="task-draft-banner" role="status">
          <span>
            📝 נמצאה טיוטה שמורה מ־
            {new Date(pendingDraft.savedAt).toLocaleString("he-IL", {
              dateStyle: "short",
              timeStyle: "short",
            })}
          </span>
          <button
            type="button"
            className="btn-primary btn-sm"
            onClick={() => applyDraft(pendingDraft)}
          >
            ↩︎ שחזר טיוטה
          </button>
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => {
              clearDraft();
              setPendingDraft(null);
            }}
          >
            מחק טיוטה
          </button>
        </div>
      )}

      <div className="task-form-row">
        <label>
          חברה
          <select
            value={company}
            onChange={(e) => {
              setCompany(e.target.value);
              setProject(""); // reset — project list changes with company
              setProjectManager(""); // reset PM until new project is picked
            }}
          >
            <option value="">בחר חברה…</option>
            {companies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        <label>
          פרויקט
          <select
            // `required` is for CREATE only — every new task must be
            // bound to a real project. EDIT mode for pseudo-projects
            // (`__personal__`) deliberately starts with an empty
            // value so the user can promote-or-keep, and the server
            // accepts an empty project on update by retaining the
            // existing pseudo. Browser-required would block the save
            // before the form's onSubmit even runs.
            required={!isEditing}
            value={project}
            onChange={(e) => onProjectChange(e.target.value)}
          >
            <option value="">
              {isEditing && editingTask?.project.startsWith("__")
                ? "השאר אישי או בחר פרויקט…"
                : "בחר פרויקט…"}
            </option>
            {companyProjects.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          בריף
          <CampaignCombobox
            value={campaign}
            onChange={setCampaign}
            options={campaignOptions}
            project={project}
            onOptionsChanged={() => setCampaignReloadNonce((n) => n + 1)}
            placeholder={
              project
                ? "בחר בריף קיים או הקלד חדש"
                : "בחר פרויקט תחילה"
            }
            disabled={!project}
            hint={
              campaignOptions.length > 0
                ? "ממוין מהחדש לישן"
                : undefined
            }
          />
        </label>
      </div>

      {/* Chain-mode bar — historically a top-level toggle to enter
          chain mode from a fresh form. Now redundant: the
          multi-assignee picker (below the assignee row, ≥2 people
          selected) carries a "🔗 שרשרת משימות →" chip that flips
          chainMode on AND pre-fills the steps. So the bar only
          renders when chainMode is already ON — its job becomes
          (1) showing the user they're in chain mode, (2) letting
          them turn it OFF, (3) exposing the withUmbrella sub-toggle.
          Reported by Maayan 2026-05-06: "scrape this here, it's only
          relevant when picking more than one assignee". */}
      {chainMode && !isEditing && (
        <div className="task-form-chain-bar is-on">
          <label
            className="task-form-chain-toggle"
            title="סר את הסימון כדי לחזור למשימה רגילה"
          >
            <input
              type="checkbox"
              checked={chainMode}
              onChange={(e) => setChainMode(e.target.checked)}
            />
            <span className="task-form-chain-toggle-label">
              📦 מצב שרשרת פעיל
            </span>
          </label>
          <label
            className="task-form-chain-umbrella-toggle"
            title="משימת־על שמרכזת את כל השלבים"
          >
            <input
              type="checkbox"
              checked={withUmbrella}
              onChange={(e) => setWithUmbrella(e.target.checked)}
            />
            <span>🔝 צור עטיפה (משימת־על)</span>
          </label>
        </div>
      )}

      <label>
        {chainMode ? "כותרת השרשרת" : "כותרת"}{" "}
        <span className="task-form-required" aria-hidden>*</span>
        <input
          type="text"
          name="title"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={
            chainMode
              ? "לדוגמה: עדכון ויזואל לקמפיין Q1"
              : "לדוגמה: Minisite_desktop — דף נחיתה לקמפיין כפר אז״ר"
          }
        />
      </label>

      <label>
        תיאור
        <textarea
          name="description"
          rows={5}
          placeholder="מה צריך לעשות, מה הקונטקסט, קישורים רלוונטיים…"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      {/* Chain-level departments are obsolete in chain mode — each
          step has its own department binding (driven by the template),
          and the per-step picker filters its assignee dropdown
          accordingly. Showing this row in chain mode confuses the
          relationship between "chain-level dept" and "step dept". */}
      {!chainMode && (
        <label>
          מחלקות{" "}
          <span className="task-form-label-hint">
            (ניתן לבחור יותר מאחת — בחירה תסנן את רשימת העובדים בהמשך)
          </span>
          <div className="task-form-dept-row">
            {departmentOptions.map((d) => {
              const emoji = roleEmoji(d);
              return (
                <button
                  key={d}
                  type="button"
                  className={`task-form-dept-chip${
                    departments.includes(d) ? " is-active" : ""
                  }`}
                  onClick={() => toggleDept(d)}
                >
                  {emoji ? (
                    <>
                      <span aria-hidden>{emoji}</span> {d}
                    </>
                  ) : (
                    d
                  )}
                </button>
              );
            })}
          </div>
        </label>
      )}

      {/* Kind picker only — priority + date moved below the Drive
          section so the natural reading order is "what is it (kind)
          → which template → where will the files live → when does
          it need to ship + how urgent." Chain mode hides this entire
          surface (each chain step has its own kind via the template). */}
      {!chainMode && (
        <label>
          סוג
          <select
            name="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            {/* When editing a task whose stored `kind` isn't in the
                schema-derived kindOptions list, surface it as an
                extra option so it stays selectable instead of
                silently downgrading on save. */}
            {isEditing &&
              editingTask!.kind &&
              !kindOptions.some((k) => k.val === editingTask!.kind) && (
                <option value={editingTask!.kind}>{editingTask!.kind}</option>
              )}
            {kindOptions.map((k) => (
              <option key={k.val} value={k.val}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* Inline template picker — only renders when the resolved kind
          folder has at least one file inside. Picking a file
          materializes a per-user draft copy via /api/worktasks/draft-
          template, which gets embedded as an editable iframe below.
          On submit, the draft folder gets re-parented into the
          task's permanent Drive folder so the issuer's edits are
          preserved. The block hides itself when (dept, kind) has no
          template binding OR the kind folder is empty. */}
      {!isEditing &&
        !chainMode &&
        primaryDept &&
        kind &&
        (templateOptions.length > 0 || optionsLoading) && (
          <label className="task-form-template-pick">
            תבנית{" "}
            <span className="task-form-label-hint">
              (אופציונלי — בחר תבנית למילוי לפני שליחה)
            </span>
            <select
              value={pickedTemplateFileId}
              onChange={(e) => setPickedTemplateFileId(e.target.value)}
              disabled={optionsLoading || draftLoading}
            >
              <option value="">
                {optionsLoading
                  ? "טוען רשימת תבניות…"
                  : "— ללא תבנית —"}
              </option>
              {templateOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.name}
                </option>
              ))}
            </select>
          </label>
        )}

      {/* Inline iframe — embedded copy of the picked template. The
          editor lives inside the form so the issuer fills it in
          place; on submit the draft folder is re-parented into the
          task's permanent Drive folder. The block hides itself when
          no template was picked or while the materialize call is in
          flight. */}
      {!isEditing && !chainMode && (draft || draftLoading) && (
        <div className="task-form-template">
          <div className="task-form-template-head">
            <span className="task-form-template-chip">
              📄 תבנית — מלא את השדות לפני השליחה
            </span>
            {draft && (
              <a
                href={draft.copyDocUrl}
                target="_blank"
                rel="noreferrer"
                className="task-form-template-newtab"
                title="פתח בכרטיסייה חדשה (לעריכה במלוא הגודל)"
              >
                ↗ פתח בכרטיסייה חדשה
              </a>
            )}
          </div>
          {draftLoading && !draft && (
            <div className="task-form-template-loading">
              טוען תבנית…
            </div>
          )}
          {draft && (
            <iframe
              key={draft.copyDocId}
              src={embeddedEditUrlFor(
                draft.copyDocId,
                draft.copyDocMimeType,
              )}
              className="task-form-template-iframe"
              title={draft.copyDocName}
              loading="lazy"
            />
          )}
        </div>
      )}

      {/* Drive folder picker hidden in chain mode — umbrella has no
          folder; each child gets its own via the standard create
          path when the chain orchestrator iterates them. */}
      {!chainMode && (
        <>
          <DriveFolderPicker
            company={company}
            project={project}
            campaign={campaign}
            defaultNewName={suggestedFolderName}
            value={folderSelection}
            onChange={handleFolderChange}
            onCampaignChange={setCampaign}
            disabled={!project}
            driveName={driveName}
            userEmail={currentUserEmail}
            accessToken={driveAccessToken}
            apiKey={drivePickerApiKey}
          />
          {/* Test-drive sibling — Google's official Drive Picker SDK,
              mounted alongside the custom picker so we can compare both
              before committing to one. Stays disabled when the access
              token or API key isn't configured (graceful no-op). When
              the user picks a folder it populates the SAME state the
              inline picker does, so the rest of the create flow doesn't
              care which one was used. */}
          <DrivePickerButton
            accessToken={driveAccessToken}
            apiKey={drivePickerApiKey}
            parentFolderId={pickerParentFolderId ?? undefined}
            disabled={!project}
            onPick={(picked) => {
              handleFolderChange({
                mode: "existing",
                folderId: picked.id,
                folderName: picked.name,
              });
            }}
          />
          {/* Files panel — same component as /tasks/[id], in
              "preview" mode (taskId="" disables tile reorder since
              there's no row to persist file_order to yet). Drag-drop
              upload from desktop still works; files land in the
              currently selected folder via SA. Once the user submits
              and the task exists, the live-task page picks up where
              this leaves off. Hidden until the user has actually
              picked an existing folder — `mode: "new"` means the
              folder doesn't exist in Drive yet so there's nothing to
              upload INTO. */}
          {folderSelection.mode === "existing" &&
            !!folderSelection.folderId && (
              <TaskFilesPanel
                taskId=""
                folderId={folderSelection.folderId}
                company={company}
                project={project}
                campaign={campaign}
                taskTitle={title}
                fileOrder=""
              />
            )}
        </>
      )}

      {/* Priority + requested date — moved here from the kind row so
          the form's reading order is task definition (above) →
          scheduling (here). Two columns instead of three since kind
          is no longer in this row. Hidden in chain mode (the umbrella
          has no own scheduling). */}
      {!chainMode && (
        <div className="task-form-row task-form-row-2col">
          <label>
            דחיפות
            <select
              name="priority"
              defaultValue={
                isEditing ? String(editingTask!.priority || 2) : "2"
              }
            >
              <option value="1">1 — גבוהה</option>
              <option value="2">2 — רגילה</option>
              <option value="3">3 — נמוכה</option>
            </select>
          </label>

          <label className="task-form-date-time">
            תאריך מבוקש
            <div className="date-time-inputs">
              <DatePicker
                name="requested_date"
                defaultValue={
                  isEditing
                    ? (editingTask!.requested_date || "").match(
                        /^\d{4}-\d{2}-\d{2}/,
                      )?.[0]
                    : tomorrowIso
                }
              />
              {/* Native <input type="time"> replaced with the M3
                  input-mode picker. Hidden mirror keeps the form's
                  `requested_time` submission identical so the
                  surrounding submit handler doesn't change. */}
              <TimePicker
                name="requested_time"
                ariaLabel="שעה (אופציונלי)"
                defaultValue={
                  isEditing
                    ? (editingTask!.requested_date || "").match(
                        /[T\s](\d{2}:\d{2})/,
                      )?.[1]
                    : undefined
                }
              />
            </div>
          </label>
        </div>
      )}

      {/* Step picker for chain mode — each row is a sequential step
          with its own title + assignees. The chain orchestrator
          applies blocks/blocked_by edges in order; first step starts
          immediately, the rest start blocked until cascade unblocks
          them. Per-step approver/due/departments could expand here
          later; v1 keeps the row compact (chain-level approver +
          departments inherited). */}
      {chainMode && (
        <fieldset className="task-form-chain-steps">
          <legend>
            שלבים בשרשרת
            {showPricing && chainPriceTotal > 0 && (
              <span className="task-form-chain-total">
                {" "}· סה״כ תמחור משוער: {fmtILS(chainPriceTotal)}
              </span>
            )}
          </legend>
          <div className="task-form-chain-steps-help">
            כל שלב נפתח אוטומטית כשהשלב הקודם מסומן בוצע. השלב הראשון מתחיל מיד; השאר ממתינים בסטטוס &quot;חסום&quot;.
            {showPricing && (
              <>
                {" "}לכל שלב אפשר לבחור מחלקה + סוג — המחיר נשלף
                אוטומטית מהמחירון (ניתן לעקוף ידנית).
              </>
            )}
          </div>

          {/* Phase 8 polish — template picker. Picking a template
              pre-fills steps + umbrella title (when empty). User
              still fills in assignees + can edit step titles. */}
          <label className="task-form-chain-template-row">
            <span>תבנית</span>
            <select
              value={chainTemplateId}
              onChange={(e) => applyChainTemplate(e.target.value)}
            >
              <option value="">— ללא תבנית (הקמה ידנית) —</option>
              {effectiveChainTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>

          {steps.map((s, i) => {
            // Per-step filtering — when the step has a department
            // bound (from the template), narrow the datalist to people
            // with that role on names-to-emails. Empty department =
            // "any role" → falls back to the chain-level filteredPeople
            // (which respects the chain's department chips, if any).
            const stepDept = (s.department || "").trim().toLowerCase();
            const stepPeople = stepDept
              ? people.filter(
                  (p) => (p.role || "").trim().toLowerCase() === stepDept,
                )
              : filteredPeople;
            const datalistId = `tasks-people-chain-${i}`;
            const stepKinds = kindsForDept(s.department || "");
            const stepResolved = resolveStepPrice(s);
            return (
              <div key={i} className="task-form-chain-step">
              <div className="task-form-chain-step-row">
                <span className="task-form-chain-step-num">{i + 1}</span>
                <input
                  type="text"
                  value={s.title}
                  onChange={(e) => {
                    const next = [...steps];
                    next[i] = { ...next[i], title: e.target.value };
                    setSteps(next);
                  }}
                  placeholder={`שלב ${i + 1} — כותרת (לדוגמה: קופי)`}
                  className="task-form-chain-step-title"
                />
                {/* מחלקה comes BEFORE the assignee: picking it narrows
                    the עובד autocomplete to that department's people
                    (and seeds kind/price below). */}
                <select
                  aria-label={`מחלקה לשלב ${i + 1}`}
                  className="task-form-chain-step-dept"
                  value={s.department || ""}
                  onChange={(e) => {
                    const next = [...steps];
                    // Department change resets kind (kinds are
                    // department-scoped) + the resolved price.
                    next[i] = {
                      ...next[i],
                      department: e.target.value,
                      kind: "",
                      priceTouched: false,
                      price: undefined,
                    };
                    setSteps(next);
                  }}
                >
                  <option value="">מחלקה…</option>
                  {departmentOptions.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={s.assignees}
                  onChange={(e) => {
                    const val = e.target.value;
                    const next = [...steps];
                    next[i] = { ...next[i], assignees: val };
                    // Auto-derive the step's מחלקה from the FIRST picked
                    // assignee's role — but only when no department has
                    // been chosen yet, so a manual pick is never clobbered.
                    // The person already implies their department, so the
                    // user shouldn't have to pick it separately.
                    if (!next[i].department) {
                      const firstEmail = val
                        .split(/[,;\n]/)
                        .map((x) => x.trim())
                        .filter(Boolean)[0];
                      const role = firstEmail
                        ? emailToRole.get(firstEmail.toLowerCase()) || ""
                        : "";
                      const matchDept = role
                        ? departmentOptions.find(
                            (d) => d.toLowerCase() === role.toLowerCase(),
                          )
                        : undefined;
                      if (matchDept) {
                        next[i] = {
                          ...next[i],
                          department: matchDept,
                          // Department drives kind/price scoping — reset
                          // them so the new department's rate resolves.
                          kind: "",
                          priceTouched: false,
                          price: undefined,
                        };
                      }
                    }
                    setSteps(next);
                  }}
                  placeholder={
                    s.assigneeHint
                      ? `מבצע — ${s.assigneeHint}`
                      : stepDept
                        ? "בחר/י עובד מהמחלקה"
                        : "מבצע — name@fandf.co.il"
                  }
                  list={datalistId}
                  className="task-form-chain-step-assignee"
                  title={
                    s.assigneeHint
                      ? `הצעה: ${s.assigneeHint}${
                          stepDept ? ` (מסונן ל-${stepDept})` : ""
                        }`
                      : stepDept
                        ? `מסונן ל-${stepDept}`
                        : undefined
                  }
                />
                {/* One datalist per step row, ID-suffixed by index, so
                    the autocomplete narrows correctly per step's role. */}
                <datalist id={datalistId}>
                  {stepPeople.map((p) => (
                    <option key={p.email} value={p.email}>
                      {displayNameOf(p)} · {p.role}
                    </option>
                  ))}
                </datalist>
                {/* Optional per-step due date — defaults to tomorrow,
                    applied to this child row by the chain orchestrator. */}
                <DatePicker
                  value={s.requested_date || ""}
                  onChange={(iso) => {
                    const next = [...steps];
                    next[i] = { ...next[i], requested_date: iso };
                    setSteps(next);
                  }}
                  ariaLabel={`תאריך יעד לשלב ${i + 1}`}
                  className="task-form-chain-step-date"
                  placeholder="תאריך יעד"
                />
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => setSteps(steps.filter((_, j) => j !== i))}
                  disabled={steps.length === 1}
                  aria-label={`הסר שלב ${i + 1}`}
                  title="הסר שלב"
                >
                  ✕
                </button>
              </div>
              {showPricing && (
                <div className="task-form-chain-step-pricing">
                  <span className="task-form-chain-step-pricing-lead">
                    {s.department ? `${s.department} ·` : "תמחור:"}
                  </span>
                  <select
                    aria-label={`סוג לשלב ${i + 1}`}
                    value={s.kind || ""}
                    disabled={!s.department}
                    onChange={(e) => {
                      const next = [...steps];
                      next[i] = {
                        ...next[i],
                        kind: e.target.value,
                        priceTouched: false,
                        price: undefined,
                      };
                      setSteps(next);
                    }}
                  >
                    <option value="">סוג…</option>
                    {stepKinds.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    aria-label={`מחיר לשלב ${i + 1}`}
                    className="task-form-chain-step-price"
                    value={effectiveStepPrice(s)}
                    placeholder={
                      stepResolved != null
                        ? String(stepResolved)
                        : "מחיר ₪"
                    }
                    onChange={(e) => {
                      const next = [...steps];
                      next[i] = {
                        ...next[i],
                        price: e.target.value,
                        priceTouched: true,
                      };
                      setSteps(next);
                    }}
                  />
                  <span className="task-form-chain-step-pricehint">
                    {!s.department || !s.kind
                      ? "בחר/י מחלקה+סוג"
                      : stepResolved != null
                        ? s.priceTouched
                          ? "ידני"
                          : "מהמחירון"
                        : "אין במחירון — הזן/י ידנית"}
                  </span>
                </div>
              )}
              </div>
            );
          })}
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() =>
              setSteps([
                ...steps,
                { title: "", assignees: "", requested_date: tomorrowIso },
              ])
            }
          >
            + הוסף שלב
          </button>
        </fieldset>
      )}

      {/* Approver / PM / assignees only apply to single tasks. In
          chain mode the umbrella has no assignee; per-step assignees
          live in the step picker above. The approver is shared
          across the chain (single approver acts as the gate for
          every step's `awaiting_approval` transition). */}
      {!chainMode && (
      <div className="task-form-row">
        <label>
          גורם מאשר
          <PersonCombobox
            value={approver}
            onChange={setApprover}
            options={people}
            placeholder="חפש לפי שם או מייל"
          />
        </label>

        <label>
          מנהל פרויקט
          <PersonCombobox
            value={projectManager}
            onChange={setProjectManager}
            options={projectManagerCandidates}
            placeholder="חפש לפי שם או מייל"
            hint={defaultPm ? "ברירת מחדל: מנהל הפרויקט מ־Keys" : undefined}
          />
        </label>

        <label>
          עובדים במשימה
          {/* PeopleMultiCombobox replaces the previous CSV textarea —
              same store format (comma-separated emails) but rendered
              with Hebrew name chips inside a combobox-styled box, to
              match the גורם מאשר / מנהל פרויקט fields beside it.
              Reported by Maayan 2026-05-06. The bubble row below
              still works as a quick-toggle, useful for picking a
              whole team at once. */}
          <PeopleMultiCombobox
            value={assignees}
            onChange={setAssignees}
            options={filteredPeople.length > 0 ? filteredPeople : people}
            placeholder="חפש לפי שם או מייל"
          />
          {departments.length > 0 && (
            <div className="task-form-dept-filter-line">
              מסונן לפי{" "}
              {departments.map((d) => (
                <span key={d} className="task-form-dept-filter-pill">
                  {d}
                </span>
              ))}
              {filteredPeople.length === 0 && (
                <span className="task-form-dept-filter-empty">
                  אין עובדים תחת מחלקות אלה — בחר אחרות או הסר סינון
                </span>
              )}
            </div>
          )}
          {filteredPeople.length > 0 && (
            <div className="task-form-assignee-chips">
              {filteredPeople.slice(0, 24).map((p) => {
                const already = assignees
                  .split(/[,;\n]/)
                  .map((s) => s.trim().toLowerCase())
                  .includes(p.email.toLowerCase());
                return (
                  <button
                    key={p.email}
                    type="button"
                    className={`task-form-assignee-chip${
                      already ? " is-active" : ""
                    }`}
                    title={avatarHoverText(displayNameOf(p), p.email, p.role)}
                    onClick={() => {
                      // Toggle: click once to append, click again to remove
                      // (matches the department chip row pattern above).
                      if (already) {
                        const next = assignees
                          .split(/[,;\n]/)
                          .map((s) => s.trim())
                          .filter(
                            (s) =>
                              s.toLowerCase() !== p.email.toLowerCase(),
                          )
                          .join(", ");
                        setAssignees(next);
                      } else {
                        const cleaned = assignees.replace(/[,;\s]+$/g, "");
                        setAssignees(
                          cleaned ? `${cleaned}, ${p.email}` : p.email,
                        );
                      }
                    }}
                  >
                    <Avatar name={p.email} size={18} />
                    {displayNameOf(p)}
                  </button>
                );
              })}
            </div>
          )}
          {/* Multi-assignee mode picker — appears once 2+ people are
              selected (single-assignee tasks have no choice to surface).
              Three options:
                joined   = current behavior: one task, all assignees jointly own it
                parallel = new: 1 umbrella + N peer children, each owned by one person
                chain    = existing chain UX: pre-fill steps from picked assignees + flip into it
              Default stays at "joined" — preserves the historical UX
              for users who don't actively pick a different mode. */}
          {(() => {
            // Multi-mode picker is only meaningful for new tasks. In edit
            // mode the row is already a single shared task — converting
            // to parallel/chain post-creation is a different operation
            // (would have to spawn umbrella + migrate references) and
            // isn't supported from the edit surface.
            if (isEditing) return null;
            const picked = assignees
              .split(/[,;\n]/)
              .map((s) => s.trim())
              .filter(Boolean);
            if (picked.length < 2) return null;
            return (
              <div
                className="task-form-multi-mode-row"
                role="radiogroup"
                aria-label="אופן חלוקת המשימה בין מספר מבצעים"
              >
                <span className="task-form-multi-mode-hint">
                  בחרת {picked.length} אנשים — איך לשייך?
                </span>
                <button
                  type="button"
                  role="radio"
                  aria-checked={multiMode === "joined"}
                  className={`task-form-multi-mode-chip${
                    multiMode === "joined" ? " is-active" : ""
                  }`}
                  onClick={() => setMultiMode("joined")}
                  title="משימה אחת משותפת — כולם בעלים יחד"
                >
                  <span aria-hidden>👥</span> משימה משותפת
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={multiMode === "parallel"}
                  className={`task-form-multi-mode-chip${
                    multiMode === "parallel" ? " is-active" : ""
                  }`}
                  onClick={() => setMultiMode("parallel")}
                  title="מטריה אחת + תת-משימה לכל אדם, ללא תלות ביניהן"
                >
                  <span aria-hidden>🌂</span> מטריה עם משימות מקבילות
                </button>
                <button
                  type="button"
                  className="task-form-multi-mode-chip task-form-multi-mode-chip-action"
                  onClick={() => {
                    // Switch the form into chain mode + pre-populate
                    // steps from the picked assignees. Each step gets
                    // the form's current title (or empty) and ONE
                    // email. The user can then refine order / titles /
                    // per-step depts in the chain UX before submit.
                    const chainSteps = picked.map((email) => ({
                      title: title.trim() || "",
                      assignees: email,
                      // Auto-derive each step's מחלקה from the picked
                      // person's role (the assignee already implies it).
                      department:
                        departmentOptions.find(
                          (d) =>
                            d.toLowerCase() ===
                            (emailToRole.get(email.trim().toLowerCase()) || "")
                              .toLowerCase(),
                        ) || undefined,
                      requested_date: tomorrowIso,
                    }));
                    // Chain UI requires at least 2 step rows visually;
                    // pad with blanks if only 2 picked but the user
                    // wants to add more.
                    while (chainSteps.length < 2) {
                      chainSteps.push({
                        title: "",
                        assignees: "",
                        department: undefined,
                        requested_date: tomorrowIso,
                      });
                    }
                    setSteps(chainSteps);
                    setChainMode(true);
                    // Reset the multiMode so re-toggling chain off
                    // returns to the default "joined" presentation.
                    setMultiMode("joined");
                  }}
                  title="פתח עורך שרשרת ומלא שלב לכל אדם — סדר ההעברה ניתן לשינוי"
                >
                  <span aria-hidden>🔗</span> שרשרת משימות →
                </button>
              </div>
            );
          })()}
        </label>
      </div>
      )}

      {/* Chain-mode shared approver — sits inline below the step
          picker, applies to every step. PM stays implicit (umbrella
          inherits from Keys). */}
      {chainMode && (
        <label className="task-form-chain-shared-approver">
          גורם מאשר משותף לכל השלבים{" "}
          <span className="task-form-label-hint">(אופציונלי — חל על כל שלב שעובר ל&quot;ממתין לאישור&quot;)</span>
          <PersonCombobox
            value={approver}
            onChange={setApprover}
            options={people}
            placeholder="חפש לפי שם או מייל"
          />
        </label>
      )}

      {/* תמחור — single compact row (chain mode uses per-step pricing
          instead, so the single-task field is hidden there). The full
          per-department breakdown is surfaced in the input's tooltip. */}
      {showPricing && !chainMode && (
        <div className="task-pricing-row" aria-live="polite">
          <span className="task-pricing-row-label">💰 מחיר המשימה (₪)</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="1"
            name="price"
            className="task-pricing-row-input"
            value={priceInput}
            onChange={(e) => {
              priceTouched.current = true;
              setPriceInput(e.target.value);
            }}
            placeholder={
              pricingResult.hasAny ? String(pricingResult.total) : "הזן/י מחיר"
            }
            title={
              pricingResult.lines.length
                ? pricingResult.lines
                    .map(
                      (l) =>
                        `${l.department} · ${kind}: ${
                          l.unitPrice == null
                            ? "אין תמחור מוגדר"
                            : `${fmtILS(l.unitPrice)} (${
                                l.basis === "project"
                                  ? "לפי פרוייקט"
                                  : "לפי חברה"
                              })`
                        }`,
                    )
                    .join("\n")
                : undefined
            }
          />
          <span className="task-pricing-row-hint">
            {departments.length === 0 || !kind
              ? "בחר/י מחלקה + סוג לתמחור אוטומטי"
              : pricingResult.hasAny
                ? priceTouched.current
                  ? "מחיר ידני"
                  : `מהמחירון · סה״כ ${fmtILS(pricingResult.total)}`
                : "אין במחירון — הזן/י ידנית"}
          </span>
          {priceTouched.current && pricingResult.hasAny && (
            <button
              type="button"
              className="task-pricing-reset"
              onClick={() => {
                priceTouched.current = false;
                setPriceInput(String(pricingResult.total));
              }}
            >
              איפוס למחירון
            </button>
          )}
        </div>
      )}

      <div className="task-form-actions">
        <button
          type="submit"
          className="btn-primary"
          disabled={saving}
          onClick={() => {
            submitModeRef.current = "plain";
          }}
        >
          {isEditing
            ? saving ? "שומר…" : "💾 שמור"
            : saving
              ? chainMode ? "יוצר שרשרת…" : "יוצר…"
              : chainMode ? "📦 צור שרשרת" : "צור משימה"}
        </button>
        {!isEditing && (
          <button
            type="button"
            className="btn-ghost"
            disabled={saving}
            onClick={saveDraft}
            title="שמירת הטופס כטיוטה מקומית — אפשר לחזור ולהמשיך מאוחר יותר"
          >
            {draftFlash ? "✓ נשמרה טיוטה" : "📝 שמור טיוטה"}
          </button>
        )}
        {isEditing && editingTask && (
          <button
            type="button"
            className="btn-ghost"
            disabled={saving}
            onClick={() =>
              router.replace(`/tasks/${encodeURIComponent(editingTask.id)}`)
            }
          >
            ביטול
          </button>
        )}
        {!isEditing && cleanupGmailTaskId && (
          <button
            type="submit"
            className="btn-primary"
            disabled={saving}
            onClick={() => {
              submitModeRef.current = "cleanup";
            }}
            title="יצירת משימה ב-Hub + סימון משימת ה-Google Tasks המקורית כהושלמה"
          >
            {saving ? "יוצר…" : "צור משימה ונקה את ה-Gmail task"}
          </button>
        )}
      </div>
    </form>
  );
}

/** Build the correct embedded edit URL for a Drive doc based on its
 *  Google mime type. Docs / Sheets / Slides each live at a different
 *  `docs.google.com/...` path; non-Google file types (PDFs, raw
 *  uploads) don't have an embeddable editor — fall back to Drive's
 *  generic preview, which renders them read-only. */
function embeddedEditUrlFor(docId: string, mimeType: string): string {
  switch (mimeType) {
    case "application/vnd.google-apps.document":
      return `https://docs.google.com/document/d/${docId}/edit?embedded=true&rm=demo`;
    case "application/vnd.google-apps.spreadsheet":
      return `https://docs.google.com/spreadsheets/d/${docId}/edit?embedded=true&rm=demo`;
    case "application/vnd.google-apps.presentation":
      return `https://docs.google.com/presentation/d/${docId}/edit?embedded=true&rm=demo`;
    default:
      return `https://drive.google.com/file/d/${docId}/preview`;
  }
}
