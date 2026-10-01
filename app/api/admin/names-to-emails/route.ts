import { NextRequest, NextResponse } from "next/server";
import {
  adminListNamesToEmails,
  adminUpsertNameToEmail,
  adminDeleteNameToEmail,
  currentUserEmail,
} from "@/lib/appsScript";
import { HUB_ADMIN_EMAILS } from "@/lib/tasksDirect";

/**
 * Admin CRUD for the `names to emails` sheet.
 *   GET    → list rows
 *   POST   → upsert (body: { fullName, email, role?, heName? })
 *   DELETE → remove  (body: { fullName })
 *
 * Auth is enforced by the Apps Script side (_requireHubAdmin_). Non-admins
 * get a 500 with "Admin only — …" which we surface verbatim.
 *
 * The hub checks too, first: this was the one admin route with no check
 * of its own, so its whole gate lived in another codebase's deployment.
 * HUB_ADMIN_EMAILS is the same list as the script's CONFIG.ADMIN_EMAILS.
 */
async function refuseNonAdmin(): Promise<NextResponse | null> {
  const email = (await currentUserEmail().catch(() => "")).toLowerCase().trim();
  if (!email) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (!HUB_ADMIN_EMAILS.has(email)) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }
  return null;
}

export async function GET() {
  const refused = await refuseNonAdmin();
  if (refused) return refused;
  try {
    const data = await adminListNamesToEmails();
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.toLowerCase().includes("admin only") ? 403 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function POST(req: NextRequest) {
  const refused = await refuseNonAdmin();
  if (refused) return refused;
  let body: {
    fullName?: string;
    email?: string;
    role?: string;
    heName?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { fullName, email, role, heName } = body;
  if (!fullName || !email) {
    return NextResponse.json(
      { error: "fullName and email required" },
      { status: 400 },
    );
  }
  try {
    // `heName` stays tri-state on the way through: absent means "don't
    // touch the cell", `""` means "clear it". Normalising to "" here
    // would make every legacy caller wipe the Hebrew name.
    const result = await adminUpsertNameToEmail({
      fullName,
      email,
      role,
      ...(heName === undefined ? {} : { heName: String(heName) }),
    });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.toLowerCase().includes("admin only") ? 403 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function DELETE(req: NextRequest) {
  const refused = await refuseNonAdmin();
  if (refused) return refused;
  let body: { fullName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { fullName } = body;
  if (!fullName) {
    return NextResponse.json({ error: "fullName required" }, { status: 400 });
  }
  try {
    const result = await adminDeleteNameToEmail(fullName);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.toLowerCase().includes("admin only") ? 403 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
