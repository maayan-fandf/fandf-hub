import { listTaskAttachments } from "@/lib/taskUpload";
import GoogleDriveIcon from "@/components/GoogleDriveIcon";
import TaskAttachmentsDropzone from "@/components/TaskAttachmentsDropzone";

type Props = {
  taskId: string;
  taskTitle: string;
  driveFolderId: string;
  driveFolderUrl?: string;
};

/**
 * Renders the contents of the task's attachments subfolder — the
 * dedicated subfolder inside the task's Drive folder where the
 * discussion composer uploads pasted screenshots and dragged files.
 *
 * Always renders a heading + folder link, even with zero files,
 * so the קבצים tab in the in-page nav has visible content to scroll
 * to (the previous component returned null on empty, which made the
 * tab feel dead).
 */
export default async function TaskAttachments({
  taskId,
  taskTitle,
  driveFolderId,
  driveFolderUrl,
}: Props) {
  if (!driveFolderId) {
    return (
      <div className="task-attachments task-attachments-empty">
        <h3>📁 קבצים מהדיון</h3>
        <p className="muted">למשימה זו עוד אין תיקיית Drive.</p>
      </div>
    );
  }

  // Best-effort listing — render the heading even on failure so the
  // tab anchor isn't an empty section.
  let result: Awaited<ReturnType<typeof listTaskAttachments>> = {
    folderId: "",
    folderUrl: "",
    files: [],
  };
  let error = "";
  try {
    result = await listTaskAttachments("", driveFolderId, taskId, taskTitle);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const folderLink = result.folderUrl || driveFolderUrl || "";

  return (
    <TaskAttachmentsDropzone taskId={taskId} enabled={!!driveFolderId}>
    <div className="task-attachments">
      <header className="task-attachments-head">
        <h3>📁 קבצים מהדיון</h3>
        {folderLink && (
          <a
            href={folderLink}
            target="_blank"
            rel="noreferrer"
            className="task-attachments-folder-link"
          >
            <GoogleDriveIcon size="1em" /> פתח תיקייה
          </a>
        )}
      </header>

      {error && (
        <div className="task-attachments-error">
          לא ניתן לטעון קבצים: {error}
        </div>
      )}

      {!error && result.files.length === 0 && (
        <p className="task-attachments-empty-hint muted">
          אין עדיין קבצים מהדיון. גרור/י לכאן קובץ, או הדבק/י צילום באזור הדיון, והוא יישמר כאן.
        </p>
      )}

      {result.files.length > 0 && (
        <ul className="task-attachments-grid">
          {result.files.map((f) => {
            const isImage = (f.mimeType || "").startsWith("image/");
            return (
              <li key={f.fileId} className="task-attachment">
                <a
                  href={f.viewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="task-attachment-link"
                  title={f.name}
                >
                  {isImage && f.thumbnailLink ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={f.thumbnailLink}
                      alt={f.name}
                      className="task-attachment-thumb"
                      loading="lazy"
                    />
                  ) : f.iconLink ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={f.iconLink}
                      alt=""
                      className="task-attachment-icon"
                      loading="lazy"
                    />
                  ) : (
                    <span className="task-attachment-icon-fallback" aria-hidden>
                      📄
                    </span>
                  )}
                  <span className="task-attachment-name">{f.name}</span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
    </TaskAttachmentsDropzone>
  );
}
