import Link from "next/link";
import Avatar from "@/components/Avatar";
import InternalChatComposer from "@/components/InternalChatComposer";
import ChatReactionsRow from "@/components/ChatReactionsRow";
import CreateChatSpaceButton from "@/components/CreateChatSpaceButton";
import {
  listRecentMessages,
  lookupUserGaiaResource,
  parseSpaceId,
  chatSpaceUrlFromSpaceId,
  type ChatMessage,
} from "@/lib/chat";
import { formatDateIso } from "@/lib/dateFormat";

/**
 * Server-rendered "🔒 דיון פנימי" tab — surfaces the project's
 * Google Chat space inside the hub. Read-only mirror in phase 1: we
 * fetch the most recent ~20 messages via Chat REST and render them
 * as a compact list, with a big "פתח בצ׳אט" deeplink for actually
 * replying. Internal team types in Chat (where they already live);
 * the hub shows enough context to scan recent activity without
 * tabbing away.
 *
 * Empty / unconfigured states all degrade gracefully:
 *   - No webhook URL on Keys col L → renders setup hint, not error
 *   - Chat API not enabled / scope missing → renders empty list +
 *     setup hint (the chat helpers swallow + log the error)
 *   - User isn't a space member → empty list (impersonated read sees
 *     zero messages, which matches their actual access)
 *
 * Wrapped in <Suspense> on the project page so the Chat fetch (~300–
 * 800ms) doesn't block the rest of the page from rendering.
 */
export default async function InternalDiscussionTab({
  subjectEmail,
  spaceUrlOrWebhook,
  showOnlyMine,
  myEmail,
  myDisplayNames,
  projectName,
  isAdmin,
}: {
  subjectEmail: string;
  /** Either the raw Chat webhook URL (from Keys col L) or the derived
   *  deeplink (`mail.google.com/chat/space/...`). `parseSpaceId`
   *  handles both shapes. */
  spaceUrlOrWebhook: string;
  /** When true, filter to messages where the user is mentioned —
   *  drives the תיוגים שלי toggle on the internal tab. */
  showOnlyMine: boolean;
  /** Lowercase session email — used to compute "my mentions" against
   *  the displayName-based annotation list. */
  myEmail: string;
  /** Lowercase display-name strings the user goes by in Chat. The
   *  Chat API surfaces userMention.displayName (not email), so we
   *  compare against the user's known names. Empty array falls back
   *  to email-prefix matching. */
  myDisplayNames: string[];
  /** Project name, threaded down to the composer + convert-button so
   *  they know where to post / scope the new task. */
  projectName: string;
  /** When true and the project has no Chat Space configured, the
   *  empty state offers a one-click "create chat space" button.
   *  /api/worktasks/project-space-create is admin-gated server-side
   *  too — this just hides the affordance from non-admins. */
  isAdmin: boolean;
}) {
  const spaceId = parseSpaceId(spaceUrlOrWebhook);
  if (!spaceId) {
    return (
      <div className="discussion-empty">
        <p>
          לא הוגדר חלל Chat לפרויקט זה.{" "}
          <span className="discussion-empty-hint">
            פתח את חלל הצ׳אט של הפרויקט, העתק את קישור החלל (▾ ליד שם
            החלל → &quot;העתק קישור&quot;) והדבק לעמודה <b>Chat Space</b>{" "}
            (col L) בגיליון Keys לשורת הפרויקט. אפשר גם להדביק URL של
            webhook אם הוגדר. הסנכרון יתחיל לפעול תוך 5 דקות (קאש).
          </span>
        </p>
        {isAdmin && (
          <CreateChatSpaceButton projectName={projectName} />
        )}
      </div>
    );
  }

  const all = await listRecentMessages(subjectEmail, spaceId, 50);

  // Drop auto-emitted task cross-posts. Two historical write paths
  // mirrored task activity into the project Chat space:
  //   - Task-comment replies: '↩️ *<author>* הגיב/ה לשרשור בפרויקט *X*\n«excerpt»\nפתח בהאב → /tasks/<id>'
  //     (lib/commentsWriteDirect.ts; gated 2026-05-01 in commit 48dfa5d)
  //   - Task create + status transitions: '📋|✅|💬 <author> יצר/ה|סיים/ה|הגיב/ה: <title>\n<base>/tasks/<id>'
  //     (lib/tasksWriteDirect.ts; removed entirely 2026-05-01)
  // Both surface as noise in the project chat tab — the canonical
  // surface for task activity is /tasks/<id>, the bell, and emails.
  // Existing chat-space history still has these cards (~50-msg
  // window), so we hide them at render. Match: starts with one of
  // the auto-emit emojis AND contains a /tasks/<id> deep link.
  // Defensive against any future write-side regression too.
  const AUTO_EMIT_PREFIXES = ["↩️", "✅", "📋", "💬"];
  const isTaskCrossPost = (m: ChatMessage): boolean => {
    const text = m.text || "";
    if (!AUTO_EMIT_PREFIXES.some((p) => text.startsWith(p))) return false;
    return /\/tasks\/[\w-]+/.test(text);
  };
  const filteredAll = all.filter((m) => !isTaskCrossPost(m));

  const spaceUrl = chatSpaceUrlFromSpaceId(spaceId);
  // Resolve the current user's Chat user resource so renderMessage
  // can decide whether to show edit (only on messages they authored).
  // Cached 1h in-process — usually 0ms after first hit per process.
  const currentUserResource = await lookupUserGaiaResource(
    subjectEmail,
    myEmail,
  );

  // "תיוגים שלי" filter — match the message's mention displayNames
  // against the user's known display names (or fall back to email
  // prefix when no display-name list is supplied). The Chat API
  // doesn't expose mention emails directly; full email-based filter
  // is a phase-2 enhancement once we have a user-directory lookup.
  const myKey = myEmail.split("@")[0].toLowerCase();
  const candidates = (
    myDisplayNames.length > 0
      ? myDisplayNames.map((n) => n.toLowerCase())
      : [myKey]
  ).filter(Boolean);
  const matchesMention = (m: ChatMessage) =>
    m.mentionEmails.some((mn) => candidates.some((c) => mn.includes(c)));

  // Group messages by thread. Each thread is a {parent, replies}
  // tuple — first message by createTime is the parent, rest are
  // replies. Top-level messages with no replies render as a "thread"
  // with empty replies — same render path, no special-case branch.
  const threadMap = new Map<string, ChatMessage[]>();
  for (const m of filteredAll) {
    const tname = m.threadName || m.name;
    const list = threadMap.get(tname);
    if (list) list.push(m);
    else threadMap.set(tname, [m]);
  }
  type Thread = {
    parent: ChatMessage;
    replies: ChatMessage[];
    hasMention: boolean;
  };
  const threads: Thread[] = [];
  threadMap.forEach((list) => {
    // Sort thread members oldest-first so the parent is at index 0
    // and replies fall after in the order they were posted.
    const sorted = list
      .slice()
      .sort((a, b) => a.createTime.localeCompare(b.createTime));
    const hasMention = sorted.some(matchesMention);
    threads.push({ parent: sorted[0], replies: sorted.slice(1), hasMention });
  });

  // Filter at thread granularity for "תיוגים שלי" — we want to keep
  // the thread parent for context even when only the reply mentions
  // the user. Otherwise `false=>true` on hasMention drops the whole
  // thread.
  const visible = showOnlyMine ? threads.filter((t) => t.hasMention) : threads;

  // Newest-thread-first in the array — column-reverse on the list
  // visually anchors the newest at the bottom (next to the composer).
  visible.sort((a, b) => b.parent.createTime.localeCompare(a.parent.createTime));

  // Total message count across all visible threads — drives the
  // empty state label more honestly than counting threads.
  const totalRendered = visible.reduce(
    (n, t) => n + 1 + t.replies.length,
    0,
  );

  return (
    <div className="discussion-internal">
      <div className="discussion-internal-head">
        <span className="discussion-internal-hint">
          הודעות אחרונות מתוך חלל הצ׳אט הפנימי. אפשר לכתוב כאן או דרך הצ׳אט.
        </span>
      </div>
      {totalRendered === 0 ? (
        <div className="discussion-empty">
          {showOnlyMine
            ? "אין שרשורים אחרונים שתויגת בהם."
            : "אין הודעות עדיין בחלל הזה."}
        </div>
      ) : (
        <ul className="chat-message-list">
          {visible.map((t) => (
            <li key={t.parent.name} className="chat-thread">
              {renderMessage(
                t.parent,
                projectName,
                spaceUrl,
                false,
                currentUserResource,
              )}
              {t.replies.length > 0 && (
                <ul className="chat-thread-replies">
                  {t.replies.map((r) => (
                    <li key={r.name} className="chat-thread-reply">
                      {renderMessage(
                        r,
                        projectName,
                        spaceUrl,
                        true,
                        currentUserResource,
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {/* Per-thread reply trigger removed — each message's
                  quick-actions row now includes its own ↩ icon, so
                  the entry point lives where the visual context is.
                  Replying from any message in the thread still
                  posts to the same thread.name. */}
            </li>
          ))}
        </ul>
      )}
      {/* Inline composer — phase 2. Hidden when filtering to "my
          mentions" since posting from a filtered view is confusing
          (the new message wouldn't appear unless it mentions the
          user). Compose-from-Chat still works as the fallback. */}
      {!showOnlyMine && (
        <InternalChatComposer project={projectName} />
      )}
      <div className="discussion-internal-foot">
        <Link href={spaceUrl} className="section-link">
          פתח ב- Google Chat ↗
        </Link>
      </div>
    </div>
  );
}

/**
 * Render one Chat message — the parent of a thread or one of its
 * replies. Same shape either way; the `isReply` flag tweaks visual
 * affordances (smaller avatar, no "convert to task" by default since
 * replies aren't usually the unit of work to capture).
 *
 * Reactions render as inline chips below the body — display only
 * for now; clicking through to Chat is the path to add/remove a
 * reaction. Phase 3 hooks the chips up to the Chat REST reactions
 * endpoint for in-hub interaction.
 */
function renderMessage(
  m: ChatMessage,
  projectName: string,
  spaceUrl: string,
  isReply: boolean,
  currentUserResource: string,
): React.ReactNode {
  const avatarSize = isReply ? 22 : 26;
  const isMine = !!currentUserResource && m.senderResource === currentUserResource;
  return (
    <>
      <Avatar
        name={m.senderName || m.senderResource || m.name}
        title={m.senderName || m.senderResource}
        size={avatarSize}
      />
      <div className="chat-message-body">
        <div className="chat-message-head">
          <span className="chat-message-author">
            {m.senderName || "לא ידוע"}
          </span>
          <span className="chat-message-time" title={m.createTime}>
            {formatRelative(m.createTime)}
          </span>
        </div>
        {/* dir="auto" lets the browser pick direction per message
            based on the first strong character (Hebrew → RTL, Latin
            → LTR). Without it every message renders RTL because the
            page is dir="rtl", which mangles English snippets like
            code blocks or URLs that the user pasted in. */}
        <div className="chat-message-text" dir="auto">
          {renderChatText(m.text)}
        </div>
        {m.attachments.length > 0 && (
          <div className="chat-message-attachments">
            {m.attachments.map((a, i) => {
              const imgUrl =
                a.thumbnailUri ||
                (a.driveFileId
                  ? `https://lh3.googleusercontent.com/d/${a.driveFileId}=w800`
                  : "");
              return a.isImage && imgUrl ? (
                <a
                  key={i}
                  href={spaceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="chat-message-image-link"
                  title={a.contentName || "תמונה מצורפת"}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imgUrl}
                    alt={a.contentName || "image"}
                    loading="lazy"
                    className="chat-message-image"
                  />
                </a>
              ) : (
                <a
                  key={i}
                  href={spaceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="chat-message-attachment-link"
                  title={a.contentType}
                >
                  📎 {a.contentName || a.contentType || "קובץ"}
                </a>
              );
            })}
          </div>
        )}
        {/* Per-message quick-actions row — reaction chips + + (react)
            + ↩ (reply) + 📋 (convert to task) + ✏️ (edit, own) + 🗑️
            (delete, own). All five actions live inline, mirroring the
            client-tab CardActions pattern. Always rendered, even on
            messages with no reactions, so the entry points are
            always available. */}
        <ChatReactionsRow
          messageName={m.name}
          reactions={m.reactions}
          project={projectName}
          threadName={m.threadName || m.name}
          text={m.text}
          isMine={isMine}
          spaceUrl={spaceUrl}
          authorName={m.senderName || ""}
        />
      </div>
    </>
  );
}

/**
 * Tiny text renderer for Chat's basic markup. Chat's text field uses
 * a subset of Markdown — `*bold*`, `_italic_`, `` `code` `` — and
 * auto-links bare URLs. We render auto-links here; bold/italic/code
 * stay as plain text for now (low-leverage, can add later).
 *
 * Filters out our own "פתח בהאב → <hub url>" footer line — that's
 * the cross-stream-signal back-pointer we add when posting client-tab
 * activity into the internal Chat space. The link is useful FOR Chat
 * users (clicks back to the hub thread), but redundant noise when
 * the same message renders inside the hub itself.
 */
function renderChatText(text: string): React.ReactNode {
  if (!text) return null;
  const lines = text
    .split("\n")
    .filter((line) => !/^\s*פתח בהאב\s*→/.test(line));
  // dir="auto" on EACH paragraph (not the parent) so multi-line
  // mixed-language messages render each line per its own first-
  // strong character. With dir="auto" only on the parent, a message
  // that starts with Hebrew ends up rendering its later English
  // lines inside an RTL container — periods at line starts, words
  // glued to the wrong margin, etc.
  return lines.map((line, i) => (
    <p key={i} className="chat-message-line" dir="auto">
      {tokenizeLine(line)}
    </p>
  ));
}

const URL_RE = /https?:\/\/[^\s)]+/g;

function tokenizeLine(line: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(line)) !== null) {
    if (m.index > lastIndex) {
      out.push(line.slice(lastIndex, m.index));
    }
    out.push(
      <a
        key={`u-${m.index}`}
        href={m[0]}
        target="_blank"
        rel="noreferrer"
      >
        {m[0]}
      </a>,
    );
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < line.length) {
    out.push(line.slice(lastIndex));
  }
  return out;
}

function formatRelative(iso: string): string {
  if (!iso) return "";
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
  return formatDateIso(iso);
}
