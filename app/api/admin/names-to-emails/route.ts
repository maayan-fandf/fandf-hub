import { NextRequest, NextResponse } from "next/server";
import {
  adminListNamesToEmails,
  adminUpsertNameToEmail,
  adminDeleteNameToEmail,
} from "@/lib/appsScript";

/**
 * Admin CRUD for the `names to emails` sheet.
 *   GET    → list rows
 *   POST   → upsert (body: { fullName, email })
 *   DELETE → remove  (body: { fullName })
 *
 * Auth is enforced by the Apps Script side (_requireHubAdmin_). Non-admins
 * get a 500 with "Admin only — …" which we surface verbatim.
 */
export async function GET() {
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
  let body: { fullName?: string; email?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { fullName, email, role } = body;
  if (!fullName || !email) {
    return NextResponse.json(
      { error: "fullName and email required" },
      { status: 400 },
    );
  }
  try {
    const result = await adminUpsertNameToEmail({ fullName, email, role });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.toLowerCase().includes("admin only") ? 403 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function DELETE(req: NextRequest) {
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
