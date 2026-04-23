import { createHmac } from "node:crypto";

/**
 * HMAC-SHA256 signer for the dashboard iframe URL.
 *
 * The hub-next server holds `APPS_SCRIPT_API_TOKEN` (shared secret with the
 * Apps Script project). It signs `{email, project, company, ts}` and the
 * Apps Script `_iframeHandle_` validates by recomputing the signature with
 * its own copy of the key. The token itself never enters the browser —
 * only the derived signature does, which is useless for other users or
 * other projects.
 *
 * Keep in sync with `_iframeHmacSign_` in dashboard-clasp/Code.js:
 *   - Message format: `user|project|company|ts` (pipe-joined, no extra
 *     whitespace, email lowercased before signing).
 *   - Timestamp: Unix seconds.
 *   - Output: base64url (no padding, `+`→`-`, `/`→`_`).
 *
 * Apps Script rejects signatures older than 4 hours.
 */
export function signIframeUrl({
  baseUrl,
  token,
  email,
  project,
  company,
  embed = true,
}: {
  baseUrl: string; // Hub API deployment exec URL
  token: string; // APPS_SCRIPT_API_TOKEN from env
  email: string;
  project: string;
  company?: string;
  embed?: boolean;
}): string {
  const user = email.toLowerCase().trim();
  const proj = project.trim();
  const co = (company ?? "").trim();
  const ts = String(Math.floor(Date.now() / 1000));
  const msg = [user, proj, co, ts].join("|");
  const sig = createHmac("sha256", token)
    .update(msg)
    .digest("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const url = new URL(baseUrl);
  url.searchParams.set("iframe", "1");
  url.searchParams.set("user", user);
  if (proj) url.searchParams.set("project", proj);
  if (co) url.searchParams.set("company", co);
  url.searchParams.set("ts", ts);
  url.searchParams.set("sig", sig);
  if (embed) url.searchParams.set("embed", "1");
  return url.toString();
}
