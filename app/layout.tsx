import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { cookies } from "next/headers";
import { auth, signOut } from "@/auth";
import CommandPalette from "@/components/CommandPalette";
import KeyboardHelp from "@/components/KeyboardHelp";
import NavMentionBadge from "@/components/NavMentionBadge";
import NavAdminLink from "@/components/NavAdminLink";
import NavMorningLink from "@/components/NavMorningLink";
import NavTasksBadge from "@/components/NavTasksBadge";
import ProjectsNavMenu from "@/components/ProjectsNavMenu";
import UserSettingsMenu from "@/components/UserSettingsMenu";
import ActiveLink from "@/components/ActiveLink";
import ThemeToggle from "@/components/ThemeToggle";
import TopProgressBar from "@/components/TopProgressBar";
import { getMyProjects, type Project } from "@/lib/appsScript";
import { isPersonOnProject, SCOPE_PERSON_COOKIE } from "@/lib/scope";

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
  // instantly. Next dedupes the `myProjects` call with the one /page.tsx
  // makes, so this is free when landing on the home page.
  let navProjects: Project[] = [];
  if (email) {
    try {
      const data = await getMyProjects();
      navProjects = data.projects;
    } catch {
      navProjects = [];
    }
  }

  // Respect the cross-hub person scope — set by the home-page filter via
  // a cookie (see HomeFilterBar.writeScopeCookie). When present, narrow
  // the nav's projects dropdown to projects where that person is on the
  // roster; otherwise the nav would show all 37 while the home grid shows
  // only the user's 23, which is what the user called out as a bug. Empty
  // cookie = "show all" (same as ?person=__all__).
  try {
    const cookieStore = await cookies();
    const scopedPerson = decodeURIComponent(
      cookieStore.get(SCOPE_PERSON_COOKIE)?.value ?? "",
    ).trim();
    if (scopedPerson) {
      const filtered = navProjects.filter((p) =>
        isPersonOnProject(p, scopedPerson),
      );
      // Guard against stale cookie (person no longer on any project) — fall
      // back to the full list so the dropdown never goes empty.
      if (filtered.length > 0) navProjects = filtered;
    }
  } catch {
    /* malformed cookie or decode error — ignore and show full list */
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
            {email && <NavMorningLink />}
            {email && (
              <ActiveLink
                href="/tasks"
                className="topnav-link topnav-link-with-badge"
              >
                📋 משימות
                <NavTasksBadge />
              </ActiveLink>
            )}
            <ActiveLink
              href="/inbox"
              className="topnav-link topnav-link-with-badge"
            >
              🏷️ תיוגים
              {email && <NavMentionBadge />}
            </ActiveLink>
            {email && <NavAdminLink />}
            {dashboardUrl && (
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
                <UserSettingsMenu myEmail={email} />
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
        {children}
        {/* Global overlays — mounted once, listen for their own key combos. */}
        {email && <CommandPalette />}
        <KeyboardHelp />
      </body>
    </html>
  );
}
