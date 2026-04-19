import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getMyProjects,
  adminListNamesToEmails,
  type NameEmailRow,
} from "@/lib/appsScript";
import NamesToEmailsEditor from "@/components/NamesToEmailsEditor";

export const dynamic = "force-dynamic";

export default async function NamesToEmailsPage() {
  // Server-side admin gate. Same pattern as /admin.
  let isAdmin = false;
  try {
    const me = await getMyProjects();
    isAdmin = me.isAdmin;
  } catch {
    isAdmin = false;
  }
  if (!isAdmin) redirect("/");

  let initial: NameEmailRow[] = [];
  let loadError: string | null = null;
  try {
    const data = await adminListNamesToEmails();
    initial = data.rows;
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>שמות ואימיילים</h1>
          <div className="subtitle">
            <Link href="/admin">→ ניהול</Link> · מיפוי שם מלא לאימייל. זהו המקור
            לתיוגים (dropdown) ולהרשאות הצוות (מיפוי שמות בעמודות C, D, J, K
            של Keys).
          </div>
        </div>
      </header>

      {loadError && (
        <div className="error">
          <strong>שגיאה בטעינת הרשימה.</strong>
          <br />
          {loadError}
        </div>
      )}

      {!loadError && <NamesToEmailsEditor initial={initial} />}
    </main>
  );
}
