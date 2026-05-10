import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { auth } from "@/auth";
import { signOutAction } from "@/lib/signOutAction";
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
import TopnavUserMenu from "@/components/TopnavUserMenu";
import ActiveLink from "@/components/ActiveLink";
import ThemeToggle from "@/components/ThemeToggle";
import TopProgressBar from "@/components/TopProgressBar";
import AgendaPanel from "@/components/AgendaPanel";
import LightboxProvider from "@/components/LightboxProvider";
import TaskPreviewProvider from "@/components/TaskPreviewProvider";
import { PageContextProvider } from "@/components/PageContextProvider";
import GeminiChatDrawer from "@/components/GeminiChatDrawer";
import {
  getMyProjects,
  tasksPeopleList,
  type Project,
} from "@/lib/appsScript";
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

/**
 * Viewport meta tag. `viewportFit: "cover"` is what unlocks the
 * `env(safe-area-inset-bottom)` value on iOS Safari — without it, the
 * browser pretends there's no home indicator, and our FAB CSS that
 * accounts for it (.quick-task-fab, .gemini-fab) has nothing to add.
 * width=device-width + initial-scale=1 are the same defaults Next.js
 * uses when no viewport export is present, kept explicit for clarity.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
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
  // Hebrew display name + role for the topnav user-pill. Resolved from
  // the names_to_emails sheet — empty strings fall back to email-prefix
  // shortname inside TopnavUserMenu, so the pill always renders.
  let myHeName = "";
  let myRole = "";
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
    // One extra Sheets read to get the Hebrew name + role for the
    // topnav user pill. Best-effort: failures silently fall back to
    // the email-prefix label (still renders, just without the role
    // emoji or Hebrew name). Keyed off `email` (not viewAs) so the
    // pill shows YOU even when you're acting as someone else — the
    // ViewAsBanner already covers the "you're impersonating X" cue.
    try {
      const peopleRes = await tasksPeopleList();
      const me = peopleRes.people.find(
        (p) => (p.email || "").toLowerCase() === email.toLowerCase(),
      );
      myHeName = me?.he_name || me?.name || "";
      myRole = me?.role || "";
    } catch {
      // Silent — empty name/role is the rendering fallback.
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
    <html
      lang="he"
      dir="rtl"
      // SSR defaults for the home filter bar: hide-ended ON, show-mine
      // ON. HomeFilterBar's useEffect overrides these from
      // localStorage on mount; the SSR values keep the filter applied
      // on first paint instead of flashing the unfiltered grid for a
      // beat. Other pages don't render rows with [data-mine] /
      // [data-ended] so the attributes are inert there.
      data-hide-ended="1"
      data-show-mine="1"
    >
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
            {/* DOM order = visual right-to-left order under dir="rtl" with
                the default flex-direction: row. The list below reads
                right-to-left as the user sees it on screen:
                פרויקטים → משימות → קמפיינים → התראות → תיוגים →
                לקוחות → מ-Google Tasks → דשבורד.
                NavInboxLink (תיוגים) self-hides when its count is 0,
                so it appears only when there's something to triage. */}
            {email ? (
              <ProjectsNavMenu projects={navProjects} />
            ) : (
              <Link href="/" className="topnav-link">
                📂 פרויקטים
              </Link>
            )}
            {email && !isClientUser && (
              <ActiveLink
                href="/tasks"
                className="topnav-link topnav-link-with-badge"
              >
                📋 משימות
                <NavTasksBadge />
              </ActiveLink>
            )}
            {email && !isClientUser && <NavCampaignsLink />}
            {email && !isClientUser && (
              <ActiveLink
                href="/notifications"
                className="topnav-link topnav-link-with-badge"
              >
                🔔 התראות
                <NavBellBadge />
              </ActiveLink>
            )}
            {email && <NavInboxLink isClientUser={isClientUser} />}
            {email && !isClientUser && <NavCustomerEmails />}
            {email && !isClientUser && <NavGmailTasks />}
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
                <TopnavUserMenu
                  email={email}
                  heName={myHeName}
                  role={myRole}
                  signOutAction={signOutAction}
                />
              </div>
            )}
          </div>
        </nav>
        {email && (
          <ViewAsBanner serverViewAs={viewAs} myEmail={email} />
        )}
        {/* Wrap children + the agenda right-rail in a grid so the
            sidebar stays sticky next to the page content. The grid
            collapses to a single column on narrow screens via the
            `.app-shell-with-agenda` rules in globals.css. The panel
            renders as a no-op for unauthenticated visitors (signin
            page etc.) — AgendaPanel itself returns null when
            userEmail is empty. */}
        {/* LightboxProvider mounts a single shared image-viewer
            overlay used by chat-attachment image clicks across the
            hub. Wraps the whole app shell so any deeply-nested
            consumer can call `useLightbox().open(src, alt, viewUrl)`
            without prop-drilling. */}
        <LightboxProvider>
          <TaskPreviewProvider>
            <PageContextProvider>
              <div className="app-shell-with-agenda">
                <div className="app-shell-main">{children}</div>
                {email && !isClientUser && (
                  <Suspense fallback={null}>
                    <AgendaPanel userEmail={email} />
                  </Suspense>
                )}
              </div>
              {/* Gemini chat assistant — staff-only. Hidden in the UI
                  for client users + the route handler enforces the
                  same gate server-side. Lives at the layout root so
                  the FAB + drawer overlay every page consistently. */}
              {email && !isClientUser && <GeminiChatDrawer />}
            </PageContextProvider>
          </TaskPreviewProvider>
        </LightboxProvider>
        {/* Global overlays — mounted once, listen for their own key combos. */}
        {email && <CommandPalette />}
        {email && !isClientUser && <QuickNoteModal />}
        {email && !isClientUser && <QuickTaskFAB />}
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
