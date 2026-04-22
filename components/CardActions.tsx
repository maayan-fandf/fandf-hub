import ReplyDrawer from "@/components/ReplyDrawer";
import ResolveButton from "@/components/ResolveButton";
import EditDrawer from "@/components/EditDrawer";
import DeleteButton from "@/components/DeleteButton";

type Props = {
  /** Reply / resolve / delete target — usually the thread root. */
  commentId: string;
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
  /** When the parent thread is resolved, the server will reject edits — hide
   *  the ✏️ button to match. Default false. */
  editLocked?: boolean;
  /** When true, the ✓ shows the resolved state as read-only (no un-resolve).
   *  Default false — most places allow toggling. */
  readOnlyWhenResolved?: boolean;
};

/**
 * Unified action row for comment/task/mention cards. Always renders the same
 * four actions in the same order (RTL): השב · סמן כפתור · ערוך · מחק. Icons
 * only, with Hebrew tooltips. Callers omit buttons they don't want by passing
 * `canReply={false}` / `editLocked={true}`.
 */
export default function CardActions({
  commentId,
  resolved,
  body,
  deleteItemLabel,
  editCommentId,
  canReply = true,
  editLocked = false,
  readOnlyWhenResolved = false,
}: Props) {
  return (
    <div className="card-actions">
      {canReply && <ReplyDrawer parentCommentId={commentId} iconOnly />}
      <ResolveButton
        commentId={commentId}
        resolved={resolved}
        readOnlyWhenResolved={readOnlyWhenResolved}
        iconOnly
      />
      <EditDrawer
        commentId={editCommentId ?? commentId}
        initialBody={body}
        locked={editLocked || resolved}
        iconOnly
      />
      <DeleteButton
        commentId={commentId}
        itemLabel={deleteItemLabel}
        iconOnly
      />
    </div>
  );
}
