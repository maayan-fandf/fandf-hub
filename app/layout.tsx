import type { Metadata } from "next";
import Link from "next/link";
import { auth, signOut } from "@/auth";
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
    <html lang="en">
      <body>
        <nav className="topnav">
          <div className="topnav-inner">
            <Link href="/" className="topnav-brand">
              Hub
            </Link>
            <Link href="/" className="topnav-link">
              Projects
            </Link>
            <Link href="/inbox" className="topnav-link">
              Mentions
            </Link>
            {dashboardUrl && (
              <a
                href={dashboardUrl}
                target="_blank"
                rel="noreferrer"
                className="topnav-link topnav-external"
              >
                Dashboard ↗
              </a>
            )}
            {email && (
              <div className="topnav-user">
                <span className="topnav-email" title={email}>
                  {email}
                </span>
                <form
                  action={async () => {
                    "use server";
                    await signOut({ redirectTo: "/signin" });
                  }}
                >
                  <button type="submit" className="topnav-signout">
                    Sign out
                  </button>
                </form>
              </div>
            )}
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
