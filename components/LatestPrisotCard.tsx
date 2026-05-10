import Link from "next/link";
import {
  pickLatestPrisotForCompanyOrProject,
  readPrisotData,
  type PrisotCellFormat,
  type PrisotData,
} from "@/lib/driveFolders";
import PrisotThumb from "./PrisotThumb";
import SendForApprovalButton from "./SendForApprovalButton";

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
}: {
  subjectEmail: string;
  company: string;
  project: string;
  /** Client emails from the project's Keys row (col E), pre-suggested
   *  in the SendForApprovalButton dialog when the latest פריסה has
   *  no active approval. Empty array → button still renders but the
   *  user has to type the approver email manually. */
  clientEmails?: string[];
}) {
  const latest = await pickLatestPrisotForCompanyOrProject(
    subjectEmail,
    company,
    project,
  ).catch(() => null);
  if (!latest) return null;

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

  return (
    <section className="project-section project-section-prisot">
      <div className="section-head">
        <h2>
          📐 פריסה אחרונה
          {/* Three-state approval badge driven by the Drive Approvals
              API + contentRestrictions readOnly fallback (see
              lib/driveFolders.ts → fetchApprovalState). "approved" =
              IN_PROGRESS resolved as APPROVED, OR file was manually
              locked. "pending" = there's a real IN_PROGRESS approval
              flow on the file. "none" = no badge — the absence of any
              badge naturally reads as "not yet approved" without making
              a state claim. */}
          {latest.approvalState === "approved" && (
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
          )}
          {latest.approvalState === "pending" && (
            <span
              className="prisot-unapproved-badge"
              title="קיים תהליך אישור פעיל על הפריסה (Drive Approvals API → IN_PROGRESS)"
            >
              ⏳ נשלח לאישור
            </span>
          )}
          {latest.approvalState === "none" && (
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
                suggestedClients={clientEmails}
              />
            </>
          )}
          {latest.source === "general" && (
            <span
              className="prisot-source-badge"
              title="הפריסה לקוחה מתיקיית 'כללי' של החברה — אין פריסה חדשה יותר תחת הפרויקט עצמו"
            >
              מתוך כללי
            </span>
          )}
        </h2>
        <a
          className="section-link"
          href={latest.webViewLink}
          target="_blank"
          rel="noreferrer"
        >
          פתח בכרטיסייה חדשה ↗
        </a>
      </div>
      <Link
        href={latest.webViewLink}
        target="_blank"
        rel="noreferrer"
        className="prisot-card"
      >
        {isImage ? (
          // Image file — render the actual bytes via the hub's image
          // proxy so we get full fidelity (not the small Drive
          // thumbnail). Onerror falls back to the thumb proxy via
          // the existing PrisotThumb wrapper, which has its own
          // fallback chain.
          <div className="prisot-thumb prisot-thumb-image">
            <PrisotThumb
              src={imageSrc}
              alt={latest.name}
            />
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
      </Link>
    </section>
  );
}

/**
 * Renders the parsed sheet data as an HTML table that visually
 * approximates the Google Sheets view: per-cell background + foreground
 * colors, bold/italic/underline, alignment, merged cells via
 * rowSpan/colSpan, column widths from `<col>`, and a sticky-header
 * treatment for the frozen rows from gridProperties.
 *
 * Cell-level formatting that matches Sheets defaults (white background,
 * black foreground) is intentionally elided — the readPrisotData layer
 * does that filtering — so the table inherits the hub's themed
 * background + ink colors. This keeps the card legible in dark mode
 * while still surfacing meaningful color choices the spreadsheet
 * author made (header bands, status pills, highlighted totals, …).
 */
function PrisotDataTable({ data }: { data: PrisotData }) {
  // Build the "skip this cell because it's covered by a merge" map
  // and the "this cell is the merge anchor" span map. Indices are
  // post-trim row/col positions.
  const occupied = new Set<string>();
  const spanByAnchor = new Map<string, { rowSpan: number; colSpan: number }>();
  for (const m of data.merges) {
    spanByAnchor.set(`${m.r1},${m.c1}`, {
      rowSpan: m.r2 - m.r1,
      colSpan: m.c2 - m.c1,
    });
    for (let r = m.r1; r < m.r2; r++) {
      for (let c = m.c1; c < m.c2; c++) {
        if (r === m.r1 && c === m.c1) continue;
        occupied.add(`${r},${c}`);
      }
    }
  }

  const colCount = data.rows[0]?.length ?? 0;

  return (
    <div className="prisot-data" dir="rtl">
      <table className="prisot-data-table">
        {data.colWidths.length > 0 && (
          <colgroup>
            {data.colWidths.slice(0, colCount).map((w, i) => (
              <col key={i} style={{ width: `${Math.max(40, w)}px` }} />
            ))}
          </colgroup>
        )}
        <tbody>
          {data.rows.map((row, ri) => {
            const isFrozen = ri < data.frozenRows;
            return (
              <tr
                key={ri}
                className={isFrozen ? "prisot-data-header" : undefined}
              >
                {row.map((cell, ci) => {
                  if (occupied.has(`${ri},${ci}`)) return null;
                  const span = spanByAnchor.get(`${ri},${ci}`);
                  const fmt = data.formats[ri]?.[ci] ?? null;
                  return (
                    <td
                      key={ci}
                      rowSpan={span?.rowSpan}
                      colSpan={span?.colSpan}
                      style={cellStyle(fmt)}
                    >
                      {cell}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Builds the React inline-style object for a single cell. Returns
 *  undefined when the cell has no overrides — keeps the DOM lean. */
function cellStyle(fmt: PrisotCellFormat | null): React.CSSProperties | undefined {
  if (!fmt) return undefined;
  const s: React.CSSProperties = {};
  if (fmt.bg) s.backgroundColor = fmt.bg;
  if (fmt.fg) s.color = fmt.fg;
  if (fmt.bold) s.fontWeight = 700;
  if (fmt.italic) s.fontStyle = "italic";
  if (fmt.underline) s.textDecoration = "underline";
  if (fmt.fontSize) s.fontSize = `${fmt.fontSize}pt`;
  if (fmt.align) s.textAlign = fmt.align;
  if (fmt.wrap) {
    s.whiteSpace = "normal";
    s.wordBreak = "break-word";
  }
  return Object.keys(s).length === 0 ? undefined : s;
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
