import Link from "next/link";

type Props = {
  /** Source comment id. The /tasks/new page reads `?from_comment=<id>`,
   *  fetches the row server-side, and pre-fills the create form's
   *  project / description / assignees / title from it. */
  commentId: string;
  /** Render as the icon-only "📋" trigger that matches the rest of the
   *  CardActions row (השב · סמן · ערוך · מחק · המר). When false,
   *  surfaces a labeled link — useful in contexts that aren't already
   *  using the unified action bar. */
  iconOnly?: boolean;
};

/**
 * Promotes a legacy תגובה (a comment row in the Comments sheet) to a
 * full work-task. Single click → navigates to /tasks/new with the
 * source comment encoded in the URL; that page fetches the row and
 * seeds the create form. The original comment is left untouched —
 * users can resolve it manually after if they want, or keep it as
 * conversation history alongside the spawned task.
 */
export default function ConvertToTaskButton({
  commentId,
  iconOnly = true,
}: Props) {
  const href = `/tasks/new?from_comment=${encodeURIComponent(commentId)}`;
  if (iconOnly) {
    return (
      <Link
        href={href}
        className="card-action"
        title="המר למשימה"
        aria-label="המר למשימה"
      >
        📋
      </Link>
    );
  }
  return (
    <Link href={href} className="btn-ghost btn-sm">
      📋 המר למשימה
    </Link>
  );
}
