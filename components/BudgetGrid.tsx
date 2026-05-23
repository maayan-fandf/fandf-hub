"use client";

import { useMemo, useState } from "react";
import CopyAmountButton from "./CopyAmountButton";
import PrisaButton from "./PrisaButton";
import GoogleAdsIcon from "./GoogleAdsIcon";
import FacebookAdsIcon from "./FacebookAdsIcon";
import {
  E3_PLATFORMS,
  MANAGER_ORDER,
  PLATFORM_LABELS,
  UNASSIGNED_MANAGER,
  pacingPlatformKey,
  type BudgetProject,
  type MediaPlanRow,
  type Platform,
  type PlatformAgg,
} from "@/lib/budgetTypes";

/**
 * קמפיינים → תקציבים grid. Summary row per project (E3 vs allocated +
 * per-platform pacing); click to expand the campaign rows and edit the
 * תקציב חודשי מאושר (column G) inline. Each platform gets a quick-open
 * button that copies the daily-required budget and opens the ad account.
 *
 * The grid keeps a local, optimistic copy of the projects so an inline
 * edit recomputes allocation/reconciliation/pacing instantly without a
 * round-trip; the write hits /api/campaigns/budget in the background and
 * the cell rolls back + shows an error if it fails.
 */

type ProjLinks = {
  gAdsUrl?: string;
  fbAdsUrl?: string;
  sheetTabUrl?: string;
  /** Hub project-page href, e.g. /projects/<name>. */
  projectHref?: string;
};

export type BudgetDismissal = {
  snooze_until: string;
  dismissed_at: string;
  reason: string;
};

export default function BudgetGrid({
  projects: initial,
  adLinks,
  inactiveProjects,
  showAdLinks,
  canEdit,
  dismissals,
  today,
  usdIlsRate,
}: {
  projects: BudgetProject[];
  /** keyed by tab name (lowercased). */
  adLinks: Record<string, ProjLinks>;
  /** Slug(==tab, lowercased) → is-inactive, using the same rule as the
   *  projects home screen / top-nav (lib/projectEnded): ended >5 days ago
   *  OR no current-month spend. Explicit true/false per feed project;
   *  absent = not in the feed (falls back to the all-zero heuristic). */
  inactiveProjects: Record<string, boolean>;
  showAdLinks: boolean;
  canEdit: boolean;
  /** "טיפלתי" snoozes keyed by the shared per-platform pacing signal_key
   *  (`<slug>|pacing-variance|platform|<platform>`) — the same key the
   *  morning feed and the dashboard project-page pacing cell use. */
  dismissals: Record<string, BudgetDismissal>;
  /** Today (Asia/Jerusalem) YYYY-MM-DD, for snooze/resurface evaluation. */
  today: string;
  /** USD→ILS rate; Taboola/Outbrain required budgets copy in USD. */
  usdIlsRate: number;
}) {
  const [projects, setProjects] = useState<BudgetProject[]>(initial);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<
    "all" | "attention" | "distribution" | "pacing"
  >("all");
  const [showInactive, setShowInactive] = useState(false);
  // Optimistic "טיפלתי" snoozes lifted here (signal_key → on/off) so BOTH
  // the campaign row AND the project's platform-summary cell fade
  // immediately, before the next server read.
  const [localDismiss, setLocalDismiss] = useState<Record<string, "on" | "off">>(
    {},
  );
  const onSnooze = (key: string, val: "on" | "off") =>
    setLocalDismiss((m) => ({ ...m, [key]: val }));

  const counts = useMemo(() => {
    let attention = 0,
      distribution = 0,
      pacing = 0,
      active = 0;
    for (const p of projects) {
      if (isInactive(p, inactiveProjects)) continue;
      active++;
      const dist = p.reconStatus === "over" || p.reconStatus === "under";
      const pace = hasPacingIssue(p);
      if (dist) distribution++;
      if (pace) pacing++;
      if (dist || pace || (p.reconStatus === "no-target" && p.allocated > 0))
        attention++;
    }
    return { attention, distribution, pacing, active, total: projects.length };
  }, [projects, inactiveProjects]);

  const visible = useMemo(() => {
    const list = projects.filter((p) => {
      if (isInactive(p, inactiveProjects) && !showInactive) return false;
      if (filter === "all") return true;
      const dist = p.reconStatus === "over" || p.reconStatus === "under";
      const pace = hasPacingIssue(p);
      if (filter === "distribution") return dist;
      if (filter === "pacing") return pace;
      // attention
      return dist || pace || (p.reconStatus === "no-target" && p.allocated > 0);
    });
    return list;
  }, [projects, filter, showInactive, inactiveProjects]);

  // Group the filtered projects: manager → company → projects. A
  // co-managed project lands under each of its managers.
  const grouped = useMemo(() => {
    const byMgr = new Map<string, Map<string, BudgetProject[]>>();
    for (const p of visible) {
      const mgrs = p.managers.length ? p.managers : [UNASSIGNED_MANAGER];
      for (const m of mgrs) {
        let cm = byMgr.get(m);
        if (!cm) {
          cm = new Map();
          byMgr.set(m, cm);
        }
        const co = p.company || "ללא חברה";
        let arr = cm.get(co);
        if (!arr) {
          arr = [];
          cm.set(co, arr);
        }
        arr.push(p);
      }
    }
    const keys = [...byMgr.keys()];
    const ordered = [
      ...MANAGER_ORDER.filter((m) => byMgr.has(m)),
      ...keys
        .filter((m) => !MANAGER_ORDER.includes(m) && m !== UNASSIGNED_MANAGER)
        .sort((a, b) => a.localeCompare(b, "he")),
      ...(byMgr.has(UNASSIGNED_MANAGER) ? [UNASSIGNED_MANAGER] : []),
    ];
    return ordered.map((m) => {
      const cm = byMgr.get(m)!;
      const companies = [...cm.keys()]
        .sort((a, b) => a.localeCompare(b, "he"))
        .map((co) => ({
          company: co,
          projects: cm.get(co)!.slice().sort(sortProjects),
        }));
      const projCount = companies.reduce((s, c) => s + c.projects.length, 0);
      return { manager: m, companies, projCount };
    });
  }, [visible]);

  function toggle(tab: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(tab)) next.delete(tab);
      else next.add(tab);
      return next;
    });
  }

  function applyEdit(tab: string, rowNum: number, value: number) {
    setProjects((prev) =>
      prev.map((p) => (p.tab === tab ? recomputeProject(p, rowNum, value) : p)),
    );
  }

  return (
    <div className="budget-wrap">
      <div className="budget-toolbar">
        <div className="budget-filters">
          <FilterChip
            label="דורש טיפול"
            count={counts.attention}
            active={filter === "attention"}
            onClick={() => setFilter("attention")}
            tone="attention"
          />
          <FilterChip
            label="חלוקה לא תקינה"
            count={counts.distribution}
            active={filter === "distribution"}
            onClick={() => setFilter("distribution")}
            tone="distribution"
          />
          <FilterChip
            label="קצב חורג"
            count={counts.pacing}
            active={filter === "pacing"}
            onClick={() => setFilter("pacing")}
            tone="pacing"
          />
          <FilterChip
            label="הכל"
            count={counts.active}
            active={filter === "all"}
            onClick={() => setFilter("all")}
          />
        </div>
        <label className="budget-inactive-toggle">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          הצג פרויקטים לא פעילים
        </label>
      </div>

      <div className="budget-legend">
        <span className="budget-dot pace-under" /> מתחת לקצב (לא ינוצל)
        <span className="budget-dot pace-ok" /> בקצב
        <span className="budget-dot pace-over" /> מעל הקצב (חריגה)
      </div>

      {grouped.length === 0 ? (
        <div className="empty">
          <span className="emoji" aria-hidden>
            ✅
          </span>
          אין פרויקטים בקטגוריה הזו.
        </div>
      ) : (
        grouped.map((mg) => (
          <section key={mg.manager} className="budget-mgr-group">
            <h2 className="budget-mgr-head">
              <span className="budget-mgr-name">👤 {mg.manager}</span>
              <span className="budget-mgr-count">{mg.projCount} פרויקטים</span>
              <GroupTotals
                projects={mg.companies.flatMap((c) => c.projects)}
              />
              <ManagerCsvButtons
                manager={mg.manager}
                projects={mg.companies.flatMap((c) => c.projects)}
                adLinks={adLinks}
                showAdLinks={showAdLinks}
              />
            </h2>
            {mg.companies.map((cg) => (
              <div key={cg.company} className="budget-co-group">
                <h3 className="budget-co-head">
                  <span className="budget-co-name">{cg.company}</span>
                  <GroupTotals projects={cg.projects} />
                  <CompanyCsvButtons
                    company={cg.company}
                    projects={cg.projects}
                    adLinks={adLinks}
                    showAdLinks={showAdLinks}
                  />
                </h3>
                <ul className="budget-list">
                  {cg.projects.map((p) => (
                    <ProjectRow
                      key={p.tab}
                      p={p}
                      open={expanded.has(p.tab)}
                      onToggle={() => toggle(p.tab)}
                      ad={adLinks[p.tab.toLowerCase()] || {}}
                      showAdLinks={showAdLinks}
                      canEdit={canEdit}
                      onEdit={applyEdit}
                      dismissals={dismissals}
                      today={today}
                      usdIlsRate={usdIlsRate}
                      localDismiss={localDismiss}
                      onSnooze={onSnooze}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ))
      )}
    </div>
  );
}

/** Σ E3 vs Σ allocated for a set of projects (manager/company subtotal). */
function GroupTotals({ projects }: { projects: BudgetProject[] }) {
  let e3 = 0,
    allocated = 0;
  for (const p of projects) {
    e3 += p.e3;
    allocated += p.allocated;
  }
  const diff = allocated - e3;
  const tone = Math.abs(diff) < 1 ? "ok" : diff > 0 ? "over" : "under";
  return (
    <span className="budget-grouptotals">
      יעד {fmt(e3)} · חולק {fmt(allocated)}
      {Math.abs(diff) >= 1 && (
        <span className={`budget-grouptotals-delta tone-${tone}`}>
          ({diff > 0 ? "+" : "−"}
          {fmt(Math.abs(diff))})
        </span>
      )}
    </span>
  );
}

/** Sort within a company: attention first, then biggest |delta|, then name. */
function sortProjects(a: BudgetProject, b: BudgetProject): number {
  const aa = needsAttention(a) ? 0 : 1;
  const bb = needsAttention(b) ? 0 : 1;
  if (aa !== bb) return aa - bb;
  const ad = Math.abs(a.delta);
  const bd = Math.abs(b.delta);
  if (ad !== bd) return bd - ad;
  return a.name.localeCompare(b.name, "he");
}

/* ── summary + drill-in row ──────────────────────────────────────── */

function ProjectRow({
  p,
  open,
  onToggle,
  ad,
  showAdLinks,
  canEdit,
  onEdit,
  dismissals,
  today,
  usdIlsRate,
  localDismiss,
  onSnooze,
}: {
  p: BudgetProject;
  open: boolean;
  onToggle: () => void;
  ad: ProjLinks;
  showAdLinks: boolean;
  canEdit: boolean;
  onEdit: (tab: string, row: number, value: number) => void;
  dismissals: Record<string, BudgetDismissal>;
  today: string;
  usdIlsRate: number;
  localDismiss: Record<string, "on" | "off">;
  onSnooze: (key: string, val: "on" | "off") => void;
}) {
  const [showPlan, setShowPlan] = useState(false);
  const projectHref =
    ad.projectHref || `/projects/${encodeURIComponent(p.name)}`;
  return (
    <li className={`budget-card ${needsAttention(p) ? "is-attention" : ""}`}>
      <button
        type="button"
        className="budget-summary"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className={`budget-caret ${open ? "open" : ""}`}>▸</span>
        <span className="budget-proj">
          <span className="budget-proj-name">
            {hasChannelAlert(p) && (
              <span
                className="budget-alert"
                title="יש ערוץ אחד או יותר שהתקציב היומי בו לא תואם את הנדרש — נדרש עדכון"
                aria-label="נדרש עדכון תקציב באחד הערוצים"
              >
                ⚠️
              </span>
            )}
            {p.name}
          </span>
          {p.company && <span className="budget-proj-co">{p.company}</span>}
          <span className="budget-days">
            {p.remainingDays > 0 ? `עוד ${p.remainingDays} ימים` : "הסתיים"}
          </span>
        </span>

        <span className="budget-recon">
          <span className="budget-recon-target">
            יעד: {fmt(p.e3)}
          </span>
          <span className="budget-recon-alloc">חולק: {fmt(p.allocated)}</span>
          <ReconBadge p={p} />
        </span>

        <ProjectProgress p={p} />

        <span className="budget-platcells">
          {E3_PLATFORMS.map((pl) => (
            <PlatformCell
              key={pl}
              platform={pl}
              agg={p.platforms[pl]}
              dimmed={platformDimmed(p, pl, dismissals, localDismiss, today)}
            />
          ))}
        </span>
      </button>

      {open && (
        <div className="budget-detail">
          <div className="budget-actions">
            {ad.sheetTabUrl && (
              <a
                href={ad.sheetTabUrl}
                target="_blank"
                rel="noreferrer"
                className="budget-action-btn"
              >
                📊 פתח בגיליון
              </a>
            )}
            <a
              href={projectHref}
              target="_blank"
              rel="noreferrer"
              className="budget-action-btn"
            >
              🏢 פתח עמוד פרוייקט
            </a>
            {p.plan && (
              <button
                type="button"
                className={`budget-action-btn ${showPlan ? "is-active" : ""}`}
                onClick={() => setShowPlan((s) => !s)}
                aria-pressed={showPlan}
              >
                📊 {showPlan ? "הסתר פריסה" : "הראה פריסה"}
              </button>
            )}
            {p.company && <PrisaButton company={p.company} project={p.name} />}
          </div>

          {showPlan && p.plan && <MediaPlanPanel plan={p.plan} />}

          <PlatformDrillGroups
            p={p}
            ad={ad}
            showAdLinks={showAdLinks}
            canEdit={canEdit}
            onEdit={onEdit}
            dismissals={dismissals}
            today={today}
            usdIlsRate={usdIlsRate}
            localDismiss={localDismiss}
            onSnooze={onSnooze}
          />
        </div>
      )}
    </li>
  );
}

/** הראה פריסה — the project's current media-plan KPIs (פריסה נוכחית). */
function MediaPlanPanel({ plan }: { plan: MediaPlanRow }) {
  const pct = (v: number) => `${Math.round((v || 0) * 100)}%`;
  return (
    <div className="budget-plan">
      <div className="budget-plan-title">📐 פריסה נוכחית (תוכנית מדיה)</div>
      <div className="budget-plan-kpis">
        <PlanKpi label="תקציב כולל" value={fmt(plan.budget)} />
        <PlanKpi label="ניצול" value={`${fmt(plan.spend)} · ${pct(plan.spendPct)}`} />
        <PlanKpi label="זמן שחלף" value={pct(plan.timePct)} />
        <PlanKpi label="לידים" value={String(Math.round(plan.leads))} />
        <PlanKpi label="עלות לליד" value={fmt(plan.cpl)} />
        <PlanKpi
          label="תיאומים"
          value={`${Math.round(plan.meetings)} · ${pct(plan.meetingPct)}`}
        />
        {(plan.startIso || plan.endIso) && (
          <PlanKpi label="טווח" value={`${plan.startIso || "?"} – ${plan.endIso || "?"}`} />
        )}
      </div>
    </div>
  );
}

function PlanKpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="budget-plan-kpi">
      <span className="budget-plan-kpi-label">{label}</span>
      <span className="budget-plan-kpi-val">{value}</span>
    </div>
  );
}

function PlatformDrillGroups({
  p,
  ad,
  showAdLinks,
  canEdit,
  onEdit,
  dismissals,
  today,
  usdIlsRate,
  localDismiss,
  onSnooze,
}: {
  p: BudgetProject;
  ad: ProjLinks;
  showAdLinks: boolean;
  canEdit: boolean;
  onEdit: (tab: string, row: number, value: number) => void;
  dismissals: Record<string, BudgetDismissal>;
  today: string;
  usdIlsRate: number;
  localDismiss: Record<string, "on" | "off">;
  onSnooze: (key: string, val: "on" | "off") => void;
}) {
  const groups: { platform: Platform | "other"; label: string; agg: PlatformAgg }[] =
    [
      ...E3_PLATFORMS.map((pl) => ({
        platform: pl as Platform | "other",
        label: PLATFORM_LABELS[pl],
        agg: p.platforms[pl],
      })),
      { platform: "other" as const, label: "אחר (לא בתקציב הפרוגרמטי)", agg: p.other },
    ];

  return (
    <div className="budget-groups">
      {groups.map((g) => {
        const rows = p.rows.filter((r) => r.platform === g.platform);
        if (rows.length === 0 && g.agg.budget === 0) return null;
        const url =
          g.platform === "google"
            ? ad.gAdsUrl
            : g.platform === "facebook"
              ? ad.fbAdsUrl
              : undefined;
        const isPaid = g.platform !== "other";
        // Taboola/Outbrain are set in the platform in USD, so the
        // required-budget copy is converted from the ILS-tracked figure.
        // TikTok defaults to ILS (like Google/Facebook) — flip it into this
        // set if the F&F TikTok account is actually billed in USD.
        const isUsd = g.platform === "taboola" || g.platform === "outbrain";
        const reqIls = Math.max(0, g.agg.dailyRequired);
        const reqVal = isUsd
          ? Math.max(0, Math.round(reqIls / (usdIlsRate || 3.7)))
          : Math.max(0, Math.round(reqIls));
        const cur = isUsd ? "$" : "₪";
        return (
          <div key={g.platform} className="budget-group">
            <div className="budget-group-head">
              <span className="budget-group-title">
                <PlatformLogoLink
                  platform={g.platform}
                  href={showAdLinks ? url : undefined}
                  copySlug={g.platform === "google" ? p.tab : undefined}
                  title={
                    g.platform === "google"
                      ? "פתח את חשבון Google Ads (המזהה מועתק ללוח לסינון לפי שם קמפיין)"
                      : g.platform === "facebook"
                        ? "פתח את חשבון פייסבוק"
                        : undefined
                  }
                />{" "}
                {g.label}
              </span>
              {isPaid && (
                <span className="budget-group-stats">
                  {fmt(g.agg.budget)} מאושר · {fmt(g.agg.spend)} בפועל ·{" "}
                  <span className="budget-pace-diag" title={pacingTooltip(g.agg)}>
                    <Pacing
                      ratio={g.agg.pacingRatio}
                      muted={
                        !needsBudgetAction(
                          g.agg.actualDaily,
                          g.agg.dailyRequired,
                          g.agg.pacingRatio,
                        )
                      }
                    />{" "}
                    ⓘ
                  </span>
                  {(g.platform === "google" || g.platform === "facebook") && (
                    <>
                      {" · "}יומי בפועל:{" "}
                      <b className="budget-actual-daily">
                        ₪{Math.round(g.agg.actualDaily).toLocaleString("he-IL")}
                      </b>
                    </>
                  )}
                </span>
              )}
              {isPaid && g.agg.dailyRequired > 0 && (
                <CopyAmountButton
                  amount={String(reqVal)}
                  variant="ghost"
                  url={showAdLinks ? url : undefined}
                  // Google: copy the required NUMBER (for the daily-budget
                  // field) AND the slug — the slug is written last so it's the
                  // current clipboard for the campaign-name filter, with the
                  // number one back in clipboard history (two separate items).
                  // Facebook's deep-link opens already campaign-scoped, so the
                  // open button just opens — no number to clobber the clipboard.
                  // The no-url fallback stays a plain "copy the number" button.
                  copyId={g.platform === "facebook" ? undefined : p.tab}
                  copyAmount={!(g.platform === "facebook" && showAdLinks && url)}
                  label={
                    showAdLinks && url
                      ? g.platform === "facebook"
                        ? `⧉ פתח · נדרש ${cur}${reqVal}/יום`
                        : `⧉ פתח + העתק נדרש ${cur}${reqVal}/יום`
                      : `📋 נדרש ${cur}${reqVal}/יום`
                  }
                />
              )}
            </div>
            {rows.length > 0 && (
              <table className="budget-rows">
                <thead>
                  <tr>
                    <th>ערוץ</th>
                    <th>סוג</th>
                    <th>תקציב מאושר</th>
                    <th>בפועל</th>
                    <th
                      className="th-help"
                      title={
                        "קצב = הוצאה בפועל ÷ ההוצאה הצפויה עד היום " +
                        "(לפי תאריכי הטיסה של הערוץ עצמו).\n" +
                        "100% = בדיוק בקצב\n" +
                        "מתחת ל-85% = מתחת לקצב — התקציב לא ינוצל עד תאריך הסיום (כדאי להעלות את היומי)\n" +
                        "מעל 110% = חריגה — התקציב ייגמר לפני הסיום (כדאי להוריד)\n" +
                        "ערוץ שהסתיים מסומן ⛔ ואינו נספר."
                      }
                    >
                      קצב <span aria-hidden>ⓘ</span>
                    </th>
                    <th>יומי מוגדר</th>
                    <th>נדרש ליום</th>
                    <th aria-label="טיפלתי"> </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <CampaignRow
                      key={r.row}
                      tab={p.tab}
                      r={r}
                      platActual={g.agg.actualDaily}
                      canEdit={canEdit}
                      onEdit={onEdit}
                      dismissals={dismissals}
                      today={today}
                      localDismiss={localDismiss}
                      onSnooze={onSnooze}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}

type FadeState = "active" | "dismissed" | "resurfaced";

function parseBaseline(reason: string): number | null {
  const m = (reason || "").match(/baseline=(-?\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

/** A dismissal's `dismissed_at` (ISO/UTC) → its calendar date in Asia/
 *  Jerusalem, so it compares apples-to-apples with `today` (also Jerusalem).
 *  A raw .slice(0,10) would be the UTC date and trip the overnight check a
 *  day early for evening-Israel dismissals. */
function jeruDateOf(iso: string): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jerusalem",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/**
 * Whether a "טיפלתי"-snoozed row should stay faded or resurface. The
 * snooze self-resurfaces the next day if the platform's actual daily
 * budget didn't actually change after Supermetrics ran overnight (the
 * baseline recorded at snooze time still matches the current value).
 */
function computeFadeState(
  actualDaily: number,
  dismissal: BudgetDismissal | undefined,
  today: string,
  local: "on" | "off" | null,
): FadeState {
  if (local === "off") return "active";
  if (local === "on") return "dismissed";
  if (!dismissal) return "active";
  const until = (dismissal.snooze_until || "").slice(0, 10);
  if (!until || until < today) return "active"; // expired / cleared
  const baseline = parseBaseline(dismissal.reason);
  // Compare the dismissal day in Asia/Jerusalem (same tz as `today`). A raw
  // .slice(0,10) is the UTC date, which for an evening-Israel dismissal is
  // already "yesterday" vs the Jerusalem "today" — flipping overnightPassed
  // true immediately and resurfacing the snooze the same evening (the
  // "doesn't stick on reload" bug).
  const dDate = jeruDateOf(dismissal.dismissed_at);
  const overnightPassed = !!dDate && dDate < today;
  const unchanged =
    baseline != null && Math.round(actualDaily) === Math.round(baseline);
  if (overnightPassed && unchanged) return "resurfaced";
  return "dismissed";
}

/** The shared per-platform pacing key for a project row's platform. */
function rowKey(tab: string, r: BudgetProject["rows"][number]): string {
  return pacingPlatformKey(tab, r.platform);
}

/**
 * A platform's summary cell is "handled" (dimmed) when it has off-pace
 * channels and the platform's shared pacing snooze is active (dismissed).
 * If the snooze expired or resurfaced (the pacing problem persists / the
 * budget wasn't actually changed), the cell stays lit.
 */
function platformDimmed(
  p: BudgetProject,
  pl: Platform,
  dismissals: Record<string, BudgetDismissal>,
  localDismiss: Record<string, "on" | "off">,
  today: string,
): boolean {
  const hasOffPace = p.rows.some((r) => {
    if (r.platform !== pl || r.ended) return false;
    const t = paceTone(r.pacingRatio);
    return t === "over" || t === "under";
  });
  if (!hasOffPace) return false;
  const key = pacingPlatformKey(p.tab, pl);
  return (
    computeFadeState(
      p.platforms[pl].actualDaily,
      dismissals[key],
      today,
      localDismiss[key] ?? null,
    ) === "dismissed"
  );
}

function CampaignRow({
  tab,
  r,
  platActual,
  canEdit,
  onEdit,
  dismissals,
  today,
  localDismiss,
  onSnooze,
}: {
  tab: string;
  r: BudgetProject["rows"][number];
  /** The platform's summed actual daily budget — the shared snooze
   *  baseline, so every row of a platform fades/resurfaces together. */
  platActual: number;
  canEdit: boolean;
  onEdit: (tab: string, row: number, value: number) => void;
  dismissals: Record<string, BudgetDismissal>;
  today: string;
  localDismiss: Record<string, "on" | "off">;
  onSnooze: (key: string, val: "on" | "off") => void;
}) {
  const [draft, setDraft] = useState(String(Math.round(r.budget)));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);
  const [snoozing, setSnoozing] = useState(false);

  async function commit() {
    const value = Number(draft.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(value) || value < 0) {
      setDraft(String(Math.round(r.budget)));
      setErr("");
      return;
    }
    if (Math.round(value) === Math.round(r.budget)) return; // no change
    setSaving(true);
    setErr("");
    try {
      const res = await fetch("/api/campaigns/budget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tab,
          row: r.row,
          value,
          expectedChannel: r.channel,
          expectedBudget: r.budget,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setErr(data.error || "שמירה נכשלה");
        setDraft(String(Math.round(r.budget)));
        return;
      }
      onEdit(tab, r.row, value);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "שמירה נכשלה");
      setDraft(String(Math.round(r.budget)));
    } finally {
      setSaving(false);
    }
  }

  const signalKey = rowKey(tab, r);

  async function snooze(restore: boolean) {
    setSnoozing(true);
    try {
      const res = await fetch("/api/campaigns/budget-dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: tab,
          platform: r.platform,
          baselineDaily: platActual,
          restore,
        }),
      });
      const d = (await res.json()) as { ok?: boolean };
      // Lift to the grid so every row of this platform + the project's
      // platform-summary cell fade together (shared per-platform key).
      if (res.ok && d.ok) onSnooze(signalKey, restore ? "off" : "on");
    } catch {
      /* best-effort; leave state as-is */
    } finally {
      setSnoozing(false);
    }
  }

  const state = computeFadeState(
    platActual,
    dismissals[signalKey],
    today,
    localDismiss[signalKey] ?? null,
  );
  const dailyReq = Math.max(0, Math.round(r.dailyRequired));
  // Action is needed only when the configured daily is materially off the
  // required daily — not merely because the historical קצב deviates.
  // "Other" channels live outside the programmatic (E3) budget, so the
  // budget-action ⚠️ never applies to them.
  const isProgrammatic = r.platform !== "other";
  const needsAction =
    isProgrammatic &&
    !r.ended &&
    needsBudgetAction(r.actualDaily, r.dailyRequired, r.pacingRatio);
  // Arrow direction: by the configured-vs-required gap when we know the
  // configured daily; else by the historical pacing tone.
  const actionTone: "over" | "under" | "ok" | "none" = !needsAction
    ? "ok"
    : r.actualDaily > 0 && r.dailyRequired > 0
      ? r.dailyRequired > r.actualDaily
        ? "under"
        : "over"
      : paceTone(r.pacingRatio);
  // ✓ טיפלתי only where there's actually something to handle.
  const offPace = needsAction;

  return (
    <tr
      className={`${err ? "row-error" : ""} ${state === "dismissed" ? "is-dismissed" : ""}`}
    >
      <td className="c-channel" title={r.channel}>
        <StatusDot status={r.campaignStatus} />
        {needsAction && (
          <span
            className="budget-alert"
            title="התקציב היומי בפלטפורמה לא תואם את הנדרש — נדרש עדכון"
            aria-label="נדרש עדכון תקציב"
          >
            ⚠️
          </span>
        )}
        {r.channel}
      </td>
      <td className="c-type" title={r.campaignType}>
        {r.campaignType || "—"}
      </td>
      <td className="c-budget">
        {canEdit ? (
          <span className="budget-edit">
            <span className="cur">₪</span>
            <input
              type="text"
              inputMode="numeric"
              value={draft}
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") {
                  setDraft(String(Math.round(r.budget)));
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
            {saving && <span className="budget-saving">…</span>}
            {savedFlash && <span className="budget-saved">✓</span>}
          </span>
        ) : (
          fmt(r.budget)
        )}
        {err && <span className="budget-err" title={err}>⚠️</span>}
      </td>
      <td className="c-spend">{fmt(r.spend)}</td>
      <td className="c-pace">
        {r.ended ? (
          <span className="pace-val pace-none" title={`הסתיים ${r.endIso}`}>
            ⛔
          </span>
        ) : (
          <Pacing ratio={r.pacingRatio} muted={!needsAction} />
        )}
      </td>
      <td className="c-actualdaily" title="תקציב יומי שמוגדר בפלטפורמה">
        {r.actualDaily > 0
          ? `₪${Math.round(r.actualDaily).toLocaleString("he-IL")}`
          : "—"}
      </td>
      <td className="c-daily">
        {r.ended ? (
          "—"
        ) : (
          <span className="budget-daily">
            {/* Action arrow by the configured-vs-required gap: ⬆ raise when
                the platform daily is below נדרש, ⬇ lower when above. No
                arrow / neutral when it's already set right. */}
            <span className={`budget-need pace-${actionTone}`}>
              ₪{dailyReq.toLocaleString("he-IL")}
              {actionTone === "over" ? " ⬇" : actionTone === "under" ? " ⬆" : ""}
            </span>
            <CopyAmountButton
              amount={String(dailyReq)}
              variant="ghost"
              label="📋"
            />
          </span>
        )}
      </td>
      <td className="c-handled">
        {state === "dismissed" ? (
          <button
            type="button"
            className="budget-handled-btn is-done"
            disabled={snoozing}
            onClick={() => snooze(true)}
            title="בטל טיפול — החזר את ההתראה"
          >
            ↩︎ בטל
          </button>
        ) : offPace ? (
          <button
            type="button"
            className="budget-handled-btn"
            disabled={snoozing}
            onClick={() => snooze(false)}
            title="טיפלתי — שקט עד מחר; אם התקציב לא ישתנה אחרי שהדאטה יתעדכן, ההתראה תחזור"
          >
            ✓ טיפלתי{state === "resurfaced" ? " (חזר)" : ""}
          </button>
        ) : null}
      </td>
    </tr>
  );
}

/* ── small presentational pieces ─────────────────────────────────── */

function PlatformCell({
  platform,
  agg,
  dimmed,
}: {
  platform: Platform;
  agg: PlatformAgg;
  dimmed?: boolean;
}) {
  const empty = agg.budget === 0 && agg.spend === 0;
  const action =
    !dimmed &&
    needsBudgetAction(agg.actualDaily, agg.dailyRequired, agg.pacingRatio);
  // Direction to move the daily budget — same semantics as the dashboard's
  // קצב יומי cell: ⬆ raise (configured below required), ⬇ lower (above).
  const dir: "over" | "under" | "none" = !action
    ? "none"
    : agg.actualDaily > 0 && agg.dailyRequired > 0
      ? agg.dailyRequired > agg.actualDaily
        ? "under"
        : "over"
      : paceTone(agg.pacingRatio) === "over"
        ? "over"
        : "under";
  return (
    <span
      className={`budget-platcell ${empty ? "is-empty" : ""} ${dimmed ? "is-handled" : ""}`}
      title={dimmed ? "טופל — ההתראה מושתקת (תחזור אם הקצב עדיין חורג)" : undefined}
    >
      <span className="pc-name">
        <PlatformIcon platform={platform} /> {PLATFORM_LABELS[platform]}
      </span>
      {empty ? (
        <span className="pc-empty">—</span>
      ) : (
        <>
          <span className="pc-amt">{fmt(agg.budget)}</span>
          <span className="pc-sub">
            {dir !== "none" && (
              <span
                className={`budget-arrow pace-${dir}`}
                title={
                  dir === "under"
                    ? "נדרש להעלות את התקציב היומי"
                    : "נדרש להוריד את התקציב היומי"
                }
              >
                {dir === "under" ? "⬆" : "⬇"}
              </span>
            )}
            {fmt(agg.spend)}
          </span>
        </>
      )}
    </span>
  );
}

/**
 * Two compact progress bars on the project summary row: budget consumed
 * (allocatedSpend ÷ allocated, i.e. the Σ col-G approved budget actually
 * spent) and time elapsed (days passed ÷ flight length). Each shows the
 * %, the real amounts, and the date range — same idea as the morning
 * dashboard's פריסה cards. Mirrors the BudgetBar/TimeBar math there.
 */
function ProjectProgress({ p }: { p: BudgetProject }) {
  // Prefer the actually-allocated budget (חולק); fall back to the E3 target
  // when nothing's distributed yet so the bar still reads.
  const budget = p.allocated > 0 ? p.allocated : p.e3;
  const spent = p.allocatedSpend;
  const budgetPct = budget > 0 ? spent / budget : 0;
  const overBudget = budgetPct > 1;
  const elapsedPct =
    p.totalDays > 0
      ? Math.max(0, (p.totalDays - p.remainingDays) / p.totalDays)
      : 0;
  const hasBudget = budget > 0;
  const hasDates = !!(p.startIso && p.endIso);
  if (!hasBudget && !hasDates) return <span className="budget-progress" />;
  return (
    <span className="budget-progress">
      {hasBudget && (
        <span
          className="budget-progress-row"
          title={`נוצל ₪${Math.round(spent).toLocaleString("he-IL")} מתוך ₪${Math.round(
            budget,
          ).toLocaleString("he-IL")}`}
        >
          <span className="bp-head">
            <span className="bp-label">תקציב</span>
            <span className="bp-val">{Math.round(budgetPct * 100)}%</span>
            <span className="bp-detail">
              {fmt(spent)} / {fmt(budget)}
            </span>
          </span>
          <span className="bp-track">
            <span
              className={`bp-fill ${overBudget ? "is-over" : ""}`}
              style={{ width: `${Math.round(Math.min(100, budgetPct * 100))}%` }}
            />
          </span>
        </span>
      )}
      {hasDates && (
        <span
          className="budget-progress-row"
          title={`${p.startIso} – ${p.endIso}${
            p.remainingDays > 0 ? ` · עוד ${p.remainingDays} ימים` : " · הסתיים"
          }`}
        >
          <span className="bp-head">
            <span className="bp-label">זמן</span>
            <span className="bp-val">{Math.round(elapsedPct * 100)}%</span>
            <span className="bp-detail">
              {fmtDmy(p.startIso)} – {fmtDmy(p.endIso)}
            </span>
          </span>
          <span className="bp-track">
            <span
              className="bp-fill"
              style={{ width: `${Math.round(Math.min(100, elapsedPct * 100))}%` }}
            />
          </span>
        </span>
      )}
    </span>
  );
}

function ReconBadge({ p }: { p: BudgetProject }) {
  if (p.reconStatus === "no-target")
    return <span className="recon-badge tone-none">אין יעד</span>;
  if (p.reconStatus === "ok")
    return <span className="recon-badge tone-ok">✓ מאוזן</span>;
  const over = p.reconStatus === "over";
  return (
    <span className={`recon-badge ${over ? "tone-over" : "tone-under"}`}>
      {over ? "חריגה +" : "חסר −"}
      {fmt(Math.abs(p.delta))}
    </span>
  );
}

function Pacing({ ratio, muted }: { ratio: number; muted?: boolean }) {
  if (!ratio) return <span className="pace-val pace-none">—</span>;
  // muted = the daily budget is already set to land on target, so the
  // historical pacing ratio isn't actionable → show it neutral, not red.
  const tone = muted ? "none" : paceTone(ratio);
  return (
    <span
      className={`pace-val pace-${tone}`}
      title={
        muted
          ? "התקציב היומי מכוון לנחיתה על היעד — הסטייה היסטורית, אין צורך בפעולה"
          : undefined
      }
    >
      {Math.round(ratio * 100)}%
    </span>
  );
}

/**
 * Whether the manager actually needs to change the daily budget: the
 * configured daily (actualDaily / יומי מוגדר) is materially off the required
 * daily (dailyRequired / נדרש ליום). When they match, the campaign is set to
 * land on budget by the end date, so the historical pacing ratio is stale —
 * NOT an alert. When the configured daily is unknown (0, e.g. Taboola/
 * Outbrain or an unmatched row), fall back to the historical pacing ratio.
 */
function needsBudgetAction(
  actualDaily: number,
  dailyRequired: number,
  pacingRatio: number,
): boolean {
  if (actualDaily > 0 && dailyRequired > 0) {
    return Math.abs(actualDaily - dailyRequired) / dailyRequired > 0.12;
  }
  const t = paceTone(pacingRatio);
  return t === "over" || t === "under";
}

function FilterChip({
  label,
  count,
  active,
  onClick,
  tone,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  tone?: string;
}) {
  return (
    <button
      type="button"
      className={`budget-chip ${active ? "is-active" : ""} ${tone ? `tone-${tone}` : ""}`}
      onClick={onClick}
    >
      {label} <span className="chip-count">{count}</span>
    </button>
  );
}

/** Brand mark for a platform — reuses the project's Google Ads / Facebook
 *  Ads SVGs; TikTok/Taboola/Outbrain fall back to their channel emoji. */
function PlatformIcon({
  platform,
  size = "1em",
}: {
  platform: Platform | "other";
  size?: string;
}) {
  if (platform === "google") return <GoogleAdsIcon size={size} />;
  if (platform === "facebook") return <FacebookAdsIcon size={size} />;
  const emoji =
    platform === "tiktok"
      ? "🎵"
      : platform === "taboola" || platform === "outbrain"
        ? "📰"
        : "";
  return emoji ? (
    <span aria-hidden style={{ fontSize: size, lineHeight: 1 }}>
      {emoji}
    </span>
  ) : null;
}

/** A platform logo that doubles as a quick "open the ad account" link —
 *  reuses the same deep-links as the "פתח" button. Google opens its account
 *  and copies the project slug (so the F&F userscript filters by campaign
 *  name); Facebook just opens its account. Plain (non-clickable) logo when
 *  there's no url to open. */
function PlatformLogoLink({
  platform,
  href,
  copySlug,
  size = "1em",
  title,
}: {
  platform: Platform | "other";
  href?: string;
  copySlug?: string;
  size?: string;
  title?: string;
}) {
  if (!href) return <PlatformIcon platform={platform} size={size} />;
  return (
    <button
      type="button"
      className="budget-logo-link"
      title={title || "פתח את חשבון הפרסום"}
      onClick={async (e) => {
        e.stopPropagation();
        if (copySlug) {
          try {
            await navigator.clipboard.writeText(copySlug);
          } catch {
            /* best-effort */
          }
        }
        window.open(href, "_blank", "noopener");
      }}
    >
      <PlatformIcon platform={platform} size={size} />
    </button>
  );
}

/** The single ad-account url shared by a set of projects, or undefined when
 *  they span more than one account — so a manager/company logo only opens an
 *  account when it's unambiguous. (Google urls carry a per-project filter
 *  hash, so for Google a group is "one account" only with one project.) */
function groupAccountUrl(
  projects: BudgetProject[],
  adLinks: Record<string, ProjLinks>,
  platform: "google" | "facebook",
): string | undefined {
  const set = new Set<string>();
  for (const p of projects) {
    const a = adLinks[p.tab.toLowerCase()];
    const u = platform === "google" ? a?.gAdsUrl : a?.fbAdsUrl;
    if (u) set.add(u);
  }
  return set.size === 1 ? [...set][0] : undefined;
}

/** Active/paused dot for a row's matched FB/Google campaigns. */
function StatusDot({
  status,
}: {
  status: "none" | "active" | "paused" | "mixed";
}) {
  if (status === "none") return null;
  const tone =
    status === "active" ? "ok" : status === "paused" ? "off" : "mixed";
  const title =
    status === "active"
      ? "קמפיין פעיל"
      : status === "paused"
        ? "קמפיין מושהה"
        : "חלק מהקמפיינים מושהים";
  return (
    <span
      className={`camp-status-dot camp-status-${tone}`}
      title={title}
      aria-label={title}
    />
  );
}

/** Per-manager budget export — one button group per platform. Download a
 *  CSV (with a Project column for per-account filtering) or copy TSV rows
 *  straight to the clipboard for the platform's bulk importer (Google Ads
 *  Editor "Make multiple changes" / FB bulk import). Both hit the same
 *  /api/campaigns/budget-csv endpoint. */
function ManagerCsvButtons({
  manager,
  projects,
  adLinks,
  showAdLinks,
}: {
  manager: string;
  projects: BudgetProject[];
  adLinks: Record<string, ProjLinks>;
  showAdLinks: boolean;
}) {
  const q = `manager=${encodeURIComponent(manager)}`;
  const gUrl = showAdLinks ? groupAccountUrl(projects, adLinks, "google") : undefined;
  const fbUrl = showAdLinks ? groupAccountUrl(projects, adLinks, "facebook") : undefined;
  return (
    <span className="budget-csv-actions">
      <CsvPlatformButtons params={q} platform="google" label="Google" openUrl={gUrl} />
      <CsvPlatformButtons params={q} platform="facebook" label="FB" openUrl={fbUrl} />
    </span>
  );
}

/** Per-company Google export (the per-חברה button on the company header). */
function CompanyCsvButtons({
  company,
  projects,
  adLinks,
  showAdLinks,
}: {
  company: string;
  projects: BudgetProject[];
  adLinks: Record<string, ProjLinks>;
  showAdLinks: boolean;
}) {
  const q = `company=${encodeURIComponent(company)}`;
  const gUrl = showAdLinks ? groupAccountUrl(projects, adLinks, "google") : undefined;
  const fbUrl = showAdLinks ? groupAccountUrl(projects, adLinks, "facebook") : undefined;
  return (
    <span className="budget-csv-actions">
      <CsvPlatformButtons params={q} platform="google" label="Google" openUrl={gUrl} />
      <CsvPlatformButtons params={q} platform="facebook" label="FB" openUrl={fbUrl} />
    </span>
  );
}

function CsvPlatformButtons({
  params,
  platform,
  label,
  openUrl,
}: {
  params: string;
  platform: "google" | "facebook";
  label: string;
  /** When set, the platform logo becomes a quick "open the ad account" link
   *  (only passed when the group resolves to a single account). */
  openUrl?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const base = `/api/campaigns/budget-csv?${params}&platform=${platform}`;
  const importer =
    platform === "google" ? "Google Ads Editor ← Make multiple changes" : "FB bulk import";
  const importHint =
    platform === "google"
      ? "ריבוי חשבונות בבת אחת: בחר 'My data includes account information' (עמודת Account = Customer ID מנתבת לכל חשבון, ומעדכן קמפיינים קיימים בלבד)"
      : "ייבוא לכל חשבון פייסבוק בנפרד (התאמה לפי Campaign ID)";
  async function copy() {
    setCopying(true);
    try {
      const res = await fetch(`${base}&format=tsv`);
      const text = await res.text();
      if (res.ok && text.trim()) {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }
    } catch {
      /* best-effort */
    } finally {
      setCopying(false);
    }
  }
  return (
    <span className="budget-csv-group" title={label}>
      <span className="budget-csv-logo">
        {openUrl ? (
          <PlatformLogoLink
            platform={platform}
            href={openUrl}
            size="1.05em"
            title={`פתח את חשבון ה${label}`}
          />
        ) : (
          <span aria-hidden>
            <PlatformIcon platform={platform} size="1.05em" />
          </span>
        )}
      </span>
      <a
        className="budget-csv-btn"
        href={base}
        download
        title={`הורד CSV — תקציב יומי מומלץ לכל קמפיין ${label} (ייבוא ${importer}). ${importHint}. עמודות עזר: Account name · חברה · פרוייקט.`}
      >
        ⬇
      </a>
      <button
        type="button"
        className="budget-csv-btn"
        onClick={copy}
        disabled={copying}
        title={`העתק שורות להדבקה ישירה ב-${importer}`}
      >
        {copied ? "✓" : "📋"}
      </button>
    </span>
  );
}

/* ── pure helpers ────────────────────────────────────────────────── */

function fmt(n: number): string {
  return "₪" + Math.round(n || 0).toLocaleString("he-IL");
}

/** ISO date (YYYY-MM-DD) → compact D.M.YY for the time-bar date range. */
function fmtDmy(iso: string): string {
  const m = (iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso || "—";
  return `${Number(m[3])}.${Number(m[2])}.${m[1].slice(2)}`;
}

function paceTone(ratio: number): "none" | "under" | "ok" | "over" {
  if (!ratio) return "none";
  if (ratio > 1.1) return "over";
  if (ratio < 0.85) return "under";
  return "ok";
}

/**
 * Platform pacing diagnosis tooltip — ports the dashboard's three-way
 * logic (plan vs platform-configured vs 7-day actual spend) so the desk
 * tells the manager whether to lower/raise the budget or investigate
 * delivery. מתוכנן = Σ קצב יומי (col J); מוגדר = configured platform
 * budget; ממוצע 7 ימים = actual 7-day avg spend.
 */
function pacingTooltip(agg: PlatformAgg): string {
  const ils = (n: number) => "₪" + Math.round(n || 0).toLocaleString("he-IL");
  const planned = agg.dailyRequired;
  const configured = agg.actualDaily;
  const actual7d = agg.actual7d;
  const lines = [`מתוכנן (קצב יומי): ${ils(planned)}`];
  if (configured > 0) lines.push(`מוגדר בפלטפורמה: ${ils(configured)}`);
  if (actual7d > 0) lines.push(`ממוצע 7 ימים בפועל: ${ils(actual7d)}`);

  if (planned > 0 && actual7d > 0) {
    const variance = (actual7d - planned) / planned;
    const configVsPlan = configured > 0 ? (configured - planned) / planned : 0;
    const sign = variance >= 0 ? "+" : "−";
    lines.push(`סטייה: ${sign}${Math.abs(Math.round(variance * 100))}%`);
    let action = "";
    if (variance > 0.1) {
      if (configured > 0 && configVsPlan > 0.1)
        action = `💡 הורד את התקציב בפלטפורמה ל־${ils(planned)} (מוגדר ${ils(configured)}, חריגה ${Math.round(configVsPlan * 100)}% מהתכנון)`;
      else if (configured > 0)
        action = `🔍 התקציב מוגדר כהלכה (${ils(configured)}) אבל מוציא ${ils(actual7d)}/יום — בדוק CPC / CBO / עונתיות, לא תקציב`;
      else action = `💡 הורד את התקציב היומי ל־${ils(planned)}`;
    } else if (variance < -0.1) {
      if (configured > 0 && configVsPlan < -0.1)
        action = `💡 העלה את התקציב בפלטפורמה ל־${ils(planned)} (כרגע מוגדר ${ils(configured)})`;
      else if (configured > 0)
        action = `🔍 התקציב מוגדר כהלכה (${ils(configured)}) אבל מוציא רק ${ils(actual7d)}/יום — בדוק audience / הצעות מחיר / קריאייטיב, לא תקציב`;
      else action = `💡 העלה את התקציב היומי ל־${ils(planned)}`;
    }
    if (action) lines.push(action);
  }
  return lines.join("\n");
}

function hasPacingIssue(p: BudgetProject): boolean {
  if (p.remainingDays <= 0) return false;
  return E3_PLATFORMS.some((pl) => {
    const a = p.platforms[pl];
    if (a.budget <= 0) return false;
    return needsBudgetAction(a.actualDaily, a.dailyRequired, a.pacingRatio);
  });
}

/**
 * Whether any individual PROGRAMMATIC channel row carries the per-row ⚠️
 * (configured daily materially off the required daily). Mirrors the
 * CampaignRow `needsAction` check so the project header flags attention the
 * moment any single channel does — even when channels within a platform net
 * out and the platform-aggregate pacing wouldn't trip. "Other" (non-
 * programmatic) channels are excluded by design: they're outside the E3
 * budget, so they never raise a budget-action alert.
 */
function hasChannelAlert(p: BudgetProject): boolean {
  return p.rows.some(
    (r) =>
      r.platform !== "other" &&
      !r.ended &&
      needsBudgetAction(r.actualDaily, r.dailyRequired, r.pacingRatio),
  );
}

function needsAttention(p: BudgetProject): boolean {
  if (p.reconStatus === "over" || p.reconStatus === "under") return true;
  if (p.reconStatus === "no-target" && p.allocated > 0) return true;
  return hasPacingIssue(p);
}

/**
 * Same "is this live?" answer as the projects home screen + top-nav: a
 * project is inactive when it ended (>5 days past) OR has no current-month
 * spend — precomputed server-side in `inactiveProjects` from the morning
 * feed. Projects missing from the feed fall back to the all-zero heuristic.
 */
function isInactive(
  p: BudgetProject,
  inactiveProjects: Record<string, boolean>,
): boolean {
  const key = p.tab.toLowerCase();
  if (key in inactiveProjects) return inactiveProjects[key];
  return p.e3 === 0 && p.allocated === 0 && p.allocatedSpend === 0;
}

/**
 * Recompute a project's derived numbers after one row's G changes —
 * mirrors the server-side math in lib/budgetMaster.ts so the optimistic
 * UI stays consistent without a refetch.
 */
function recomputeProject(
  p: BudgetProject,
  rowNum: number,
  value: number,
): BudgetProject {
  const elapsedFrac =
    p.totalDays > 0
      ? Math.min(1, Math.max(0, p.totalDays - p.remainingDays) / p.totalDays)
      : 0;
  const rows = p.rows.map((r) => {
    if (r.row !== rowNum) return r;
    const expected = value * elapsedFrac;
    // Derive this channel's day count from its existing sheet rate
    // (dailyRequired = (G−H)/days) so the optimistic preview keeps the
    // same days-left the sheet used — matching the project page.
    const days =
      r.dailyRequired !== 0 ? (r.budget - r.spend) / r.dailyRequired : 0;
    return {
      ...r,
      budget: value,
      pacingRatio: expected > 0 ? r.spend / expected : 0,
      dailyRequired: days > 0 ? (value - r.spend) / days : 0,
    };
  });

  const platforms = {
    google: agg("google"),
    facebook: agg("facebook"),
    tiktok: agg("tiktok"),
    taboola: agg("taboola"),
    outbrain: agg("outbrain"),
  };
  function agg(pl: Platform): PlatformAgg {
    let budget = 0,
      spend = 0,
      rowCount = 0,
      daily = 0;
    for (const r of rows) {
      if (r.platform !== pl) continue;
      budget += r.budget;
      spend += r.spend;
      daily += r.dailyRequired; // platform daily = Σ channel rates (col J)
      rowCount++;
    }
    const expected = budget * elapsedFrac;
    return {
      budget,
      spend,
      rowCount,
      pacingRatio: expected > 0 ? spend / expected : 0,
      dailyRequired: daily,
      actualDaily: p.platforms[pl].actualDaily,
      actual7d: p.platforms[pl].actual7d,
    };
  }
  let oBudget = 0,
    oSpend = 0,
    oCount = 0,
    oDaily = 0;
  for (const r of rows) {
    if (r.platform !== "other") continue;
    oBudget += r.budget;
    oSpend += r.spend;
    oDaily += r.dailyRequired;
    oCount++;
  }
  const oExpected = oBudget * elapsedFrac;
  const other: PlatformAgg = {
    budget: oBudget,
    spend: oSpend,
    rowCount: oCount,
    pacingRatio: oExpected > 0 ? oSpend / oExpected : 0,
    dailyRequired: oDaily,
    actualDaily: 0,
    actual7d: 0,
  };

  const allocated = E3_PLATFORMS.reduce((s, pl) => s + platforms[pl].budget, 0);
  const allocatedSpend = E3_PLATFORMS.reduce(
    (s, pl) => s + platforms[pl].spend,
    0,
  );
  const delta = allocated - p.e3;
  const reconStatus: BudgetProject["reconStatus"] =
    p.e3 <= 0
      ? "no-target"
      : Math.abs(delta) < 1
        ? "ok"
        : delta > 0
          ? "over"
          : "under";

  return {
    ...p,
    rows,
    platforms,
    other,
    allocated,
    allocatedSpend,
    delta,
    reconStatus,
  };
}
