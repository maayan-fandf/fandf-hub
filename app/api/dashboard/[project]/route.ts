import { NextResponse } from "next/server";
import { currentUserEmail } from "@/lib/appsScript";

/**
 * Server-side proxy for the Apps Script dashboard iframe.
 *
 * Why this exists: when an external Gmail client is signed into Google and
 * their browser loads `script.google.com/macros/s/.../exec` directly, Google
 * silently rewrites the URL to `/u/N/s/...` (multi-account routing). That
 * routing triggers a Drive ACL check on the script file — and even though
 * the deployment is ANYONE_ANONYMOUS and the script is shared as
 * "Anyone with the link", the browser still renders Drive's "can't open
 * this file" error for those signed-in sessions. There is no URL param
 * that overrides this behavior.
 *
 * Workaround: the hub's Node server fetches the Apps Script output with
 * plain server-to-server fetch (no Google cookies, no `/u/N/` rerouting,
 * ANYONE_ANONYMOUS works as intended) and re-serves the HTML under the
 * hub's own origin. The client's browser loads the iframe from
 * `hub.fandf.co.il/api/dashboard/<project>` — never touches
 * `script.google.com` — so the account-routing issue can't apply.
 *
 * Apps Script action: `renderDashboardHtml` (added in Code.js @366) returns
 * the evaluated Index.html template as text/html with iframe-mode flags set
 * and the viewer-scoped projects JSON already inlined. The dashboard's
 * client-side JS skips all `google.script.run` calls when IFRAME_MODE is
 * true, so we don't need any further interactivity plumbing.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ project: string }> },
) {
  let email: string;
  try {
    email = await currentUserEmail();
  } catch {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const base = process.env.APPS_SCRIPT_API_URL;
  const token = process.env.APPS_SCRIPT_API_TOKEN;
  if (!base || !token) {
    return new NextResponse("Server misconfigured (APPS_SCRIPT_API_URL / TOKEN)", {
      status: 500,
    });
  }

  const { project: projectParam } = await params;
  const project = decodeURIComponent(projectParam);

  const url = new URL(base);
  url.searchParams.set("api", "1");
  url.searchParams.set("action", "renderDashboardHtml");
  url.searchParams.set("token", token);
  url.searchParams.set("user", email);
  url.searchParams.set("project", project);

  // Cold-render on the Apps Script side can take 15–30s (sheet reads +
  // creative map + platform data). Allow plenty of headroom.
  const res = await fetch(url.toString(), {
    method: "GET",
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return new NextResponse(`Upstream ${res.status}: ${text.slice(0, 500)}`, {
      status: 502,
    });
  }

  const html = await res.text();

  return new NextResponse(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Same-origin frame embedding — the hub page embeds this route.
      "x-frame-options": "SAMEORIGIN",
      // No caching at the edge yet; the data is viewer-scoped and freshness
      // matters. A short per-user SWR layer could go here later.
      "cache-control": "no-store",
    },
  });
}
