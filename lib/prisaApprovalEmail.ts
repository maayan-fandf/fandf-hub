/**
 * The Hebrew email a client gets when the team hits "📤 שלח לאישור" on a
 * פריסה. Replaces Drive's own approval notification, which arrived
 * Google-branded, demanded a Google identity, and dropped the recipient
 * into the Drive UI to hunt for an approval bar.
 *
 * This one is F&F-branded, says what's being approved in one line, and
 * its primary CTA is a signed link that opens the plan and its
 * אשר / בקש שינויים buttons with no login at all
 * (see lib/prisaApprovalTokens.ts).
 *
 * Styling deliberately mirrors `buildDefaultEmailHtml` in
 * lib/notifications.ts — inline styles only, RTL forced on <body> AND an
 * inner <div> because Gmail strips <html>/<head> (the LTR-render bug
 * maayan reported 2026-05-12).
 */

import { projectLabel } from "@/lib/projectHref";

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildPrisaApprovalEmail(opts: {
  /** Drive file name of the plan. */
  fileName: string;
  projectName: string;
  /** Owning company. Only reaches the reader for a כללי project, where
   *  the project name alone identifies nothing — see projectLabel. */
  company?: string;
  /** Internal sender — used for the "X שלח/ה לך" line. */
  senderEmail: string;
  /** Free-text the sender typed into the dialog. Optional. */
  message?: string;
  /** The changes this recipient asked for last time, quoted back. Present
   *  only on a re-send that answers an open change request — it is what
   *  turns "here is a plan" into "here is the plan you asked us to fix",
   *  and it is the client's own words, so they can check the revision
   *  against them without digging up the earlier mail. */
  changeNote?: { text: string; requestedAt: string };
  /** The signed, login-free approve link for THIS recipient. */
  approveUrl: string;
  /** ISO — rendered as a soft deadline so the link doesn't silently die. */
  expiresAt: string;
}): { subject: string; plainBody: string; htmlBody: string } {
  const sender = opts.senderEmail.split("@")[0] || "הצוות";
  const project = projectLabel(opts.projectName || "", opts.company || "");
  const subject = `📐 פריסה שיווקית לאישורכם — ${project || opts.fileName}`;
  const expiry = formatDateHe(opts.expiresAt);
  const note = (opts.message || "").trim();

  const change = (opts.changeNote?.text || "").trim();
  const changedOn = opts.changeNote ? formatDateHe(opts.changeNote.requestedAt) : "";
  // A revision announces itself. Without this the second mail is
  // word-for-word the first, and the recipient has to remember whether
  // anything happened in between.
  const lead = change
    ? `${sender} עדכן/ה את הפריסה השיווקית${project ? ` של ${project}` : ""} לפי הבקשה שלכם, והיא שוב לאישורכם.`
    : `${sender} שלח/ה לכם את הפריסה השיווקית${project ? ` של ${project}` : ""} לאישור.`;

  const plainBody = [
    lead,
    "",
    `קובץ: ${opts.fileName}`,
    change
      ? `\nהשינויים שביקשתם${changedOn ? ` ב-${changedOn}` : ""}:\n${change
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n")}\n`
      : "",
    note ? `\nהערה מהצוות:\n${note}\n` : "",
    "לצפייה ולאישור בלחיצה אחת (ללא צורך בהתחברות):",
    opts.approveUrl,
    "",
    `הקישור בתוקף עד ${expiry}.`,
    "",
    "F&F — פרסום ושיווק",
  ]
    .filter((l) => l !== "")
    .join("\n");

  const blocks: string[] = [];
  blocks.push(
    change
      ? `<p style="margin:0 0 12px;font-size:15px">${esc(sender)} עדכן/ה את הפריסה השיווקית${
          project ? ` של <b>${esc(project)}</b>` : ""
        } לפי הבקשה שלכם, והיא שוב לאישורכם.</p>`
      : `<p style="margin:0 0 12px;font-size:15px">${esc(sender)} שלח/ה לכם את הפריסה השיווקית${
          project ? ` של <b>${esc(project)}</b>` : ""
        } לאישור.</p>`,
  );
  blocks.push(
    `<p style="margin:0 0 16px;color:#475569">📄 ${esc(opts.fileName)}</p>`,
  );
  if (change) {
    blocks.push(
      `<div style="margin:0 0 18px;padding:10px 14px;background:#fffbeb;border-right:3px solid #f59e0b;border-radius:4px">` +
        `<div style="font-size:13px;font-weight:600;color:#92400e;margin-bottom:4px">🔄 השינויים שביקשתם${
          changedOn ? ` · ${esc(changedOn)}` : ""
        }</div>` +
        `<div style="white-space:pre-wrap;color:#475569">${esc(change)}</div>` +
        `</div>`,
    );
  }
  if (note) {
    blocks.push(
      `<div style="margin:0 0 18px;padding:10px 14px;background:#f1f5f9;border-right:3px solid #4f46e5;border-radius:4px;white-space:pre-wrap">${esc(
        note,
      )}</div>`,
    );
  }
  blocks.push(
    `<p style="margin:22px 0 10px"><a href="${esc(
      opts.approveUrl,
    )}" style="display:inline-block;padding:13px 28px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:15px">צפייה ואישור הפריסה</a></p>`,
  );
  blocks.push(
    `<p style="margin:0 0 18px;color:#64748b;font-size:13px">הקישור נפתח ישירות — אין צורך בהתחברות או בחשבון Google. אפשר לאשר או לבקש שינויים מאותו מסך.</p>`,
  );
  blocks.push(
    `<p style="margin:0;color:#94a3b8;font-size:12px">הקישור בתוקף עד ${esc(
      expiry,
    )}, ומיועד לנמעני ההודעה הזו בלבד — נא לא להעביר הלאה.</p>`,
  );

  const htmlBody = [
    "<!doctype html>",
    '<html lang="he" dir="rtl"><head><meta charset="utf-8"></head>',
    '<body dir="rtl" lang="he" style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.6;color:#0f172a;direction:rtl;text-align:right">',
    '<div dir="rtl" style="direction:rtl;text-align:right;max-width:560px">',
    blocks.join("\n"),
    "</div>",
    "</body></html>",
  ].join("");

  return { subject, plainBody, htmlBody };
}

/** dd/mm/yyyy — the format the rest of the Hebrew UI uses for absolute
 *  dates (see formatRelativeHe's fallback in LatestPrisotCard). */
function formatDateHe(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}
