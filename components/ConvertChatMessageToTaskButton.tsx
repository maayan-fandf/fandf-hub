import Link from "next/link";

/**
 * "Convert this Chat message → hub task" button. Server component —
 * just an anchor that deeplinks to /tasks/new with the message
 * body / title / source prefilled via search params.
 *
 * The Chat-message version of "המר למשימה" we already have on hub-
 * Comments cards (ConvertToTaskButton). Different code path because
 * Chat messages don't live in the hub Comments sheet — there's no
 * comment_id to point at, so we pass the body content directly via
 * URL params instead of via from_comment.
 *
 * Body shape sent to /tasks/new:
 *   - project        — project name (always)
 *   - title          — first line of message body, capped at 60 chars
 *   - body           — full message text + a back-pointer link to
 *                      the Chat thread for traceability
 */
export default function ConvertChatMessageToTaskButton({
  project,
  messageText,
  authorName,
  chatSpaceUrl,
}: {
  project: string;
  messageText: string;
  authorName: string;
  chatSpaceUrl: string;
}) {
  // Build the prefill body — original message + a metadata footer so
  // the resulting task carries enough context to act on without
  // needing to look back at the original Chat thread.
  const cleanedText = messageText.trim();
  const firstLine = cleanedText.split("\n")[0].slice(0, 60).trim();
  const lines: string[] = [];
  lines.push(cleanedText);
  if (authorName || chatSpaceUrl) {
    lines.push("");
    if (authorName) lines.push(`— נכתב על ידי: ${authorName}`);
    if (chatSpaceUrl) lines.push(`— מקור (חלל הצ׳אט): ${chatSpaceUrl}`);
  }
  const body = lines.join("\n");

  const qs = new URLSearchParams();
  qs.set("project", project);
  if (firstLine) qs.set("title", firstLine);
  qs.set("body", body);

  return (
    <Link
      href={`/tasks/new?${qs.toString()}`}
      className="chat-message-action chat-message-convert"
      title="המר את ההודעה הזו למשימה ב-Hub"
      aria-label="המר למשימה"
    >
      📋
    </Link>
  );
}
