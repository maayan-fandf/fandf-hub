/**
 * Whether `viewerEmail` may edit a comment authored by `authorEmail`.
 *
 * Strict authorship: every user may edit their OWN comments / root
 * messages, and nobody else's — the rule Maayan asked for ("a user can
 * only edit their own message"). No admin override: the owner edits his
 * own messages like everyone else. The server (editCommentDirect) is the
 * security backstop; this only governs whether the UI offers the ✏️.
 *
 * Shared by the project discussion (CommentsPreview / MentionsPreview)
 * and the תיוגים inbox so the rule can't drift between surfaces.
 *
 * Empty viewer (logged-out / unknown) → no edit.
 */
export function viewerCanEditComment(
  authorEmail: string,
  viewerEmail: string,
): boolean {
  const v = (viewerEmail || "").toLowerCase().trim();
  if (!v) return false;
  return v === (authorEmail || "").toLowerCase().trim();
}
