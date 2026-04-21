import { NextResponse } from "next/server";
import { getMyProjects } from "@/lib/appsScript";

/**
 * Light "who am I" for client components that need admin gating (like
 * the admin nav link). Reuses getMyProjects() because it already returns
 * `isAdmin` without requiring an extra Apps Script action.
 */
export async function GET() {
  try {
    const data = await getMyProjects();
    return NextResponse.json({
      email: data.email,
      isAdmin: data.isAdmin,
      isInternal: data.isInternal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
