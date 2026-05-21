"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { projectHref } from "@/lib/projectHref";
import { useRouter } from "next/navigation";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { WorkTask, WorkTaskStatus, TasksPerson } from "@/lib/appsScript";

/** Sort axes exposed via clickable column headers. `rank` is the
 *  drag-driven manual order (default); the rest sort within each
 *  bucket. `status` is most useful when the user is grouping by
 *  something OTHER than status (e.g. assignee) — it surfaces each
 *  person's pending work first, in-progress next, done last. */
export type TasksSortKey =
  | "rank"
  | "title"
  | "priority"
  | "requested_date"
  | "created_at"
  | "updated_at"
  | "status";
export type TasksSortOrder = "asc" | "desc";
import TaskStatusCell, { STATUS_EMOJIS } from "@/components/TaskStatusCell";
import GoogleDriveIcon from "@/components/GoogleDriveIcon";
import CopyLocalPathButton from "@/components/CopyLocalPathButton";
import { buildLocalDrivePaths } from "@/lib/localDrivePath";
import TasksBulkBar from "@/components/TasksBulkBar";
import {
  TaskPriorityCell,
  TaskRequestedDateCell,
  TaskApproverCell,
  TaskAssigneesCell,
} from "@/components/TaskInlineEditors";
import { compareByRank, computeInsertRank } from "@/lib/taskRank";
import { personDisplayName } from "@/lib/personDisplay";
import { displayProjectOrCompany } from "@/lib/personalLabel";
import { kindLabel } from "@/lib/kindLabel";
import {
  TASK_USER_STATE_LABELS,
  type TaskUserState,
} from "@/lib/taskUserState";
import Avatar, { avatarHoverText } from "@/components/Avatar";
import { roleEmoji, roleLabel } from "@/components/RoleChip";
import { useTaskPreview } from "@/components/TaskPreviewProvider";

/** Render-time label for a bucket key under a non-status group axis.
 *  For the assignee axis we also surface a small avatar via the
 *  `humanizeBucketAvatar` companion below — but the label-only path
 *  is what the bucket-header text uses. Falls back to the raw key
 *  for unmappable values so nothing renders blank. */
function humanizeBucketKey(
  key: string,
  axis: string,
  people: TasksPerson[],
): string {
  // Sentinel "no value" markers — same set used in bucketKeysFor above.
  const SENTINELS: Record<string, string> = {
    __no_company__: "ללא חברה",
    __no_project__: "ללא פרויקט",
    __no_campaign__: "ללא בריף",
    __no_department__: "ללא מחלקה",
    __no_assignee__: "ללא משויך",
    __standalone__: "ללא מטריה",
    __all__: "כל המשימות",
    __unknown__: "—",
  };
  if (key in SENTINELS) return SENTINELS[key];
  if (axis === "assignee") {
    return personDisplayName(key, people) || key;
  }
  if (axis === "department") {
    // Prefer the canonical English label (matches the dept chip on
    // each row); fall back to whatever's stored when unrecognized.
    return roleLabel(key);
  }
  if (axis === "umbrella") {
    // Bucket key is the umbrella's task id. Look it up in the page's
    // task list to surface its title — graceful fallback to the id.
    // Note: this lookup is O(n) per umbrella bucket; acceptable
    // since the bucket count is small.
    return key;
  }
  return key;
}

// Canonical lifecycle buckets, ordered left-to-right (RTL: right-to-
// left on screen) the way work actually flows:
//   ממתין לטיפול → בעבודה → ממתין לאישור → בוצע, with ממתין לבירור
// parked alongside as the blocked-for-info bucket.
// Only true drafts surface in the "other" fold now; `blocked` has its
// own visible section (added below) and `cancelled` is a real bucket.
//
// `archiveAfterDays` (when set) splits the bucket: rows with
// `updated_at` newer than the cutoff render normally; older rows
// collapse into a single <details> fold below them so the queue
// doesn't grow unboundedly with terminal-state work.
//
// Note: there used to be a per-bucket `groupBy` axis (assignee /
// approver / company / none) that would split each bucket into sub-
// header bands. Once rank-based manual ordering replaced the
// chronological within-bucket sort, sub-groups fought with rank — a
// dragged row could land in a "different person's" visual band even
// though its rank was correct. Sub-grouping is now permanently off;
// the per-row company / assignee / approver columns surface the same
// facts without overriding rank order.
const DEFAULT_ARCHIVE_AFTER_DAYS = 14;
const STATUS_BUCKETS: {
  key: WorkTaskStatus;
  label: string;
  tone: string;
  /** Whether this bucket is a "terminal" state — done/cancelled that
   *  trigger the per-bucket >N-day fold AND whose entire bucket
   *  collapses when the user has hide_archived turned on at the
   *  page level. */
  isTerminal?: boolean;
}[] = [
  { key: "awaiting_handling", label: "ממתין לטיפול", tone: "awaiting_handling" },
  { key: "in_progress", label: "בעבודה", tone: "in_progress" },
  { key: "awaiting_clarification", label: "ממתין לבירור", tone: "awaiting_clarification" },
  { key: "awaiting_approval", label: "ממתין לאישור", tone: "awaiting_approval" },
  // Blocked = waiting on a dependency. Its own visible section so the
  // worker sees what's coming, but it is NOT actionable (excluded from
  // the nav badge). When the dependency cascade clears it, the task
  // flips to awaiting_handling and moves into the active flow above.
  // Not terminal, so it never archive-folds. Previously it fell into the
  // "other"/drafts fold, which mislabeled blocked tasks as drafts.
  { key: "blocked", label: "חסום", tone: "blocked" },
  { key: "done", label: "בוצע", tone: "done", isTerminal: true },
  // Cancelled used to live in the collapsed "other" fold, but now that
  // it's a revivable state (awaiting_handling / in_progress targets in
  // the menu) users need to see it — otherwise cancelling a task makes
  // it look like it disappeared.
  { key: "cancelled", label: "בוטל", tone: "cancelled", isTerminal: true },
];

/** Split a list of terminal-state tasks into "recent" + "older". Uses
 *  `updated_at` (ISO) as the freshness signal — that's the timestamp
 *  set when the status flipped to done/cancelled. Falls back to
 *  `created_at` for tasks somehow missing an updated_at. */
function partitionByAge(
  tasks: WorkTask[],
  thresholdDays: number,
): { recent: WorkTask[]; older: WorkTask[] } {
  const cutoff = Date.now() - thresholdDays * 24 * 60 * 60 * 1000;
  const recent: WorkTask[] = [];
  const older: WorkTask[] = [];
  for (const t of tasks) {
    const stamp = t.updated_at || t.created_at;
    const ms = stamp ? new Date(stamp).getTime() : NaN;
    if (Number.isFinite(ms) && ms >= cutoff) recent.push(t);
    else if (Number.isFinite(ms)) older.push(t);
    else recent.push(t); // fail-open if we can't parse the timestamp
  }
  return { recent, older };
}

type Props = {
  tasks: WorkTask[];
  /**
   * Whether to group rows by company → project inside each bucket.
   * True on the portfolio-wide queue (`/tasks`) where you're looking
   * across companies; false on a project-scoped page where the project
   * is already implicit in the page header.
   */
  groupByCompany?: boolean;
  /**
   * Text to show when there are zero tasks in any bucket. Callers can
   * customize this for e.g. "no tasks on this project yet" vs. the
   * portfolio-wide "no tasks matching your filters".
   */
  emptyMessage?: string;
  /**
   * When true, the "other" fold (draft + cancelled) is hidden to reduce
   * visual noise on compact surfaces like the project page. Defaults
   * to false so the main queue keeps showing it.
   */
  hideOther?: boolean;
  /**
   * Compact layout — smaller column padding, drops the redundant
   * "פרויקט" column (implied when the caller is a project-scoped page)
   * and the description preview. Used on /projects/[project] so the
   * queue section sits cleanly alongside the other sections on the
   * page instead of forcing a wide horizontal scroll.
   */
  compact?: boolean;
  /**
   * People list — used by the inline-edit popovers on the assignees
   * and approver cells. When empty, those cells fall back to plain
   * text (no autocomplete). Callers should pass the same
   * tasksPeopleList() payload they already fetch for the filter bar.
   */
  people?: TasksPerson[];
  /**
   * Shared-drive name for the Drive Desktop local-path button on each
   * row. When empty (e.g. SA doesn't resolve it), the row's "open in
   * Explorer" button is hidden. Path format:
   *   Windows: G:\Shared drives\<driveName>\<company>\<project>[\<campaign>]
   *   macOS:   ~/Library/CloudStorage/GoogleDrive-<email>/Shared drives/...
   */
  driveName?: string;
  /**
   * Signed-in user's email — needed for the macOS variant of the
   * Drive Desktop local path. Empty string → Mac users fall back to
   * the Windows path on their button (broken on their machine, but
   * no crash; matches pre-cross-OS behavior).
   */
  userEmail?: string;
  /**
   * Whether the current user is an admin. Threads through to row
   * components so admin users see the edit-pencil affordance on
   * tasks they didn't author (matching the server-side gate that
   * lets admins edit any task). Default false — non-admin behavior.
   */
  isAdmin?: boolean;
  /**
   * Company → project names map. Powers the hover-reveal dropdown on
   * each row's company cell — hovering "Gindy" lists every project
   * under Gindy with a link to each. Same map TasksFilterCompanyProject
   * already builds; pass through if you want the dropdown, omit to
   * keep the company cell as plain text.
   */
  companyToProjects?: Record<string, string[]>;
  /**
   * Sort axis applied within each status bucket. "rank" (default)
   * uses drag-driven manual order; any other value disables drag
   * because the rank-based reorder would be invisible to the user
   * under a non-rank sort.
   */
  sort?: TasksSortKey;
  sortOrder?: TasksSortOrder;
  /**
   * Existing search params on /tasks. Used to build the Link hrefs on
   * sortable column headers — toggling preserves filters. Omit on
   * surfaces that don't support URL-driven sort (e.g. project pages).
   */
  searchParams?: Record<string, string | undefined>;
  /**
   * When true, the done + cancelled buckets render in a collapsed
   * <details> by default — a single "📦 בוצע (N)" / "📦 בוטל (N)"
   * line that the user can click to expand. Driven by the user's
   * hide_archived gear-menu pref via the page-level archive toggle.
   * The 14-day per-bucket "+N ישנות" sub-fold still works inside
   * the expanded section. */
  hideArchived?: boolean;
  /**
   * Days a done/cancelled task can sit before it's considered
   * archived. Drives the per-bucket "+N ישנות (לפני יותר מ-X יום)"
   * fold inside the bucket. Defaults to 14 — overridden via the
   * archive_after_days gear-menu pref. */
  archiveAfterDays?: number;
  /**
   * Group-by axis for the bucket headers.
   *   - "" / "status" / undefined → today's behavior: five lifecycle
   *     buckets (ממתין לטיפול / בעבודה / etc.). DEFAULT.
   *   - "company"      → bucket per task.company
   *   - "project"      → bucket per task.project
   *   - "department"   → bucket per task.departments[i] (multi-fan-out)
   *   - "assignee"     → bucket per task.assignees[i] (multi-fan-out);
   *                      header shows avatar + Hebrew name + role chip
   *   - "umbrella"     → bucket per task.umbrella_id, with the umbrella
   *                      itself sharing the bucket; standalone tasks
   *                      land in a "ללא מטריה" bucket
   *   - "none"         → one big flat list, no buckets
   *
   * Drag-to-reorder stays scoped per-bucket. Cross-bucket drops are
   * disabled when the axis isn't "status" — a v2 enhancement could
   * reinterpret a cross-bucket drop as "change the task's company /
   * department / assignee" but for now the UX is: same axis → rank
   * reorder; different axis → no-op. */
  groupBy?: string;
  /**
   * Per-task "wants something from YOU" classification — drives the
   * row accent + leading chip on /tasks. Only contains entries where
   * the state is non-null (tagged / awaiting_approval /
   * awaiting_clarification). Computed server-side by
   * buildUserStateByTaskId so the queue + kanban views agree. Omit on
   * surfaces that should never highlight (e.g. project-page mini
   * queue if we ever decide it's too noisy there). */
  userStateByTaskId?: ReadonlyMap<string, "tagged" | "awaiting_approval" | "awaiting_clarification">;
};

/** Default order per sort axis: dates default to descending (newest
 *  first), priority defaults to ascending (1=high first), title
 *  defaults to alpha asc. Keeps the first click on a column behave
 *  the way most users expect. */
function defaultOrderFor(sort: TasksSortKey): TasksSortOrder {
  switch (sort) {
    case "requested_date":
    case "created_at":
    case "updated_at":
      return "desc";
    default:
      return "asc";
  }
}

/** Map a group-by axis to the column whose content the bucket header
 *  already shows — so the column can be hidden on the table to save
 *  width. Returned value becomes the `data-hide-col` attribute on
 *  `.tasks-table-wrap`; matching CSS rules drop the matching `th`/`td`
 *  via `display:none`. Returns undefined when no column should be
 *  hidden (status/umbrella/none). */
function hideColumnByAxis(axis: string): string | undefined {
  switch (axis) {
    case "company":    return "company";
    case "project":    return "project";
    case "campaign":   return "brief";
    case "department": return "department";
    case "assignee":   return "assignees";
    default:           return undefined;
  }
}

/** Workflow position for the `status` sort axis. Lower number = earlier
 *  in the lifecycle (= surfaces first under ascending sort). Anything
 *  outside the canonical set (legacy values, typos, etc.) lands at
 *  the end so it doesn't push real work down. */
function statusOrder(status: string): number {
  switch (status) {
    case "awaiting_handling":     return 0;
    case "blocked":               return 1;
    case "in_progress":           return 2;
    case "awaiting_clarification":return 3;
    case "awaiting_approval":     return 4;
    case "done":                  return 5;
    case "cancelled":             return 6;
    default:                      return 99;
  }
}

/** Build the /tasks href that resets sort to rank, preserving every
 *  other current search param. Adds `sort=rank` EXPLICITLY (not just
 *  stripping the existing sort/order params) so the server-side
 *  effectiveSort resolves to rank IMMEDIATELY — without this, the
 *  persisted user pref (`tasks_sort=status` etc.) would beat the
 *  empty URL and the user would land on a "looks like nothing
 *  happened" page after a slow refetch. The companion
 *  `ResetSortButton` below also fires a fire-and-forget pref clear so
 *  future visits without `?sort=` stay on rank. Maayan reported
 *  2026-05-12 that hitting "↺ סדר ידני" felt like it took forever to
 *  load. */
function buildResetSortHref(
  current: Record<string, string | undefined>,
): string {
  const merged: Record<string, string> = { sort: "rank" };
  for (const [k, v] of Object.entries(current)) {
    if (!v) continue;
    if (k === "sort" || k === "order") continue;
    merged[k] = v;
  }
  const qs = new URLSearchParams(merged).toString();
  return qs ? `/tasks?${qs}` : "/tasks";
}

/** Build a comparator for a non-rank sort axis. Returns null for
 *  `rank`, in which case callers fall back to compareByRank. */
function comparatorFor(
  sort: TasksSortKey,
  order: TasksSortOrder,
): ((a: WorkTask, b: WorkTask) => number) | null {
  if (sort === "rank") return null;
  const dir = order === "desc" ? -1 : 1;
  switch (sort) {
    case "title":
      return (a, b) => dir * a.title.localeCompare(b.title, "he");
    case "priority":
      return (a, b) => dir * ((a.priority || 99) - (b.priority || 99));
    case "requested_date":
      return (a, b) =>
        dir * ((a.requested_date || "").localeCompare(b.requested_date || ""));
    case "created_at":
      return (a, b) => dir * a.created_at.localeCompare(b.created_at);
    case "updated_at":
      return (a, b) => dir * a.updated_at.localeCompare(b.updated_at);
    case "status":
      return (a, b) => dir * (statusOrder(a.status) - statusOrder(b.status));
  }
}

/**
 * The Data-Plus-style tasks queue, rendered as grouped lifecycle
 * buckets over a single flat <table>. Used both on `/tasks` (portfolio
 * view, with company grouping) and on `/projects/[project]` (project
 * view, company grouping off — projects are already scoped).
 *
 * Note: the company-group / project-group sub-headers share the same
 * table body so column widths stay aligned without nested tables.
 */
export default function TasksQueue({
  tasks: initialTasks,
  groupByCompany = true,
  emptyMessage = "אין משימות תואמות לסינון.",
  hideOther = false,
  compact = false,
  people = [],
  driveName = "",
  userEmail = "",
  isAdmin = false,
  companyToProjects = {},
  sort = "rank",
  sortOrder,
  searchParams,
  hideArchived = false,
  archiveAfterDays,
  groupBy = "",
  userStateByTaskId,
}: Props) {
  // Local task state lets us optimistically reorder rows on drop and
  // revert on server error — same pattern the kanban uses. Initial
  // value is the server-rendered list passed in by the page.
  const [tasks, setTasks] = useState(initialTasks);
  // Re-sync from props when the parent re-renders with a new task
  // list. Without this, the local state initialized once at mount and
  // never picked up server-data changes — so URL-driven filter toggles
  // (e.g. ?umbrellas=1 via router.push + router.refresh) flipped the
  // active query state but the table kept rendering the original list.
  // Verified live 2026-05-06: clicking the עטיפות chip pushed the URL
  // and the parent re-rendered with umbrella rows in `initialTasks`,
  // but TasksQueue's internal `tasks` stayed stale → bucket counts
  // didn't change. Hard reload "fixed" it because remount re-ran
  // `useState(initialTasks)`. The optimistic-update flicker on
  // drag-end is acceptable: router.refresh after a successful save
  // re-syncs to the server's view, which is the source of truth.
  useEffect(() => {
    setTasks(initialTasks);
  }, [initialTasks]);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  // Bulk-selection state. A row's checkbox toggles its id in/out of
  // this Set; the floating action bar reads `.size` for visibility +
  // count and the Set itself when fanning out an action over the
  // /api/worktasks/update endpoint. Selection is local to this view —
  // navigations clear it, which is the desired UX.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  function toggleSelected(id: string) {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function clearSelection() {
    setSelectedIds(new Set());
  }

  // Resolve the order for the current sort axis. When the caller
  // passes a sort but no order, fall back to the column's natural
  // default direction.
  const effectiveOrder: TasksSortOrder = sortOrder || defaultOrderFor(sort);
  const sortFn = useMemo(
    () => comparatorFor(sort, effectiveOrder),
    [sort, effectiveOrder],
  );
  // Drag is always enabled UNDER STATUS GROUPING — under a non-rank
  // sort, dropping still updates the row's rank and we auto-flip the
  // URL back to rank sort so the user sees the new manual order.
  // Disabled when the user picks a non-status group axis: cross-bucket
  // drops on those axes would be ambiguous (drop the task into another
  // company → re-categorize? change the field? rerank within the new
  // bucket?). Cleaner UX: turn drag off; user can always switch back
  // to status grouping to reorder. v2 may interpret cross-bucket drops
  // as "change this task's company / department / assignee".
  const dragEnabled = !groupBy || groupBy === "status";

  // 8px activation distance keeps a click on a row's title link from
  // accidentally starting a drag — pointer movement past the threshold
  // is the trigger. Touch sensor uses a longer delay so taps don't
  // grab rows on mobile. Keyboard sensor uses dnd-kit's sortable
  // coordinate getter so arrow keys move the focused row through the
  // list one step at a time — Space/Enter to grab + drop, Esc to
  // cancel. Drag handles below are tabIndex={0} so power users can
  // reorder without a mouse.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Umbrellas-mode (?umbrellas=1) is the "chain context" view. When
  // active, status-grouped buckets cluster each chain's family together:
  // a chain child is bucketed by ITS UMBRELLA'S status (not its own),
  // so the umbrella header + every step of the chain land in the same
  // bucket. The reorder pass in SortableTableSection then sorts the
  // family with umbrella-first + children in chain order. Outside
  // umbrellas mode, this is a no-op — children sit in their own status
  // bucket as before. Maayan reported 2026-05-12: she wants children
  // indented under their umbrella with non-mine stages greyed out.
  const showUmbrellas = searchParams?.umbrellas === "1";

  // Build umbrella id → umbrella's status map. Used to rebucket chain
  // children below. When the umbrella isn't in the current `tasks`
  // (filtered out by some other axis), children stay in their own
  // status — best-effort, no spurious cross-bucket moves.
  const umbrellaStatusById = useMemo(() => {
    if (!showUmbrellas) return new Map<string, WorkTaskStatus>();
    const m = new Map<string, WorkTaskStatus>();
    for (const t of tasks) {
      if (t.is_umbrella) m.set(t.id, t.status);
    }
    return m;
  }, [tasks, showUmbrellas]);

  // Bucketize once. Default behavior (groupBy empty/status) → group
  // by lifecycle status using STATUS_BUCKETS — anything outside the
  // canonical list sinks into `other` (drafts, anomalies). Other
  // axes (company / project / assignee / department / umbrella /
  // none) generate dynamic buckets with a synthetic
  // {key, label, tone, isTerminal:false} shape so the existing
  // bucket render loop below works unchanged.
  const byStatus = useMemo(() => {
    if (!groupBy || groupBy === "status") {
      const map: Record<string, WorkTask[]> = {};
      for (const b of STATUS_BUCKETS) map[b.key] = [];
      const out: WorkTask[] = [];
      for (const t of tasks) {
        // In umbrellas mode, route chain children into the umbrella's
        // bucket so the family stays together. Falls back to own
        // status when the umbrella isn't loaded OR when its status
        // isn't a canonical STATUS_BUCKETS key (defensive — avoids
        // a chain child dropping into `other` just because its
        // umbrella row has a malformed status cell).
        let bucketKey: WorkTaskStatus = t.status;
        if (showUmbrellas && t.umbrella_id) {
          const us = umbrellaStatusById.get(t.umbrella_id);
          if (us && map[us]) bucketKey = us;
        }
        if (map[bucketKey]) map[bucketKey].push(t);
        else out.push(t);
      }
      return { byStatus: map, other: out, dynamicBuckets: null };
    }
    // Custom axis. Build a Map (preserves insertion order →
    // buckets render in the order tasks land in them, which is
    // close enough to "alphabetical / size-desc" without an
    // extra sort). For multi-value fields (assignee / department)
    // a task fans out into each value's bucket.
    const map = new Map<string, WorkTask[]>();
    function bucketKeysFor(t: WorkTask): string[] {
      switch (groupBy) {
        case "company":    return [t.company || "__no_company__"];
        case "project":    return [t.project || "__no_project__"];
        case "campaign":   return [t.campaign || "__no_campaign__"];
        case "department": return t.departments && t.departments.length > 0 ? t.departments : ["__no_department__"];
        case "assignee":   return t.assignees && t.assignees.length > 0 ? t.assignees : ["__no_assignee__"];
        case "umbrella":
          if (t.is_umbrella) return [t.id];
          if (t.umbrella_id) return [t.umbrella_id];
          return ["__standalone__"];
        case "none":       return ["__all__"];
        default:           return ["__unknown__"];
      }
    }
    for (const t of tasks) {
      for (const key of bucketKeysFor(t)) {
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(t);
      }
    }
    // Build the synthetic STATUS_BUCKETS-shape array.
    const buckets: { key: string; label: string; tone: string; isTerminal?: boolean }[] = [];
    const flat: Record<string, WorkTask[]> = {};
    // Sort buckets by size desc (most populated first); push
    // empty-meta keys (__no_*__ / __standalone__) to the end.
    const entries = Array.from(map.entries());
    entries.sort((a, b) => {
      const aMeta = a[0].startsWith("__");
      const bMeta = b[0].startsWith("__");
      if (aMeta !== bMeta) return aMeta ? 1 : -1;
      return b[1].length - a[1].length;
    });
    for (const [key, list] of entries) {
      buckets.push({
        key,
        label: humanizeBucketKey(key, groupBy, people),
        tone: "neutral",
      });
      flat[key] = list;
    }
    return { byStatus: flat, other: [], dynamicBuckets: buckets };
  }, [tasks, groupBy, people, showUmbrellas, umbrellaStatusById]);

  async function onDragEnd(e: DragEndEvent) {
    setError(null);
    if (!e.over) return;
    const draggedId = String(e.active.id);
    const overId = String(e.over.id);
    if (draggedId === overId) return;

    const dragged = tasks.find((t) => t.id === draggedId);
    if (!dragged) return;

    // Drop targets in the table are always other rows in the same
    // bucket (each SortableContext is scoped per-bucket). Compute the
    // new rank from the bucket's currently-rendered order — which is
    // sortFn order under a non-rank sort, NOT rank order. dnd-kit's
    // visual rearrangement happens in the order of SortableContext.items,
    // and that list is `ordered` from SortableTableSection (sortFn ||
    // compareByRank). So fromIdx/toIdx must use the same order, otherwise
    // the direction logic gets pointed in the wrong direction.
    //
    // Direction-aware insert anchor: dnd-kit's verticalListSortingStrategy
    // mirrors `arrayMove(items, oldIdx, newIdx)` — the dragged item
    // lands AT over's position in the resulting array:
    //   - Dragging DOWN (fromIdx < toIdx) → insert AFTER overId
    //   - Dragging UP   (fromIdx > toIdx) → insert BEFORE overId
    const visualSort = sortFn || compareByRank;
    const visualList = (byStatus.byStatus[dragged.status] || [])
      .slice()
      .sort(visualSort);
    const fromIdx = visualList.findIndex((t) => t.id === draggedId);
    const toIdx = visualList.findIndex((t) => t.id === overId);
    if (fromIdx === -1 || toIdx === -1) return;
    const filteredVisual = visualList.filter((t) => t.id !== draggedId);
    const overInFiltered = filteredVisual.findIndex((t) => t.id === overId);
    const insertVisualIdx =
      fromIdx < toIdx ? overInFiltered + 1 : overInFiltered;

    // Compute newRank. Under rank sort the visual list IS rank-ordered
    // and `computeInsertRank` (midpoint of neighbors) Just Works. Under
    // a non-rank sort the visual neighbors aren't necessarily rank-
    // adjacent — using their rank values as midpoint anchors places the
    // dragged "between" them in rank-space, which is the closest we can
    // do without rewriting other rows' ranks. After the save the auto-
    // reset switches the user to rank sort, where this rank lands the
    // dragged near the position they dropped it in.
    const insertBeforeId =
      filteredVisual[insertVisualIdx]?.id ?? null; // null = append
    const newRank = computeInsertRank(filteredVisual, insertBeforeId);

    if (dragged.rank === newRank) return;

    // Optimistic local update.
    const prev = tasks;
    const next = tasks.map((t) =>
      t.id === draggedId ? { ...t, rank: newRank } : t,
    );
    setTasks(next);

    try {
      const res = await fetch("/api/worktasks/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: draggedId,
          patch: { rank: newRank, note: "list: reorder" },
        }),
      });
      const data = (await res.json()) as
        | { ok: true }
        | { ok: false; error: string };
      if (!res.ok || !data.ok) {
        throw new Error("error" in data ? data.error : "Update failed");
      }
      // If the user was sorted by something other than rank, the
      // rank update we just saved would be invisible until they
      // reset sort manually. Auto-reset so the drag's outcome
      // shows up immediately. Two parts:
      //   1. Persist sort:"" (= rank) on the user's prefs row.
      //      Without this, the page re-reads the persisted sort
      //      from /api/me/prefs on the next render and re-applies
      //      whatever the user had saved (e.g. "status"). Just
      //      clearing URL params doesn't help.
      //   2. Push the URL without ?sort=&order= and refresh, so
      //      the page picks up the cleared pref + renders in rank
      //      order. We deliberately don't add an explicit
      //      ?sort=rank — the empty pref + empty URL is the
      //      canonical "default" state.
      if (sort !== "rank") {
        // Fire-and-forget pref clear; same shape as persistSortPref
        // below. keepalive lets the request survive the navigation.
        void fetch("/api/me/prefs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tasks_sort: "",
            tasks_sort_order: "",
          }),
          keepalive: true,
        }).catch(() => {
          /* best-effort — auto-reset is a UX nicety, not critical */
        });
        if (searchParams) {
          const merged: Record<string, string> = {};
          for (const [k, v] of Object.entries(searchParams)) {
            if (!v) continue;
            if (k === "sort" || k === "order") continue;
            merged[k] = v;
          }
          const qs = new URLSearchParams(merged).toString();
          router.push(qs ? `/tasks?${qs}` : "/tasks");
        }
        router.refresh();
      }
    } catch (err) {
      setTasks(prev);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (tasks.length === 0) {
    return (
      <div className="empty">
        <span className="emoji" aria-hidden>
          🌿
        </span>
        {emptyMessage}
      </div>
    );
  }

  const { byStatus: byStatusMap, other, dynamicBuckets } = byStatus;
  // Bucket list to render — STATUS_BUCKETS for the default axis,
  // synthesized from the data otherwise. The status path keeps its
  // {tone, isTerminal} metadata (drives terminal-bucket folding); the
  // dynamic path uses neutral chrome.
  const bucketsToRender: { key: string; label: string; tone: string; isTerminal?: boolean }[] =
    dynamicBuckets ?? STATUS_BUCKETS.map((b) => ({ ...b }));
  // For the umbrella axis, build an id → task lookup so the bucket
  // header can show the umbrella's TITLE (not its task id). For
  // assignee axis, the same task-list-derived people roster is
  // already passed in via props; humanizeBucketKey handles that.
  const tasksById = new Map<string, WorkTask>();
  if (groupBy === "umbrella") {
    for (const t of tasks) tasksById.set(t.id, t);
  }

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      {error && (
        <div className="kanban-error" role="alert">
          {error}
          <button
            type="button"
            className="kanban-error-dismiss"
            onClick={() => setError(null)}
            aria-label="סגור"
          >
            ×
          </button>
        </div>
      )}
      {bucketsToRender.map((b) => {
        const list = byStatusMap[b.key] || [];
        if (!list.length) return null;
        // Terminal-state buckets (done / cancelled) split into recent
        // + older — older rows live behind a fold so the queue doesn't
        // accumulate visual debt over time.
        const effectiveArchiveDays =
          archiveAfterDays ?? DEFAULT_ARCHIVE_AFTER_DAYS;
        const { recent, older } = b.isTerminal
          ? partitionByAge(list, effectiveArchiveDays)
          : { recent: list, older: [] };
        const bucketBody = (
          <>
            {recent.length > 0 && (
              <div className="tasks-table-wrap" data-hide-col={hideColumnByAxis(groupBy)}>
                <SortableTableSection
                  rows={recent}
                  compact={compact}
                  groupByCompany={groupByCompany}
                  people={people}
                  driveName={driveName}
                  userEmail={userEmail}
                  isAdmin={isAdmin}
                  companyToProjects={companyToProjects}
                  sort={sort}
                  sortOrder={effectiveOrder}
                  sortFn={sortFn}
                  searchParams={searchParams}
                  dragEnabled={dragEnabled}
                  selectedIds={selectedIds}
                  onToggleSelected={toggleSelected}
                  showUmbrellas={showUmbrellas}
                  userStateByTaskId={userStateByTaskId}
                />
              </div>
            )}
            {older.length > 0 && (
              <details className="tasks-archive-fold">
                <summary>
                  {`${older.length} משימות ${b.label.toLowerCase()} ישנות (לפני יותר מ‑${effectiveArchiveDays} יום) — לחץ להצגה`}
                </summary>
                <div className="tasks-table-wrap" data-hide-col={hideColumnByAxis(groupBy)}>
                  <SortableTableSection
                    rows={older}
                    compact={compact}
                    groupByCompany={groupByCompany}
                    people={people}
                    driveName={driveName}
                    userEmail={userEmail}
                    isAdmin={isAdmin}
                    companyToProjects={companyToProjects}
                    sort={sort}
                    sortOrder={effectiveOrder}
                    sortFn={sortFn}
                    searchParams={searchParams}
                    dragEnabled={dragEnabled}
                    selectedIds={selectedIds}
                    onToggleSelected={toggleSelected}
                    userStateByTaskId={userStateByTaskId}
                  />
                </div>
              </details>
            )}
          </>
        );
        // When the user has hide_archived on, terminal buckets render
        // as a single collapsed `<details>` line so the active queue
        // doesn't bleed into completed/cancelled work. Click → expand.
        if (b.isTerminal && hideArchived) {
          return (
            <details
              key={b.key}
              className={`tasks-bucket tasks-bucket-${b.tone} is-archived-fold`}
            >
              <summary className="tasks-bucket-head tasks-bucket-head-summary">
                <span aria-hidden>📦</span>
                {/* Terminal-fold path is status-only; cast is safe. */}
                <span aria-hidden>{STATUS_EMOJIS[b.key as WorkTaskStatus]}</span>
                {b.label}
                <span className="tasks-bucket-count">{list.length}</span>
                <span className="tasks-bucket-archived-hint">
                  לחץ להצגת הארכיון
                </span>
              </summary>
              {bucketBody}
            </details>
          );
        }
        // Bucket header chrome — varies by axis. Status (default) uses
        // the existing emoji + Hebrew label. Other axes:
        //   - assignee → 20px avatar (with role tooltip via Avatar)
        //                + Hebrew name from the resolver
        //   - umbrella → 🪆 + the umbrella's actual title (fall back to
        //                the sentinel label for standalone bucket)
        //   - company / project / department / none → small icon + label
        const renderHeadContent = () => {
          if (!groupBy || groupBy === "status") {
            // Status branch — b.key is a real WorkTaskStatus.
            return (
              <>
                <span aria-hidden>{STATUS_EMOJIS[b.key as WorkTaskStatus]}</span>
                {b.label}
              </>
            );
          }
          if (groupBy === "assignee") {
            const isSentinel = b.key.startsWith("__");
            if (isSentinel) {
              return (
                <>
                  <span aria-hidden>👤</span>
                  {b.label}
                </>
              );
            }
            const person = people.find(
              (p) => p.email.toLowerCase() === b.key.toLowerCase(),
            );
            return (
              <span className="tasks-bucket-head-person">
                <Avatar
                  name={b.key}
                  role={person?.role}
                  title={b.label}
                  size={22}
                />
                <span>{b.label}</span>
                {person?.role && (
                  <span className="tasks-bucket-head-role">
                    {roleEmoji(person.role)} {roleLabel(person.role)}
                  </span>
                )}
              </span>
            );
          }
          if (groupBy === "umbrella") {
            if (b.key === "__standalone__") {
              return (
                <>
                  <span aria-hidden>📋</span>
                  {b.label}
                </>
              );
            }
            const umbrella = tasksById.get(b.key);
            return (
              <>
                <span aria-hidden>🪆</span>
                {umbrella?.title || b.label}
              </>
            );
          }
          if (groupBy === "company") {
            return (
              <>
                <span aria-hidden>🏢</span>
                {b.label}
              </>
            );
          }
          if (groupBy === "project") {
            return (
              <>
                <span aria-hidden>📁</span>
                {b.label}
              </>
            );
          }
          if (groupBy === "department") {
            return (
              <>
                <span aria-hidden>{roleEmoji(b.key) || "🏷"}</span>
                {b.label}
              </>
            );
          }
          if (groupBy === "none") {
            return (
              <>
                <span aria-hidden>📋</span>
                {b.label}
              </>
            );
          }
          return <>{b.label}</>;
        };
        return (
          <section key={b.key} className={`tasks-bucket tasks-bucket-${b.tone}`}>
            <h2 className="tasks-bucket-head">
              {renderHeadContent()}
              <span className="tasks-bucket-count">{list.length}</span>
              {sort !== "rank" && searchParams && (
                <Link
                  href={buildResetSortHref(searchParams)}
                  scroll={false}
                  className="tasks-bucket-sort-reset"
                  onClick={() => {
                    // Fire-and-forget pref clear so the next /tasks
                    // visit without ?sort= in the URL stays on rank.
                    // Without this, the server-side persistedSort
                    // lookup would silently restore the column sort
                    // and the user would land back where they started
                    // after a navigation. Mirrors what the drag-end
                    // handler does on a successful reorder.
                    void fetch("/api/me/prefs", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({
                        tasks_sort: "",
                        tasks_sort_order: "",
                      }),
                      keepalive: true,
                    }).catch(() => {
                      /* best-effort — link still navigates with
                         ?sort=rank so the current view resets
                         regardless */
                    });
                  }}
                  title={
                    "סדר ידני = הסדר שאת/ה קובע/ת ביד על ידי גרירת שורות. " +
                    "בכל פעם שגוררים שורה למיקום חדש המיקום נשמר, וזו ברירת המחדל של הרשימה. " +
                    "כעת התצוגה ממוינת לפי עמודה — לחץ/י כאן כדי לחזור לסדר הידני."
                  }
                >
                  ↺ סדר ידני
                </Link>
              )}
            </h2>
            {bucketBody}
          </section>
        );
      })}

      <TasksBulkBar
        selectedIds={selectedIds}
        people={people}
        campaigns={Array.from(
          new Set(
            tasks.map((t) => (t.campaign || "").trim()).filter(Boolean),
          ),
        ).sort()}
        onClear={clearSelection}
      />
      {!hideOther && other.length > 0 && (
        <details className="tasks-other">
          <summary>
            {other.length} טיוטות — לחץ להצגה
          </summary>
          <div className="tasks-table-wrap">
            <table className="tasks-table">
              <thead>
                <tr>
                  <th>סטטוס</th>
                  <th>פרויקט</th>
                  <th>כותרת</th>
                  <th>תאריך מבוקש</th>
                  <th>כותב</th>
                </tr>
              </thead>
              <tbody>
                {other.map((t) => (
                  <tr key={t.id}>
                    {/* Interactive status cell — cancelled tasks need a
                        way to be revived; a read-only pill here was the
                        reason "I don't see any way to un-cancel". */}
                    <td>
                      <TaskStatusCell task={t} />
                    </td>
                    <td>
                      {t.company
                        ? `${displayProjectOrCompany(t.company)} / `
                        : ""}
                      {displayProjectOrCompany(t.project)}
                    </td>
                    <td>
                      <Link href={`/tasks/${encodeURIComponent(t.id)}`}>
                        {t.title}
                      </Link>
                    </td>
                    <td>{t.requested_date || "—"}</td>
                    <td>{shortName(t.author_email, people)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </DndContext>
  );
}

/* ── Bucket body ─────────────────────────────────────────────────── */

/**
 * Renders the rows for a single status bucket, sorted by rank
 * ascending. There used to be sub-grouping helpers here (assignee /
 * approver / company sub-headers) but rank-based ordering replaced
 * them — sub-headers fought with rank, see the STATUS_BUCKETS comment
 * for the rationale.
 */

/** Wraps the table + thead + tbody for one section (recent or
 *  archived rows of a single bucket). Owns the SortableContext too —
 *  drag-reorder is enabled only when sorting by rank, since dragging
 *  under a column-driven sort doesn't visibly affect order and just
 *  confuses the user. */
/** Reorder a bucket's rows so each visible umbrella is immediately
 *  followed by its visible children in chain order (created_at asc),
 *  preserving the caller's sort order for top-level (non-family) items.
 *  Returns a new array; doesn't mutate `sorted`.
 *
 *  Algorithm: walk `sorted` once. Skip rows we've already placed. For
 *  each row, if it's a chain member (umbrella OR child with an
 *  umbrella_id in this list), emit the whole family at this position.
 *  Otherwise emit the row alone. This way the family lands at the
 *  earliest sort position of any of its members — the umbrella drops
 *  to where the user's sort would put any of its rows. */
function clusterChainFamilies(sorted: WorkTask[]): WorkTask[] {
  const umbrellaById = new Map<string, WorkTask>();
  const childrenByUmbrella = new Map<string, WorkTask[]>();
  for (const t of sorted) {
    if (t.is_umbrella) umbrellaById.set(t.id, t);
  }
  for (const t of sorted) {
    if (t.is_umbrella) continue;
    if (!t.umbrella_id || !umbrellaById.has(t.umbrella_id)) continue;
    const list = childrenByUmbrella.get(t.umbrella_id) ?? [];
    list.push(t);
    childrenByUmbrella.set(t.umbrella_id, list);
  }
  // Chain order = created_at ascending — chain create wires steps in
  // sequence so creation order matches the dependency order. Falls
  // through cleanly for parallel-children umbrellas too (they have no
  // edges; order is arbitrary, created_at is a sensible default).
  for (const list of childrenByUmbrella.values()) {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  const placed = new Set<string>();
  const out: WorkTask[] = [];
  for (const t of sorted) {
    if (placed.has(t.id)) continue;
    const umbrellaId = t.is_umbrella ? t.id : t.umbrella_id;
    const umbrella =
      umbrellaId && umbrellaById.has(umbrellaId) ? umbrellaById.get(umbrellaId)! : null;
    if (umbrella) {
      out.push(umbrella);
      placed.add(umbrella.id);
      const kids = childrenByUmbrella.get(umbrella.id) || [];
      for (const k of kids) {
        out.push(k);
        placed.add(k.id);
      }
    } else {
      out.push(t);
      placed.add(t.id);
    }
  }
  return out;
}

function SortableTableSection({
  rows,
  compact,
  groupByCompany,
  people,
  driveName,
  userEmail,
  isAdmin,
  companyToProjects,
  sort,
  sortOrder,
  sortFn,
  searchParams,
  dragEnabled,
  selectedIds,
  onToggleSelected,
  showUmbrellas = false,
  userStateByTaskId,
}: {
  rows: WorkTask[];
  compact: boolean;
  groupByCompany: boolean;
  people: TasksPerson[];
  driveName: string;
  userEmail: string;
  isAdmin: boolean;
  companyToProjects: Record<string, string[]>;
  sort: TasksSortKey;
  sortOrder: TasksSortOrder;
  sortFn: ((a: WorkTask, b: WorkTask) => number) | null;
  searchParams?: Record<string, string | undefined>;
  dragEnabled: boolean;
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
  /** When true, post-sort cluster rows so each umbrella is immediately
   *  followed by its children (in chain order = oldest-first). Without
   *  this, sort by created_at/title/priority would spread family members
   *  apart inside the bucket. Only meaningful when the parent rebucketed
   *  chain children into the umbrella's bucket — outside umbrellas
   *  mode this is a no-op. */
  showUmbrellas?: boolean;
  userStateByTaskId?: ReadonlyMap<string, "tagged" | "awaiting_approval" | "awaiting_clarification">;
}) {
  const sorted = sortFn
    ? rows.slice().sort(sortFn)
    : rows.slice().sort(compareByRank);
  // Cluster families when umbrellas mode is active. We iterate the
  // user's chosen sort order; the FIRST time we encounter a family
  // member, the umbrella drops in (if visible in this bucket) followed
  // by its children in chain order (created_at asc — chain creation
  // sequence). Subsequent family members are skipped (already placed).
  const ordered = showUmbrellas ? clusterChainFamilies(sorted) : sorted;
  // Header checkbox controls "select all visible in this section".
  // When all rows are already selected, clicking it deselects this
  // section's rows; otherwise it adds them.
  const allSelected =
    ordered.length > 0 && ordered.every((t) => selectedIds.has(t.id));
  const someSelected =
    !allSelected && ordered.some((t) => selectedIds.has(t.id));
  function toggleAll() {
    if (allSelected) {
      for (const t of ordered) {
        if (selectedIds.has(t.id)) onToggleSelected(t.id);
      }
    } else {
      for (const t of ordered) {
        if (!selectedIds.has(t.id)) onToggleSelected(t.id);
      }
    }
  }
  const head = (
    <thead>
      <tr>
        <th className="bulk-select-col" aria-label="בחירה מרובה">
          <input
            type="checkbox"
            className="bulk-select-checkbox"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected;
            }}
            onChange={toggleAll}
            aria-label={
              allSelected ? "בטל בחירה" : "סמן את כל השורות בקטע זה"
            }
          />
        </th>
        {dragEnabled && <th className="drag-handle-col" aria-hidden></th>}
        {!compact && <th className="col-company">חברה</th>}
        {/* Project header — same column whether the page groups by
            company (portfolio /tasks) or not (project page). Used to
            be "פרטי הפרוייקט" in the grouped variant; collapsed to
            just "פרויקט" 2026-05-05 for consistency with the rest of
            the column labels in this row. */}
        {!compact && <th className="col-project">פרויקט</th>}
        <th className="col-brief">בריף</th>
        {/* סוג משימה — task kind. Stored on `task.kind` either as a
            schema-driven Hebrew label (newer rows) or a legacy enum
            key (ad_creative, landing_page, …). `kindLabel` normalizes
            both forms; raw value is the filter key. */}
        <th>סוג משימה</th>
        <SortableTh
          column="title"
          label="משימה"
          sort={sort}
          sortOrder={sortOrder}
          searchParams={searchParams}
        />
        {!compact && (
          <SortableTh
            column="created_at"
            label="תאריך יצירה"
            sort={sort}
            sortOrder={sortOrder}
            searchParams={searchParams}
          />
        )}
        <SortableTh
          column="requested_date"
          label="תאריך יעד"
          sort={sort}
          sortOrder={sortOrder}
          searchParams={searchParams}
        />
        <SortableTh
          column="priority"
          label="דחיפות"
          sort={sort}
          sortOrder={sortOrder}
          searchParams={searchParams}
        />
        <th className="col-department">מחלקה</th>
        <th>כותב</th>
        <th className="col-assignees">עובדים</th>
        <th>מאשר</th>
        <SortableTh
          column="status"
          label="סטטוס"
          sort={sort}
          sortOrder={sortOrder}
          searchParams={searchParams}
        />
        <th className="icons">פעולות</th>
      </tr>
    </thead>
  );
  const body = (
    <BucketBody
      tasks={ordered}
      compact={compact}
      people={people}
      driveName={driveName}
      userEmail={userEmail}
      isAdmin={isAdmin}
      companyToProjects={companyToProjects}
      dragEnabled={dragEnabled}
      selectedIds={selectedIds}
      onToggleSelected={onToggleSelected}
      userStateByTaskId={userStateByTaskId}
    />
  );
  const table = (
    <table className={`tasks-table${compact ? " tasks-table-compact" : ""}`}>
      {head}
      <tbody>{body}</tbody>
    </table>
  );
  if (!dragEnabled) return table;
  return (
    <SortableContext
      items={ordered.map((t) => t.id)}
      strategy={verticalListSortingStrategy}
    >
      {table}
    </SortableContext>
  );
}

/** A single column header that's clickable when `searchParams` is
 *  provided (URL-driven sort). Click toggles asc/desc on the active
 *  column, or sets this column as the new sort axis with its default
 *  direction. Without `searchParams` (e.g. when used on a project
 *  page that doesn't expose URL sort), renders as plain text.
 *
 *  Also persists the choice to /api/me/prefs in the background so
 *  the column-sort survives a navigation away and back — no need to
 *  carry ?sort=…&order=… in every link the user follows from /tasks. */
function SortableTh({
  column,
  label,
  sort,
  sortOrder,
  searchParams,
}: {
  column: TasksSortKey;
  label: string;
  sort: TasksSortKey;
  sortOrder: TasksSortOrder;
  searchParams?: Record<string, string | undefined>;
}) {
  if (!searchParams) {
    return <th>{label}</th>;
  }
  const isActive = sort === column;
  const nextOrder: TasksSortOrder = isActive
    ? sortOrder === "asc"
      ? "desc"
      : "asc"
    : defaultOrderFor(column);
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(searchParams)) {
    if (v) merged[k] = v;
  }
  merged.sort = column;
  merged.order = nextOrder;
  const qs = new URLSearchParams(merged).toString();
  const href = qs ? `/tasks?${qs}` : "/tasks";
  return (
    <th className={`sortable-th${isActive ? " is-active" : ""}`}>
      <Link
        href={href}
        scroll={false}
        className="sortable-th-link"
        onClick={() => persistSortPref(column, nextOrder)}
      >
        {label}
        <span className="sortable-th-indicator" aria-hidden>
          {isActive ? (sortOrder === "desc" ? " ▼" : " ▲") : ""}
        </span>
      </Link>
    </th>
  );
}

/** Fire-and-forget POST to /api/me/prefs so the user's column-sort
 *  choice survives a navigation. `keepalive` keeps the request in
 *  flight even if the click triggers an immediate route change. */
function persistSortPref(sort: TasksSortKey, order: TasksSortOrder): void {
  void fetch("/api/me/prefs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tasks_sort: sort === "rank" ? "" : sort,
      tasks_sort_order: sort === "rank" ? "" : order,
    }),
    keepalive: true,
  }).catch(() => {
    /* best-effort — sort persistence isn't worth surfacing an error */
  });
}

function BucketBody({
  tasks,
  compact,
  people,
  driveName,
  userEmail,
  isAdmin = false,
  companyToProjects,
  dragEnabled = true,
  selectedIds,
  onToggleSelected,
  userStateByTaskId,
}: {
  tasks: WorkTask[];
  compact: boolean;
  people: TasksPerson[];
  driveName: string;
  userEmail: string;
  isAdmin?: boolean;
  companyToProjects: Record<string, string[]>;
  dragEnabled?: boolean;
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
  userStateByTaskId?: ReadonlyMap<string, "tagged" | "awaiting_approval" | "awaiting_clarification">;
}) {
  // Caller (SortableTableSection) already sorted into the right order
  // for the active sort axis; we just render in the order received.
  return (
    <>
      {tasks.map((t) => (
        <TaskRow
          key={t.id}
          task={t}
          compact={compact}
          people={people}
          driveName={driveName}
          userEmail={userEmail}
          isAdmin={isAdmin}
          companyProjects={
            t.company ? companyToProjects[t.company] || [] : []
          }
          dragEnabled={dragEnabled}
          selected={selectedIds.has(t.id)}
          onToggleSelected={onToggleSelected}
          userState={userStateByTaskId?.get(t.id) ?? null}
        />
      ))}
    </>
  );
}

/* ── Row + helpers ───────────────────────────────────────────────── */

function TaskRow({
  task,
  compact = false,
  people = [],
  driveName = "",
  userEmail = "",
  isAdmin = false,
  companyProjects = [],
  dragEnabled = true,
  selected = false,
  onToggleSelected,
  userState = null,
}: {
  task: WorkTask;
  compact?: boolean;
  people?: TasksPerson[];
  driveName?: string;
  userEmail?: string;
  isAdmin?: boolean;
  /** Sibling projects under this row's company. When non-empty, the
   *  company cell renders a hover-revealed dropdown listing each
   *  with a deep-link to its project page. */
  companyProjects?: string[];
  dragEnabled?: boolean;
  selected?: boolean;
  onToggleSelected?: (id: string) => void;
  /** "This row wants action from YOU" classification — drives the
   *  row accent + leading chip. Null means render unchanged. See
   *  lib/taskUserState for how this is derived. */
  userState?: TaskUserState;
}) {
  // useSortable always runs (rules of hooks), but we ignore its bindings
  // when drag is disabled — i.e. when the queue is sorted by something
  // other than rank. Under a non-rank sort, dragging would reorder the
  // task's stored rank invisibly, so we hide the handle and skip the
  // attributes / listeners on the row.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id });
  const rowStyle: React.CSSProperties = dragEnabled
    ? {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.45 : undefined,
      }
    : {};

  // Quick-preview hook — used by the 👁 button below to open the
  // side drawer without leaving /tasks. The hook returns no-op
  // functions when no provider is mounted, so isolated tests /
  // SSR snapshots don't crash; the layout root mounts the provider
  // for every authenticated page.
  const preview = useTaskPreview();
  // Drive Desktop local path. We deliberately don't include the
  // task-specific subfolder (drive_folder_url is a web URL, not a path);
  // the user can drill into it once Explorer opens at the campaign
  // level. Both windows + mac variants computed here; the button
  // picks per-OS at runtime.
  const localPaths = buildLocalDrivePaths({
    driveName,
    company: task.company,
    project: task.project,
    campaign: task.campaign,
    userEmail,
  });
  // Visual hierarchy by row kind — umbrella reads as a header
  // (bold + slightly larger title), children render slightly smaller
  // with a start-indent on the title so the eye sees them as
  // subordinate. Standalone rows keep the baseline. Pure CSS via the
  // row-level class; per-cell overrides target the title link only.
  const rowKind = classifyTask(task);
  const rowKindCls =
    rowKind === "umbrella"
      ? " tasks-row-umbrella"
      : rowKind === "parallel-child"
        ? " tasks-row-child tasks-row-parallel-child"
        : rowKind === "chain-child"
          ? " tasks-row-child tasks-row-chain-child"
          : "";
  // In umbrellas-mode chain-context view, sibling steps the user
  // doesn't own (different assignee) come in for the chain context —
  // grey them out so the eye reads them as "context, not my job."
  // Umbrella rows aren't muted (they're the header, role-agnostic).
  // Maayan reported 2026-05-12: chain stages assigned to teammates
  // should appear in the list but visibly de-emphasized.
  const isChild = rowKind === "parallel-child" || rowKind === "chain-child";
  const lcUser = (userEmail || "").toLowerCase();
  const isMine =
    !!lcUser &&
    (task.assignees || []).some((e) => e.toLowerCase() === lcUser);
  const muteCls = isChild && lcUser && !isMine ? " tasks-row-other-assignee" : "";
  return (
    <tr
      ref={dragEnabled ? setNodeRef : undefined}
      style={rowStyle}
      // data-user-state drives the row accent (left/start border tint +
      // soft background wash) — see the .tasks-table tr[data-user-state]
      // rules in globals.css. Undefined attr (not just empty) keeps
      // unstyled rows clean of stray DOM attributes.
      data-user-state={userState ?? undefined}
      className={`${selected ? "is-selected" : ""}${rowKindCls}${muteCls}`.trim() || undefined}
    >
      <td className="bulk-select-cell">
        <input
          type="checkbox"
          className="bulk-select-checkbox"
          checked={selected}
          onChange={() => onToggleSelected?.(task.id)}
          aria-label={selected ? `בטל בחירה — ${task.title}` : `בחר ${task.title}`}
          // Stop propagation so a checkbox click doesn't bubble into
          // any row-level handlers (drag, link clicks).
          onClick={(e) => e.stopPropagation()}
        />
      </td>
      {dragEnabled && (
        <td
          className="drag-handle-cell"
          {...attributes}
          {...listeners}
          tabIndex={0}
          aria-label="גרור לשינוי סדר — Space לתפיסה, חיצים להזזה, Enter לשחרור"
        >
          <span className="drag-handle-grip" aria-hidden>⋮⋮</span>
        </td>
      )}
      {!compact && (
        <td className="tasks-company-cell col-company">
          {task.company ? (
            companyProjects.length > 1 ? (
              // Hover-reveal dropdown listing every project under this
              // company. Pure CSS hover (no client state) — same
              // pattern as the topnav ProjectsNavMenu, scoped to a
              // single company. Falls through to plain text when the
              // company has only one project (the row's own project)
              // since a dropdown of one item is just noise.
              <div className="tasks-company-hover-menu">
                <span className="tasks-company-name">
                  {displayProjectOrCompany(task.company)}
                </span>
                <div className="tasks-company-dropdown" role="menu">
                  <div className="tasks-company-dropdown-head">
                    {displayProjectOrCompany(task.company)} ·{" "}
                    {companyProjects.length} פרויקטים
                  </div>
                  <ul className="tasks-company-dropdown-list">
                    {companyProjects.map((p) => (
                      <li key={p}>
                        <Link
                          href={projectHref(p, task.company)}
                          role="menuitem"
                          className={
                            p === task.project
                              ? "tasks-company-dropdown-current"
                              : undefined
                          }
                        >
                          {displayProjectOrCompany(p)}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              displayProjectOrCompany(task.company)
            )
          ) : (
            <span className="task-empty-cell">—</span>
          )}
        </td>
      )}
      {/* Project cell omitted in compact mode (page is already scoped). */}
      {!compact && (
        <td className="tasks-project-cell-nested col-project">
          <Link
            href={projectHref(task.project, task.company)}
            className="tasks-project-link"
          >
            {displayProjectOrCompany(task.project)}
          </Link>
        </td>
      )}
      {/* Column order (2026-05-05): brief → משימה → תאריך יצירה →
          תאריך יעד → דחיפות → מחלקה → כותב → עובדים → מאשר → סטטוס →
          פעולות. Matches the headers in the `head` block above; any
          reorder there has to be mirrored here. Cells use the same
          inner content as before; only the sequence changed. */}
      <td className="tasks-brief-cell col-brief">
        {task.campaign ? (
          task.campaign
        ) : (
          <span className="task-empty-cell">—</span>
        )}
      </td>
      <td className="tasks-kind-cell">
        {task.kind ? (
          kindLabel(task.kind)
        ) : (
          <span className="task-empty-cell">—</span>
        )}
      </td>
      <td className="title-cell">
        {/* Title + chip cluster split into two rows: the title link
            owns the first line so the (often long) task name doesn't
            get crushed when 3-4 chips also live in this cell. The
            chips wrap onto a second row underneath, separated by a
            small gap. Description preview goes below them as before. */}
        <div className="tasks-title-row">
          {/* Phase 6b — 🔒 badge for blocked tasks. Sits before the
              title for the visual cue. Hover hint shows blocker count;
              the side panel on the detail page lists the actual
              upstream tasks. */}
          {task.status === "blocked" && (
            <span
              className="tasks-row-blocked-badge"
              title={
                (task.blocked_by?.length ?? 0) > 0
                  ? `ממתין על ${task.blocked_by.length} משימות אחרות`
                  : "חסום"
              }
            >
              🔒
            </span>
          )}
          {/* "Wants something from YOU" chip — tagged / approval /
              clarification. Renders at the start of the title row so
              the eye reads "what does this row need from me" before
              "what's the task called". */}
          {userState && (
            <span
              className={`task-user-state-chip task-user-state-${userState}`}
              title={TASK_USER_STATE_LABELS[userState]}
            >
              {TASK_USER_STATE_LABELS[userState]}
            </span>
          )}
          <Link
            href={`/tasks/${encodeURIComponent(task.id)}`}
            className="tasks-title-link"
          >
            {task.title}
          </Link>
          {/* Quick-preview eye button — sits next to the title so
              it's discoverable on the title row instead of buried in
              the actions cell. Visually muted by default; brightens
              on title-cell hover so it doesn't clutter the row. */}
          <button
            type="button"
            className="tasks-title-preview-btn"
            title="תצוגה מקדימה — תיאור מלא ופרטים, ללא מעבר עמוד"
            aria-label="תצוגה מקדימה"
            onClick={(e) => {
              e.stopPropagation();
              preview.open(task, people);
            }}
          >
            👁
          </button>
        </div>
        {(() => {
          const isNew = isCreatedWithin24h(task.created_at);
          // Overdue is rendered on the date cell (red text + ⚠️) so it
          // doesn't clutter the title row alongside structural chips.
          // See `task-date-overdue` styling on TaskRequestedDateCell.
          const hasAnyChip =
            isNew || task.round_number > 1 || rowKind !== null;
          if (!hasAnyChip) return null;
          return (
            <div className="tasks-title-chips">
              {isNew && (
                <span
                  className="tasks-new-chip"
                  title="נוצרה ב־24 שעות האחרונות"
                >
                  🆕 חדש
                </span>
              )}
              {task.round_number > 1 && (
                <span className="tasks-round-chip" title="סבב תיקונים">
                  סבב #{task.round_number}
                </span>
              )}
              {rowKind === "umbrella" && (
                <span
                  className="tasks-type-chip tasks-type-chip-umbrella"
                  title="שורת עטיפה — מרכזת את כל תתי-המשימות שתחתיה"
                >
                  🪆 עטיפה
                </span>
              )}
              {rowKind === "parallel-child" && (
                <span
                  className="tasks-type-chip tasks-type-chip-parallel"
                  title="תת-משימה מקבילה תחת עטיפה — אין תלות בתתי-משימות אחרות"
                >
                  🌂 מקבילה
                </span>
              )}
              {rowKind === "chain-child" && (
                <span
                  className="tasks-type-chip tasks-type-chip-chain"
                  title="שלב בשרשרת — סדר מסירה אוטומטי מאחד לבא"
                >
                  🔗 בשרשרת
                </span>
              )}
            </div>
          );
        })()}
        {!compact && task.description && (
          <div className="tasks-desc-preview">
            {task.description.slice(0, 90)}
            {task.description.length > 90 ? "…" : ""}
          </div>
        )}
      </td>
      {!compact && (
        <td className="date-cell">{formatCreatedAt(task.created_at)}</td>
      )}
      <td className="date-cell">
        <TaskRequestedDateCell task={task} />
      </td>
      <td className="priority-cell">
        <TaskPriorityCell task={task} />
      </td>
      <td className="col-department">
        {(task.departments || []).length === 0 ? (
          "—"
        ) : (
          <span className="tasks-cell-depts">
            {(task.departments || []).map((d, i) => {
              const emoji = roleEmoji(d);
              const label = roleLabel(d);
              return (
                <span key={i} className="tasks-cell-dept" title={label || d}>
                  {emoji && <span aria-hidden>{emoji}</span>}
                  {emoji ? " " : ""}
                  {label || d}
                </span>
              );
            })}
          </span>
        )}
      </td>
      <td>
        {task.author_email ? (
          (() => {
            const authorPerson = people.find(
              (p) =>
                p.email.toLowerCase() === task.author_email.toLowerCase(),
            );
            const name = shortName(task.author_email, people) || task.author_email;
            return (
              <span
                className="cell-person"
                title={avatarHoverText(
                  name,
                  task.author_email,
                  authorPerson?.role,
                )}
              >
                <Avatar
                  name={task.author_email}
                  role={authorPerson?.role}
                  title={name}
                  size={18}
                />
                <span className="cell-person-name">{name}</span>
              </span>
            );
          })()
        ) : (
          "—"
        )}
      </td>
      <td className="col-assignees">
        <TaskAssigneesCell task={task} people={people} />
      </td>
      <td>
        <TaskApproverCell task={task} people={people} />
      </td>
      <td>
        <TaskStatusCell task={task} />
      </td>
      <td className="icons">
        <div className="tasks-row-icons">
          <Link
            href={`/tasks/${encodeURIComponent(task.id)}`}
            className="tasks-row-icon"
            title="פתח משימה"
          >
            📖
          </Link>
          {/* Edit shortcut — author-only OR admin. Mirrors the
              server-side gate in lib/tasksWriteDirect.ts so a user
              who can't actually save isn't shown the affordance. */}
          {(isAdmin ||
            (task.author_email &&
              userEmail &&
              task.author_email.toLowerCase() ===
                userEmail.toLowerCase())) && (
            <Link
              href={`/tasks/${encodeURIComponent(task.id)}?edit=1`}
              className="tasks-row-icon"
              title="ערוך משימה"
            >
              ✏️
            </Link>
          )}
          {task.drive_folder_url && (
            <a
              href={task.drive_folder_url}
              target="_blank"
              rel="noreferrer"
              className="tasks-row-icon tasks-row-icon-drive"
              title="תיקיית קבצים ב־Drive"
              aria-label="תיקיית קבצים ב־Drive"
            >
              <GoogleDriveIcon size="1em" />
            </a>
          )}
          {localPaths.windows && (
            <CopyLocalPathButton
              path={localPaths.windows}
              pathMac={localPaths.mac}
              title="העתק נתיב מקומי — Drive Desktop"
            />
          )}
          <Link
            href={`/tasks/${encodeURIComponent(task.id)}#history`}
            className={`tasks-row-icon${task.comments_count ? " has-comments" : ""}`}
            title={
              task.comments_count
                ? `${task.comments_count} תגובות`
                : "היסטוריה + הערות"
            }
          >
            💬
            {task.comments_count ? (
              <span className="tasks-row-icon-badge">{task.comments_count}</span>
            ) : null}
          </Link>
        </div>
      </td>
    </tr>
  );
}

/** Within the last 24h — same window the kanban card uses for the
 *  "🆕 חדש" chip. Now that within-bucket sort is rank-driven (not
 *  chronological), this badge restores the "what just landed" signal. */
function isCreatedWithin24h(iso: string): boolean {
  const ms = Date.parse(iso || "");
  if (!Number.isFinite(ms)) return false;
  return Date.now() - ms < 24 * 60 * 60 * 1000;
}

/** Classify a row's place in the dependency graph for the inline chip.
 *  Returns null for plain standalone tasks (the dominant case — we'd
 *  add visual noise to every row otherwise). The four cases:
 *   - umbrella       → row IS an umbrella container
 *   - parallel-child → row sits under an umbrella with NO edges
 *   - chain-child    → row sits under an umbrella with edges, OR has
 *                      edges without an umbrella (rare standalone-link)
 *   - null           → standalone task with no umbrella and no edges */
type TaskKind = "umbrella" | "parallel-child" | "chain-child";
function classifyTask(task: WorkTask): TaskKind | null {
  if (task.is_umbrella) return "umbrella";
  const hasEdges =
    (task.blocks?.length ?? 0) > 0 || (task.blocked_by?.length ?? 0) > 0;
  if (task.umbrella_id) {
    return hasEdges ? "chain-child" : "parallel-child";
  }
  return hasEdges ? "chain-child" : null;
}


// `shortName` was an inline email-prefix fallback before the
// names_to_emails sheet got a `he name` column. Now we route through
// the shared resolver so every employee chip prefers the Hebrew name,
// then English name, then email-prefix as last resort.
function shortName(email: string, people?: TasksPerson[]): string {
  return personDisplayName(email, people);
}

function formatCreatedAt(iso: string): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}
