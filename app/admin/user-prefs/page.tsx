import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getMyProjects,
  tasksPeopleList,
  currentUserEmail,
  type TasksPerson,
} from "@/lib/appsScript";
import {
  getUserPrefs,
  listAllUserPrefs,
  getDefaultUserPrefs,
  type UserPrefs,
} from "@/lib/userPrefs";
import UserPrefsAdminEditor from "@/components/UserPrefsAdminEditor";

export const dynamic = "force-dynamic";

export type UserPrefRow = {
  email: string;
  name: string;
  role: string;
  prefs: UserPrefs;
  /** True when the row is built from defaults — the user has never
   *  written prefs and there's no actual sheet row yet. The first
   *  edit creates one. */
  isDefault: boolean;
  /** Empty when isDefault. */
  updatedAt: string;
};

export default async function UserPrefsAdminPage() {
  // Server-side admin gate.
  let me;
  try {
    me = await getMyProjects();
  } catch {
    me = null;
  }
  if (!me?.isAdmin) redirect("/");

  const adminEmail = await currentUserEmail();

  // Pull everything in parallel so the page renders in one round-trip.
  const [myPrefs, allPrefsList, peopleRes] = await Promise.all([
    getUserPrefs(adminEmail).catch(() => getDefaultUserPrefs()),
    listAllUserPrefs(adminEmail).catch(() => []),
    tasksPeopleList().catch(() => ({ ok: false, people: [] as TasksPerson[] })),
  ]);

  const people = (peopleRes.ok ? peopleRes.people : []) as TasksPerson[];
  // Build the admin table. One row per person from names-to-emails;
  // merge in the actual prefs row if one exists, else mark default.
  const prefsByEmail = new Map<string, { prefs: UserPrefs; updatedAt: string }>();
  for (const p of allPrefsList) {
    prefsByEmail.set(p.email.toLowerCase().trim(), {
      prefs: p.prefs,
      updatedAt: p.updatedAt,
    });
  }
  const seen = new Set<string>();
  const rows: UserPrefRow[] = [];
  for (const p of people) {
    const lc = p.email.toLowerCase().trim();
    if (!lc || seen.has(lc)) continue;
    seen.add(lc);
    const found = prefsByEmail.get(lc);
    rows.push({
      email: lc,
      name: p.name || lc.split("@")[0],
      role: p.role || "",
      prefs: found ? found.prefs : getDefaultUserPrefs(),
      isDefault: !found,
      updatedAt: found?.updatedAt || "",
    });
  }
  // Append any prefs rows that exist for emails NOT in names-to-emails
  // (e.g. an old admin who isn't in the people list — still shouldn't
  // be invisible to the admin view).
  for (const p of allPrefsList) {
    const lc = p.email.toLowerCase().trim();
    if (seen.has(lc)) continue;
    seen.add(lc);
    rows.push({
      email: lc,
      name: lc.split("@")[0],
      role: "(לא במיפוי שמות)",
      prefs: p.prefs,
      isDefault: false,
      updatedAt: p.updatedAt,
    });
  }

  // Sort: name (he), with the admin's own row pinned to the top.
  const collator = new Intl.Collator("he");
  rows.sort((a, b) => {
    if (a.email === adminEmail.toLowerCase()) return -1;
    if (b.email === adminEmail.toLowerCase()) return 1;
    return collator.compare(a.name, b.name);
  });

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>👥</span>
            העדפות משתמשים
          </h1>
          <div className="subtitle">
            <Link href="/admin">→ ניהול</Link> · ניהול ההעדפות של כל משתמשי
            ההאב — התראות במייל, סנכרון Google Tasks, &quot;הצג כ&quot; ועוד.
            השינוי בטופס נשמר מיד ל-&quot;User Preferences&quot; ב-Comments
            spreadsheet, וכל קריאה רעננה מהגיליון תופיע מיד כאן.
          </div>
        </div>
      </header>

      <UserPrefsAdminEditor
        myEmail={adminEmail.toLowerCase()}
        myPrefs={myPrefs}
        rows={rows}
      />
    </main>
  );
}
