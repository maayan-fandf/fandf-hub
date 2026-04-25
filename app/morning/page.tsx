import Link from "next/link";
import {
  currentUserEmail,
  getMorningFeed,
  getMyProjects,
  type MorningFeed,
  type MorningProject,
} from "@/lib/appsScript";
import { getUserPrefs } from "@/lib/userPrefs";
import { scopedProjectNames } from "@/lib/scope";
import { getScopedPerson } from "@/lib/scope-server";
import MorningSignalRow from "@/components/MorningSignalRow";

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
  const prefs = me ? await getUserPrefs(me).catch(() => null) : null;
  const viewAs = prefs?.view_as_email || "";
  const overrideEmail = viewAs && viewAs !== me ? viewAs : undefined;

  const [feedRes, projectsRes] = await Promise.allSettled([
    getMorningFeed({ scope, overrideEmail }),
    scopedPerson || overrideEmail
      ? getMyProjects(overrideEmail)
      : Promise.resolve(null),
  ]);
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

  const allProjects = data?.projects ?? [];
  // Narrow to projects where the scoped person is on the roster. Null set
  // = stale cookie (person no longer on any project), fall back to full
  // feed so the page doesn't go empty — same pattern as app/layout.tsx.
  const scopedSet = projectsData
    ? scopedProjectNames(projectsData.projects, scopedPerson)
    : null;
  const projects = scopedSet
    ? allProjects.filter((p) => scopedSet.has(p.name))
    : allProjects;

  // Recompute severity counts against the scoped set so the chip counts
  // (above the severity filter bar) match what will actually render.
  const counts = scopedSet
    ? {
        total: projects.length,
        severe: projects.filter((p) => p.maxSeverity === 3).length,
        warn: projects.filter((p) => p.maxSeverity === 2).length,
        clear: projects.filter((p) => p.maxSeverity === 0).length,
      }
    : data?.counts ?? { total: 0, severe: 0, warn: 0, clear: 0 };

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
              ☀️
            </span>
            בוקר
          </h1>
          {data && (
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

      {error && (
        <div className="error">
          <strong>שגיאה בטעינת המידע.</strong>
          <br />
          {error}
        </div>
      )}

      {data && (
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

      {data && (data.isAdmin || data.isInternal) && visible.length === 0 && (
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

      {alertProjects.length > 0 && (
        <ul className="morning-list">
          {alertProjects.map((p) => (
            <ProjectCard key={p.name} p={p} />
          ))}
        </ul>
      )}

      {clearProjects.length > 0 && severityFilter !== "clear" && (
        <details className="morning-clear">
          <summary>
            ✅ {clearProjects.length} פרויקטים ללא התראות (לחץ להצגה)
          </summary>
          <ul className="morning-list morning-list-compact">
            {clearProjects.map((p) => (
              <ProjectCard key={p.name} p={p} compact />
            ))}
          </ul>
        </details>
      )}
    </main>
  );
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
}: {
  p: MorningProject;
  compact?: boolean;
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
          {p.gAdsUrl && (
            <a
              href={p.gAdsUrl}
              target="_blank"
              rel="noreferrer"
              className="morning-link morning-link-google"
              title="פתח את החשבון ב־Google Ads"
            >
              🔍 Google Ads
            </a>
          )}
          {p.fbAdsUrl && (
            <a
              href={p.fbAdsUrl}
              target="_blank"
              rel="noreferrer"
              className="morning-link morning-link-fb"
              title="פתח את החשבון ב־Facebook Ads"
            >
              📘 Facebook Ads
            </a>
          )}
        </div>
      </div>

      {!compact && p.signals.length > 0 && (
        <ul className="morning-signal-list">
          {p.signals.map((s, i) => (
            <MorningSignalRow key={i} signal={s} />
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

