import Link from "next/link";
import { redirect } from "next/navigation";
import { getMyProjects, currentUserEmail } from "@/lib/appsScript";
import { getTaskFormSchema } from "@/lib/taskFormSchema";
import { readPricingSetup } from "@/lib/pricing";

export const metadata = { title: "תמחורים" };
import PricingEditor from "@/components/PricingEditor";

export const dynamic = "force-dynamic";

/**
 * Admin editor for the per-company/project rate card (Pricingsetup
 * tab). Replaces raw-Sheets editing. Same per-client model + the
 * project→company fallback the new-task pricing panel resolves
 * against — this page only changes WHERE the rates are managed.
 *
 * Company/project options come from Keys (getMyProjects, admin sees
 * all); department + kind options come from TaskFormSchema — the same
 * vocabulary the new-task form + lib/pricingMatch compare on, so
 * admin-entered values always line up with what gets resolved.
 */
export default async function PricingAdminPage() {
  let me: Awaited<ReturnType<typeof getMyProjects>> | null = null;
  try {
    me = await getMyProjects();
  } catch {
    me = null;
  }
  if (!me?.isAdmin) redirect("/");

  const adminEmail = await currentUserEmail();
  const [rows, schema] = await Promise.all([
    readPricingSetup(adminEmail).catch(() => []),
    getTaskFormSchema(adminEmail).catch(() => null),
  ]);

  const projectsByCompany: Record<string, string[]> = {};
  const companySet = new Set<string>();
  for (const p of me.projects) {
    const c = (p.company || "").trim();
    if (!c) continue;
    companySet.add(c);
    (projectsByCompany[c] ||= []).push(p.name);
  }
  for (const c of Object.keys(projectsByCompany)) {
    projectsByCompany[c].sort((a, b) => a.localeCompare(b, "he"));
  }
  const companies = [...companySet].sort((a, b) => a.localeCompare(b, "he"));

  const departmentOptions =
    schema && !schema.isEmpty ? [...schema.departments].sort() : [];
  const kindOptions =
    schema && !schema.isEmpty ? [...schema.allKinds].sort() : [];

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>💰</span>
            תמחור
          </h1>
          <div className="subtitle">
            <Link href="/admin">→ ניהול</Link> ·{" "}
            <Link href="/admin/task-form-schema">סכמת טופס משימה</Link> ·{" "}
            <Link href="/admin/billing">🧾 חיובים ללקוח</Link> ·
            מחירון לפי חברה/פרוייקט × מחלקה × סוג. הערכים מוזנים בטופס
            ״משימה חדשה״ (פרוייקט-ספציפי, אחרת לפי חברה), ונשמרים על
            המשימה ובלשונית <code>PricingLog</code>.
          </div>
        </div>
      </header>

      <PricingEditor
        initialRows={rows}
        companies={companies}
        projectsByCompany={projectsByCompany}
        departmentOptions={departmentOptions}
        kindOptions={kindOptions}
      />
    </main>
  );
}
