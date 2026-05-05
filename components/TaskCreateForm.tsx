"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { TasksPerson } from "@/lib/appsScript";
import CampaignCombobox from "./CampaignCombobox";
import DatePicker from "./DatePicker";
import PersonCombobox from "./PersonCombobox";
import DrivePickerButton from "./DrivePickerButton";
import { displayNameOf } from "@/lib/personDisplay";
import DriveFolderPicker, {
  type FolderPickerValue,
} from "./DriveFolderPicker";
import {
  CHAIN_TEMPLATES,
  type ChainTemplate,
} from "@/lib/chainTemplates";

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
}) {
  const router = useRouter();
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

  const defaultProjectOpt = projects.find((p) => p.name === defaultProject);
  // Company defaults: project pick wins (auto-derived); else the explicit
  // ?company param; else empty.
  const defaultCompany = defaultProjectOpt?.company || defaultCompanyProp || "";
  const defaultPm = defaultProjectOpt
    ? nameToEmail.get(defaultProjectOpt.projectManagerFull.trim().toLowerCase()) || ""
    : "";

  const [company, setCompany] = useState(defaultCompany);
  const [project, setProject] = useState(defaultProject);
  const [departments, setDepartments] = useState<string[]>([]);
  const [projectManager, setProjectManager] = useState(defaultPm);
  const [approver, setApprover] = useState("");
  const [assignees, setAssignees] = useState(defaultAssignees);
  const [campaign, setCampaign] = useState("");
  const [title, setTitle] = useState(defaultTitle);
  // Phase 5b — chain mode. When the user opts in, the form switches
  // to a multi-step picker: the title is the umbrella's title, and
  // the body becomes a list of step rows (title + assignees per step).
  // Submit goes to /api/worktasks/create-chain instead of /create.
  // Default OFF preserves the standard single-task UX as the dominant
  // path (per the locked design — most quick client requests are NOT
  // chains).
  const [chainMode, setChainMode] = useState(false);
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
     *  Empty/undefined = "any role". Comes from the template; NOT
     *  user-editable in the standard create form (the admin chain
     *  builder manages template departments). */
    department?: string;
  };
  const [steps, setSteps] = useState<ChainStep[]>([
    { title: "", assignees: "" },
    { title: "", assignees: "" },
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

  // Departments — schema sheet wins when provided; falls back to the
  // live `Role` column on names-to-emails; falls back to the hardcoded
  // list. The schema is the authoritative source once admin has shaped
  // it via /admin/task-form-schema.
  const departmentOptions = useMemo(() => {
    if (formSchema && formSchema.departments.length > 0) {
      return formSchema.departments;
    }
    const set = new Set<string>();
    for (const p of people) {
      const r = (p.role || "").trim();
      if (r) set.add(r);
    }
    if (set.size === 0) return DEPARTMENTS_FALLBACK;
    return Array.from(set).sort((a, b) => a.localeCompare(b, "he"));
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

    // Phase 5b chain branch — when the user opted into "צור כשרשרת",
    // build the chain payload and POST to the chain endpoint instead
    // of the standalone-create endpoint. Validation: at least one
    // step with a title (the orchestrator throws otherwise; we surface
    // it earlier for nicer UX).
    if (chainMode) {
      const trimmedSteps = steps
        .map((s) => ({
          title: s.title.trim(),
          assignees: s.assignees
            .split(/[,;\n]/)
            .map((x) => x.trim())
            .filter(Boolean),
        }))
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
          description: String(fd.get("description") || ""),
        },
        steps: trimmedSteps.map((s) => ({
          title: s.title,
          assignees: s.assignees,
          // Per-step approver / departments / due could be exposed in
          // a richer step editor later; v1 keeps the row compact.
          approver_email: approver,
          departments,
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

    const payload: Record<string, unknown> = {
      project: project,
      company: company, // falls back to Keys lookup server-side if empty
      brief: String(fd.get("brief") || ""),
      title: title,
      description: String(fd.get("description") || ""),
      departments,
      kind: String(fd.get("kind") || ""),
      priority: Number(fd.get("priority") || "2"),
      approver_email: approver,
      project_manager_email: projectManager,
      assignees: assigneeList,
      requested_date: requestedDate,
      campaign: campaign.trim(),
    };
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
      router.push(`/tasks/${encodeURIComponent(data.task.id)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  const companies = Array.from(byCompany.keys()).filter(Boolean).sort();

  return (
    <form className="task-form" onSubmit={onSubmit}>
      {error && <div className="error">{error}</div>}

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
            required
            value={project}
            onChange={(e) => onProjectChange(e.target.value)}
          >
            <option value="">בחר פרויקט…</option>
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

      {/* Phase 5b dependencies — chain-mode toggle bar. Sits as a
          dedicated banner-style row above the title field so it's
          discoverable but not intrusive. When on, expands to show
          the umbrella sub-toggle + step picker takes over the body. */}
      <div className={`task-form-chain-bar${chainMode ? " is-on" : ""}`}>
        <label className="task-form-chain-toggle">
          <input
            type="checkbox"
            checked={chainMode}
            onChange={(e) => setChainMode(e.target.checked)}
          />
          <span className="task-form-chain-toggle-label">
            📦 צור כשרשרת
          </span>
          <span className="task-form-chain-toggle-hint">
            כמה שלבים עם העברה אוטומטית בין מבצעים
          </span>
        </label>
        {chainMode && (
          <label className="task-form-chain-umbrella-toggle">
            <input
              type="checkbox"
              checked={withUmbrella}
              onChange={(e) => setWithUmbrella(e.target.checked)}
            />
            <span>
              🔝 צור עטיפה (משימת־על שמרכזת את כל השלבים)
            </span>
          </label>
        )}
      </div>

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
          defaultValue={defaultDescription}
        />
      </label>

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
        </>
      )}

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
            {departmentOptions.map((d) => (
              <button
                key={d}
                type="button"
                className={`task-form-dept-chip${
                  departments.includes(d) ? " is-active" : ""
                }`}
                onClick={() => toggleDept(d)}
              >
                {d}
              </button>
            ))}
          </div>
        </label>
      )}

      {/* Kind / priority / date are per-task concerns — in chain mode
          they'd apply to the umbrella, which has no own work. Hide
          them; each child step inherits chain-level departments and
          gets its own assignees via the step picker below. */}
      {!chainMode && (
        <div className="task-form-row">
          <label>
            סוג
            <select
              name="kind"
              defaultValue={kindOptions[0]?.val ?? "ad_creative"}
              key={kindOptions.map((k) => k.val).join("|")}
            >
              {kindOptions.map((k) => (
                <option key={k.val} value={k.val}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            דחיפות
            <select name="priority" defaultValue="2">
              <option value="1">1 — גבוהה</option>
              <option value="2">2 — רגילה</option>
              <option value="3">3 — נמוכה</option>
            </select>
          </label>

          <label className="task-form-date-time">
            תאריך מבוקש
            <div className="date-time-inputs">
              <DatePicker name="requested_date" />
              <input
                type="time"
                name="requested_time"
                aria-label="שעה (אופציונלי)"
                title="שעה (אופציונלי)"
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
          <legend>שלבים בשרשרת</legend>
          <div className="task-form-chain-steps-help">
            כל שלב נפתח אוטומטית כשהשלב הקודם מסומן בוצע. השלב הראשון מתחיל מיד; השאר ממתינים בסטטוס &quot;חסום&quot;.
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
            return (
              <div key={i} className="task-form-chain-step-row">
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
                <input
                  type="text"
                  value={s.assignees}
                  onChange={(e) => {
                    const next = [...steps];
                    next[i] = { ...next[i], assignees: e.target.value };
                    setSteps(next);
                  }}
                  placeholder={
                    s.assigneeHint
                      ? `מבצע — ${s.assigneeHint}`
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
            );
          })}
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() =>
              setSteps([...steps, { title: "", assignees: "" }])
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
            options={people}
            placeholder="חפש לפי שם או מייל"
            hint={defaultPm ? "ברירת מחדל: מנהל הפרויקט מ־Keys" : undefined}
          />
        </label>

        <label>
          עובדים במשימה
          <textarea
            rows={2}
            value={assignees}
            onChange={(e) => setAssignees(e.target.value)}
            placeholder="felix@fandf.co.il, nadav@fandf.co.il"
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
                    title={`${displayNameOf(p)} · ${p.role}`}
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
                    {displayNameOf(p)}
                  </button>
                );
              })}
            </div>
          )}
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

      {currentUserEmail && (
        <div className="task-form-author-line">
          כותב המשימה: <b dir="ltr">{currentUserEmail}</b>
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
          {saving
            ? chainMode ? "יוצר שרשרת…" : "יוצר…"
            : chainMode ? "📦 צור שרשרת" : "צור משימה"}
        </button>
        {cleanupGmailTaskId && (
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
