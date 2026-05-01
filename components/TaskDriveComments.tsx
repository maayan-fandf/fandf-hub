import { listTaskDriveComments } from "@/lib/driveComments";
import { auth } from "@/auth";
import { formatDateIso } from "@/lib/dateFormat";

type Props = {
  taskId: string;
  driveFolderId: string;
  driveFolderUrl?: string;
};

/**
 * Read-only mirror of Drive comments left on files inside the task's
 * Drive folder. Each file with comments gets a header; threads list
 * top-level comments with replies indented underneath. Each thread
 * deep-links to the Drive view at the comment's anchor.
 *
 * Server component — fetches via SA on render. 60s in-process cache
 * absorbs rapid revisits without rate-eating Drive.comments.list.
 */
export default async function TaskDriveComments({
  taskId,
  driveFolderId,
  driveFolderUrl,
}: Props) {
  void taskId;
  if (!driveFolderId) return null;

  const session = await auth();
  const subjectEmail = session?.user?.email || "";
  if (!subjectEmail) return null;

  const files = await listTaskDriveComments(subjectEmail, driveFolderId).catch(
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return { error: msg } as const;
    },
  );

  if ("error" in files) {
    return (
      <section className="drive-comments-section">
        <h3>תגובות מ‑Drive</h3>
        <div className="drive-comments-error">
          לא ניתן לטעון תגובות מ‑Drive: {files.error}
        </div>
      </section>
    );
  }

  if (files.length === 0) return null;

  const totalComments = files.reduce(
    (n, f) => n + f.threads.length + f.threads.reduce((m, t) => m + t.replies.length, 0),
    0,
  );

  return (
    <section className="drive-comments-section">
      <header className="drive-comments-head">
        <h3>
          🖼️ תגובות מ‑Drive{" "}
          <span className="drive-comments-count">({totalComments})</span>
        </h3>
        {driveFolderUrl && (
          <a
            href={driveFolderUrl}
            target="_blank"
            rel="noreferrer"
            className="drive-comments-folder-link"
          >
            פתח תיקייה ↗
          </a>
        )}
      </header>

      {files.map((file) => (
        <div key={file.fileId} className="drive-comments-file">
          <div className="drive-comments-file-head">
            {file.thumbnailLink ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="drive-comments-thumb"
                src={file.thumbnailLink}
                alt=""
                loading="lazy"
              />
            ) : file.iconLink ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="drive-comments-icon"
                src={file.iconLink}
                alt=""
                loading="lazy"
              />
            ) : null}
            <a
              href={file.webViewLink}
              target="_blank"
              rel="noreferrer"
              className="drive-comments-file-name"
            >
              {file.fileName}
            </a>
            <span className="drive-comments-thread-count">
              {file.threads.length} שרשורים
            </span>
          </div>

          <ul className="drive-comments-thread-list">
            {file.threads.map((t) => (
              <li
                key={t.id}
                className={`drive-comments-thread${t.resolved ? " is-resolved" : ""}`}
              >
                <CommentBubble
                  authorName={t.authorName}
                  authorPhoto={t.authorPhoto}
                  content={t.content}
                  createdTime={t.createdTime}
                  modifiedTime={t.modifiedTime}
                  quotedSnippet={t.quotedSnippet}
                  driveDeepLink={t.driveDeepLink}
                  resolved={t.resolved}
                />
                {t.replies.length > 0 && (
                  <ul className="drive-comments-replies">
                    {t.replies.map((r) => (
                      <li key={r.id}>
                        <CommentBubble
                          authorName={r.authorName}
                          authorPhoto={r.authorPhoto}
                          content={r.content}
                          createdTime={r.createdTime}
                          modifiedTime={r.modifiedTime}
                          driveDeepLink={t.driveDeepLink}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function CommentBubble({
  authorName,
  authorPhoto,
  content,
  createdTime,
  modifiedTime,
  quotedSnippet,
  driveDeepLink,
  resolved,
}: {
  authorName: string;
  authorPhoto?: string;
  content: string;
  createdTime: string;
  modifiedTime?: string;
  quotedSnippet?: string;
  driveDeepLink: string;
  resolved?: boolean;
}) {
  const edited = modifiedTime && modifiedTime !== createdTime;
  return (
    <div className="drive-comment-bubble">
      <div className="drive-comment-head">
        {authorPhoto ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="drive-comment-avatar"
            src={authorPhoto}
            alt=""
            loading="lazy"
          />
        ) : (
          <span className="drive-comment-avatar drive-comment-avatar-fallback">
            {authorName.slice(0, 1)}
          </span>
        )}
        <span className="drive-comment-author">{authorName}</span>
        <span className="drive-comment-time" title={createdTime}>
          {formatRelative(createdTime)}
        </span>
        {edited && (
          <span
            className="chip chip-muted"
            title={`נערך ${formatRelative(modifiedTime!)}`}
          >
            📝 נערך
          </span>
        )}
        {resolved && (
          <span className="chip chip-resolved" title="סומן כפתור">
            ✓ נסגר
          </span>
        )}
        <span className="drive-comment-spacer" />
        <a
          href={driveDeepLink}
          target="_blank"
          rel="noreferrer"
          className="drive-comment-deep-link"
          title="פתח ב‑Drive עם התגובה מסומנת"
        >
          פתח ב‑Drive ↗
        </a>
      </div>
      {quotedSnippet && (
        <blockquote className="drive-comment-quote">{quotedSnippet}</blockquote>
      )}
      <div className="drive-comment-body">
        {content.split("\n").map((line, i) => (
          <p key={i} dir="auto">{line}</p>
        ))}
      </div>
    </div>
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
  return formatDateIso(iso);
}
