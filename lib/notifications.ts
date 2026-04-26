/**
 * In-hub notifications. Single source of truth for "tell user X that Y
 * happened" — replaces / wraps the per-callsite sendMimeMail() pattern
 * so email and the in-hub feed stay in lockstep.
 *
 * Storage: a `Notifications` tab on the Comments spreadsheet
 * (SHEET_ID_COMMENTS). Auto-created on first write. One row per
 * (recipient × event). Schema is append-only; `read_at` is the only
 * column that gets back-patched.
 *
 * Trigger pipeline:
 *   notifyOnce({ kind, forEmail, actorEmail, ...payload })
 *     ├─ skip when actorEmail === forEmail (no self-pings)
 *     ├─ append a Notifications row → surfaces in /notifications + bell
 *     └─ if user's email_notifications pref is on AND the kind sends
 *         email by default → also sendMimeMail (multipart HTML)
 *
 * The hub feed is always-on (every kind writes a row) so users have a
 * fallback even when email is muted. Snooze affects the BELL BADGE
 * only — rows still get written so /notifications stays the activity
 * log.
 */

import { sheetsClient, gmailClient } from "@/lib/sa";

export type NotificationKind =
  | "task_assigned"
  | "task_unassigned"
  | "task_awaiting_approval"
  | "task_returned"
  | "task_done"
  | "task_cancelled"
  | "comment_reply"
  | "mention";

const TAB = "Notifications";
const HEADERS = [
  "id",
  "for_email",
  "created_at",
  "kind",
  "task_id",
  "comment_id",
  "actor_email",
  "project",
  "title",
  "body",
  "link",
  "read_at",
  "emailed_at",
];

export type NotificationRow = {
  id: string;
  for_email: string;
  created_at: string;
  kind: NotificationKind | string;
  task_id: string;
  comment_id: string;
  actor_email: string;
  project: string;
  title: string;
  body: string;
  link: string;
  read_at: string;
  emailed_at: string;
};

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

/** Idempotently create the Notifications tab + add any missing
 *  headers. Mirrors the User Preferences auto-migrate pattern so
 *  schema additions don't require a manual sheet edit. */
async function ensureTab(subjectEmail: string): Promise<void> {
  const sheets = sheetsClient(subjectEmail);
  const ssId = envOrThrow("SHEET_ID_COMMENTS");
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: ssId,
      range: `${TAB}!1:1`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const row = (res.data.values?.[0] ?? []) as unknown[];
    const have = row.map((h) => String(h ?? "").trim().toLowerCase());
    const want = HEADERS.map((h) => h.toLowerCase());
    const missing = want.filter((h) => !have.includes(h));
    if (missing.length === 0) return;
    const next = [...have];
    for (const h of missing) next.push(h);
    await sheets.spreadsheets.values.update({
      spreadsheetId: ssId,
      range: `${TAB}!1:1`,
      valueInputOption: "RAW",
      requestBody: { values: [next] },
    });
    return;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/Unable to parse range|notFound|not found/i.test(msg)) throw e;
  }
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: TAB } } }],
    },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId,
    range: `${TAB}!1:1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });
}

function newId(): string {
  // ~62-bit URL-safe random — sufficient for sheet rows. Avoids the
  // crypto.randomUUID dep which isn't a polyfill in older Node lambdas.
  return (
    "n_" +
    Math.random().toString(36).slice(2, 11) +
    "-" +
    Date.now().toString(36)
  );
}

/** Append one notification row + (optionally) send the matching
 *  email. Best-effort: any failure is logged but doesn't propagate so
 *  trigger sites stay non-blocking. Pass `actorEmail === forEmail` is
 *  silently dropped (no self-notifications). */
export async function notifyOnce(opts: {
  kind: NotificationKind;
  forEmail: string;
  actorEmail: string;
  taskId?: string;
  commentId?: string;
  project?: string;
  title?: string;
  body?: string;
  link: string;
  /** Subject line for the email. When omitted, derived from kind. */
  emailSubject?: string;
  /** Plain-text body for the email. Falls back to `body`. */
  emailPlain?: string;
  /** HTML body for the email. Optional — falls back to plain. */
  emailHtml?: string;
}): Promise<void> {
  const forEmail = (opts.forEmail || "").toLowerCase().trim();
  const actorEmail = (opts.actorEmail || "").toLowerCase().trim();
  if (!forEmail) return;
  if (actorEmail && actorEmail === forEmail) return;
  try {
    await ensureTab(forEmail);
    const sheets = sheetsClient(forEmail);
    const ssId = envOrThrow("SHEET_ID_COMMENTS");

    // Decide whether email should fire BEFORE the row append so we can
    // stamp emailed_at into the row and avoid a re-read.
    const { shouldSendEmail } = await import("@/lib/userPrefs").then(
      async (m) => {
        const prefs = await m.getUserPrefs(forEmail).catch(() => null);
        return {
          shouldSendEmail:
            !!prefs?.email_notifications && emailDefaultOn(opts.kind),
        };
      },
    );

    let emailedAt = "";
    if (shouldSendEmail && actorEmail) {
      try {
        await sendNotificationEmail({
          fromEmail: actorEmail,
          toEmail: forEmail,
          subject: opts.emailSubject || defaultEmailSubject(opts),
          plainBody: opts.emailPlain || opts.body || "",
          htmlBody:
            opts.emailHtml ||
            buildDefaultEmailHtml({
              intro: defaultEmailIntro(opts),
              body: opts.body || "",
              link: opts.link,
              ctaLabel: defaultCtaLabel(opts.kind),
            }),
        });
        emailedAt = new Date().toISOString();
      } catch (e) {
        console.log(
          "[notifications] email send failed (non-fatal):",
          e instanceof Error ? e.message : String(e),
        );
      }
    }

    const cells: Record<string, unknown> = {
      id: newId(),
      for_email: forEmail,
      created_at: new Date().toISOString(),
      kind: opts.kind,
      task_id: opts.taskId || "",
      comment_id: opts.commentId || "",
      actor_email: actorEmail,
      project: opts.project || "",
      title: (opts.title || "").slice(0, 200),
      body: (opts.body || "").slice(0, 500),
      link: opts.link,
      read_at: "",
      emailed_at: emailedAt,
    };
    const row = HEADERS.map((h) => (h in cells ? cells[h] : ""));
    await sheets.spreadsheets.values.append({
      spreadsheetId: ssId,
      range: TAB,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row as unknown[]] },
    });
  } catch (e) {
    console.log(
      "[notifications] notifyOnce failed (non-fatal):",
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** Read recent notifications for a user, newest first. Limit is hard-
 *  capped at 200 to keep the page render bounded. */
export async function listNotifications(
  forEmail: string,
  opts: { limit?: number; unreadOnly?: boolean } = {},
): Promise<NotificationRow[]> {
  const lc = forEmail.toLowerCase().trim();
  if (!lc) return [];
  const limit = Math.min(opts.limit ?? 100, 200);
  await ensureTab(forEmail);
  const sheets = sheetsClient(forEmail);
  const ssId = envOrThrow("SHEET_ID_COMMENTS");
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId,
    range: TAB,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const values = (res.data.values ?? []) as unknown[][];
  if (values.length < 2) return [];
  const headers = (values[0] as unknown[]).map((h) =>
    String(h ?? "").trim().toLowerCase(),
  );
  const idx = (h: string) => headers.indexOf(h);
  const out: NotificationRow[] = [];
  for (let i = values.length - 1; i >= 1 && out.length < limit; i--) {
    const row = values[i];
    const fe = String(row[idx("for_email")] ?? "").toLowerCase().trim();
    if (fe !== lc) continue;
    const readAt = String(row[idx("read_at")] ?? "");
    if (opts.unreadOnly && readAt) continue;
    out.push({
      id: String(row[idx("id")] ?? ""),
      for_email: fe,
      created_at: String(row[idx("created_at")] ?? ""),
      kind: String(row[idx("kind")] ?? ""),
      task_id: String(row[idx("task_id")] ?? ""),
      comment_id: String(row[idx("comment_id")] ?? ""),
      actor_email: String(row[idx("actor_email")] ?? ""),
      project: String(row[idx("project")] ?? ""),
      title: String(row[idx("title")] ?? ""),
      body: String(row[idx("body")] ?? ""),
      link: String(row[idx("link")] ?? ""),
      read_at: readAt,
      emailed_at: String(row[idx("emailed_at")] ?? ""),
    });
  }
  return out;
}

/** Count unread notifications for the bell badge. Returns at most 99. */
export async function countUnread(forEmail: string): Promise<number> {
  const lc = forEmail.toLowerCase().trim();
  if (!lc) return 0;
  try {
    await ensureTab(forEmail);
    const sheets = sheetsClient(forEmail);
    const ssId = envOrThrow("SHEET_ID_COMMENTS");
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: ssId,
      range: TAB,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const values = (res.data.values ?? []) as unknown[][];
    if (values.length < 2) return 0;
    const headers = (values[0] as unknown[]).map((h) =>
      String(h ?? "").trim().toLowerCase(),
    );
    const iFor = headers.indexOf("for_email");
    const iRead = headers.indexOf("read_at");
    if (iFor < 0 || iRead < 0) return 0;
    let n = 0;
    for (let i = 1; i < values.length; i++) {
      const fe = String(values[i][iFor] ?? "").toLowerCase().trim();
      if (fe !== lc) continue;
      if (String(values[i][iRead] ?? "")) continue;
      n++;
      if (n >= 99) return 99;
    }
    return n;
  } catch (e) {
    console.log(
      "[notifications] countUnread failed (non-fatal):",
      e instanceof Error ? e.message : String(e),
    );
    return 0;
  }
}

/** Mark one or more notifications read. Empty `ids` (or "*") marks
 *  every unread row for this user — used by the "סמן הכל כנקרא" bulk
 *  action. */
export async function markRead(
  forEmail: string,
  ids: string[] | "*",
): Promise<{ ok: true; updated: number }> {
  const lc = forEmail.toLowerCase().trim();
  if (!lc) return { ok: true, updated: 0 };
  await ensureTab(forEmail);
  const sheets = sheetsClient(forEmail);
  const ssId = envOrThrow("SHEET_ID_COMMENTS");
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId,
    range: TAB,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const values = (res.data.values ?? []) as unknown[][];
  if (values.length < 2) return { ok: true, updated: 0 };
  const headers = (values[0] as unknown[]).map((h) =>
    String(h ?? "").trim().toLowerCase(),
  );
  const iId = headers.indexOf("id");
  const iFor = headers.indexOf("for_email");
  const iRead = headers.indexOf("read_at");
  if (iId < 0 || iFor < 0 || iRead < 0) return { ok: true, updated: 0 };

  const wantAll = ids === "*";
  const wantSet = wantAll ? null : new Set((ids as string[]).map((s) => s));
  const now = new Date().toISOString();
  const updates: { range: string; values: [[string]] }[] = [];
  for (let i = 1; i < values.length; i++) {
    const fe = String(values[i][iFor] ?? "").toLowerCase().trim();
    if (fe !== lc) continue;
    if (String(values[i][iRead] ?? "")) continue;
    if (!wantAll && !wantSet?.has(String(values[i][iId] ?? ""))) continue;
    const sheetRow = i + 1;
    const col = columnLetter(iRead + 1);
    updates.push({
      range: `${TAB}!${col}${sheetRow}:${col}${sheetRow}`,
      values: [[now]],
    });
  }
  if (updates.length === 0) return { ok: true, updated: 0 };
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: ssId,
    requestBody: { valueInputOption: "RAW", data: updates },
  });
  return { ok: true, updated: updates.length };
}

/* ─── Per-kind defaults ──────────────────────────────────────────── */

/** All kinds default to email-on; the user's global email_notifications
 *  pref is the master switch. Kept as a function instead of a const map
 *  so future per-kind toggles can drop in without changing call sites. */
function emailDefaultOn(_kind: NotificationKind): boolean {
  return true;
}

function defaultEmailSubject(opts: {
  kind: NotificationKind;
  project?: string;
  title?: string;
}): string {
  const tail =
    [opts.project, opts.title].filter(Boolean).join(" · ") || "המשימה";
  switch (opts.kind) {
    case "task_assigned":
      return `📋 משימה חדשה עבורך — ${tail}`;
    case "task_unassigned":
      return `📋 הוסרת מהמשימה — ${tail}`;
    case "task_awaiting_approval":
      return `📋 משימה ממתינה לאישורך — ${tail}`;
    case "task_returned":
      return `↩️ משימה הוחזרה — ${tail}`;
    case "task_done":
      return `✅ משימה סומנה כבוצעה — ${tail}`;
    case "task_cancelled":
      return `🚫 משימה בוטלה — ${tail}`;
    case "comment_reply":
      return `💬 תגובה חדשה לשרשור — ${tail}`;
    case "mention":
      return `🏷️ תויגת בתגובה — ${tail}`;
  }
}

function defaultEmailIntro(opts: {
  kind: NotificationKind;
  actorEmail: string;
}): string {
  const actor = opts.actorEmail.split("@")[0] || "מישהו";
  switch (opts.kind) {
    case "task_assigned":
      return `${esc(actor)} שיבץ/ה אותך למשימה חדשה.`;
    case "task_unassigned":
      return `${esc(actor)} הסיר/ה אותך ממשימה.`;
    case "task_awaiting_approval":
      return `${esc(actor)} סיים/ה את העבודה ומחכה לאישורך.`;
    case "task_returned":
      return `${esc(actor)} החזיר/ה את המשימה לטיפול.`;
    case "task_done":
      return `${esc(actor)} סימן/ה את המשימה כבוצעה.`;
    case "task_cancelled":
      return `${esc(actor)} ביטל/ה את המשימה.`;
    case "comment_reply":
      return `${esc(actor)} הגיב/ה לשרשור שלך.`;
    case "mention":
      return `${esc(actor)} תייג/ה אותך בתגובה.`;
  }
}

function defaultCtaLabel(kind: NotificationKind): string {
  switch (kind) {
    case "task_awaiting_approval":
      return "סקירה + אישור";
    case "task_returned":
      return "פתח את המשימה";
    case "comment_reply":
    case "mention":
      return "פתח את הדיון";
    default:
      return "פתח את המשימה";
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildDefaultEmailHtml(opts: {
  intro: string;
  body: string;
  link: string;
  ctaLabel: string;
}): string {
  const blocks: string[] = [];
  blocks.push(`<p style="margin:0 0 12px">${opts.intro}</p>`);
  if (opts.body) {
    blocks.push(
      `<p style="margin:8px 0 12px;white-space:pre-wrap">${esc(opts.body)}</p>`,
    );
  }
  if (opts.link) {
    blocks.push(
      `<p style="margin:18px 0 8px"><a href="${esc(
        opts.link,
      )}" style="display:inline-block;padding:10px 16px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">${esc(
        opts.ctaLabel,
      )}</a></p>`,
    );
  }
  return [
    "<!doctype html>",
    '<html lang="he" dir="rtl"><head><meta charset="utf-8"></head>',
    '<body style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;color:#0f172a">',
    blocks.join("\n"),
    "</body></html>",
  ].join("");
}

/* ─── MIME email send (mirrors the helper in tasksWriteDirect) ──── */

async function sendNotificationEmail(opts: {
  fromEmail: string;
  toEmail: string;
  subject: string;
  plainBody: string;
  htmlBody?: string;
}): Promise<void> {
  const gmail = gmailClient(opts.fromEmail);
  const headers = [
    `From: ${opts.fromEmail}`,
    `To: ${opts.toEmail}`,
    `Subject: =?UTF-8?B?${Buffer.from(opts.subject, "utf-8").toString("base64")}?=`,
    "MIME-Version: 1.0",
  ];
  let mime: string;
  if (opts.htmlBody) {
    const boundary = `=_N_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    mime = [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(opts.plainBody, "utf-8").toString("base64"),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(opts.htmlBody, "utf-8").toString("base64"),
      `--${boundary}--`,
    ].join("\r\n");
  } else {
    mime = [
      ...headers,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(opts.plainBody, "utf-8").toString("base64"),
    ].join("\r\n");
  }
  const raw = Buffer.from(mime, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
}

function columnLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
