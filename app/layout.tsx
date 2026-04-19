import type { Metadata } from "next";
import Link from "next/link";
import { auth, signOut } from "@/auth";
import CommandPalette from "@/components/CommandPalette";
import KeyboardHelp from "@/components/KeyboardHelp";
import NavMentionBadge from "@/components/NavMentionBadge";
import NavAdminLink from "@/components/NavAdminLink";
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
      <body>
        <nav className="topnav">
          <div className="topnav-inner">
            <Link href="/" className="topnav-brand">
              ✨ Hub
            </Link>
            <Link href="/" className="topnav-link">
              📂 פרויקטים
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
