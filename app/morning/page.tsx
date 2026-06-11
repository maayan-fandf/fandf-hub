import Link from "next/link";
import {
  currentUserEmail,
  getMorningFeed,
  getMyProjects,
  tasksPeopleList,
  type MorningFeed,
  type MorningProject,
  type MorningSignal,
  type MorningSeverity,
} from "@/lib/appsScript";
import { getEffectiveViewAs } from "@/lib/viewAsCookie";

export const metadata = { title: "סיכום בוקר" };
import { scopedProjectNames } from "@/lib/scope";
import { getScopedPerson } from "@/lib/scope-server";
import { canViewAdLinks } from "@/lib/adLinkAccess";
import { canSeeCampaigns } from "@/lib/userRole";
import { getCrmFunnelForProject } from "@/lib/crmData";
import { getAllClientsCurrentForProject } from "@/lib/allClients";
import { computeCrmAlerts } from "@/lib/crmAlerts";
import { listAlertDismissals, applyDismissalsToSignals } from "@/lib/alertDismissals";
import { driveFolderOwner } from "@/lib/sa";
import { isRealEstateType } from "@/lib/keys";
import MorningSignalRow from "@/components/MorningSignalRow";
import FacebookAdsIcon from "@/components/FacebookAdsIcon";
import GoogleAdsIcon from "@/components/GoogleAdsIcon";
import CampaignsTabs from "@/components/CampaignsTabs";

export const dynamic = "force-dynamic";

type Search = { scope?: string; severity?: string; person?: string };

export default async function MorningPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const scope = sp.scope === "all" ? "all" : "mine";
  const severityFilter = sp.severity ?? "";

  // Person scope: cookie (set by home-page filter) with `?person=X` as an
  // ephemeral URL override. Matches the precedence used on the home page,
  // inbox, and nav dropdown.
  const scopedPerson = await getScopedPerson(sp.person);

  // Honor the gear-menu "view as" pref so the morning page mirrors
  // /tasks and / when impersonating. Without this the feed always
  // came back as the session user even when view_as was set.
  const me = await currentUserEmail().catch(() => "");
  const viewAs = me ? await getEffectiveViewAs(me).catch(() => "") : "";
  const overrideEmail = viewAs && viewAs !== me ? viewAs : undefined;

  // Single parallel batch for everything the page needs up-front:
  //   - role gate (canSeeCampaigns) — previously awaited serially
  //     BEFORE the batch, pushing the slow feed fetch ~100-200ms later
  //   - the feed itself + projects + people list
  //   - the alert-dismissals store — previously awaited serially AFTER
  //     this batch (blocking the per-project CRM enrichment fan-out by
  //     a full Firestore round-trip). Speed pass 2026-06-10.
  const [roleRes, feedRes, projectsRes, peopleRes, dismissalsRes] =
    await Promise.allSettled([
      canSeeCampaigns(overrideEmail || me),
      getMorningFeed({ scope, overrideEmail }),
      scopedPerson || overrideEmail
        ? getMyProjects(overrideEmail)
        : Promise.resolve(null),
      tasksPeopleList(),
      listAlertDismissals(),
    ]);
  const roleEligible =
    roleRes.status === "fulfilled" ? roleRes.value : false;
  const data: MorningFeed | null =
    feedRes.status === "fulfilled" ? feedRes.value : null;
  const error =
    feedRes.status === "rejected"
      ? feedRes.reason instanceof Error
        ? feedRes.reason.message
        : String(feedRes.reason)
      : null;
  const projectsData =
    projectsRes.status === "fulfilled" ? projectsRes.value : null;
  // Ad-platform deep-link gate — Media role + Felix only. Honors the
  // gear-menu view-as so impersonation hides the buttons too when the
  // impersonated user isn't on the access list.
  const peopleListData =
    peopleRes.status === "fulfilled" && peopleRes.value.ok
      ? peopleRes.value.people
      : [];
  const adLinkSubject = overrideEmail || me;
  const showAdLinks = canViewAdLinks(adLinkSubject, peopleListData);

  const rawProjects = data?.projects ?? [];
  // Enrich each project with hub-side CRM alerts (computeCrmAlerts) and
  // merge them into the project's `signals` array. Without this, the
  // morning page shows ONLY the Apps-Script-side dashboard alerts and
  // misses meeting-noshow-spike / source-converts-poorly /
  // creative-mismatch / stale-leads — which is why the same project on
  // /projects/[name] shows more alerts than on /morning.
  //
  // Cost: per project, two cached reads (CRM workbook + ALL CLIENTS).
  // All underlying reads are two-layer cached (unstable_cache 5min +
  // per-request cache()), so on warm cache this is in-memory filter
  // work; on cold cache the slowest underlying read dominates.
  // Promise.allSettled so one stuck project doesn't block the page.
  // Dismissal store fetched once in the initial batch above (not per
  // project, not serially) so the hub-side CRM alerts can be
  // faded/hidden like the report's own signals.
  const dismissals =
    dismissalsRes.status === "fulfilled" ? dismissalsRes.value : {};
  const enrichedResults = await Promise.allSettled(
    rawProjects.map(async (p) => {
      if (!p.company) return p;
      const subjectEmail = driveFolderOwner();
      // Three parallel fetches per project: month-filtered funnel
      // (CRM card on the project page reads the same), all-time
      // funnel (creative-mismatch's objection dominance — see
      // crmAlerts.ts for the rationale), and ALL CLIENTS current
      // rows. All underlying Sheets reads are two-layer cached, so
      // the per-project work is in-memory filtering.
      const [funnel, funnelAllTime, allClients] = await Promise.all([
        getCrmFunnelForProject({ company: p.company, project: p.name })
          .catch(() => null),
        getCrmFunnelForProject({ company: p.company, project: p.name, noFilter: true })
          .catch(() => null),
        getAllClientsCurrentForProject({ subjectEmail, project: p.name, projectSlug: p.slug })
          .catch(() => []),
      ]);
      const crmSignals = applyDismissalsToSignals(
        computeCrmAlerts({
          funnel,
          funnelAllTime,
          allClients,
          projectSlug: p.slug || p.name,
        }),
        dismissals,
      );
      if (crmSignals.length === 0) return p;
      const signals: MorningSignal[] = [...p.signals, ...crmSignals];
      return { ...p, signals, maxSeverity: maxSeverityFromSignals(signals) };
    }),
  );
  const allProjects: MorningProject[] = enrichedResults.map((r, i) =>
    r.status === "fulfilled" ? r.value : rawProjects[i],
  );

  // Project-type filter (2026-05-27): /morning is a real-estate-only
  // surface — its alerts are all media/pacing/funnel-shaped. Non-
  // real-estate projects (e.g. צוות F&F's כללי) have no spend, no
  // funnel, no creative — surfacing them here would mean rows that
  // are always "all clear" and just pollute the count. Drop them
  // before any further processing. The projectType lookup comes
  // from getMyProjects (Keys-backed); fallback to "real estate" so
  // a project the feed has but Keys doesn't keeps its old behavior.
  const projectTypeByName = new Map<string, string>();
  for (const p of projectsData?.projects ?? []) {
    projectTypeByName.set(p.name, p.projectType);
  }
  const typeFiltered = allProjects.filter((p) =>
    isRealEstateType(projectTypeByName.get(p.name)),
  );

  // Narrow to projects where the scoped person is on the roster. Null set
  // = stale cookie (person no longer on any project), fall back to full
  // feed so the page doesn't go empty — same pattern as app/layout.tsx.
  const scopedSet = projectsData
    ? scopedProjectNames(projectsData.projects, scopedPerson)
    : null;
  const projects = scopedSet
    ? typeFiltered.filter((p) => scopedSet.has(p.name))
    : typeFiltered;

  // Recompute severity counts from the final (post-CRM-merge) project
  // list — both the scoped and unscoped cases need this, since the
  // Apps-Script-side counts in `data.counts` don't know about the hub-
  // merged CRM alerts.
  const counts = {
    total: projects.length,
    severe: projects.filter((p) => p.maxSeverity === 3).length,
    warn: projects.filter((p) => p.maxSeverity === 2).length,
    clear: projects.filter((p) => p.maxSeverity === 0).length,
  };

  const visible = projects.filter((p) => {
    if (!severityFilter) return true;
    if (severityFilter === "severe") return p.maxSeverity === 3;
    if (severityFilter === "warn") return p.maxSeverity === 2;
    if (severityFilter === "clear") return p.maxSeverity === 0;
    return true;
  });
  const clearProjects = visible.filter((p) => p.maxSeverity === 0);
  const alertProjects = visible.filter((p) => p.maxSeverity > 0);

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>
              📢
            </span>
            קמפיינים
          </h1>
          {data && roleEligible && (
            <div className="subtitle">
              התראות זמינות לאורך כל היום · טיפלת? סמן ✓ והן ישוקטו עד למחר
              <br />
              {counts.severe > 0 && <>🔥 {counts.severe} קריטיים · </>}
              {counts.warn > 0 && <>⚠️ {counts.warn} אזהרות · </>}
              {counts.clear > 0 && <>✅ {counts.clear} ללא התראות · </>}
              {counts.total} פרויקטים סה&quot;כ
              {scopedPerson && scopedSet && (
                <>
                  {" · "}
                  👤 סינון: <b>{scopedPerson}</b>
                </>
              )}
              {(data.isAdmin || data.isInternal) && (
                <>
                  {" · "}
                  <ScopeToggle scope={scope} />
                </>
              )}
            </div>
          )}
        </div>
      </header>

      {roleEligible && (
        <CampaignsTabs
          active="alerts"
          showForecast={!!projectsData?.isAdmin}
        />
      )}

      {error && (
        <div className="error">
          <strong>שגיאה בטעינת המידע.</strong>
          <br />
          {error}
        </div>
      )}

      {data && roleEligible && (
        <div className="morning-filter-bar">
          <SeverityChip
            label="הכל"
            count={counts.total}
            active={!severityFilter}
            href={`/morning${scope === "all" ? "?scope=all" : ""}`}
          />
          <SeverityChip
            label="🔥 קריטיים"
            count={counts.severe}
            active={severityFilter === "severe"}
            href={buildHref(scope, "severe")}
            tone="severe"
          />
          <SeverityChip
            label="⚠️ אזהרות"
            count={counts.warn}
            active={severityFilter === "warn"}
            href={buildHref(scope, "warn")}
            tone="warn"
          />
          <SeverityChip
            label="✅ שקט"
            count={counts.clear}
            active={severityFilter === "clear"}
            href={buildHref(scope, "clear")}
            tone="clear"
          />
        </div>
      )}

      {data && !data.isAdmin && !data.isInternal && (
        <div className="empty">
          <span className="emoji" aria-hidden>🔒</span>
          עמוד ההתראות זמין לצוות F&amp;F בלבד.
        </div>
      )}

      {data && (data.isAdmin || data.isInternal) && !roleEligible && (
        <div className="empty">
          <span className="emoji" aria-hidden>🔒</span>
          עמוד הקמפיינים זמין לאדמינים, מנהלים וצוות המדיה בלבד.
        </div>
      )}

      {data && (data.isAdmin || data.isInternal) && roleEligible && visible.length === 0 && (
        <div className="empty">
          <span className="emoji" aria-hidden>
            🌿
          </span>
          {scopedSet && projects.length === 0 && allProjects.length > 0
            ? `הסינון הנוכחי (${scopedPerson}) מסתיר ${allProjects.length} פרויקטים.`
            : projects.length === 0
              ? "אין פרויקטים בטווח הזה."
              : "אין פרויקטים תואמים לסינון."}
        </div>
      )}

      {roleEligible && alertProjects.length > 0 && (
        <ul className="morning-list">
          {alertProjects.map((p) => (
            <ProjectCard key={p.name} p={p} showAdLinks={showAdLinks} />
          ))}
        </ul>
      )}

      {roleEligible && clearProjects.length > 0 && severityFilter !== "clear" && (
        <details className="morning-clear">
          <summary>
            ✅ {clearProjects.length} פרויקטים ללא התראות (לחץ להצגה)
          </summary>
          <ul className="morning-list morning-list-compact">
            {clearProjects.map((p) => (
              <ProjectCard key={p.name} p={p} compact showAdLinks={showAdLinks} />
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}

/**
 * Mirror of the Apps-Script-side `SEVERITY_RANK` (`Code.js#L3417`):
 *   severe → 3, warn → 2, info → 1, clear → 0.
 * Used to recompute `maxSeverity` after merging hub-side CRM alerts
 * into a project's signal list so the morning page's chip counts +
 * card colors reflect the merged severity, not just the original
 * Apps-Script-computed value.
 */
function maxSeverityFromSignals(signals: MorningSignal[]): number {
  let m = 0;
  for (const s of signals) {
    const r = severityRank(s.severity);
    if (r > m) m = r;
  }
  return m;
}
function severityRank(s: MorningSeverity): number {
  if (s === "severe") return 3;
  if (s === "warn") return 2;
  if (s === "info") return 1;
  return 0;
}

function buildHref(scope: string, severity: string) {
  const params = new URLSearchParams();
  if (scope === "all") params.set("scope", "all");
  if (severity) params.set("severity", severity);
  const q = params.toString();
  return `/morning${q ? `?${q}` : ""}`;
}

function ScopeToggle({ scope }: { scope: string }) {
  const other = scope === "all" ? "mine" : "all";
  const label = scope === "all" ? "הצג רק את שלי" : "הצג את כולם";
  const href = other === "all" ? "/morning?scope=all" : "/morning";
  return (
    <Link href={href} className="morning-scope-toggle">
      {label}
    </Link>
  );
}

function SeverityChip({
  label,
  count,
  active,
  href,
  tone,
}: {
  label: string;
  count: number;
  active: boolean;
  href: string;
  tone?: "severe" | "warn" | "clear";
}) {
  const cls = [
    "morning-severity-chip",
    tone ? `tone-${tone}` : "",
    active ? "is-active" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Link href={href} className={cls}>
      {label} <span className="chip-count">{count}</span>
    </Link>
  );
}

function ProjectCard({
  p,
  compact,
  showAdLinks,
}: {
  p: MorningProject;
  compact?: boolean;
  /** Show Facebook Ads / Google Ads deep-link buttons. Gated to Media
   *  role + Felix only — see lib/adLinkAccess.ts. */
  showAdLinks?: boolean;
}) {
  const sevClass =
    p.maxSeverity === 3
      ? "is-severe"
      : p.maxSeverity === 2
        ? "is-warn"
        : p.maxSeverity === 1
          ? "is-info"
          : "is-clear";

  return (
    <li className={`morning-card ${sevClass}`}>
      <div className="morning-card-head">
        <div className="morning-card-title">
          <Link href={`/projects/${encodeURIComponent(p.name)}`}>
            {p.name}
          </Link>
          {p.company && (
            <span className="morning-card-company">({p.company})</span>
          )}
        </div>
        <div className="morning-card-meta">
          <BudgetBar budget={p.budget} spend={p.spend} />
          <TimeBar
            daysTotal={p.daysTotal}
            daysElapsed={p.daysElapsed}
            daysRemaining={p.daysRemaining}
            endIso={p.endIso}
          />
        </div>
        <div className="morning-card-links">
          <Link
            href={`/projects/${encodeURIComponent(p.name)}`}
            className="morning-link morning-link-hub"
            title="פתח את עמוד הפרויקט בהאב"
          >
            🏢 פרויקט
          </Link>
          {p.sheetTabUrl && (
            <a
              href={p.sheetTabUrl}
              target="_blank"
              rel="noreferrer"
              className="morning-link morning-link-sheet"
              title="פתח את גיליון הפרויקט"
            >
              📊 גיליון
            </a>
          )}
          {showAdLinks && p.gAdsUrl && (
            <a
              href={p.gAdsUrl}
              target="_blank"
              rel="noreferrer"
              className="morning-link morning-link-google"
              title="פתח את החשבון ב־Google Ads"
            >
              <GoogleAdsIcon size="1em" /> Google Ads
            </a>
          )}
          {showAdLinks && p.fbAdsUrl && (
            <a
              href={p.fbAdsUrl}
              target="_blank"
              rel="noreferrer"
              className="morning-link morning-link-fb"
              title="פתח את החשבון ב־Facebook Ads"
            >
              <FacebookAdsIcon size="1em" /> Facebook Ads
            </a>
          )}
        </div>
      </div>

      {!compact && p.signals.length > 0 && (
        <ul className="morning-signal-list">
          {p.signals.map((s, i) => (
            <MorningSignalRow key={i} signal={s} projectName={p.name} />
          ))}
        </ul>
      )}
    </li>
  );
}

function BudgetBar({ budget, spend }: { budget: number; spend: number }) {
  if (!budget) return null;
  const pct = Math.min(1.2, spend / budget);
  const over = pct > 1;
  return (
    <div
      className="morning-bar"
      title={`₪${Math.round(spend).toLocaleString()} / ₪${Math.round(budget).toLocaleString()}`}
    >
      <span className="morning-bar-label">תקציב</span>
      <span className="morning-bar-track">
        <span
          className={`morning-bar-fill ${over ? "is-over" : ""}`}
          style={{ width: `${Math.round(Math.min(100, pct * 100))}%` }}
        />
      </span>
      <span className="morning-bar-val">{Math.round(pct * 100)}%</span>
    </div>
  );
}

function TimeBar({
  daysTotal,
  daysElapsed,
  daysRemaining,
  endIso,
}: {
  daysTotal: number;
  daysElapsed: number;
  daysRemaining: number;
  endIso: string;
}) {
  if (!daysTotal) return null;
  const pct = Math.min(1.2, daysElapsed / daysTotal);
  return (
    <div
      className="morning-bar"
      title={`יום ${daysElapsed} מתוך ${daysTotal} · מסתיים ${endIso}`}
    >
      <span className="morning-bar-label">זמן</span>
      <span className="morning-bar-track">
        <span
          className="morning-bar-fill"
          style={{ width: `${Math.round(Math.min(100, pct * 100))}%` }}
        />
      </span>
      <span className="morning-bar-val">
        {daysRemaining > 0 ? `עוד ${daysRemaining} י׳` : "נגמר"}
      </span>
    </div>
  );
}

