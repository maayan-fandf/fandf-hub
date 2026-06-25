/**
 * Whether `viewerEmail` may edit a comment authored by `authorEmail`.
 *
 * Strict authorship — you only ever edit your OWN message, the rule
 * Maayan asked for ("a user can only edit their own message"). We
 * deliberately do NOT mirror the server's admin override here: an admin
 * (Maayan included) reported seeing the ✏️ on a teammate's message and
 * wanted it gone, so the UI surfaces the edit button only for the author.
 * The server (editCommentDirect) still allows author-OR-admin as a
 * backstop — hiding the button never grants anything; it just stops
 * offering an edit the viewer shouldn't make.
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
