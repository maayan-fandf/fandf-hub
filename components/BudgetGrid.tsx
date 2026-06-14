"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import CopyAmountButton from "./CopyAmountButton";
import PrisaButton from "./PrisaButton";
import GoogleAdsIcon from "./GoogleAdsIcon";
import FacebookAdsIcon from "./FacebookAdsIcon";
import {
  E3_PLATFORMS,
  MANAGER_ORDER,
  PLATFORM_LABELS,
  UNASSIGNED_MANAGER,
  classifyChannel,
  pacingChannelKey,
  budgetShiftKey,
  type BudgetProject,
  type MediaPlanRow,
  type Platform,
  type PlatformAgg,
} from "@/lib/budgetTypes";
import {
  costChipStyle,
  costMetricColor,
  type ProjectBudgetShift,
  type ChannelPerf,
} from "@/lib/budgetShiftSuggestions";
import type { DailySpendSpikes, SpendSpike } from "@/lib/platformDailySpend";

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
  shifts,
  perf,
  spikes,
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
  /** Budget-shift suggestions (iframe reallocation engine, computed
   *  server-side) keyed by lowercase tab. Absent key = nothing to suggest. */
  shifts: Record<string, ProjectBudgetShift>;
  /** Per-channel performance (leads/scheduled/meetings + cost-per) keyed
   *  by lowercase tab → lowercase channel, for the drill-in table. */
  perf: Record<string, Record<string, ChannelPerf>>;
  /** Overspend spikes (latest day ≫ trailing avg) keyed by slug →
   *  platform. Only spiking platforms are present. */
  spikes: DailySpendSpikes;
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
      const stopped = hasStoppedChannel(p);
      if (dist) distribution++;
      if (pace) pacing++;
      if (
        dist ||
        pace ||
        stopped ||
        (p.reconStatus === "no-target" && p.allocated > 0)
      )
        attention++;
    }
    return { attention, distribution, pacing, active, total: projects.length };
  }, [projects, inactiveProjects]);

  // Portfolio rollup across the ACTIVE book (independent of the chip
  // filter — an overview shouldn't shrink when you click "קצב חורג").
  // Reuses GroupTotals' Σ-budget math + the per-channel perf already
  // loaded, plus a count of stopped channels / spiking platforms.
  const portfolio = useMemo(() => {
    let target = 0,
      allocated = 0,
      spend = 0,
      leads = 0,
      spendForCpl = 0,
      notSpending = 0,
      spikeCount = 0,
      offPace = 0;
    for (const p of projects) {
      if (isInactive(p, inactiveProjects)) continue;
      target += p.e3;
      allocated += p.allocated;
      spend += p.allocatedSpend;
      if (hasPacingIssue(p)) offPace++;
      const chPerf = perf[p.tab.toLowerCase()];
      if (chPerf) {
        for (const k of Object.keys(chPerf)) {
          leads += chPerf[k].leads;
          spendForCpl += chPerf[k].spend;
        }
      }
      for (const r of p.rows) if (isStoppedSpending(r)) notSpending++;
      const sp = spikes[p.tab.toLowerCase()];
      if (sp) spikeCount += Object.keys(sp).length;
    }
    return {
      target,
      allocated,
      spend,
      leads,
      blendedCpl: leads > 0 ? spendForCpl / leads : 0,
      delta: allocated - target,
      notSpending,
      spikeCount,
      offPace,
    };
  }, [projects, inactiveProjects, perf, spikes]);

  const visible = useMemo(() => {
    const list = projects.filter((p) => {
      if (isInactive(p, inactiveProjects) && !showInactive) return false;
      if (filter === "all") return true;
      const dist = p.reconStatus === "over" || p.reconStatus === "under";
      const pace = hasPacingIssue(p);
      if (filter === "distribution") return dist;
      if (filter === "pacing") return pace;
      // attention
      return (
        dist ||
        pace ||
        hasStoppedChannel(p) ||
        (p.reconStatus === "no-target" && p.allocated > 0)
      );
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
      <PortfolioStrip p={portfolio} activeCount={counts.active} />

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
                      shift={shifts[p.tab.toLowerCase()]}
                      perf={perf[p.tab.toLowerCase()]}
                      spike={spikes[p.tab.toLowerCase()]}
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

/** Top-of-page portfolio overview across the active book — Σ target /
 *  allocated / spend, blended CPL, and counts of the attention signals
 *  (off-pace projects, stopped channels, spend spikes). Reuses the same
 *  Σ-budget math as GroupTotals and the already-loaded per-channel perf. */
function PortfolioStrip({
  p,
  activeCount,
}: {
  p: {
    target: number;
    allocated: number;
    spend: number;
    leads: number;
    blendedCpl: number;
    delta: number;
    notSpending: number;
    spikeCount: number;
    offPace: number;
  };
  activeCount: number;
}) {
  const tone = Math.abs(p.delta) < 1 ? "ok" : p.delta > 0 ? "over" : "under";
  return (
    <div className="budget-portfolio">
      <PortfolioTile label="פרויקטים פעילים" value={String(activeCount)} />
      <PortfolioTile label="יעד E3" value={fmt(p.target)} />
      <PortfolioTile
        label="חולק"
        value={fmt(p.allocated)}
        sub={
          Math.abs(p.delta) >= 1
            ? `${p.delta > 0 ? "+" : "−"}${fmt(Math.abs(p.delta))}`
            : "מאוזן"
        }
        subTone={tone}
      />
      <PortfolioTile label="הוצאה" value={fmt(p.spend)} />
      <PortfolioTile
        label="עלות לליד ממוצעת"
        value={p.blendedCpl > 0 ? fmt(p.blendedCpl) : "—"}
        sub={p.leads > 0 ? `${p.leads.toLocaleString("he-IL")} לידים` : undefined}
        title="ממוצע משוקלל על פני כל הערוצים הפעילים (Σהוצאה ÷ Σלידים)"
      />
      <PortfolioTile
        label="קצב חורג"
        value={String(p.offPace)}
        tone={p.offPace > 0 ? "warn" : "ok"}
        title="פרויקטים פעילים שלפחות ערוץ אחד בהם חורג מהקצב"
      />
      <PortfolioTile
        label="ערוצים מושהים"
        value={String(p.notSpending)}
        tone={p.notSpending > 0 ? "warn" : "ok"}
        title="ערוצים עם תקציב שנותר אך כל הקמפיינים מושהים — לא מוציאים"
      />
      <PortfolioTile
        label="חריגות הוצאה"
        value={String(p.spikeCount)}
        tone={p.spikeCount > 0 ? "warn" : "ok"}
        title="פלטפורמות שהוציאו היום הרבה מעל הממוצע השבועי"
      />
    </div>
  );
}

function PortfolioTile({
  label,
  value,
  sub,
  subTone,
  tone,
  title,
}: {
  label: string;
  value: string;
  sub?: string;
  subTone?: string;
  tone?: string;
  title?: string;
}) {
  return (
    <div className={`budget-pf-tile ${tone ? `pf-${tone}` : ""}`} title={title}>
      <span className="budget-pf-label">{label}</span>
      <span className="budget-pf-value">{value}</span>
      {sub && (
        <span className={`budget-pf-sub ${subTone ? `tone-${subTone}` : ""}`}>
          {sub}
        </span>
      )}
    </div>
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
  shift,
  perf,
  spike,
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
  shift?: ProjectBudgetShift;
  /** channel(lowercase) → performance for this project's channels. */
  perf?: Record<string, ChannelPerf>;
  /** platform → overspend spike for this project (only spiking ones). */
  spike?: Partial<Record<Platform, SpendSpike>>;
}) {
  const [showPlan, setShowPlan] = useState(false);
  const projectHref =
    ad.projectHref || `/projects/${encodeURIComponent(p.name)}`;
  // Budget-shift suggestion fade state — per project, same snooze
  // semantics as the pacing rows (next Jerusalem day + still-firing →
  // resurfaced). gapStillOff = the suggestions still compute.
  const shiftKey = budgetShiftKey(p.tab);
  const shiftState = computeFadeState(
    dismissals[shiftKey],
    today,
    localDismiss[shiftKey] ?? null,
    !!shift && shift.suggestions.length > 0,
  );
  const showShiftFlag = !!shift && shiftState !== "dismissed";
  // Blended CPL / CPS across this project's PROGRAMMATIC channels only
  // (classifyChannel ≠ "other", so כתבה/article/phone lines are excluded)
  // — a quick at-a-glance read on the collapsed row of where media cost
  // sits, without expanding. Aggregates raw spend/leads/scheduled from the
  // already-loaded per-channel perf so a 0-lead channel's spend still
  // weighs the blend (Σspend ÷ Σleads), then colored via costChipStyle.
  let progSpend = 0,
    progLeads = 0,
    progSched = 0;
  if (perf) {
    for (const ch of Object.keys(perf)) {
      if (classifyChannel(ch) === "other") continue;
      const e = perf[ch];
      progSpend += e.spend;
      progLeads += e.leads;
      progSched += e.scheduled;
    }
  }
  const projCpl = progLeads > 0 ? progSpend / progLeads : 0;
  const projCps = progSched > 0 ? progSpend / progSched : 0;
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
            {hasChannelAlert(p, dismissals, localDismiss, today) && (
              <span
                className="budget-alert"
                title="יש ערוץ אחד או יותר שהתקציב היומי בו לא תואם את הנדרש — נדרש עדכון"
                aria-label="נדרש עדכון תקציב באחד הערוצים"
              >
                ⚠️
              </span>
            )}
            {showShiftFlag && (
              <span
                className="budget-shift-flag"
                title="יש הצעת התאמת תקציב בין ערוצים — פתחו את הפרויקט לפרטים"
                aria-label="יש הצעת התאמת תקציב"
              >
                💡
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
          {(projCpl > 0 || projCps > 0) && (
            <span className="budget-recon-perf">
              <CostChip label="CPL" metric="cpl" value={projCpl} />
              <CostChip label="CPS" metric="cps" value={projCps} />
            </span>
          )}
        </span>

        <ProjectProgress p={p} />

        <span className="budget-platcells">
          {E3_PLATFORMS.map((pl) => (
            <PlatformCell
              key={pl}
              platform={pl}
              agg={p.platforms[pl]}
              dimmed={platformDimmed(p, pl, dismissals, localDismiss, today)}
              spike={spike?.[pl]}
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

          {shift && (
            <BudgetShiftPanel
              shift={shift}
              rows={p.rows}
              state={shiftState}
              signalKey={shiftKey}
              onSnooze={onSnooze}
              canEdit={canEdit}
              onEdit={onEdit}
            />
          )}

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
            perf={perf}
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

/**
 * 💡 הצעת התאמה — budget-shift suggestions (the iframe's reallocation
 * engine, computed server-side in lib/budgetShiftSuggestions). Advisory
 * only: shows which channels should give/receive budget and the CPL/
 * CPS/CPM numbers behind each call; the actual edit stays in the
 * channel rows below. Snoozes per project via the shared dismissal
 * store, with the same next-day resurface semantics as pacing rows.
 */
function BudgetShiftPanel({
  shift,
  rows,
  state,
  signalKey,
  onSnooze,
  canEdit,
  onEdit,
}: {
  shift: ProjectBudgetShift;
  /** The project's budget rows (from budgetMaster) — carry the sheet's
   *  OWN channel labels + absolute row numbers, so apply writes by row
   *  instead of re-looking-up by the ALL CLIENTS channel name. */
  rows: BudgetProject["rows"];
  state: FadeState;
  signalKey: string;
  onSnooze: (key: string, val: "on" | "off") => void;
  canEdit: boolean;
  onEdit: (tab: string, row: number, value: number) => void;
}) {
  const [snoozing, setSnoozing] = useState(false);
  const isRebalance = shift.mode === "rebalance";
  // Per-channel apply progress. "applied" sticks until reload — the
  // server recomputes suggestions on the next page load (where a closed
  // gap makes the whole strip disappear, which is the desired end state).
  const [applyState, setApplyState] = useState<
    Record<string, "saving" | "applied" | "error">
  >({});
  const [applyErr, setApplyErr] = useState<Record<string, string>>({});
  const [applyingAll, setApplyingAll] = useState(false);

  /**
   * Apply one suggestion. Earlier this POSTed slug+channel+distribute and
   * let the server re-find the rows by channel NAME — but the suggestion's
   * channel comes from ALL CLIENTS, whose label can differ in case/spelling
   * from the budget sheet's col D, and the server's lookup skipped merged
   * continuation rows (empty D) → 404 / 409-drift on apply. Instead we
   * resolve the sheet rows here from the project's OWN budget rows (their
   * channel label + absolute row number come from budgetMaster, so they
   * match the sheet exactly), split the channel's new total across them,
   * and write each cell via the SAME tab+row+expectedChannel+expectedBudget
   * request the inline cell edit uses (a proven path). onEdit() updates the
   * rows below optimistically, exactly like an inline edit.
   */
  async function applyOne(sg: ProjectBudgetShift["suggestions"][number]) {
    const chLc = sg.channel.toLowerCase().trim();
    const subRows = rows.filter((r) => r.channel.toLowerCase().trim() === chLc);
    if (!subRows.length) {
      setApplyState((m) => ({ ...m, [sg.channel]: "error" }));
      setApplyErr((m) => ({ ...m, [sg.channel]: "הערוץ לא נמצא בגיליון" }));
      return false;
    }
    // Split the channel's new total across its sub-rows proportionally to
    // each row's current budget (₪100 steps; rounding residual onto the
    // largest), so a channel spread over several campaigns keeps its
    // internal ratio — the same split the old server distribute mode did.
    const curTotal = subRows.reduce((a, r) => a + r.budget, 0);
    const splits = subRows.map((r) => ({
      row: r.row,
      channel: r.channel,
      oldBudget: r.budget,
      newBudget:
        curTotal > 0
          ? Math.round((sg.newBudget * (r.budget / curTotal)) / 100) * 100
          : Math.round(sg.newBudget / subRows.length / 100) * 100,
    }));
    const residual = Math.round(
      sg.newBudget - splits.reduce((a, s) => a + s.newBudget, 0),
    );
    if (Math.abs(residual) >= 1 && splits.length) {
      let li = 0;
      for (let i = 1; i < splits.length; i++)
        if (splits[i].newBudget > splits[li].newBudget) li = i;
      splits[li].newBudget += residual;
    }
    setApplyState((m) => ({ ...m, [sg.channel]: "saving" }));
    try {
      for (const s of splits) {
        const res = await fetch("/api/campaigns/budget", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tab: shift.slug,
            row: s.row,
            value: s.newBudget,
            expectedChannel: s.channel,
            expectedBudget: s.oldBudget,
          }),
        });
        const d = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || !d.ok) {
          setApplyState((m) => ({ ...m, [sg.channel]: "error" }));
          setApplyErr((m) => ({ ...m, [sg.channel]: d.error || "שמירה נכשלה" }));
          return false;
        }
        onEdit(shift.slug, s.row, s.newBudget);
      }
      setApplyState((m) => ({ ...m, [sg.channel]: "applied" }));
      return true;
    } catch (e) {
      setApplyState((m) => ({ ...m, [sg.channel]: "error" }));
      setApplyErr((m) => ({
        ...m,
        [sg.channel]: e instanceof Error ? e.message : "שמירה נכשלה",
      }));
      return false;
    }
  }

  async function applyAll() {
    setApplyingAll(true);
    try {
      for (const sg of shift.suggestions) {
        if (applyState[sg.channel] === "applied") continue;
        await applyOne(sg);
      }
    } finally {
      setApplyingAll(false);
    }
  }

  const allApplied = shift.suggestions.every(
    (sg) => applyState[sg.channel] === "applied",
  );

  async function snooze(restore: boolean) {
    setSnoozing(true);
    try {
      const res = await fetch("/api/campaigns/budget-dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: shift.slug,
          kind: "budget-shift",
          baselineDaily: shift.totalMove,
          restore,
        }),
      });
      const d = (await res.json()) as { ok?: boolean };
      if (res.ok && d.ok) onSnooze(signalKey, restore ? "off" : "on");
    } catch {
      /* best-effort; leave state as-is */
    } finally {
      setSnoozing(false);
    }
  }

  // Headline copy ported from the iframe (Index.html#L9305).
  const headline = isRebalance
    ? `🔄 איזון מחדש — אין פער, אבל ניתן לשפר ROI · העברה של ${fmt(shift.totalMove)}`
    : `💡 הצעת התאמה — ${shift.delta < 0 ? "הוספה" : "הפחתה"} של ${fmt(shift.totalMove)} מבוסס ביצועי ערוצים`;

  const dismissed = state === "dismissed";
  return (
    <div
      className={`budget-shift${isRebalance ? " is-rebalance" : ""}${dismissed ? " is-dismissed" : ""}`}
    >
      <div className="budget-shift-head">
        <span className="budget-shift-title">{headline}</span>
        {canEdit && !dismissed && shift.suggestions.length > 1 && (
          <button
            type="button"
            className="budget-shift-apply budget-shift-apply-all"
            disabled={applyingAll || allApplied}
            onClick={applyAll}
            title="כתיבת כל התקציבים המוצעים לגיליון (עמודה G), בדיוק כמו עריכה ידנית בשורות למטה"
          >
            {allApplied
              ? "✓ הוחל"
              : applyingAll
                ? "…מחיל"
                : isRebalance
                  ? "✓ החל איזון"
                  : "✓ החל הכל"}
          </button>
        )}
        {dismissed ? (
          <button
            type="button"
            className="budget-handled-btn is-done"
            disabled={snoozing}
            onClick={() => snooze(true)}
            title="בטל טיפול — החזר את ההצעה"
          >
            ↩︎ בטל
          </button>
        ) : (
          <button
            type="button"
            className="budget-handled-btn"
            disabled={snoozing}
            onClick={() => snooze(false)}
            title="טיפלתי — שקט עד מחר; אם ההצעה עדיין רלוונטית אחרי שהדאטה יתעדכן, היא תחזור"
          >
            ✓ טיפלתי{state === "resurfaced" ? " (חזר)" : ""}
          </button>
        )}
      </div>
      {!dismissed && (
        <div className="budget-shift-list">
          {shift.suggestions.map((sg) => {
            const aState = applyState[sg.channel];
            return (
              <div
                key={sg.channel}
                className={`budget-shift-row ${sg.delta > 0 ? "is-up" : "is-down"}${aState === "applied" ? " is-applied" : ""}`}
              >
                <span className="budget-shift-channel" title={sg.channel}>
                  {sg.channel}
                </span>
                <span className="budget-shift-delta">
                  {fmt(sg.currentBudget)} → <b>{fmt(sg.newBudget)}</b>{" "}
                  <span className="budget-shift-arrow">
                    {sg.delta > 0 ? "↑" : "↓"} {fmt(Math.abs(sg.delta))}
                  </span>
                </span>
                <span className="budget-shift-reason">{sg.reason}</span>
                <span className="budget-shift-chips">
                  <CostChip label="CPL" metric="cpl" value={sg.cpl} />
                  <CostChip label="CPS" metric="cps" value={sg.cps} />
                  <CostChip label="CPM" metric="cpm" value={sg.cpm} />
                </span>
                {canEdit && (
                  <span className="budget-shift-action">
                    {aState === "applied" ? (
                      <span className="budget-shift-applied">✓ הוחל</span>
                    ) : (
                      <button
                        type="button"
                        className="budget-shift-apply"
                        disabled={aState === "saving" || applyingAll}
                        onClick={() => applyOne(sg)}
                        title={
                          aState === "error"
                            ? `${applyErr[sg.channel] || "שמירה נכשלה"} — לחצו לניסיון חוזר`
                            : `עדכון תקציב ${sg.channel} ל-${fmt(sg.newBudget)} בגיליון`
                        }
                      >
                        {aState === "saving"
                          ? "…"
                          : aState === "error"
                            ? "⚠️ נסה שוב"
                            : "✓ החל"}
                      </button>
                    )}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** One CPL/CPS/CPM pill, colored on the iframe's costStyle gradient
 *  (green=cheap → red=expensive). Hidden for zero metrics. */
function CostChip({
  label,
  metric,
  value,
}: {
  label: string;
  metric: "cpl" | "cps" | "cpm";
  value: number;
}) {
  const style = costChipStyle(metric, value);
  if (!style) return null;
  const titles: Record<string, string> = {
    cpl: "עלות לליד",
    cps: "עלות לתיאום פגישה",
    cpm: "עלות לביצוע פגישה",
  };
  return (
    <span
      className="budget-shift-chip"
      style={{ background: style.bg, color: style.fg }}
      title={titles[metric]}
    >
      {label} {fmt(Math.round(value))}
    </span>
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
  usdIlsRate: _usdIlsRate,
  localDismiss,
  onSnooze,
  perf,
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
  perf?: Record<string, ChannelPerf>;
}) {
  // One flat table of ALL channels (owner request 2026-06-12 — the
  // per-platform sub-tables + headers fragmented the view; now every
  // channel shares one aligned column grid, with the platform shown as
  // a small logo per row). Rows ordered by platform (E3 order, then
  // "other"), preserving the sheet order within each platform.
  const [expandedChannels, setExpandedChannels] = useState<Set<string>>(
    new Set(),
  );
  const toggleChannel = (chLc: string) =>
    setExpandedChannels((s) => {
      const n = new Set(s);
      if (n.has(chLc)) n.delete(chLc);
      else n.add(chLc);
      return n;
    });
  const platformOrder: (Platform | "other")[] = [...E3_PLATFORMS, "other"];
  const ordered = platformOrder.flatMap((pl) =>
    p.rows.filter((r) => r.platform === pl),
  );
  if (ordered.length === 0) return null;
  // Group consecutive same-channel rows into channels. A channel with
  // several sheet sub-rows (each a campaign — own סוג + budget) collapses
  // into ONE summary row that expands to reveal the campaigns inside it
  // (owner request 2026-06-12). Single-campaign channels render as a
  // normal row. Channel-level CRM perf shows on the summary / single row.
  const channelGroups: {
    chLc: string;
    channel: string;
    rows: BudgetProject["rows"];
  }[] = [];
  for (const r of ordered) {
    const chLc = r.channel.toLowerCase().trim();
    const last = channelGroups[channelGroups.length - 1];
    if (last && last.chLc === chLc) last.rows.push(r);
    else channelGroups.push({ chLc, channel: r.channel, rows: [r] });
  }
  const platformUrlFor = (pl: Platform | "other") =>
    pl === "google" ? ad.gAdsUrl : pl === "facebook" ? ad.fbAdsUrl : undefined;

  return (
    <div className="budget-rows-scroll">
    <table className="budget-rows">
      <thead>
        <tr>
          <th>ערוץ</th>
          <th>סוג</th>
          <th>תקציב מאושר</th>
          <th>בפועל</th>
          <th
            className="th-help"
            title="לידים שנרשמו ב-CRM. רחפו על המספר כדי לראות את העלות לליד (הוצאה ÷ לידים)."
          >
            לידים <span aria-hidden>ⓘ</span>
          </th>
          <th
            className="th-help"
            title="תיאומי פגישות שנקבעו (CRM). רחפו על המספר כדי לראות את העלות לתיאום (הוצאה ÷ תיאומים)."
          >
            תיאומים <span aria-hidden>ⓘ</span>
          </th>
          <th
            className="th-help"
            title="פגישות שבוצעו בפועל (CRM). רחפו על המספר כדי לראות את העלות לפגישה (הוצאה ÷ פגישות)."
          >
            פגישות <span aria-hidden>ⓘ</span>
          </th>
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
        {channelGroups.map((g) => {
          const url = platformUrlFor(g.rows[0].platform);
          const chPerf = perf?.[g.chLc];
          // Single-campaign channel — a normal row carrying the perf.
          if (g.rows.length === 1) {
            const r = g.rows[0];
            return (
              <CampaignRow
                key={r.row}
                tab={p.tab}
                r={r}
                canEdit={canEdit}
                onEdit={onEdit}
                dismissals={dismissals}
                today={today}
                localDismiss={localDismiss}
                onSnooze={onSnooze}
                platformUrl={showAdLinks ? url : undefined}
                perf={chPerf}
              />
            );
          }
          // Multi-campaign channel — collapsible summary + the campaigns.
          const expanded = expandedChannels.has(g.chLc);
          return (
            <Fragment key={"grp-" + g.chLc}>
              <ChannelSummaryRow
                channel={g.channel}
                platform={g.rows[0].platform}
                rows={g.rows}
                perf={chPerf}
                expanded={expanded}
                onToggle={() => toggleChannel(g.chLc)}
              />
              {expanded &&
                g.rows.map((r) => (
                  <CampaignRow
                    key={r.row}
                    tab={p.tab}
                    r={r}
                    canEdit={canEdit}
                    onEdit={onEdit}
                    dismissals={dismissals}
                    today={today}
                    localDismiss={localDismiss}
                    onSnooze={onSnooze}
                    platformUrl={showAdLinks ? url : undefined}
                    indent
                  />
                ))}
            </Fragment>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}

/**
 * Collapsed summary for a channel that holds several campaigns. Shows the
 * channel totals (budget/spend), its channel-level CRM perf, and an
 * aggregate pace; click to expand/collapse the campaign rows beneath.
 * Read-only — budgets are edited on the campaign rows inside.
 */
function ChannelSummaryRow({
  channel,
  platform,
  rows,
  perf,
  expanded,
  onToggle,
}: {
  channel: string;
  platform: Platform | "other";
  rows: BudgetProject["rows"];
  perf?: ChannelPerf;
  expanded: boolean;
  onToggle: () => void;
}) {
  const budget = rows.reduce((a, r) => a + r.budget, 0);
  const spend = rows.reduce((a, r) => a + r.spend, 0);
  const actualDaily = rows.reduce((a, r) => a + r.actualDaily, 0);
  const dailyRequired = rows.reduce((a, r) => a + r.dailyRequired, 0);
  const allEnded = rows.every((r) => r.ended);
  const anyNeedsAction = rows.some(
    (r) =>
      r.platform !== "other" &&
      !r.ended &&
      !budgetEssentiallySpent(r.budget, r.spend) &&
      needsBudgetAction(r.actualDaily, r.dailyRequired, r.pacingRatio),
  );
  const anyStopped = rows.some(isStoppedSpending);
  // Channel pace = Σspend ÷ Σexpected over active rows that have an
  // expected (pacingRatio>0; expected_i = spend_i ÷ ratio_i).
  let aggSpend = 0;
  let aggExpected = 0;
  for (const r of rows) {
    if (r.ended) continue;
    aggSpend += r.spend;
    if (r.pacingRatio > 0) aggExpected += r.spend / r.pacingRatio;
  }
  const aggRatio = aggExpected > 0 ? aggSpend / aggExpected : 0;
  const dailyReq = Math.max(0, Math.round(dailyRequired));
  // Aggregate action tone for the collapsed נדרש ליום pill — same colors
  // the campaign rows + platform cells use, so a collapsed channel still
  // signals raise (⬆ under) / lower (⬇ over) / set-right (green) at a
  // glance. Direction from Σ configured-daily vs Σ required-daily.
  const summaryTone: "over" | "under" | "ok" | "none" = allEnded
    ? "none"
    : !anyNeedsAction
      ? "ok"
      : actualDaily > 0 && dailyRequired > 0
        ? dailyRequired > actualDaily
          ? "under"
          : "over"
        : paceTone(aggRatio) === "over"
          ? "over"
          : "under";
  return (
    <tr
      className="channel-summary"
      onClick={onToggle}
      title="לחצו כדי להציג/להסתיר את הקמפיינים בערוץ"
    >
      <td
        className="c-channel"
        title={`${PLATFORM_LABELS[platform as Platform] ?? "אחר"} · ${channel}`}
      >
        <span className={`channel-caret ${expanded ? "open" : ""}`} aria-hidden>
          ▸
        </span>
        <span className="c-channel-logo" aria-hidden>
          <PlatformIcon platform={platform} size=".95em" />
        </span>
        {anyNeedsAction && (
          <span
            className="budget-alert"
            title="יש קמפיין בערוץ שדורש עדכון תקציב יומי"
            aria-label="נדרש עדכון תקציב"
          >
            ⚠️
          </span>
        )}
        {anyStopped && (
          <span
            className="budget-stopped"
            title="יש קמפיין בערוץ עם תקציב שנותר אך כל הקמפיינים שלו מושהים — לא מוציא"
            aria-label="קמפיין מושהה ללא הוצאה"
          >
            ⏸
          </span>
        )}
        {channel}
      </td>
      <td className="c-type">
        <span className="channel-count">{rows.length} קמפיינים</span>
      </td>
      <td className="c-budget">
        <b>{fmt(budget)}</b>
      </td>
      <td className="c-spend">{fmt(spend)}</td>
      <PerfCells perf={perf} />
      <td className="c-pace">
        {allEnded ? (
          <span className="pace-val pace-none">⛔</span>
        ) : (
          <>
            {aggRatio > 0 ? <Pacing ratio={aggRatio} muted /> : "—"}
            <RunwayHint
              remaining={budget - spend}
              dailyRate={perf?.dailyRate ?? 0}
            />
          </>
        )}
      </td>
      <td className="c-actualdaily">
        {actualDaily > 0
          ? `₪${Math.round(actualDaily).toLocaleString("he-IL")}`
          : "—"}
      </td>
      <td className="c-daily">
        {dailyReq > 0 ? (
          <span
            className={`budget-need pace-${summaryTone}`}
            title="סך הנדרש ליום בערוץ (Σ הקמפיינים) — פתחו את הערוץ לפירוט"
          >
            ₪{dailyReq.toLocaleString("he-IL")}
            {summaryTone === "over" ? " ⬇" : summaryTone === "under" ? " ⬆" : ""}
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className="c-handled" />
    </tr>
  );
}

type FadeState = "active" | "dismissed" | "resurfaced";

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
 * Whether a "טיפלתי"-snoozed row should stay faded or resurface. A snooze
 * stays faded the day it was made, then the next Asia/Jerusalem day it
 * self-resurfaces IF the alert is still firing — i.e. the configured-vs-
 * required daily gap is still significant (`gapStillOff`). If the gap has
 * since closed, it stays 'dismissed' (resolved). Replaces the old
 * "baseline daily unchanged" check (2026-05-25): a budget that changed
 * but is still off should come back; one that was fixed should not.
 */
function computeFadeState(
  dismissal: BudgetDismissal | undefined,
  today: string,
  local: "on" | "off" | null,
  gapStillOff: boolean,
): FadeState {
  if (local === "off") return "active";
  if (local === "on") return "dismissed";
  if (!dismissal) return "active";
  const until = (dismissal.snooze_until || "").slice(0, 10);
  if (!until || until < today) return "active"; // expired / cleared
  // Compare the dismissal day in Asia/Jerusalem (same tz as `today`). A raw
  // .slice(0,10) is the UTC date, which for an evening-Israel dismissal is
  // already "yesterday" vs the Jerusalem "today" — flipping overnightPassed
  // true immediately and resurfacing the snooze the same evening (the
  // "doesn't stick on reload" bug).
  const dDate = jeruDateOf(dismissal.dismissed_at);
  const overnightPassed = !!dDate && dDate < today;
  if (overnightPassed && gapStillOff) return "resurfaced";
  return "dismissed";
}

/** The per-CHANNEL pacing key for a budget row (2026-05-25 — was per
 *  platform, so dismissing one channel no longer fades its siblings). */
function rowKey(tab: string, r: BudgetProject["rows"][number]): string {
  return pacingChannelKey(tab, r.channel);
}

/**
 * A platform's summary cell is "handled" (dimmed) when it has off-pace
 * channels and EVERY one of them is individually snoozed (dismissed).
 * Per-channel since 2026-05-25 — a single channel's snooze no longer dims
 * the whole platform; only when all its off-pace rows are handled. A row
 * that resurfaced (gap still open next day) keeps the cell lit.
 */
function platformDimmed(
  p: BudgetProject,
  pl: Platform,
  dismissals: Record<string, BudgetDismissal>,
  localDismiss: Record<string, "on" | "off">,
  today: string,
): boolean {
  const offPaceRows = p.rows.filter(
    (r) =>
      r.platform === pl &&
      !r.ended &&
      needsBudgetAction(r.actualDaily, r.dailyRequired, r.pacingRatio),
  );
  if (offPaceRows.length === 0) return false;
  return offPaceRows.every((r) => {
    const key = pacingChannelKey(p.tab, r.channel);
    return (
      computeFadeState(
        dismissals[key],
        today,
        localDismiss[key] ?? null,
        true, // these rows are off-pace by construction
      ) === "dismissed"
    );
  });
}

/**
 * The three CRM-performance cells shared by the channel rows + the
 * collapsed channel-summary row: לידים / תיאומים / פגישות, each showing
 * the count with its cost-per metric (CPL / CPS / CPM) on hover. perf is
 * channel-level — passed on a single-campaign row or the channel summary,
 * and omitted (blank cells) on the expanded sub-campaign rows so counts
 * aren't duplicated.
 */
function PerfCells({ perf }: { perf?: ChannelPerf }) {
  const cell = (
    cls: string,
    count: number | undefined,
    cost: number | undefined,
    metric: "cpl" | "cps" | "cpm",
    costLabel: string,
    emptyLabel: string,
    extra?: ReactNode,
  ) => {
    const has = !!perf && (count ?? 0) > 0;
    // Tint the count by its cost-per-result on the same green→red scale as
    // the CPL/CPS chips — cheap = green, expensive = red — so the rows that
    // need attention pop. Blank/no-data counts keep the default color.
    const color = has ? costMetricColor(metric, cost ?? 0) : null;
    return (
      <td
        className={cls}
        title={perf ? (has ? `${costLabel}: ${fmt(Math.round(cost || 0))}` : emptyLabel) : undefined}
      >
        <span style={color ? { color, fontWeight: 600 } : undefined}>
          {perf ? (has ? (count as number).toLocaleString("he-IL") : "—") : ""}
        </span>
        {extra}
      </td>
    );
  };
  return (
    <>
      {cell(
        "c-leads",
        perf?.leads,
        perf?.cpl,
        "cpl",
        "עלות לליד",
        "אין לידים בתקופה",
        <CplTrend trend={perf?.cplTrend ?? 0} show={!!perf && (perf?.leads ?? 0) > 0} />,
      )}
      {cell("c-sched", perf?.scheduled, perf?.cps, "cps", "עלות לתיאום", "אין תיאומים בתקופה")}
      {cell("c-meet", perf?.meetings, perf?.cpm, "cpm", "עלות לפגישה", "אין פגישות בתקופה")}
    </>
  );
}

/**
 * CPL direction vs the trailing ~90 days (the value the budget-shift
 * engine already computes as trendScore). ▼ green = cost-per-lead
 * improving (cheaper now), ▲ red = worsening. Hidden below ±10% so it's
 * a real signal, not noise.
 */
function CplTrend({ trend, show }: { trend: number; show: boolean }) {
  if (!show) return null;
  if (trend <= -0.1)
    return (
      <span
        className="cpl-trend cpl-trend-down"
        title={`עלות לליד ירדה ~${Math.round(-trend * 100)}% מול 90 הימים האחרונים`}
        aria-label="עלות לליד משתפרת"
      >
        ▼
      </span>
    );
  if (trend >= 0.1)
    return (
      <span
        className="cpl-trend cpl-trend-up"
        title={`עלות לליד עלתה ~${Math.round(trend * 100)}% מול 90 הימים האחרונים`}
        aria-label="עלות לליד מתייקרת"
      >
        ▲
      </span>
    );
  return null;
}

/**
 * Days-of-runway hint for the pace cell: at the channel's recent daily
 * spend rate (קצב יומי), how long the remaining budget lasts. Amber when
 * it's about to dry up (≤7 days). Hidden when there's no daily rate or
 * nothing left to spend.
 */
function RunwayHint({
  remaining,
  dailyRate,
}: {
  remaining: number;
  dailyRate: number;
}) {
  if (!(dailyRate > 0) || remaining <= 0) return null;
  const days = Math.round(remaining / dailyRate);
  // Only surface when the budget is actually depleting (≤21 days) — a
  // healthy channel with months of runway would just clutter the pace
  // cell (the owner deliberately keeps this table tight).
  if (days > 21) return null;
  const tone = days <= 7 ? "soon" : "mid";
  return (
    <span
      className={`runway runway-${tone}`}
      title={`בקצב היומי הנוכחי (₪${Math.round(dailyRate).toLocaleString(
        "he-IL",
      )}/יום) התקציב שנותר (₪${Math.round(remaining).toLocaleString(
        "he-IL",
      )}) יספיק לעוד ~${days} ימים`}
    >
      ≈{days} ימ׳
    </span>
  );
}

function CampaignRow({
  tab,
  r,
  canEdit,
  onEdit,
  dismissals,
  today,
  localDismiss,
  onSnooze,
  platformUrl,
  perf,
  indent,
}: {
  tab: string;
  r: BudgetProject["rows"][number];
  canEdit: boolean;
  onEdit: (tab: string, row: number, value: number) => void;
  dismissals: Record<string, BudgetDismissal>;
  today: string;
  localDismiss: Record<string, "on" | "off">;
  onSnooze: (key: string, val: "on" | "off") => void;
  /** "Open in ad platform" deep-link for THIS row's platform (FB/Google
   *  account URL), already gated by showAdLinks. When set, the per-row
   *  copy button also opens the platform and copies the row's campaign
   *  filter token (FB) / project slug (Google) for the native search. */
  platformUrl?: string;
  /** This channel's CRM performance (leads/scheduled/meetings + cost-per).
   *  Passed on a single-campaign row; omitted on expanded sub-campaign
   *  rows (the channel summary carries it) or when there's no match. */
  perf?: ChannelPerf;
  /** True when this row is a sub-campaign under an expanded channel
   *  summary — indents it and drops the (redundant) channel name/logo. */
  indent?: boolean;
}) {
  const [draft, setDraft] = useState(String(Math.round(r.budget)));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  // Click-to-copy on the colored daily-required badge (just the number,
  // no slug, no platform open — the heavier "⧉ open + copy slug" button
  // beside it covers that workflow).
  const [numCopied, setNumCopied] = useState(false);
  async function copyDailyNumber() {
    try {
      await navigator.clipboard.writeText(String(Math.max(0, Math.round(r.dailyRequired))));
      setNumCopied(true);
      setTimeout(() => setNumCopied(false), 1500);
    } catch {
      /* best-effort */
    }
  }
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
          channel: r.channel,
          platform: r.platform,
          baselineDaily: r.actualDaily,
          restore,
        }),
      });
      const d = (await res.json()) as { ok?: boolean };
      // Lift to the grid so this channel's row fades immediately (per-
      // channel key); the platform-summary cell dims only once all its
      // off-pace rows are handled (see platformDimmed).
      if (res.ok && d.ok) onSnooze(signalKey, restore ? "off" : "on");
    } catch {
      /* best-effort; leave state as-is */
    } finally {
      setSnoozing(false);
    }
  }

  const dailyReq = Math.max(0, Math.round(r.dailyRequired));
  // Action is needed only when the configured daily is materially off the
  // required daily — not merely because the historical קצב deviates.
  // "Other" channels live outside the programmatic (E3) budget, so the
  // budget-action ⚠️ never applies to them.
  const isProgrammatic = r.platform !== "other";
  const needsAction =
    isProgrammatic &&
    !r.ended &&
    !budgetEssentiallySpent(r.budget, r.spend) &&
    needsBudgetAction(r.actualDaily, r.dailyRequired, r.pacingRatio);
  // Stopped-spending: budget left + flight still open, but every matched
  // campaign is paused → the channel isn't spending (broke overnight /
  // never relaunched). Shares the per-channel snooze with the pacing ⚠️.
  const stopped = isStoppedSpending(r);
  const actionable = needsAction || stopped;
  // Fade state: a snooze resurfaces next day only if THIS row still needs
  // attention (off-pace OR stopped), not on a budget-unchanged baseline.
  const state = computeFadeState(
    dismissals[signalKey],
    today,
    localDismiss[signalKey] ?? null,
    actionable,
  );
  // Arrow direction: by the configured-vs-required gap when we know the
  // configured daily; else by the historical pacing tone.
  const actionTone: "over" | "under" | "ok" | "none" = !needsAction
    ? "ok"
    : r.actualDaily > 0 && r.dailyRequired > 0
      ? r.dailyRequired > r.actualDaily
        ? "under"
        : "over"
      : paceTone(r.pacingRatio);
  // ✓ טיפלתי where there's something to handle — off-pace OR stopped.
  const offPace = actionable;

  return (
    <tr
      className={`${err ? "row-error" : ""} ${state === "dismissed" ? "is-dismissed" : ""} ${indent ? "is-subcampaign" : ""}`}
    >
      <td className="c-channel" title={`${PLATFORM_LABELS[r.platform as Platform] ?? "אחר"} · ${r.channel}${r.campaignType ? " · " + r.campaignType : ""}`}>
        {indent ? (
          <span className="subcamp-arrow" aria-hidden>
            ↳
          </span>
        ) : (
          <span className="c-channel-logo" aria-hidden>
            <PlatformIcon platform={r.platform} size=".95em" />
          </span>
        )}
        <StatusDot status={r.campaignStatus} />
        {needsAction && !stopped && (
          <span
            className="budget-alert"
            title="התקציב היומי בפלטפורמה לא תואם את הנדרש — נדרש עדכון"
            aria-label="נדרש עדכון תקציב"
          >
            ⚠️
          </span>
        )}
        {stopped && (
          <span
            className="budget-stopped"
            title="כל הקמפיינים בערוץ מושהים אך נותר תקציב — הערוץ לא מוציא. בדקו אם צריך להפעיל מחדש"
            aria-label="קמפיין מושהה ללא הוצאה"
          >
            ⏸
          </span>
        )}
        {/* Sub-campaign rows are identified by their סוג column, so the
            channel name isn't repeated here — keeps the group tidy. */}
        {!indent && r.channel}
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
      <PerfCells perf={perf} />
      <td className="c-pace">
        {r.ended ? (
          <span className="pace-val pace-none" title={`הסתיים ${r.endIso}`}>
            ⛔
          </span>
        ) : (
          <>
            <Pacing ratio={r.pacingRatio} muted={!needsAction} />
            <RunwayHint
              remaining={r.budget - r.spend}
              dailyRate={perf?.dailyRate ?? 0}
            />
          </>
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
            <button
              type="button"
              className={`budget-need pace-${actionTone} budget-need-copy${
                numCopied ? " is-copied" : ""
              }`}
              onClick={copyDailyNumber}
              title={numCopied ? "✓ הועתק" : "לחץ להעתקת הסכום"}
              aria-label={`העתק ₪${dailyReq.toLocaleString("he-IL")}`}
            >
              ₪{dailyReq.toLocaleString("he-IL")}
              {actionTone === "over" ? " ⬇" : actionTone === "under" ? " ⬆" : ""}
            </button>
            <CopyAmountButton
              amount={String(dailyReq)}
              variant="ghost"
              // FB row: open Ads Manager already filtered for BOTH the
              // project slug (already in the base fbAdsUrl) AND this
              // row's type slug — both as CONTAINS_ALL terms in the
              // filter_set, so FB shows only campaigns whose name
              // contains both. The clipboard then only needs the daily
              // number (no campaign identifier to paste). Owner asked
              // 2026-05-27.
              // Google row: unchanged — opens the account and copies
              // the project slug so the user can paste it into FB-
              // -style search inside Google's UI (which doesn't take
              // a slug filter via URL). Budget number stays one back
              // in clipboard history.
              url={
                r.platform === "facebook" && platformUrl
                  ? fbUrlWithExtraFilter(
                      platformUrl,
                      r.campaignType?.trim() || "",
                    )
                  : platformUrl
              }
              copyId={
                platformUrl && r.platform !== "facebook" ? tab : undefined
              }
              label={platformUrl ? "⧉" : "📋"}
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
  spike,
}: {
  platform: Platform;
  agg: PlatformAgg;
  dimmed?: boolean;
  /** Overspend spike on this platform (latest day ≫ trailing avg). */
  spike?: SpendSpike;
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
        {spike && (
          <span
            className="pc-spike"
            title={`חריגת הוצאה: ${fmt(spike.latest)} ביום האחרון לעומת ממוצע ${fmt(
              spike.prevAvg,
            )} (×${spike.ratio.toFixed(1)}) — בדקו תקרת תקציב/קמפיין שדולף`}
            aria-label="חריגת הוצאה"
          >
            🔥
          </span>
        )}
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

/**
 * A channel whose budget is essentially spent (≥90%) has no remaining
 * runway to pace, so a daily-budget ⚠️ is just noise — e.g. a channel that
 * over-paced and used up its budget early (TikTok at Essence, flagged
 * 2026-05-25): the alert says "lower the daily" but there's nothing left
 * to spend at any daily. Suppress the budget-action alert there, same
 * spirit as suppressing it for an ended channel.
 */
function budgetEssentiallySpent(budget: number, spend: number): boolean {
  return budget > 0 && spend >= budget * 0.9;
}

/**
 * A channel that's broken/idle: every matched Google/Facebook campaign is
 * paused, yet the channel still has budget left and its flight hasn't
 * ended — i.e. it isn't spending when it should be. campaignStatus is
 * already computed server-side (budgetMaster) by matching the row's סוג
 * token against the creatives sheet; we just promote the existing
 * 'paused' state into an actionable alarm. Channels whose budget is
 * essentially spent are excluded (they did their job).
 */
function isStoppedSpending(r: BudgetProject["rows"][number]): boolean {
  return (
    (r.platform === "google" || r.platform === "facebook") &&
    r.campaignStatus === "paused" &&
    !r.ended &&
    r.budget > 0 &&
    !budgetEssentiallySpent(r.budget, r.spend)
  );
}

function hasStoppedChannel(p: BudgetProject): boolean {
  return p.rows.some(isStoppedSpending);
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
  // Identify the ACCOUNT for each project by stripping the per-project
  // `filter_set` from its URL — so projects sharing a single FB/Google
  // account collate to one key. When the whole group resolves to one
  // account, return an ACCOUNT-level URL (filter_set stripped): the
  // manager/company button intent is "open the account", not "filter
  // to the first project's campaigns".
  //
  // (Before this strip, restoring per-project filter_set made every
  // project's URL unique → set.size > 1 → undefined → the icon
  // degraded to a non-clickable placeholder. 2026-05-25.)
  const accountKeys = new Set<string>();
  let firstUrl: string | undefined;
  for (const p of projects) {
    const a = adLinks[p.tab.toLowerCase()];
    const u = platform === "google" ? a?.gAdsUrl : a?.fbAdsUrl;
    if (!u) continue;
    let key = u;
    try {
      const parsed = new URL(u);
      parsed.searchParams.delete("filter_set");
      parsed.searchParams.sort();
      key = parsed.toString();
    } catch {
      /* unparseable — fall back to full-URL identity */
    }
    accountKeys.add(key);
    if (!firstUrl) firstUrl = u;
  }
  if (accountKeys.size !== 1 || !firstUrl) return undefined;
  try {
    const parsed = new URL(firstUrl);
    parsed.searchParams.delete("filter_set");
    return parsed.toString();
  } catch {
    return firstUrl;
  }
}

/**
 * Take a project-scoped FB Ads Manager URL (built by Apps Script with
 * filter_set = CONTAINS_ALL(["project-slug-1", "project-slug-2", ...]))
 * and add the per-row type slug (e.g. "wl") to the same CONTAINS_ALL
 * list. Result: FB now shows only campaigns whose name contains BOTH
 * the project slug AND the type slug.
 *
 * filter_set format (from Apps Script Code.js, verified against a
 * working captured URL): the param value is
 *     <FIELD>-STRING<OP><wrapped>
 * where the third part is JSON.stringify(JSON.stringify([...])) —
 * a double-stringified array so the inner JSON survives a round trip
 * through FB's quirky parser.
 *
 * Best-effort: any parse failure returns the input URL unchanged so
 * we never break the "open" behavior, only the extra filter. Returns
 * the input when typeSlug is empty (caller usually passes
 * r.campaignType?.trim() || "").
 */
function fbUrlWithExtraFilter(fbAdsUrl: string, typeSlug: string): string {
  if (!fbAdsUrl || !typeSlug) return fbAdsUrl;
  const RS = "";
  try {
    const u = new URL(fbAdsUrl);
    const fsRaw = u.searchParams.get("filter_set");
    if (!fsRaw) {
      // No existing filter_set (= account-level URL) — build a fresh
      // CONTAINS_ALL with just the type slug. Unlikely on the per-row
      // surface (rows live under a project-scoped fbAdsUrl) but
      // handled for completeness.
      const inner = JSON.stringify([typeSlug]);
      const wrapped = JSON.stringify(inner);
      u.searchParams.set(
        "filter_set",
        "SEARCH_BY_CAMPAIGN_GROUP_NAME-STRING" + RS + "CONTAINS_ALL" + RS + wrapped,
      );
      return u.toString();
    }
    const parts = fsRaw.split(RS);
    if (parts.length !== 3) return fbAdsUrl;
    const field = parts[0];
    const op = parts[1];
    const wrapped = parts[2];
    const inner = JSON.parse(wrapped) as string;
    const arr = JSON.parse(inner) as unknown;
    if (!Array.isArray(arr)) return fbAdsUrl;
    const lc = typeSlug.toLowerCase();
    if (!arr.some((v) => String(v).toLowerCase() === lc)) {
      arr.push(typeSlug);
    }
    const newInner = JSON.stringify(arr);
    const newWrapped = JSON.stringify(newInner);
    u.searchParams.set("filter_set", field + RS + op + RS + newWrapped);
    return u.toString();
  } catch {
    return fbAdsUrl;
  }
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
// Project-row ⚠️ — shows only while at least one programmatic channel
// needs a budget change AND is NOT currently handled (טיפלתי-snoozed).
// Dismissal-aware so clicking טיפלתי on the alerting channels clears the
// project ⚠️ too; a snooze that lapses with the gap still open returns to
// 'resurfaced' (counts as unhandled) → the ⚠️ comes back. Same per-row
// computeFadeState the channel rows use, so header + rows stay in sync.
function hasChannelAlert(
  p: BudgetProject,
  dismissals: Record<string, BudgetDismissal>,
  localDismiss: Record<string, "on" | "off">,
  today: string,
): boolean {
  return p.rows.some((r) => {
    if (r.platform === "other" || r.ended) return false;
    if (budgetEssentiallySpent(r.budget, r.spend)) return false;
    const needsAction = needsBudgetAction(
      r.actualDaily,
      r.dailyRequired,
      r.pacingRatio,
    );
    const stopped = isStoppedSpending(r);
    if (!needsAction && !stopped) return false;
    const key = pacingChannelKey(p.tab, r.channel);
    const state = computeFadeState(
      dismissals[key],
      today,
      localDismiss[key] ?? null,
      needsAction || stopped,
    );
    return state !== "dismissed";
  });
}

function needsAttention(p: BudgetProject): boolean {
  if (p.reconStatus === "over" || p.reconStatus === "under") return true;
  if (p.reconStatus === "no-target" && p.allocated > 0) return true;
  return hasPacingIssue(p) || hasStoppedChannel(p);
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
