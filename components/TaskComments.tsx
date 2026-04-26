import Avatar from "./Avatar";
import TaskReplyComposer from "./TaskReplyComposer";
import EditDrawer from "./EditDrawer";
import DeleteButton from "./DeleteButton";
import { getTaskComments } from "@/lib/appsScript";

type Props = {
  taskId: string;
};

export default async function TaskComments({ taskId }: Props) {
  const data = await getTaskComments(taskId).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg } as const;
  });

  if ("error" in data) {
    return (
      <section className="task-detail-comments">
        <h3>דיון</h3>
        <div className="task-comments-error">שגיאה בטעינת תגובות: {data.error}</div>
      </section>
    );
  }

  const { comments, me } = data;
  const project = data.project || "";
  const myEmail = (me?.email || "").toLowerCase();
  const isAdmin = !!me?.isAdmin;

  return (
    <section className="task-detail-comments">
      <h3>
        דיון{" "}
        <span className="task-comments-count">
          {comments.length > 0 ? `(${comments.length})` : ""}
        </span>
      </h3>

      {comments.length === 0 && (
        <div className="task-comments-empty">אין תגובות עדיין — התחל את הדיון.</div>
      )}

      {comments.length > 0 && (
        <ul className="task-comments-list">
          {comments.map((c) => {
            const canEdit =
              !!myEmail && c.author_email.toLowerCase() === myEmail;
            const canDelete = canEdit || isAdmin;
            return (
              <li key={c.comment_id} className="thread-reply">
                <Avatar
                  name={c.author_email}
                  title={c.author_name || c.author_email}
                  size={26}
                />
                <div className="thread-reply-body">
                  <div className="thread-reply-head">
                    <span className="thread-reply-author">
                      {c.author_name || c.author_email}
                    </span>
                    <span className="thread-reply-time" title={c.timestamp}>
                      {formatRelative(c.timestamp)}
                    </span>
                    {c.edited_at && (
                      <span
                        className="chip chip-muted"
                        title={`נערך ${formatRelative(c.edited_at)}`}
                      >
                        📝 נערך
                      </span>
                    )}
                    {(canEdit || canDelete) && (
                      <span className="thread-reply-actions">
                        {canEdit && (
                          <EditDrawer
                            commentId={c.comment_id}
                            initialBody={c.body}
                            iconOnly
                          />
                        )}
                        {canDelete && (
                          <DeleteButton
                            commentId={c.comment_id}
                            itemLabel="את ההערה"
                            iconOnly
                          />
                        )}
                      </span>
                    )}
                  </div>
                  <div className="thread-reply-text">{renderBody(c.body)}</div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <TaskReplyComposer taskId={taskId} project={project} />
    </section>
  );
}

/**
 * Render a comment body as a series of paragraphs. Each line is scanned
 * for our two markdown-ish tokens:
 *   - `![alt](url)` → inline image (URL whitelisted to drive.google.com)
 *   - `[label](url)` → anchor link (URL whitelisted to trusted hosts)
 *
 * Any URL that doesn't match the whitelist is rendered as plain text —
 * avoids rendering arbitrary `javascript:` / tracking-pixel hosts if
 * someone ever types a token into a comment body by hand.
 */
function renderBody(body: string): React.ReactNode {
  const lines = body.split("\n");
  return lines.map((line, i) => {
    const parts = tokenizeLine(line);
    if (parts.length === 1 && parts[0].kind === "text") {
      // Preserve the existing "one <p> per line" layout including blank lines.
      return <p key={i}>{parts[0].text}</p>;
    }
    // If the line is a single image token, break it out of <p> so the
    // image can expand to its natural block size.
    if (parts.length === 1 && parts[0].kind === "image") {
      return renderPart(parts[0], `${i}-0`);
    }
    return (
      <p key={i}>
        {parts.map((p, j) => (
          <span key={`${i}-${j}`}>{renderPart(p, `${i}-${j}`)}</span>
        ))}
      </p>
    );
  });
}

type Part =
  | { kind: "text"; text: string }
  | { kind: "image"; alt: string; viewUrl: string; embedUrl: string }
  | { kind: "link"; label: string; url: string };

const IMG_RE = /!\[([^\]\n]*)\]\(([^)\s]+)\)/;
const LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)/;

function tokenizeLine(line: string): Part[] {
  const out: Part[] = [];
  let rest = line;
  while (rest.length) {
    const imgMatch = rest.match(IMG_RE);
    const linkMatch = rest.match(LINK_RE);
    let chosen: { idx: number; len: number; part: Part } | null = null;
    if (imgMatch && typeof imgMatch.index === "number") {
      const [whole, alt, url] = imgMatch;
      const img = toImagePart(alt, url);
      if (img) chosen = { idx: imgMatch.index, len: whole.length, part: img };
    }
    if (linkMatch && typeof linkMatch.index === "number") {
      // Skip link matches that are actually image prefixes.
      const isImagePrefix = linkMatch.index > 0 && rest[linkMatch.index - 1] === "!";
      if (
        !isImagePrefix &&
        (!chosen || linkMatch.index < chosen.idx)
      ) {
        const [whole, label, url] = linkMatch;
        const link = toLinkPart(label, url);
        if (link) chosen = { idx: linkMatch.index, len: whole.length, part: link };
      }
    }
    if (!chosen) {
      out.push({ kind: "text", text: rest });
      break;
    }
    if (chosen.idx > 0) {
      out.push({ kind: "text", text: rest.slice(0, chosen.idx) });
    }
    out.push(chosen.part);
    rest = rest.slice(chosen.idx + chosen.len);
  }
  return out;
}

function toImagePart(alt: string, url: string): Part | null {
  const id = extractDriveFileId(url);
  if (!id) return null;
  return {
    kind: "image",
    alt: alt || "image",
    viewUrl: url,
    embedUrl: `https://lh3.googleusercontent.com/d/${id}=w1600`,
  };
}

function toLinkPart(label: string, url: string): Part | null {
  if (!isSafeUrl(url)) return null;
  return { kind: "link", label, url };
}

function extractDriveFileId(url: string): string | null {
  const m1 = url.match(/^https:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m1) return m1[1];
  const m2 = url.match(/^https:\/\/drive\.google\.com\/.*[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2) return m2[1];
  const m3 = url.match(/^https:\/\/lh3\.googleusercontent\.com\/d\/([a-zA-Z0-9_-]+)/);
  if (m3) return m3[1];
  return null;
}

function isSafeUrl(url: string): boolean {
  if (!/^https:\/\//.test(url)) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return (
      host === "drive.google.com" ||
      host === "lh3.googleusercontent.com" ||
      host === "docs.google.com" ||
      host === "hub.fandf.co.il" ||
      host.endsWith(".fandf.co.il")
    );
  } catch {
    return false;
  }
}

function renderPart(part: Part, key: string): React.ReactNode {
  if (part.kind === "text") return <span key={key}>{part.text}</span>;
  if (part.kind === "image") {
    return (
      <a
        key={key}
        href={part.viewUrl}
        target="_blank"
        rel="noreferrer"
        className="task-comment-image-link"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={part.embedUrl}
          alt={part.alt}
          className="task-comment-image"
          loading="lazy"
        />
      </a>
    );
  }
  return (
    <a key={key} href={part.url} target="_blank" rel="noreferrer">
      {part.label}
    </a>
  );
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
  return new Date(iso).toLocaleDateString("he-IL");
}
