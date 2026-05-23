"use client";

import { useMemo, useState } from "react";
import CopyAmountButton from "./CopyAmountButton";
import PrisaButton from "./PrisaButton";
import {
  E3_PLATFORMS,
  MANAGER_ORDER,
  PLATFORM_LABELS,
  UNASSIGNED_MANAGER,
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

export default function BudgetGrid({
  projects: initial,
  adLinks,
  showAdLinks,
  canEdit,
}: {
  projects: BudgetProject[];
  /** keyed by tab name (lowercased). */
  adLinks: Record<string, ProjLinks>;
  showAdLinks: boolean;
  canEdit: boolean;
}) {
  const [projects, setProjects] = useState<BudgetProject[]>(initial);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<
    "all" | "attention" | "distribution" | "pacing"
  >("attention");
  const [showInactive, setShowInactive] = useState(false);

  const counts = useMemo(() => {
    let attention = 0,
      distribution = 0,
      pacing = 0,
      active = 0;
    for (const p of projects) {
      if (isInactive(p)) continue;
      active++;
      const dist = p.reconStatus === "over" || p.reconStatus === "under";
      const pace = hasPacingIssue(p);
      if (dist) distribution++;
      if (pace) pacing++;
      if (dist || pace || (p.reconStatus === "no-target" && p.allocated > 0))
        attention++;
    }
    return { attention, distribution, pacing, active, total: projects.length };
  }, [projects]);

  const visible = useMemo(() => {
    const list = projects.filter((p) => {
      if (isInactive(p) && !showInactive) return false;
      if (filter === "all") return true;
      const dist = p.reconStatus === "over" || p.reconStatus === "under";
      const pace = hasPacingIssue(p);
      if (filter === "distribution") return dist;
      if (filter === "pacing") return pace;
      // attention
      return dist || pace || (p.reconStatus === "no-target" && p.allocated > 0);
    });
    return list;
  }, [projects, filter, showInactive]);

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
            </h2>
            {mg.companies.map((cg) => (
              <div key={cg.company} className="budget-co-group">
                <h3 className="budget-co-head">
                  <span className="budget-co-name">{cg.company}</span>
                  <GroupTotals projects={cg.projects} />
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
}: {
  p: BudgetProject;
  open: boolean;
  onToggle: () => void;
  ad: ProjLinks;
  showAdLinks: boolean;
  canEdit: boolean;
  onEdit: (tab: string, row: number, value: number) => void;
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
          <span className="budget-proj-name">{p.name}</span>
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

        <span className="budget-platcells">
          {E3_PLATFORMS.map((pl) => (
            <PlatformCell key={pl} platform={pl} agg={p.platforms[pl]} />
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
}: {
  p: BudgetProject;
  ad: ProjLinks;
  showAdLinks: boolean;
  canEdit: boolean;
  onEdit: (tab: string, row: number, value: number) => void;
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
        return (
          <div key={g.platform} className="budget-group">
            <div className="budget-group-head">
              <span className="budget-group-title">{g.label}</span>
              {isPaid && (
                <span className="budget-group-stats">
                  {fmt(g.agg.budget)} מאושר · {fmt(g.agg.spend)} בפועל ·{" "}
                  <Pacing ratio={g.agg.pacingRatio} />
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
              {isPaid && p.remainingDays > 0 && g.agg.budget > 0 && (
                <CopyAmountButton
                  amount={String(Math.max(0, Math.round(g.agg.dailyRequired)))}
                  variant="ghost"
                  url={showAdLinks ? url : undefined}
                  label={
                    showAdLinks && url
                      ? `⧉ פתח + העתק נדרש ₪${Math.max(0, Math.round(g.agg.dailyRequired))}/יום`
                      : `📋 נדרש ₪${Math.max(0, Math.round(g.agg.dailyRequired))}/יום`
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
                    <th>קצב</th>
                    <th>נדרש ליום</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <CampaignRow
                      key={r.row}
                      tab={p.tab}
                      remainingDays={p.remainingDays}
                      r={r}
                      canEdit={canEdit}
                      onEdit={onEdit}
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

function CampaignRow({
  tab,
  remainingDays,
  r,
  canEdit,
  onEdit,
}: {
  tab: string;
  remainingDays: number;
  r: BudgetProject["rows"][number];
  canEdit: boolean;
  onEdit: (tab: string, row: number, value: number) => void;
}) {
  const [draft, setDraft] = useState(String(Math.round(r.budget)));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);

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

  const daily = remainingDays > 0 ? Math.max(0, Math.round(r.dailyRequired)) : 0;

  return (
    <tr className={err ? "row-error" : ""}>
      <td className="c-channel" title={r.channel}>
        {r.channel}
      </td>
      <td className="c-type">{r.campaignType || "—"}</td>
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
        <Pacing ratio={r.pacingRatio} />
      </td>
      <td className="c-daily">
        {remainingDays > 0 ? (
          <span className="budget-daily">
            ₪{daily.toLocaleString("he-IL")}
            <CopyAmountButton amount={String(daily)} variant="ghost" label="📋" />
          </span>
        ) : (
          "—"
        )}
      </td>
    </tr>
  );
}

/* ── small presentational pieces ─────────────────────────────────── */

function PlatformCell({ platform, agg }: { platform: Platform; agg: PlatformAgg }) {
  const empty = agg.budget === 0 && agg.spend === 0;
  return (
    <span className={`budget-platcell ${empty ? "is-empty" : ""}`}>
      <span className="pc-name">{PLATFORM_LABELS[platform]}</span>
      {empty ? (
        <span className="pc-empty">—</span>
      ) : (
        <>
          <span className="pc-amt">{fmt(agg.budget)}</span>
          <span className="pc-sub">
            <span className={`budget-dot pace-${paceTone(agg.pacingRatio)}`} />
            {fmt(agg.spend)}
          </span>
        </>
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

function Pacing({ ratio }: { ratio: number }) {
  if (!ratio) return <span className="pace-val pace-none">—</span>;
  const tone = paceTone(ratio);
  return (
    <span className={`pace-val pace-${tone}`}>
      {Math.round(ratio * 100)}%
    </span>
  );
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

/* ── pure helpers ────────────────────────────────────────────────── */

function fmt(n: number): string {
  return "₪" + Math.round(n || 0).toLocaleString("he-IL");
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
    const t = paceTone(a.pacingRatio);
    return t === "over" || t === "under";
  });
}

function needsAttention(p: BudgetProject): boolean {
  if (p.reconStatus === "over" || p.reconStatus === "under") return true;
  if (p.reconStatus === "no-target" && p.allocated > 0) return true;
  return hasPacingIssue(p);
}

function isInactive(p: BudgetProject): boolean {
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
    return {
      ...r,
      budget: value,
      pacingRatio: expected > 0 ? r.spend / expected : 0,
      dailyRequired: p.remainingDays > 0 ? (value - r.spend) / p.remainingDays : 0,
    };
  });

  const platforms = {
    google: agg("google"),
    facebook: agg("facebook"),
    taboola: agg("taboola"),
    outbrain: agg("outbrain"),
  };
  function agg(pl: Platform): PlatformAgg {
    let budget = 0,
      spend = 0,
      rowCount = 0;
    for (const r of rows) {
      if (r.platform !== pl) continue;
      budget += r.budget;
      spend += r.spend;
      rowCount++;
    }
    const expected = budget * elapsedFrac;
    return {
      budget,
      spend,
      rowCount,
      pacingRatio: expected > 0 ? spend / expected : 0,
      dailyRequired: p.remainingDays > 0 ? (budget - spend) / p.remainingDays : 0,
      actualDaily: p.platforms[pl].actualDaily,
    };
  }
  let oBudget = 0,
    oSpend = 0,
    oCount = 0;
  for (const r of rows) {
    if (r.platform !== "other") continue;
    oBudget += r.budget;
    oSpend += r.spend;
    oCount++;
  }
  const oExpected = oBudget * elapsedFrac;
  const other: PlatformAgg = {
    budget: oBudget,
    spend: oSpend,
    rowCount: oCount,
    pacingRatio: oExpected > 0 ? oSpend / oExpected : 0,
    dailyRequired: p.remainingDays > 0 ? (oBudget - oSpend) / p.remainingDays : 0,
    actualDaily: 0,
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
