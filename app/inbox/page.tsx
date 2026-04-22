import Link from "next/link";
import { getMyMentions, type MentionItem } from "@/lib/appsScript";
import InboxFilterBar from "@/components/InboxFilterBar";
import CardActions from "@/components/CardActions";
import Avatar from "@/components/Avatar";

export const dynamic = "force-dynamic";

type Search = { project?: string };

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const projectFilter = sp.project ?? "";

  let data;
  let error: string | null = null;
  try {
    data = await getMyMentions();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const all = data?.mentions ?? [];
  const projects = Array.from(new Set(all.map((m) => m.project))).sort();

  // Split open vs resolved. Project filter applies to both so the archive
  // respects the same scope the user is browsing.
  const byProject = (m: MentionItem) =>
    !projectFilter || m.project === projectFilter;
  const openMentions = all.filter((m) => !m.resolved && byProject(m));
  const resolvedMentions = all.filter((m) => m.resolved && byProject(m));

  const openCount = all.filter((m) => !m.resolved).length;

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>🏷️</span>
            תיוגים
          </h1>
          <div className="subtitle">
            {data && (
              <>
                🔥 {openCount} פתוחים · {all.length} סה&quot;כ
                {data.me.isAdmin && " · 👑 אדמין (רואה את כל הפרויקטים)"}
              </>
            )}
          </div>
        </div>
      </header>

      {error && (
        <div className="error">
          <strong>שגיאה בטעינת התיוגים.</strong>
          <br />
          {error}
        </div>
      )}

      {data && all.length > 0 && (
        <InboxFilterBar
          projects={projects}
          currentProject={projectFilter}
        />
      )}

      {data && openMentions.length === 0 && (
        <div className="empty">
          <span className="emoji" aria-hidden>
            {all.length === 0 ? "🌿" : resolvedMentions.length > 0 ? "✅" : "🔍"}
          </span>
          {all.length === 0
            ? "אף אחד לא תייג אותך עדיין. יום שקט!"
            : resolvedMentions.length > 0
              ? "כל הכבוד — אין תיוגים פתוחים."
              : "אין תיוגים תואמים לסינון הנוכחי."}
        </div>
      )}

      {openMentions.length > 0 && (
        <ul className="mention-list">
          {openMentions.map((m) => (
            <MentionCard key={m.comment_id} m={m} />
          ))}
        </ul>
      )}

      {/* Collapsible archive — resolved mentions stay one click away so the
          user can unresolve, re-read context, or audit recently-handled
          tags without abandoning the inbox view. Closed by default. */}
      {resolvedMentions.length > 0 && (
        <details className="inbox-archive">
          <summary className="inbox-archive-summary">
            <span className="inbox-archive-icon" aria-hidden>📦</span>
            <span className="inbox-archive-label">
              ארכיון תיוגים שנפתרו ({resolvedMentions.length})
            </span>
            <span className="inbox-archive-chev" aria-hidden>▸</span>
          </summary>
          <ul className="mention-list inbox-archive-list">
            {resolvedMentions.map((m) => (
              <MentionCard key={m.comment_id} m={m} />
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}

function MentionCard({ m }: { m: MentionItem }) {
  // Resolve targets the thread root — only top-level comments can be
  // resolved on the Apps Script side. Falls back to comment_id for API
  // responses that don't yet include thread_root_id.
  const resolveTarget = m.thread_root_id || m.parent_id || m.comment_id;
  return (
    <li className={`mention-card ${m.resolved ? "is-resolved" : ""}`}>
      <div className="mention-head">
        <Avatar
          name={m.author_email}
          title={m.author_name || m.author_email}
          size={32}
        />
        <Link
          className="mention-project"
          href={`/projects/${encodeURIComponent(m.project)}/tasks`}
        >
          {m.project}
        </Link>
        <span className="mention-author">
          {m.author_name || m.author_email}
        </span>
        {m.edited_at && (
          <span
            className="chip chip-muted"
            title={`נערך ${formatRelative(m.edited_at)}`}
          >
            📝 נערך
          </span>
        )}
        <span className="mention-time" title={m.timestamp}>
          {formatRelative(m.timestamp)}
        </span>
      </div>
      <div className="mention-body">
        {truncate(m.body, 400)}
      </div>
      <div className="mention-actions">
        <CardActions
          commentId={resolveTarget}
          editCommentId={m.comment_id}
          resolved={m.resolved}
          body={m.body}
          deleteItemLabel="את התיוג"
        />
      </div>
    </li>
  );
}

/* ─── Helpers ────────────────────────────────────────────────────── */

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const now = Date.now();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return "עכשיו";
  const mins = Math.round(diffSec / 60);
  if (mins < 60) return `לפני ${mins} ד׳`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `לפני ${hrs} ש׳`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `לפני ${days} י׳`;
  const months = Math.round(days / 30);
  if (months < 12) return `לפני ${months} חו׳`;
  const years = Math.round(days / 365);
  return `לפני ${years} ש׳`;
}
