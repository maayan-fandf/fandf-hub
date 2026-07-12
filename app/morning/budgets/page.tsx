import {
  currentUserEmail,
  getAllProjectAdLinks,
  getMyProjects,
  tasksPeopleList,
} from "@/lib/appsScript";
import { getEffectiveViewAs } from "@/lib/viewAsCookie";
import { canSeeCampaigns } from "@/lib/userRole";

export const metadata = { title: "תקציבים" };
import { canViewAdLinks } from "@/lib/adLinkAccess";
import { driveFolderOwner } from "@/lib/sa";
import { getBudgetMaster } from "@/lib/budgetMaster";
import { isProjectEndedByIso } from "@/lib/projectEnded";
import { isRealEstateType } from "@/lib/keys";
import { listAlertDismissals } from "@/lib/alertDismissals";
import { getUsdIlsRate } from "@/lib/fxRate";
import { getAllClientsAllRows } from "@/lib/allClients";
import {
  getDailySpendSpikes,
  type DailySpendSpikes,
} from "@/lib/platformDailySpend";
import {
  computeBudgetShiftForProject,
  groupAllClientsBySlug,
  buildChannelPerf,
  type ProjectBudgetShift,
  type ChannelPerf,
} from "@/lib/budgetShiftSuggestions";
import BudgetGrid, { type BudgetDismissal } from "@/components/BudgetGrid";
import CampaignsTabs from "@/components/CampaignsTabs";

export const dynamic = "force-dynamic";

export default async function BudgetsPage() {
  const me = await currentUserEmail().catch(() => "");
  const viewAs = me ? await getEffectiveViewAs(me).catch(() => "") : "";
  const overrideEmail = viewAs && viewAs !== me ? viewAs : undefined;
  const subject = overrideEmail || me;

  const roleEligible = await canSeeCampaigns(subject).catch(() => false);

  if (!roleEligible) {
    return (
      <main className="container">
        <header className="page-header">
          <div>
            <h1>
              <span className="emoji" aria-hidden>
                💰
              </span>
              תקציבים
            </h1>
          </div>
        </header>
        <div className="empty">
          <span className="emoji" aria-hidden>
            🔒
          </span>
          עמוד ניהול התקציבים זמין לאדמינים, מנהלים וצוות המדיה בלבד.
        </div>
      </main>
    );
  }

  const [
    budgetRes,
    adLinksRes,
    peopleRes,
    dismissRes,
    rateRes,
    projectsRes,
    allClientsRes,
    spikesRes,
  ] = await Promise.allSettled([
    getBudgetMaster(driveFolderOwner()),
    // Ad-account / sheet deep-links via the lightweight bulk resolver — NOT
    // the full morningFeed, which takes ~130s and times out at the 45s fetch
    // limit, leaving the desk with no links (the original "broken links" bug).
    getAllProjectAdLinks(subject),
    tasksPeopleList(),
    listAlertDismissals(),
    getUsdIlsRate(),
    getMyProjects(overrideEmail),
    // Per-channel leads/meetings (current) + חודשי history for the
    // budget-shift suggestions. Same 5-min-cached read the CRM alerts
    // already share, so this adds no Sheets quota.
    getAllClientsAllRows(driveFolderOwner()),
    // Per project×platform spend spikes (latest day vs trailing avg).
    // Shares the same 30-min-cached daily-spend read budgetMaster already
    // does for actual7d (driveFolderOwner subject) — no extra Sheets call.
    getDailySpendSpikes(driveFolderOwner()),
  ]);

  const master = budgetRes.status === "fulfilled" ? budgetRes.value : null;
  const error =
    budgetRes.status === "rejected"
      ? budgetRes.reason instanceof Error
        ? budgetRes.reason.message
        : String(budgetRes.reason)
      : null;
  const adLinkEntries =
    adLinksRes.status === "fulfilled" ? adLinksRes.value : [];
  const peopleList =
    peopleRes.status === "fulfilled" && peopleRes.value.ok
      ? peopleRes.value.people
      : [];

  // Per-project ad-account + sheet deep-links from the lightweight bulk
  // resolver, keyed by BOTH the slug (== the budget `tab`) and the Hebrew
  // name so the grid's tab→name lookup resolves either identifier. (projectHref
  // is dropped: the grid falls back to /projects/{name}, which is identical.)
  const adLinks: Record<
    string,
    { gAdsUrl?: string; fbAdsUrl?: string; sheetTabUrl?: string }
  > = {};
  for (const e of adLinkEntries) {
    const entry = {
      gAdsUrl: e.gAdsUrl || undefined,
      fbAdsUrl: e.fbAdsUrl || undefined,
      sheetTabUrl: e.sheetTabUrl || undefined,
    };
    for (const k of [e.slug, e.name]) {
      const key = (k || "").toLowerCase().trim();
      if (key) adLinks[key] = entry;
    }
  }
  // Live/inactive map derived from the budget master (the same project list the
  // grid renders): non-live when ended (>5 days past) OR no current-month
  // spend — same definition as the projects home screen + top-nav. Keyed by
  // both tab and name. (This used to come from the morning feed, which now
  // times out — so it was silently empty on prod.)
  const inactiveProjects: Record<string, boolean> = {};
  for (const p of master?.projects ?? []) {
    const spendSum = Object.values(p.platforms).reduce(
      (s, pl) => s + (pl?.spend || 0),
      0,
    );
    const inactive = isProjectEndedByIso(p.endIso) || !(spendSum > 0);
    for (const k of [p.tab, p.name]) {
      const key = (k || "").toLowerCase().trim();
      if (key) inactiveProjects[key] = inactive;
    }
  }
  const showAdLinks = canViewAdLinks(subject, peopleList);

  // "טיפלתי" snoozes — the pacing slice of the shared dismissal store.
  // Per-channel keys (2026-05-25) plus legacy per-platform ones, all of
  // which the morning feed + dashboard pacing cell also use, so a dismiss
  // on any surface fades here.
  const allDismissals =
    dismissRes.status === "fulfilled" ? dismissRes.value : {};
  const budgetDismissals: Record<string, BudgetDismissal> = {};
  for (const [key, d] of Object.entries(allDismissals)) {
    if (!key.includes("|pacing-variance|") && !key.endsWith("|budget-shift"))
      continue;
    budgetDismissals[key] = {
      snooze_until: d.snooze_until || "",
      dismissed_at: d.dismissed_at || "",
      reason: d.reason || "",
    };
  }
  const usdIlsRate = rateRes.status === "fulfilled" ? rateRes.value : 3.7;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
  }).format(new Date());

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>
              💰
            </span>
            תקציבים
          </h1>
          <div className="subtitle">
            חלוקת התקציב הפרוגרמטי (E3) בין Google · Facebook · TikTok ·
            Taboola · Outbrain — ועריכת התקציב החודשי המאושר ישירות מכאן.
          </div>
        </div>
      </header>

      <CampaignsTabs
        active="budgets"
        showForecast={
          projectsRes.status === "fulfilled" ? !!projectsRes.value.isAdmin : false
        }
      />

      {error && (
        <div className="error">
          <strong>שגיאה בטעינת התקציבים.</strong>
          <br />
          {error}
        </div>
      )}

      {master && (() => {
        // Project-type filter (2026-05-27): the budget desk is a
        // real-estate-only surface — non-real-estate projects (like
        // the internal צוות F&F row) have no media spend / pacing
        // concept, so showing them in the grid would mean a row of
        // zeros polluting the view. Build a projectName→type map
        // from the live Project[] (already type-aware via Keys'
        // `project type` column) and filter the master roster.
        const projectsData =
          projectsRes.status === "fulfilled" ? projectsRes.value : null;
        const typeByName = new Map<string, string>();
        for (const p of projectsData?.projects ?? []) {
          typeByName.set(p.name, p.projectType);
        }
        const filtered = master.projects.filter((p) => {
          const type = typeByName.get(p.tab) || typeByName.get(p.name);
          return isRealEstateType(type);
        });
        // Budget-shift suggestions — the iframe's reallocation engine
        // (scoring + drift/rebalance) running hub-side on the same
        // ALL CLIENTS data. Keyed by lowercase tab for the grid lookup.
        const allClientsRows =
          allClientsRes.status === "fulfilled" ? allClientsRes.value : [];
        const bySlug = groupAllClientsBySlug(allClientsRows);
        const shifts: Record<string, ProjectBudgetShift> = {};
        // Per-channel leads/scheduled/meetings (+ cost-per) for the
        // drill-in channel table's תיאומים/פגישות columns. Keyed by
        // lowercase tab → lowercase channel.
        const perf: Record<string, Record<string, ChannelPerf>> = {};
        for (const p of filtered) {
          const g = bySlug.get(p.tab.toLowerCase().trim());
          if (!g) continue;
          // Pass the חודשי history + today so each channel also gets a
          // CPL trend vs its trailing ~90 days (▲/▼ on the leads cell).
          perf[p.tab.toLowerCase()] = buildChannelPerf(g.current, g.monthly, today);
          const shift = computeBudgetShiftForProject({
            project: p,
            currentRows: g.current,
            monthlyRows: g.monthly,
            todayIso: today,
          });
          if (shift) shifts[p.tab.toLowerCase()] = shift;
        }
        const spikes: DailySpendSpikes =
          spikesRes.status === "fulfilled" ? spikesRes.value : {};
        return (
          <BudgetGrid
            projects={filtered}
            adLinks={adLinks}
            inactiveProjects={inactiveProjects}
            showAdLinks={showAdLinks}
            canEdit={roleEligible}
            dismissals={budgetDismissals}
            today={today}
            usdIlsRate={usdIlsRate}
            shifts={shifts}
            perf={perf}
            spikes={spikes}
          />
        );
      })()}
    </main>
  );
}
