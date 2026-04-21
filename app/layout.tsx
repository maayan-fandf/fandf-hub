import type { Metadata } from "next";
import Link from "next/link";
import { auth, signOut } from "@/auth";
import CommandPalette from "@/components/CommandPalette";
import KeyboardHelp from "@/components/KeyboardHelp";
import NavMentionBadge from "@/components/NavMentionBadge";
import NavAdminLink from "@/components/NavAdminLink";
import ThemeToggle from "@/components/ThemeToggle";

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
  const dashboardUrl = process.env.DASHBOARD_URL ?? "";

  return (
    <html lang="he" dir="rtl">
      <head>
        <script
          // Safe: string is static, no user input interpolated.
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
      </head>
      <body>
        <nav className="topnav">
          <div className="topnav-inner">
            <Link href="/" className="topnav-brand">
              ✨ Hub
            </Link>
            <Link href="/" className="topnav-link">
              📂 פרויקטים
            </Link>
            <Link href="/morning" className="topnav-link">
              ☀️ בוקר
            </Link>
            <Link href="/inbox" className="topnav-link topnav-link-with-badge">
              🏷️ תיוגים
              {email && <NavMentionBadge />}
            </Link>
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
