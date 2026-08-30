import type { Metadata } from "next";
import {
  getDriveFileMeta,
  readPrisotData,
  type PrisotData,
} from "@/lib/driveFolders";
import { driveFolderOwner } from "@/lib/sa";
import { projectHref, projectLabel } from "@/lib/projectHref";
import PrisotDataTable from "@/components/PrisotDataTable";
import PrisaTokenActions from "@/components/PrisaTokenActions";
import {
  approverOptionsFor,
  getPrisaApprovalRequest,
  isAwaitingApproval,
  verifyPrisaApprovalToken,
  type PrisaApprovalRequest,
} from "@/lib/prisaApprovalTokens";

/**
 * The login-free פריסה approval page — where an emailed approval link
 * lands. This is the whole point of the flow: the client sees the plan
 * and signs it off in one click, with no Google account, no Drive UI,
 * and no hub session.
 *
 * PUBLIC (exempted in middleware.ts). Everything on the page is scoped
 * by the signed token: the file it renders, the recipient it attributes
 * the decision to, and the preview proxy it points at. There is no
 * fileId or email in the URL that a visitor could edit.
 *
 * Falls back gracefully in every dead-end — expired link, unknown
 * request, already-decided — by pointing at the hub's normal
 * session-authed project page, which offers the same two actions to
 * anyone who can sign in. That's the "signed link, login as fallback"
 * shape: the fast path needs no identity, the slow path still works.
 *
 * The root layout renders around this page; `.prisa-approve-standalone`
 * on the wrapper hides the app topnav (globals.css) so a client doesn't
 * land inside internal chrome they can't use.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "אישור פריסה",
  // Capability URL — keep it out of search indexes and out of the
  // Referer header on any outbound click.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function ApprovePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token: tokenRaw } = await params;
  const token = decodeURIComponent(tokenRaw || "");
  const verified = verifyPrisaApprovalToken(token);

  if (!verified.ok) {
    // Expired but correctly signed → we still know which plan it was, so
    // point the visitor at the project page. Signing in there gives them
    // the same two actions, which is the whole reason the hub keeps a
    // session-authed path alongside the token one.
    const expiredHref =
      verified.reason === "expired"
        ? await hrefForFile(verified.fileId)
        : undefined;
    return (
      <Shell>
        <Dead
          icon={verified.reason === "expired" ? "⏳" : "🔒"}
          title={
            verified.reason === "expired"
              ? "פג תוקף הקישור"
              : "הקישור אינו תקין"
          }
          body={
            verified.reason === "expired"
              ? "קישורי אישור בתוקף לשבועיים. בקשו מהצוות לשלוח קישור חדש — הפריסה עצמה עדיין ממתינה."
              : "ייתכן שהקישור נחתך בהעתקה מהמייל. נסו ללחוץ ישירות על הכפתור בהודעה, או בקשו מהצוות לשלוח שוב."
          }
          href={expiredHref}
        />
      </Shell>
    );
  }

  const request = await getPrisaApprovalRequest(verified.fileId);
  if (!request) {
    return (
      <Shell>
        <Dead
          icon="🔎"
          title="בקשת האישור לא נמצאה"
          body="ייתכן שהבקשה בוטלה או שנשלחה פריסה חדשה במקומה. בקשו מהצוות לשלוח קישור עדכני."
        />
      </Shell>
    );
  }

  // Straight to the פריסות section: this page IS a plan, so the visitor
  // who signs in is coming to look at plans, not at the report's default
  // section.
  const href = projectHref(request.projectName, request.company, "prisot");

  if (request.resolution === "approved") {
    return (
      <Shell>
        <Dead
          icon="✓"
          title="הפריסה כבר אושרה"
          body={
            request.resolvedBy
              ? `הפריסה אושרה על ידי ${request.resolvedBy}. אין צורך בפעולה נוספת.`
              : "הפריסה כבר מסומנת כמאושרת. אין צורך בפעולה נוספת."
          }
          href={href}
        />
      </Shell>
    );
  }
  if (request.resolution === "changes") {
    return (
      <Shell>
        <Dead
          icon="✏️"
          title="כבר נשלחה בקשת שינויים"
          body="הצוות עובד על עדכון הפריסה, ותקבלו קישור חדש לאישור הגרסה המעודכנת."
          href={href}
        />
      </Shell>
    );
  }
  if (!isAwaitingApproval(request)) {
    return (
      <Shell>
        <Dead
          icon="⏳"
          title="פג תוקף בקשת האישור"
          body="בקשו מהצוות לשלוח קישור חדש — הפריסה עצמה עדיין ממתינה לאישורכם."
          href={href}
        />
      </Shell>
    );
  }

  // Live request. Render the plan itself. Native Sheets go through
  // readPrisotData (server-side, no client credentials involved);
  // images / PDFs stream from the token-scoped proxy. Both read under
  // the SA, so the visitor needs no Drive access of their own.
  //
  // The name and mime come from Drive rather than from the request doc,
  // which only holds what they were when the mail went out — a file
  // renamed after sending would otherwise keep showing its old name to
  // the client. Stored values remain the fallback.
  const [data, live, approvers] = await Promise.all([
    readPrisotData(driveFolderOwner(), verified.fileId).catch(() => null),
    getDriveFileMeta(driveFolderOwner(), verified.fileId),
    approverOptionsFor(request, driveFolderOwner()),
  ]);
  const fileName = live?.name || request.fileName;
  const mimeType = live?.mimeType || request.mimeType || "";
  const previewSrc = `/api/prisot/preview/${encodeURIComponent(token)}`;

  return (
    <Shell>
      <header className="prisa-approve-head">
        <div className="prisa-approve-eyebrow">F&amp;F · פרסום ושיווק</div>
        <h1>📐 פריסה שיווקית לאישורכם</h1>
        <Meta request={request} fileName={fileName} />
      </header>

      {request.message && (
        <div className="prisa-approve-message">{request.message}</div>
      )}

      <div className="prisa-approve-preview">
        <Preview
          data={data}
          mimeType={mimeType}
          fileName={fileName}
          src={previewSrc}
        />
      </div>

      <PrisaTokenActions
        token={token}
        projectHref={href}
        approvers={approvers}
      />
    </Shell>
  );
}

/**
 * Render the plan itself, picking by mime type rather than assuming.
 *
 * The first version had two branches — sheet-data or `<img>` — so every
 * PDF and .xlsx plan (both accepted פריסה formats) painted a broken
 * image placeholder above a live "✓ אשר פריסה" button. Asking someone to
 * sign off on a document you failed to show them is the one outcome this
 * page must not produce, so the fallback is now an explicit note plus a
 * way to open the file.
 */
function Preview({
  data,
  mimeType,
  fileName,
  src,
}: {
  data: PrisotData | null;
  mimeType: string;
  fileName: string;
  src: string;
}) {
  // Native Sheet read succeeded — the richest rendering, and the common
  // case. Checked first because it doesn't depend on mimeType being
  // recorded (docs written before that field exists have it empty).
  if (data) return <PrisotDataTable data={data} />;
  if (mimeType.startsWith("image/")) {
    return (
      /* eslint-disable-next-line @next/next/no-img-element */
      <img src={src} alt={fileName} className="prisa-approve-img" />
    );
  }
  if (mimeType === "application/pdf") {
    return (
      <object data={src} type="application/pdf" className="prisa-approve-pdf">
        {/* Shown when the browser has no inline PDF viewer (common on
            mobile Safari) — never a blank frame. */}
        <p className="prisa-approve-nopreview">
          לא ניתן להציג את הקובץ כאן.{" "}
          <a href={src} target="_blank" rel="noreferrer">
            פתחו את הפריסה בכרטיסייה חדשה
          </a>{" "}
          לפני האישור.
        </p>
      </object>
    );
  }
  // Unknown / unrecorded mime, or a Sheet whose read failed transiently.
  // Say so plainly rather than implying the plan was displayed.
  return (
    <p className="prisa-approve-nopreview">
      ⚠️ לא הצלחנו להציג את הפריסה כאן.{" "}
      <a href={src} target="_blank" rel="noreferrer">
        נסו לפתוח את הקובץ
      </a>
      , ואם הוא לא נפתח — פנו לצוות לפני האישור.
    </p>
  );
}

/** Best-effort project deep link for a fileId whose token has expired.
 *  Returns undefined when the request doc is gone, in which case the
 *  page simply omits the link rather than sending the visitor somewhere
 *  that 404s. */
async function hrefForFile(fileId: string): Promise<string | undefined> {
  const req = await getPrisaApprovalRequest(fileId);
  if (!req?.projectName) return undefined;
  return projectHref(req.projectName, req.company, "prisot");
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="prisa-approve-standalone" dir="rtl">
      <div className="prisa-approve-card">{children}</div>
    </main>
  );
}

function Meta({
  request,
  fileName,
}: {
  request: PrisaApprovalRequest;
  /** Live Drive name, falling back to the one snapshotted on the request. */
  fileName: string;
}) {
  const sender = request.sentBy.split("@")[0] || "הצוות";
  const label = projectLabel(request.projectName, request.company);
  return (
    <p className="prisa-approve-meta">
      {label && <b>{label}</b>}
      {label && " · "}
      {fileName}
      <br />
      <span className="prisa-approve-meta-dim">
        נשלח על ידי {sender} · בתוקף עד {formatDateHe(request.expiresAt)}
      </span>
    </p>
  );
}

function Dead({
  icon,
  title,
  body,
  href,
}: {
  icon: string;
  title: string;
  body: string;
  href?: string;
}) {
  return (
    <div className="prisa-approve-result" dir="rtl">
      <div className="prisa-approve-result-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{body}</p>
      {href && (
        <p className="prisa-approve-signin-hint">
          <a href={href}>כניסה לעמוד הפרויקט ב-Hub</a>
        </p>
      )}
    </div>
  );
}

function formatDateHe(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}
