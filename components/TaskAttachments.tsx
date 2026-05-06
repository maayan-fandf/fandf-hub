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
 * Visibility rule (2026-05-06): renders ONLY when the subfolder has
 * at least one file (or there's a load error worth surfacing). With
 * the unified TaskFilesPanel rendering above this section for the
 * task's main בריף folder, having an always-visible second "Drive
 * instance" with an empty-state hint felt confusing — readers
 * couldn't tell whether they'd accidentally landed on two different
 * folders. Now: empty subfolder → section is invisible. The chat
 * composer (TaskReplyComposer) still uploads to this same subfolder
 * via paste/drag-drop, and `router.refresh()` after a post will
 * reveal this section as soon as a file lands.
 */
export default async function TaskAttachments({
  taskId,
  taskTitle,
  driveFolderId,
  driveFolderUrl,
}: Props) {
  // Without a parent Drive folder there's nothing to list — and
  // there's no useful affordance for the user here either, so we stay
  // hidden. (The folder is provisioned at task creation; if it's
  // missing that's an upstream issue surfaced elsewhere.)
  if (!driveFolderId) return null;

  // Best-effort listing — surface a load error if it happens, but
  // otherwise stay quiet when the subfolder is empty.
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

  // Empty + no error → don't add a second Drive UI to the page.
  if (!error && result.files.length === 0) return null;

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
