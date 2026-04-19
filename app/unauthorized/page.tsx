import { auth, signOut } from "@/auth";

export const dynamic = "force-dynamic";

export default async function UnauthorizedPage() {
  const session = await auth();
  const email = session?.user?.email;

  return (
    <main className="container signin-container">
      <div className="signin-card">
        <h1>No access yet</h1>
        <p>
          You&apos;re signed in as <strong>{email ?? "(unknown)"}</strong>, but
          that email isn&apos;t listed as an admin or a member of any project in
          the dashboard.
        </p>
        <p>
          Ask an admin to add you to the <code>Keys</code> tab (as
          &quot;EMAIL Manager&quot; or &quot;Email Client&quot;) or to
          <code>CONFIG.ADMIN_EMAILS</code>. Then reload this page.
        </p>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/signin" });
          }}
        >
          <button type="submit" className="btn-primary">
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
