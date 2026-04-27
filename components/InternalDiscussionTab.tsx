import Link from "next/link";
import Avatar from "@/components/Avatar";
import {
  listRecentMessages,
  parseSpaceId,
  chatSpaceUrlFromSpaceId,
} from "@/lib/chat";

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
}) {
  const spaceId = parseSpaceId(spaceUrlOrWebhook);
  if (!spaceId) {
    return (
      <div className="discussion-empty">
        <p>
          לא הוגדר חלל Chat לפרויקט זה.{" "}
          <span className="discussion-empty-hint">
            הוסף webhook ל-Keys col L → Chat Webhook כדי להפעיל את הסנכרון
            הדו-כיווני עם הצוות הפנימי.
          </span>
        </p>
      </div>
    );
  }

  const all = await listRecentMessages(subjectEmail, spaceId, 30);
  const spaceUrl = chatSpaceUrlFromSpaceId(spaceId);

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
  const messages = showOnlyMine
    ? all.filter((m) =>
        m.mentionEmails.some((mn) =>
          candidates.some((c) => mn.includes(c)),
        ),
      )
    : all;

  return (
    <div className="discussion-internal">
      <div className="discussion-internal-head">
        <a
          href={spaceUrl}
          target="_blank"
          rel="noreferrer"
          className="btn-primary btn-sm"
          title="פתח את חלל הצ׳אט בכרטיסייה חדשה"
        >
          💬 פתח בצ׳אט ↗
        </a>
        <span className="discussion-internal-hint">
          הודעות אחרונות מתוך חלל הצ׳אט הפנימי. כתיבה — דרך הצ׳אט.
        </span>
      </div>
      {messages.length === 0 ? (
        <div className="discussion-empty">
          {showOnlyMine
            ? "אין הודעות אחרונות שתויגת בהן."
            : "אין הודעות עדיין בחלל הזה."}
        </div>
      ) : (
        <ul className="chat-message-list">
          {messages.map((m) => (
            <li key={m.name} className="chat-message">
              <Avatar
                name={m.senderName || m.name}
                title={m.senderName}
                size={26}
              />
              <div className="chat-message-body">
                <div className="chat-message-head">
                  <span className="chat-message-author">
                    {m.senderName || "לא ידוע"}
                  </span>
                  <span
                    className="chat-message-time"
                    title={m.createTime}
                  >
                    {formatRelative(m.createTime)}
                  </span>
                </div>
                <div className="chat-message-text">
                  {renderChatText(m.text)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="discussion-internal-foot">
        <Link href={spaceUrl} className="section-link">
          פתח חלל מלא בצ׳אט ↗
        </Link>
      </div>
    </div>
  );
}

/**
 * Tiny text renderer for Chat's basic markup. Chat's text field uses
 * a subset of Markdown — `*bold*`, `_italic_`, `` `code` `` — and
 * auto-links bare URLs. We render bold + auto-links here; italic /
 * code stay as plain text for now (low-leverage, can add later).
 */
function renderChatText(text: string): React.ReactNode {
  if (!text) return null;
  const lines = text.split("\n");
  return lines.map((line, i) => (
    <p key={i} className="chat-message-line">
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
  return new Date(iso).toLocaleDateString("he-IL");
}
