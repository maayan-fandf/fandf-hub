import Link from "next/link";
import { getMyMentions, getMyProjects, type MentionItem } from "@/lib/appsScript";
import { scopedProjectNames } from "@/lib/scope";
import { getScopedPerson } from "@/lib/scope-server";
import InboxFilterBar from "@/components/InboxFilterBar";
import CardActions from "@/components/CardActions";
import ThreadReplies from "@/components/ThreadReplies";
import Avatar from "@/components/Avatar";

export const dynamic = "force-dynamic";

type Search = { resolved?: string; project?: string; person?: string };

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const showResolved = sp.resolved === "1";
  const projectFilter = sp.project ?? "";

  // Person scope: cookie (set by home-page filter) with `?person=X` as an
  // ephemeral URL override so shared links don't silently hijack the
  // recipient's own scope.
  const scopedPerson = await getScopedPerson(sp.person);

  const [mentionsRes, projectsRes] = await Promise.allSettled([
    getMyMentions(),
    scopedPerson ? getMyProjects() : Promise.resolve(null),
  ]);
  const data =
    mentionsRes.status === "fulfilled" ? mentionsRes.value : undefined;
  const error =
    mentionsRes.status === "rejected"
      ? mentionsRes.reason instanceof Error
        ? mentionsRes.reason.message
        : String(mentionsRes.reason)
      : null;
  const projectsData =
    projectsRes.status === "fulfilled" ? projectsRes.value : null;

  const all = data?.mentions ?? [];

  // Narrow mentions to projects where the scoped person is on the roster.
  // Null = no scope (fallback to showing everything), same stale-cookie
  // safety as app/layout.tsx's nav dropdown.
  const scopedSet = projectsData
    ? scopedProjectNames(projectsData.projects, scopedPerson)
    : null;
  const scoped = scopedSet ? all.filter((m) => scopedSet.has(m.project)) : all;
  const hiddenByScope = all.length - scoped.length;

  const projects = Array.from(new Set(scoped.map((m) => m.project))).sort();
  const visible = scoped.filter((m) => {
    if (!showResolved && m.resolved) return false;
    if (projectFilter && m.project !== projectFilter) return false;
    return true;
  });

  const openCount = scoped.filter((m) => !m.resolved).length;
  const resolvedCount = scoped.filter((m) => {
    if (!m.resolved) return false;
    if (projectFilter && m.project !== projectFilter) return false;
    return true;
  }).length;

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
                🔥 {openCount} פתוחים · {scoped.length} סה&quot;כ
                {scopedPerson && hiddenByScope > 0 && (
                  <> · 👤 סינון: <b>{scopedPerson}</b></>
                )}
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

      {data && scoped.length > 0 && (
        <InboxFilterBar
          projects={projects}
          currentProject={projectFilter}
          showResolved={showResolved}
          resolvedCount={resolvedCount}
        />
      )}

      {data && visible.length === 0 && (
        <div className="empty">
          <span className="emoji" aria-hidden>
            {scoped.length === 0 && all.length === 0 ? "🌿" : "🔍"}
          </span>
          {scoped.length === 0 && all.length === 0
            ? "אף אחד לא תייג אותך עדיין. יום שקט!"
            : scoped.length === 0 && hiddenByScope > 0
              ? `הסינון הנוכחי מסתיר ${hiddenByScope} תיוגים מפרויקטים אחרים.`
              : "אין תיוגים תואמים לסינון הנוכחי."}
        </div>
      )}

      {visible.length > 0 && (
        <ul className="mention-list">
          {visible.map((m) => (
            <MentionCard key={m.comment_id} m={m} />
          ))}
        </ul>
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
        <ThreadReplies
          parentCommentId={resolveTarget}
          project={m.project}
          count={m.reply_count ?? 0}
        />
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
