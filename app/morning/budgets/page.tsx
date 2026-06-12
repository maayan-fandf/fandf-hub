import {
  currentUserEmail,
  getMorningFeed,
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
    feedRes,
    peopleRes,
    dismissRes,
    rateRes,
    projectsRes,
    allClientsRes,
  ] = await Promise.allSettled([
    getBudgetMaster(driveFolderOwner()),
    getMorningFeed({ scope: "all", overrideEmail }),
    tasksPeopleList(),
    listAlertDismissals(),
    getUsdIlsRate(),
    getMyProjects(overrideEmail),
    // Per-channel leads/meetings (current) + חודשי history for the
    // budget-shift suggestions. Same 5-min-cached read the CRM alerts
    // already share, so this adds no Sheets quota.
    getAllClientsAllRows(driveFolderOwner()),
  ]);

  const master = budgetRes.status === "fulfilled" ? budgetRes.value : null;
  const error =
    budgetRes.status === "rejected"
      ? budgetRes.reason instanceof Error
        ? budgetRes.reason.message
        : String(budgetRes.reason)
      : null;
  const feed = feedRes.status === "fulfilled" ? feedRes.value : null;
  const peopleList =
    peopleRes.status === "fulfilled" && peopleRes.value.ok
      ? peopleRes.value.people
      : [];

  // Per-project links from the morning feed, keyed by slug (== tab):
  // ad-account deep links, the sheet tab URL, and the Hub project page.
  const adLinks: Record<
    string,
    {
      gAdsUrl?: string;
      fbAdsUrl?: string;
      sheetTabUrl?: string;
      projectHref?: string;
    }
  > = {};
  // Live/inactive map (slug → is-inactive), keyed the same way as adLinks
  // so the grid can look it up by tab. Uses the SAME definition as the
  // projects home screen + top-nav (lib/projectEnded): a project is
  // non-live when it ended (>5 days past) OR has no current-month spend.
  // Every feed project gets an explicit true/false so the grid can tell a
  // "live" project (false) from one missing from the feed (absent).
  const inactiveProjects: Record<string, boolean> = {};
  if (feed) {
    for (const pr of feed.projects) {
      const key = (pr.slug || pr.name || "").toLowerCase();
      if (!key) continue;
      adLinks[key] = {
        gAdsUrl: pr.gAdsUrl || undefined,
        fbAdsUrl: pr.fbAdsUrl || undefined,
        sheetTabUrl: pr.sheetTabUrl || undefined,
        projectHref: pr.name
          ? `/projects/${encodeURIComponent(pr.name)}`
          : undefined,
      };
      inactiveProjects[key] = isProjectEndedByIso(pr.endIso) || !(pr.spend > 0);
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
          perf[p.tab.toLowerCase()] = buildChannelPerf(g.current);
          const shift = computeBudgetShiftForProject({
            project: p,
            currentRows: g.current,
            monthlyRows: g.monthly,
            todayIso: today,
          });
          if (shift) shifts[p.tab.toLowerCase()] = shift;
        }
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
          />
        );
      })()}
    </main>
  );
}
