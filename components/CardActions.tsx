import ReplyDrawer from "@/components/ReplyDrawer";
import ResolveButton from "@/components/ResolveButton";
import EditDrawer from "@/components/EditDrawer";
import DeleteButton from "@/components/DeleteButton";
import ConvertToTaskButton from "@/components/ConvertToTaskButton";

type Props = {
  /** Reply / resolve / delete target — usually the thread root. */
  commentId: string;
  /** Project the comment lives on. Forwarded to ReplyDrawer to enable
   *  file attachments on replies (uploads land in <project>/הערות/).
   *  Optional for callers that don't have project context. */
  project?: string;
  /** Current resolved state — drives the ✓ button's active styling. */
  resolved: boolean;
  /** Body of the comment, needed by EditDrawer to pre-fill the textarea. */
  body: string;
  /** Label inserted into the delete-confirmation prompt. "את התגובה" / "את
   *  התיוג" / "את המשימה". */
  deleteItemLabel: string;
  /** Comment whose body ✏️ edits — defaults to `commentId`. For mention-list
   *  contexts where resolve/delete act on the thread root but edit should
   *  still target the specific mention body, pass the mention's own id here. */
  editCommentId?: string;
  /** Whether this card can be replied to. Replies-of-replies aren't allowed,
   *  and some contexts (preview-only views) skip reply too. Default true. */
  canReply?: boolean;
  /** Hard lock on the ✏️ button regardless of resolved state. Default
   *  false; no caller currently sets it true. */
  editLocked?: boolean;
  /** Allow editing even when the thread is resolved. Discussion comments
   *  pass this (a user may edit their OWN message after it's resolved —
   *  the `canEdit` author-gate still applies). Task cards leave it false so
   *  a done task stays locked. Default false. */
  allowEditWhenResolved?: boolean;
  /** Whether the viewer may edit this comment's body. The server only lets
   *  the author (or an admin) edit — when the viewer is neither, hide the
   *  ✏️ button instead of showing one that errors on save. Default true so
   *  callers without author context (and the server guard) keep working. */
  canEdit?: boolean;
  /** When true, the ✓ shows the resolved state as read-only (no un-resolve).
   *  Default false — most places allow toggling. */
  readOnlyWhenResolved?: boolean;
  /** Whether to surface the "📋 המר למשימה" promote-to-task button. Comments
   *  + mentions get it; task cards (which use the same row) don't, since
   *  converting a task into a task makes no sense. Default true. */
  canConvertToTask?: boolean;
};

/**
 * Unified action row for comment/task/mention cards. Always renders the same
 * four actions in the same order (RTL): השב · סמן כפתור · ערוך · מחק. Icons
 * only, with Hebrew tooltips. Callers omit buttons they don't want by passing
 * `canReply={false}` / `editLocked={true}`.
 */
export default function CardActions({
  commentId,
  project,
  resolved,
  body,
  deleteItemLabel,
  editCommentId,
  canReply = true,
  editLocked = false,
  allowEditWhenResolved = false,
  readOnlyWhenResolved = false,
  canConvertToTask = true,
  canEdit = true,
}: Props) {
  return (
    <div className="card-actions">
      {canReply && (
        <ReplyDrawer parentCommentId={commentId} project={project} iconOnly />
      )}
      <ResolveButton
        commentId={commentId}
        resolved={resolved}
        readOnlyWhenResolved={readOnlyWhenResolved}
        iconOnly
      />
      {canEdit && (
        <EditDrawer
          commentId={editCommentId ?? commentId}
          initialBody={body}
          locked={editLocked || (resolved && !allowEditWhenResolved)}
          iconOnly
          project={project}
        />
      )}
      {canConvertToTask && (
        <ConvertToTaskButton commentId={editCommentId ?? commentId} />
      )}
      <DeleteButton
        commentId={commentId}
        itemLabel={deleteItemLabel}
        iconOnly
      />
    </div>
  );
}
