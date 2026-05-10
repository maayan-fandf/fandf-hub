import { NextRequest, NextResponse } from "next/server";
import { getProjectAssignees, currentUserEmail } from "@/lib/appsScript";
import { tasksPeopleListDirect } from "@/lib/tasksDirect";

/**
 * Project members for the @-mention picker. Apps Script returns
 * email + English `name` + role — we enrich each row with the
 * Hebrew display name from the names_to_emails sheet (via the
 * hub-side tasksPeopleListDirect helper). UIs prefer he_name when
 * present so the picker reads "מעיין" instead of "maayan", matching
 * how the team addresses each other.
 *
 * Enrichment is a single SA-impersonated read against the names sheet
 * (~50ms warm) — cheap to do per-request without caching, since the
 * picker only fires this when the user actually opens the dropdown.
 * Missing he_name falls back to the English `name` server-side, so
 * client code can read `a.he_name || a.name` uniformly.
 */
export async function GET(req: NextRequest) {
  const project = req.nextUrl.searchParams.get("project");
  if (!project) {
    return NextResponse.json({ error: "project query param required" }, { status: 400 });
  }

  try {
    const result = await getProjectAssignees(project);
    // Build email → he_name map. tasksPeopleListDirect needs an
    // impersonated subject; the session user is fine for this read.
    let heByEmail = new Map<string, string>();
    try {
      const me = await currentUserEmail();
      if (me) {
        const peopleRes = await tasksPeopleListDirect(me);
        for (const p of peopleRes.people) {
          if (p.email && p.he_name) {
            heByEmail.set(p.email.toLowerCase().trim(), p.he_name);
          }
        }
      }
    } catch {
      // Best-effort: missing he_name just means UIs render the
      // English name. Don't fail the assignees fetch over it.
      heByEmail = new Map();
    }
    const enriched = {
      ...result,
      assignees: result.assignees.map((a) => {
        const he = heByEmail.get(a.email.toLowerCase().trim());
        return he ? { ...a, he_name: he } : a;
      }),
    };
    return NextResponse.json(enriched);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
