import Link from "next/link";
import {
  latestPrisotForRequest,
  readPrisotData,
} from "@/lib/driveFolders";
import PrisotThumb from "./PrisotThumb";
import PrisotDataTable from "./PrisotDataTable";
import SendForApprovalButton from "./SendForApprovalButton";
import ApprovePrisaButton from "./ApprovePrisaButton";
import RequestChangesButton from "./RequestChangesButton";
import GoogleDriveIcon from "./GoogleDriveIcon";
import { getPrisotChangeRequest } from "@/lib/prisotChangeRequests";
import { ensurePrisaClientAccess } from "@/lib/driveClientAccess";
import { displayNameOf, personDisplayName } from "@/lib/personDisplay";
import type { TasksPerson } from "@/lib/appsScript";

/**
 * Server component — fetches and renders the latest Google Sheet from
 * `<project>/פריסות/` (or, when the project's own folder has no
 * later-dated sheet, from `<company>/כללי/פריסות/`) on the project
 * overview page.
 *
 * The fallback rule: if the company-level כללי folder has a sheet whose
 * filename contains a more recent date (YYYY-MM-DD pattern) than the
 * project's own latest, we surface the כללי one instead — handles the
 * "weekly spread lives in כללי and supersedes per-project drafts"
 * workflow. A small badge marks the source when fallback fires so users
 * can tell at a glance which folder the file came from.
 *
 * Wrapped in <Suspense> at the call site so the Drive lookup
 * (~500–2000ms cold for two parallel folder traversals) doesn't block
 * the rest of the page.
 */
export default async function LatestPrisotCard({
  subjectEmail,
  company,
  project,
  clientEmails = [],
  teamNames = [],
  people = [],
  isClientUser = false,
}: {
  subjectEmail: string;
  company: string;
  project: string;
  /** Client emails from the project's Keys row (col E), pre-suggested
   *  in the SendForApprovalButton dialog when the latest פריסה has
   *  no active approval. Empty array → button still renders but the
   *  user has to type the approver email manually. */
  clientEmails?: string[];
  /** F&F names from the project's Keys row (col K "Client-facing" plus
   *  the campaign + account managers) — offered as extra recipients in
   *  the send-for-approval dialog. Names, not emails: Keys holds People
   *  chips, and `people` below is what turns them into addresses. */
  teamNames?: string[];
  /** People roster — used to resolve reviewer email addresses on the
   *  approval chip ("✓ אושר ע״י <Hebrew name>"). Falls back to email
   *  local-part when the person isn't in the roster (typical for
   *  external client reviewers like Marketing1@s-sarfati.co.il). */
  people?: TasksPerson[];
  /** True when the viewer is a client (col-E only). Hides the internal
   *  approval-workflow chrome (send-for-approval, reviewer chips, the
   *  internal Drive-folder / open-in-Sheets links, the "מתוך כללי"
   *  source badge) and instead offers a single "✓ אשר פריסה" action so
   *  the client can sign off the plan without leaving the hub. */
  isClientUser?: boolean;
}) {
  const latest = await latestPrisotForRequest(
    subjectEmail,
    company,
    project,
  ).catch(() => null);
  if (!latest) return null;
  const clientMode = !!isClientUser;
  // Attribution for a content-lock approval (the client "אשר פריסה"
  // action, or a manual Sheets lock): the approver email is stamped into
  // the lock reason as `אושר ע"י <email> …`. Drive Approvals-API flows
  // carry structured reviewers instead, so this only resolves for the
  // lock path — letting the card show "אושר על ידי X" where it otherwise
  // couldn't (a lock has no API reviewer to read).
  const lockApprover =
    (latest.approvalReason.match(/אושר ע["״]י\s+(\S+@\S+?)(?:\s|$)/) ||
      [])[1] || "";
  // Pending client change-request for this exact plan (keyed by fileId).
  // Drives the "🔄 התבקשו שינויים" chip; cleared on (re-)approval. Reads
  // soft-fail to null so the card still renders if Firestore is down.
  const changeRequest = await getPrisotChangeRequest(latest.id);

  // Ensure the project's clients have native Drive access to the plan —
  // commenter on the sheet (comment in Google Sheets) + reader on the
  // פריסות folder (browse prior plans). Idempotent + cached (mirrors
  // ensureProjectSharedFolder); the SA does the grant so it runs for any
  // viewer, and it's best-effort — never block the card on a Drive write.
  if (clientEmails.length) {
    await ensurePrisaClientAccess(
      latest.id,
      latest.folderId,
      clientEmails,
    ).catch(() => {});
  }

  const teamRecipients = resolveTeamRecipients(teamNames, people, clientEmails);

  const isImage = latest.mimeType.startsWith("image/");
  const isSheet =
    latest.mimeType === "application/vnd.google-apps.spreadsheet";

  // Sheets only — read the actual cell values for inline-table render.
  // Skipped entirely for image files (we render the image directly).
  // Falls back to the thumbnail when the read fails (auth, deleted, no
  // values, etc.) so the card never goes blank.
  const data = isSheet
    ? await readPrisotData(subjectEmail, latest.id).catch(() => null)
    : null;

  const modified = formatRelativeHe(latest.modifiedTime);
  // Always proxy through the hub so external clients (whose browser
  // has no F&F Google session) can still see the file. Two endpoints:
  //   /api/drive/image/<id>  → streams the actual bytes (full fidelity)
  //   /api/drive/thumb/<id>  → resized rendering (works for any file)
  const imageSrc = `/api/drive/image/${encodeURIComponent(latest.id)}`;
  const thumbSrc = `/api/drive/thumb/${encodeURIComponent(latest.id)}`;
  // Sheets-only .xlsx export, streamed through the hub under the SA so a
  // client with no F&F Google session still gets the file (same rationale
  // as the image/thumb proxies above) rather than a Google access wall.
  const xlsxSrc = `/api/drive/xlsx/${encodeURIComponent(latest.id)}`;

  return (
    <section
      id="prisa-section"
      className="project-section project-section-prisot"
    >
      <div className="section-head">
        <h2>
          📐 פריסה אחרונה
          {/* Client-requested-changes marker — shown to BOTH the client
              (their request registered) and the team (a change was asked).
              Suppressed once the plan is approved (approval supersedes it,
              and the approve route clears the record). */}
          {changeRequest && latest.approvalState !== "approved" && (
            <span
              className="prisot-change-request-chip"
              title={
                (changeRequest.note ? changeRequest.note + " · " : "") +
                `התבקשו שינויים ${formatRelativeHe(changeRequest.requestedAt)}`
              }
            >
              🔄 התבקשו שינויים · {formatRelativeHe(changeRequest.requestedAt)}
            </span>
          )}
          {/* Client view: no internal approval-workflow chrome. Either a
              plain ✓ מאושר badge (when the plan is already locked /
              approved) or a single "אשר פריסה" action that locks it as
              the approved version — attributed to the client. */}
          {clientMode &&
            (latest.approvalState === "approved" ? (
              <>
                <span
                  className="prisot-approved-badge"
                  title={
                    latest.approvedTime
                      ? `הפריסה אושרה ב־${formatRelativeHe(latest.approvedTime)}`
                      : "הפריסה מסומנת כגרסה מאושרת"
                  }
                >
                  ✓ מאושר
                </span>
                {lockApprover && (
                  <span
                    className="prisot-reviewer-chip prisot-reviewer-chip-approved"
                    title={`אושר ע״י ${lockApprover}${
                      latest.approvedTime
                        ? ` · ${formatRelativeHe(latest.approvedTime)}`
                        : ""
                    }`}
                  >
                    ע״י {personDisplayName(lockApprover, people) || lockApprover}
                  </span>
                )}
              </>
            ) : (
              <>
                <ApprovePrisaButton fileId={latest.id} />
                <RequestChangesButton
                  fileId={latest.id}
                  project={project}
                />
              </>
            ))}
          {/* Three-state approval badge driven by the Drive Approvals
              API + contentRestrictions readOnly fallback (see
              lib/driveFolders.ts → fetchApprovalState). "approved" =
              IN_PROGRESS resolved as APPROVED, OR file was manually
              locked. "pending" = there's a real IN_PROGRESS approval
              flow on the file. "none" = no badge — the absence of any
              badge naturally reads as "not yet approved" without making
              a state claim. */}
          {!clientMode && latest.approvalState === "approved" && (() => {
            // Find reviewer who actually approved (vs. NO_RESPONSE
            // siblings on multi-approver flows). When the approval came
            // from a content lock (the hub "אשר פריסה" client action, or
            // a manual Sheets lock) there are no API reviewers — fall
            // back to the approver email stamped in the lock reason so
            // the team still sees who signed off (e.g. a client).
            const approver = (latest.approvalReviewers || []).find(
              (r) => r.response === "APPROVED",
            );
            const approverEmail = approver?.email || lockApprover;
            const approverName = approverEmail
              ? personDisplayName(approverEmail, people) || approverEmail
              : "";
            return (
              <>
                <span
                  className="prisot-approved-badge"
                  title={
                    latest.approvedTime
                      ? `הפריסה אושרה / ננעלה ב־${formatRelativeHe(latest.approvedTime)}`
                      : "הפריסה מסומנת כגרסה מאושרת"
                  }
                >
                  ✓ מאושר
                </span>
                {approverName && (
                  <span
                    className="prisot-reviewer-chip prisot-reviewer-chip-approved"
                    title={`אושר ע״י ${approverEmail}`}
                  >
                    ע״י {approverName}
                  </span>
                )}
              </>
            );
          })()}
          {!clientMode && latest.approvalState === "pending" && (() => {
            // Pending = at least one reviewer hasn't responded.
            // Chip lists the still-pending reviewers (NO_RESPONSE),
            // capped at 2 to keep the head row tidy with a "+N"
            // overflow.
            const stillPending = (latest.approvalReviewers || []).filter(
              (r) => r.response === "NO_RESPONSE",
            );
            const names = stillPending.map((r) =>
              personDisplayName(r.email, people),
            );
            const head = names.slice(0, 2).join(", ");
            const overflow = names.length > 2 ? ` +${names.length - 2}` : "";
            const chipText = head + overflow;
            return (
              <>
                <span
                  className="prisot-unapproved-badge"
                  title="קיים תהליך אישור פעיל על הפריסה (Drive Approvals API → IN_PROGRESS)"
                >
                  ⏳ נשלח לאישור
                </span>
                {chipText && (
                  <span
                    className="prisot-reviewer-chip prisot-reviewer-chip-pending"
                    title={
                      "ממתינים: " +
                      stillPending.map((r) => r.email).join(", ")
                    }
                  >
                    ממתין מ{chipText}
                  </span>
                )}
                {/* Re-send while pending. "Waiting" used to be a one-way
                    door: the send button rendered only for none/declined,
                    so any request that got stuck — a bounced email, a
                    client who answered in the hub instead of the link, a
                    plan revised mid-flight — left the team with no way to
                    send again until the 14-day expiry. Re-sending also
                    supersedes the earlier links (see tokenMatchesRequest),
                    which is exactly what you want after a revision. */}
                <SendForApprovalButton
                  fileId={latest.id}
                  fileName={latest.name}
                  mimeType={latest.mimeType}
                  project={project}
                  company={company}
                  suggestedClients={clientEmails}
                  suggestedTeam={teamRecipients}
                  resend
                />
              </>
            );
          })()}
          {!clientMode && latest.approvalState === "declined" && (() => {
            // First reviewer with DECLINED response. Drive's flow
            // marks the whole approval as declined when any
            // reviewer rejects, so we only need the first one.
            const decliner = (latest.approvalReviewers || []).find(
              (r) => r.response === "DECLINED",
            );
            const declinerName = decliner
              ? personDisplayName(decliner.email, people)
              : "";
            return (
              <>
                <span
                  className="prisot-declined-badge"
                  title="הפריסה נדחתה ע״י אחד הנמענים — יש לתקן ולשלוח שוב"
                >
                  ❌ נדחה
                </span>
                {declinerName && (
                  <span
                    className="prisot-reviewer-chip prisot-reviewer-chip-declined"
                    title={`נדחה ע״י ${decliner?.email}`}
                  >
                    ע״י {declinerName}
                  </span>
                )}
                <SendForApprovalButton
                  fileId={latest.id}
                  fileName={latest.name}
                  mimeType={latest.mimeType}
                  project={project}
                  company={company}
                  suggestedClients={clientEmails}
                  suggestedTeam={teamRecipients}
                  resend
                />
              </>
            );
          })()}
          {!clientMode && latest.approvalState === "none" && (
            <>
              <span
                className="prisot-not-approved-badge"
                title="הפריסה לא נשלחה לאישור ולא נעולה"
              >
                ⛔ לא מאושר
              </span>
              <SendForApprovalButton
                fileId={latest.id}
                fileName={latest.name}
                mimeType={latest.mimeType}
                project={project}
                company={company}
                suggestedClients={clientEmails}
                  suggestedTeam={teamRecipients}
              />
            </>
          )}
          {!clientMode && latest.source === "general" && (
            <span
              className="prisot-source-badge"
              title="הפריסה לקוחה מתיקיית 'כללי' של החברה — אין פריסה חדשה יותר תחת הפרויקט עצמו"
            >
              מתוך כללי
            </span>
          )}
        </h2>
        {/* Header actions. Clients now get the SAME folder + file links as
            the team: they're auto-granted reader on the פריסות folder
            (browse prior plans for finance/review) + commenter on the
            sheet (comment natively), so both links resolve for them. The
            file link is labelled "פתח ב-Google Sheets" for clients to cue
            that they can comment there. */}
        <div className="section-head-actions prisot-head-actions">
          {latest.folderUrl && (
            <a
              className="prisot-folder-link"
              href={latest.folderUrl}
              target="_blank"
              rel="noreferrer"
              title={
                clientMode
                  ? "פתח את תיקיית הפריסות — לצפייה בפריסות קודמות"
                  : "פתח את תיקיית הפריסות ב-Drive"
              }
              aria-label="פתח את תיקיית הפריסות ב-Drive"
            >
              <GoogleDriveIcon size="1.05em" />
              <span>תיקייה</span>
            </a>
          )}
          {/* Excel export — Sheets only (files.export is Workspace-native
              types only; an image פריסה has nothing to convert). Served by
              the hub proxy so it works for clients without a Google
              session too. */}
          {isSheet && (
            <a
              className="prisot-xlsx-link"
              href={xlsxSrc}
              download
              title="הורד את הפריסה כקובץ Excel (.xlsx)"
            >
              ⬇️ הורד XLS
            </a>
          )}
          <a
            className="section-link"
            href={latest.webViewLink}
            target="_blank"
            rel="noreferrer"
            title={
              clientMode
                ? "פתח ב-Google Sheets — אפשר להוסיף הערות על התאים"
                : undefined
            }
          >
            {clientMode ? "📊 פתח ב-Google Sheets" : "פתח בכרטיסייה חדשה ↗"}
          </a>
        </div>
      </div>
      {(() => {
        const cardInner = (
          <>
            {isImage ? (
              // Image file — render the actual bytes via the hub's image
              // proxy so we get full fidelity (not the small Drive
              // thumbnail). Onerror falls back to the thumb proxy via
              // the existing PrisotThumb wrapper, which has its own
              // fallback chain.
              <div className="prisot-thumb prisot-thumb-image">
                <PrisotThumb src={imageSrc} alt={latest.name} />
              </div>
            ) : data ? (
              // Sheet file with successfully-read cell values + formats →
              // styled HTML table that mirrors the Google Sheets view.
              <PrisotDataTable data={data} />
            ) : (
              // Sheet file but the data read failed (or unsupported file
              // type) → fall back to the thumbnail proxy.
              <div className="prisot-thumb">
                <PrisotThumb
                  src={thumbSrc}
                  alt={`תצוגה מקדימה של ${latest.name}`}
                />
              </div>
            )}
            <div className="prisot-meta">
              <div className="prisot-name">
                {latest.name}
                {data && (
                  <span className="prisot-tab-name" title="שם הלשונית שנקראה">
                    · {data.sheetTitle}
                  </span>
                )}
              </div>
              <div className="prisot-modified">📅 עודכן {modified}</div>
            </div>
          </>
        );
        // Clients have no Drive access to the internal Shared-Drive sheet,
        // so the card doesn't link out to Drive for them (it would bounce
        // to "request access"). They read the plan from the rendered
        // preview itself. Internal users keep the click-through.
        return clientMode ? (
          <div className="prisot-card prisot-card-static">{cardInner}</div>
        ) : (
          <Link
            href={latest.webViewLink}
            target="_blank"
            rel="noreferrer"
            className="prisot-card"
          >
            {cardInner}
          </Link>
        );
      })()}
    </section>
  );
}

/**
 * Lightweight Hebrew relative-time formatter. Uses Intl.RelativeTimeFormat
 * which is built into the platform — no extra dependency. Falls back to
 * the absolute date when the gap is large enough (≥30 days) so users see
 * "13/04/2026" instead of "לפני 23 ימים" for older spreads.
 */
function formatRelativeHe(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffMs = Date.now() - t;
  const diffMin = Math.round(diffMs / 60000);
  const diffHr = Math.round(diffMs / 3600000);
  const diffDay = Math.round(diffMs / 86400000);
  const rtf = new Intl.RelativeTimeFormat("he", { numeric: "auto" });
  if (Math.abs(diffMin) < 60) return rtf.format(-diffMin, "minute");
  if (Math.abs(diffHr) < 24) return rtf.format(-diffHr, "hour");
  if (Math.abs(diffDay) < 30) return rtf.format(-diffDay, "day");
  // Anything older than a month — show the absolute date to avoid
  // "13 weeks ago" weirdness.
  const d = new Date(t);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/**
 * Keys roster names → mailable recipients, using the people directory the
 * card already holds. Names that nobody in the directory answers to are
 * dropped rather than guessed at — a wrong address on an approval mail is
 * worse than a missing checkbox — and anyone already on the client list is
 * skipped so the same person can't appear in both groups. A cell that
 * already holds an address (col J mixes the two) passes through as-is.
 */
function resolveTeamRecipients(
  names: readonly string[],
  people: TasksPerson[],
  clientEmails: readonly string[],
): { email: string; label: string }[] {
  const taken = new Set(
    clientEmails.map((e) => String(e).toLowerCase().trim()).filter(Boolean),
  );
  const byName = new Map<string, TasksPerson>();
  for (const p of people) {
    for (const n of [p.name, p.he_name]) {
      const k = String(n ?? "").toLowerCase().trim();
      if (k && !byName.has(k)) byName.set(k, p);
    }
  }
  const out: { email: string; label: string }[] = [];
  for (const raw of names) {
    const token = String(raw ?? "").trim();
    if (!token) continue;
    const person = token.includes("@")
      ? people.find((p) => p.email.toLowerCase() === token.toLowerCase())
      : byName.get(token.toLowerCase());
    const email = (person?.email || (token.includes("@") ? token : ""))
      .toLowerCase()
      .trim();
    if (!email || taken.has(email)) continue;
    taken.add(email);
    out.push({ email, label: person ? displayNameOf(person) : email });
  }
  return out;
}
