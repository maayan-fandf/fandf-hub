import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getMyProjects } from "@/lib/appsScript";
import {
  upsertManagementFee,
  setChannelTypeFee,
  setGlobalDefaultFee,
} from "@/lib/managementFees";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/management-fees
 *
 * Upserts a management-fee override at one of three cascade levels.
 * Admin-only — same gate as /morning/forecast itself.
 *
 * Body: { scope?, percent, ...target }
 *   - scope: "channel" (default) | "channelType" | "global"
 *   - percent: number, 0-100 (clamped server-side)
 *   - channel scope     → { slug, channel } (per-project-channel override)
 *   - channelType scope → { channelType } (canonical media-channel default)
 *   - global scope      → {} (the agency-wide default)
 *
 * Resolution precedence at read time:
 *   (slug,channel) → channel-type → global.
 *
 * Response: { ok: true, fee } on success, { ok: false, error } else.
 */
export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  // Admin gate via getMyProjects().isAdmin. Same predicate the
  // /morning/forecast page checks; non-admins shouldn't be able to
  // override fees the team relies on for billing.
  const me = await getMyProjects().catch(() => null);
  if (!me?.isAdmin) {
    return NextResponse.json(
      { ok: false, error: "Admin only" },
      { status: 403 },
    );
  }

  let body: {
    scope?: string;
    slug?: string;
    channel?: string;
    channelType?: string;
    percent?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const percent = Number(body.percent);
  if (!Number.isFinite(percent)) {
    return NextResponse.json(
      { ok: false, error: "percent must be a number" },
      { status: 400 },
    );
  }

  // scope defaults to "channel" so existing { slug, channel, percent }
  // callers (the per-cell editor) keep working unchanged.
  const scope = String(body.scope || "channel").trim();

  try {
    let fee;
    if (scope === "global") {
      fee = await setGlobalDefaultFee({ percent, updatedBy: email });
    } else if (scope === "channelType") {
      const channelType = String(body.channelType || "").trim();
      if (!channelType) {
        return NextResponse.json(
          { ok: false, error: "channelType is required" },
          { status: 400 },
        );
      }
      fee = await setChannelTypeFee({ channelType, percent, updatedBy: email });
    } else if (scope === "channel") {
      const slug = String(body.slug || "").trim();
      const channel = String(body.channel || "").trim();
      if (!slug || !channel) {
        return NextResponse.json(
          { ok: false, error: "slug and channel are required" },
          { status: 400 },
        );
      }
      fee = await upsertManagementFee({
        slug,
        channel,
        percent,
        updatedBy: email,
      });
    } else {
      return NextResponse.json(
        { ok: false, error: `unknown scope: ${scope}` },
        { status: 400 },
      );
    }
    return NextResponse.json({ ok: true, fee });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[/api/management-fees POST] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
