import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getMyProjects,
  currentUserEmail,
} from "@/lib/appsScript";
import { listChainTemplates } from "@/lib/chainTemplatesStore";
import { CHAIN_TEMPLATES } from "@/lib/chainTemplates";
import { getTaskFormSchema } from "@/lib/taskFormSchema";
import ChainTemplatesEditor from "@/components/ChainTemplatesEditor";

export const dynamic = "force-dynamic";

/**
 * Admin page for managing the sheet-backed chain templates store
 * (`ChainTemplates` tab on SHEET_ID_COMMENTS). Renders the editor
 * with the current templates pre-loaded; when the sheet is empty
 * (first-run / fresh install), seeds the editor with the hardcoded
 * defaults so admins have something to start from.
 *
 * Phase 10 of dependencies feature, 2026-05-03.
 */
export default async function ChainTemplatesAdminPage() {
  let isAdmin = false;
  try {
    const me = await getMyProjects();
    isAdmin = me.isAdmin;
  } catch {
    isAdmin = false;
  }
  if (!isAdmin) redirect("/");

  const adminEmail = await currentUserEmail();
  const [stored, schema] = await Promise.all([
    listChainTemplates(adminEmail).catch(() => []),
    // Source the department dropdown options from TaskFormSchema's
    // `מחלקה` column — same authoritative list that drives the
    // standard create-task department picker. Per-step assignee
    // filtering matches step.department against names-to-emails
    // role values, so admins should keep TaskFormSchema departments
    // aligned with the role values used there.
    getTaskFormSchema(adminEmail).catch(() => null),
  ]);

  // First-run convenience: when the sheet hasn't been initialized yet,
  // hand the editor the hardcoded defaults so admins can save them
  // (writes the initial rows + the tab) instead of having to hand-type
  // every template. The editor distinguishes "loaded from sheet" from
  // "seed pre-fill" via the `seeded` prop so the UI can label this
  // clearly.
  const seeded = stored.length === 0;
  const templates = seeded ? CHAIN_TEMPLATES : stored;

  // Department options from TaskFormSchema (the same source the
  // standard create-task form uses). Falls back to an empty list
  // when the schema sheet isn't accessible — admin can still edit
  // templates manually via the input, just without dropdown
  // assistance.
  const departmentOptions =
    schema && !schema.isEmpty
      ? [...schema.departments].sort()
      : [];

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>📦</span>
            תבניות שרשרת
          </h1>
          <div className="subtitle">
            <Link href="/admin">→ ניהול</Link> · תבניות מוכנות עבור טופס
            יצירת השרשרת. כל תבנית כוללת כותרת ברירת מחדל לעטיפה
            וסדרת שלבים. לכל שלב אפשר להגדיר מחלקה — ה־autocomplete
            של המבצע יסונן רק לאנשים מהמחלקה הזו.
            {seeded && (
              <>
                {" "}· <b>שמור פעם אחת כדי לאתחל את הלשונית
                <code>ChainTemplates</code> בגיליון</b>.
              </>
            )}
          </div>
        </div>
      </header>

      <ChainTemplatesEditor
        initialTemplates={templates}
        departmentOptions={departmentOptions}
        seeded={seeded}
      />
    </main>
  );
}
