import {
  currentUserEmail,
  getMorningFeed,
  tasksPeopleList,
} from "@/lib/appsScript";
import { getEffectiveViewAs } from "@/lib/viewAsCookie";
import { canSeeCampaigns } from "@/lib/userRole";
import { canViewAdLinks } from "@/lib/adLinkAccess";
import { driveFolderOwner } from "@/lib/sa";
import { getBudgetMaster } from "@/lib/budgetMaster";
import BudgetGrid from "@/components/BudgetGrid";
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

  const [budgetRes, feedRes, peopleRes] = await Promise.allSettled([
    getBudgetMaster(driveFolderOwner()),
    getMorningFeed({ scope: "all", overrideEmail }),
    tasksPeopleList(),
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
    }
  }
  const showAdLinks = canViewAdLinks(subject, peopleList);

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
            חלוקת התקציב הפרוגרמטי (E3) בין Google · Facebook · Taboola ·
            Outbrain — ועריכת התקציב החודשי המאושר ישירות מכאן.
          </div>
        </div>
      </header>

      <CampaignsTabs active="budgets" />

      {error && (
        <div className="error">
          <strong>שגיאה בטעינת התקציבים.</strong>
          <br />
          {error}
        </div>
      )}

      {master && (
        <BudgetGrid
          projects={master.projects}
          adLinks={adLinks}
          showAdLinks={showAdLinks}
          canEdit={roleEligible}
        />
      )}
    </main>
  );
}
