import Link from "next/link";
import { findLatestPrisotForProject } from "@/lib/driveFolders";

/**
 * Server component — fetches and renders the latest Google Sheet from
 * `<project>/פריסות/` on the project overview page. Renders nothing
 * when the folder doesn't exist or has no sheets, so the page silently
 * degrades for projects that don't follow the convention yet.
 *
 * Wrapped in <Suspense> at the call site so the slow Drive lookup
 * (~500–1500ms cold) doesn't block the rest of the page rendering.
 */
export default async function LatestPrisotCard({
  subjectEmail,
  company,
  project,
}: {
  subjectEmail: string;
  company: string;
  project: string;
}) {
  const latest = await findLatestPrisotForProject(
    subjectEmail,
    company,
    project,
  ).catch(() => null);
  if (!latest) return null;

  const modified = formatRelativeHe(latest.modifiedTime);
  // Always proxy the thumbnail through the hub so external clients
  // (whose browser has no F&F Google session) can still see the
  // preview. The proxy route uses the SA bearer token under DWD.
  const thumbSrc = `/api/drive/thumb/${encodeURIComponent(latest.id)}`;

  return (
    <section className="project-section project-section-prisot">
      <div className="section-head">
        <h2>📐 פריסה אחרונה</h2>
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
        <div className="prisot-thumb">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumbSrc}
            alt={`תצוגה מקדימה של ${latest.name}`}
            loading="lazy"
            decoding="async"
          />
        </div>
        <div className="prisot-meta">
          <div className="prisot-name">{latest.name}</div>
          <div className="prisot-modified">📅 עודכן {modified}</div>
        </div>
      </Link>
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
