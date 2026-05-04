import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { auth, signOut } from "@/auth";
import CommandPalette from "@/components/CommandPalette";
import ExternalNavListener from "@/components/ExternalNavListener";
import KeyboardHelp from "@/components/KeyboardHelp";
import QuickNoteModal from "@/components/QuickNoteModal";
import QuickTaskFAB from "@/components/QuickTaskFAB";
import NavBellBadge from "@/components/NavBellBadge";
import NavGmailTasks from "@/components/NavGmailTasks";
import NavCustomerEmails from "@/components/NavCustomerEmails";
import NavCampaignsLink from "@/components/NavCampaignsLink";
import NavInboxLink from "@/components/NavInboxLink";
import ViewAsBanner from "@/components/ViewAsBanner";
import { getEffectiveViewAs } from "@/lib/viewAsCookie";
import NavTasksBadge from "@/components/NavTasksBadge";
import ProjectsNavMenu from "@/components/ProjectsNavMenu";
import UserSettingsMenu from "@/components/UserSettingsMenu";
import ActiveLink from "@/components/ActiveLink";
import ThemeToggle from "@/components/ThemeToggle";
import TopProgressBar from "@/components/TopProgressBar";
import { getMyProjects, type Project } from "@/lib/appsScript";
import { scopeProjectsToPerson } from "@/lib/scope";

// Runs before React hydrates so data-theme is set before the first paint —
// avoids the "flash of wrong theme" when a user has picked dark/light but
// the page renders in light first then flips.
const THEME_INIT_SCRIPT = `
(function () {
  try {
    var k = 'hub-theme';
    var t = localStorage.getItem(k) || 'auto';
    var effective;
    if (t === 'dark') effective = 'dark';
    else if (t === 'light') effective = 'light';
    else effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = effective;
  } catch (e) {}
})();
`;
import "./globals.css";

export const metadata: Metadata = {
  title: "Hub",
  description: "Client & project hub",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const email = session?.user?.email ?? null;

  // Prefetch the user's projects server-side so the nav dropdown opens
  // instantly. Honors the gear-menu "view as" pref so the top-nav projects
  // list mirrors the home grid + /tasks default filter — single source of
  // truth for "who am I acting as". Next dedupes the `myProjects` call with
  // the one /page.tsx makes, so this is free when landing on the home page.
  let navProjects: Project[] = [];
  // True only for col-E-only users (clients). Drives whether the
  // `📋 משימות` top-nav link renders — clients don't see the task
  // surface at all.
  let isClientUser = false;
  // Drives the admin section inside the gear menu (inline ניהול).
  let isAdminUser = false;
  let viewAs = "";
  if (email) {
    viewAs = await getEffectiveViewAs(email).catch(() => "");
    try {
      const data = await getMyProjects(viewAs || undefined);
      // Mirror the home grid: narrow @fandf.co.il staff's blanket access
      // list to projects where this person is actually on the roster, so
      // the nav dropdown is a personal view rather than dumping all 37
      // internal projects on every staff member.
      navProjects = scopeProjectsToPerson(data.projects, data.person, data.isClient);
      isClientUser =
        !!data.isClient && !data.isAdmin && !data.isStaff && !data.isInternal;
      isAdminUser = !!data.isAdmin;
    } catch {
      navProjects = [];
    }
  }

  const dashboardBase = process.env.DASHBOARD_URL ?? "";
  // Append ?authuser=<user-email> so multi-account browsers land in the right
  // Google slot instead of Apps Script's default "last used" account. Preserves
  // any existing query string if DASHBOARD_URL happens to carry one.
  const dashboardUrl =
    dashboardBase && email
      ? dashboardBase +
        (dashboardBase.includes("?") ? "&" : "?") +
        "authuser=" +
        encodeURIComponent(email)
      : dashboardBase;

  return (
    <html lang="he" dir="rtl">
      <head>
        <script
          // Safe: string is static, no user input interpolated.
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
      </head>
      <body>
        {/* Suspense boundary required by Next.js 15 for any client component
            that reads useSearchParams (TopProgressBar uses it to detect
            navigation completion on ?-param changes). */}
        <Suspense fallback={null}>
          <TopProgressBar />
        </Suspense>
        <nav className="topnav">
          <div className="topnav-inner">
            <Link href="/" className="topnav-brand">
              ✨ Hub
            </Link>
            {email ? (
              <ProjectsNavMenu projects={navProjects} />
            ) : (
              <Link href="/" className="topnav-link">
                📂 פרויקטים
              </Link>
            )}
            {email && !isClientUser && <NavCampaignsLink />}
            {email && !isClientUser && (
              <ActiveLink
                href="/tasks"
                className="topnav-link topnav-link-with-badge"
              >
                📋 משימות
                <NavTasksBadge />
              </ActiveLink>
            )}
            {email && <NavInboxLink isClientUser={isClientUser} />}
            {email && !isClientUser && (
              <ActiveLink
                href="/notifications"
                className="topnav-link topnav-link-with-badge"
              >
                🔔 התראות
                <NavBellBadge />
              </ActiveLink>
            )}
            {email && !isClientUser && <NavGmailTasks />}
            {email && !isClientUser && <NavCustomerEmails />}
            {dashboardUrl && !isClientUser && (
              <a
                href={dashboardUrl}
                target="_blank"
                rel="noreferrer"
                className="topnav-link topnav-external"
              >
                🔗 דשבורד
              </a>
            )}
            {email && (
              <div className="topnav-user">
                <UserSettingsMenu myEmail={email} isAdmin={isAdminUser} />
                <ThemeToggle />
                <span
                  className="topnav-hint"
                  title="לחץ ⌘K או Ctrl+K לפתיחת חיפוש"
                >
                  ⌘K
                </span>
                <span className="topnav-email" title={email} dir="ltr">
                  {email}
                </span>
                <form
                  action={async () => {
                    "use server";
                    await signOut({ redirectTo: "/signin" });
                  }}
                >
                  <button type="submit" className="topnav-signout">
                    יציאה
                  </button>
                </form>
              </div>
            )}
          </div>
        </nav>
        {email && (
          <ViewAsBanner serverViewAs={viewAs} myEmail={email} />
        )}
        {children}
        {/* Global overlays — mounted once, listen for their own key combos. */}
        {email && <CommandPalette />}
        {email && !isClientUser && <QuickNoteModal />}
        {email && !isClientUser && (
          <QuickTaskFAB
            projects={navProjects.map((p) => ({
              name: p.name,
              company: p.company,
            }))}
          />
        )}
        <KeyboardHelp />
        {/* Listens for postMessage from nested iframes asking the hub
            to navigate to a whitelisted external URL. The dashboard's
            ads / pacing links use this to escape Apps Script's
            sandboxed iframe — see components/ExternalNavListener.tsx. */}
        <ExternalNavListener />
      </body>
    </html>
  );
}
