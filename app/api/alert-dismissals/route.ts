import { NextResponse } from "next/server";
import {
  listAlertDismissals,
  upsertAlertDismissal,
} from "@/lib/alertDismissals";

export const dynamic = "force-dynamic";

/**
 * Server-to-server store for morning-alert dismissals, called by the
 * Apps Script report (Client Dashboard) which moved this off its
 * "Alert Dismissals" sheet onto Firestore.
 *
 *   GET  → { ok, dismissals: { [signal_key]: {...} } }
 *   POST → upsert one dismissal → { ok, signal_key, snooze_until, dismissed_at }
 *
 * Auth: the shared APPS_SCRIPT_API_TOKEN, sent as the `x-api-token`
 * header (preferred) or `?token=` (GET) / body.token (POST). No NextAuth
 * session — Apps Script calls run unattended. Public path in middleware.
 */
function isAuthorized(req: Request, bodyToken?: unknown): boolean {
  const expected = process.env.APPS_SCRIPT_API_TOKEN || "";
  if (!expected) return false;
  const header = req.headers.get("x-api-token") || "";
  if (header && header === expected) return true;
  if (typeof bodyToken === "string" && bodyToken === expected) return true;
  try {
    const url = new URL(req.url);
    if (url.searchParams.get("token") === expected) return true;
  } catch {
    /* ignore malformed URL */
  }
  return false;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const dismissals = await listAlertDismissals();
    return NextResponse.json({ ok: true, dismissals });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  let body: {
    token?: unknown;
    user_email?: unknown;
    signal_key?: unknown;
    snooze_until?: unknown;
    reason?: unknown;
    dismissed_at?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isAuthorized(req, body.token)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const signal_key = String(body.signal_key || "").trim();
  if (!signal_key) {
    return NextResponse.json(
      { ok: false, error: "signal_key is required" },
      { status: 400 },
    );
  }
  try {
    const rec = await upsertAlertDismissal({
      user_email: String(body.user_email || ""),
      signal_key,
      snooze_until: String(body.snooze_until || ""),
      reason: String(body.reason || ""),
      dismissed_at:
        typeof body.dismissed_at === "string" ? body.dismissed_at : undefined,
    });
    return NextResponse.json({
      ok: true,
      signal_key: rec.signal_key,
      snooze_until: rec.snooze_until,
      dismissed_at: rec.dismissed_at,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
