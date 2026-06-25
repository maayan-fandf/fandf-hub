"use client";

import { useState } from "react";
import type { TasksPerson } from "@/lib/appsScript";
import CommentBody, { wouldTruncate } from "./CommentBody";

/**
 * Client wrapper that makes a truncated CommentBody expandable.
 *
 * The server-rendered CommentBody clips long bodies to `truncateChars`
 * with a trailing ellipsis but offered no way to read the rest — the
 * "…" just sat there (the "read more isn't working" Maayan reported on
 * the project discussion). This restores the expand: when the body is
 * long enough to actually clip (see `wouldTruncate` — bodies with an
 * image/link token always render in full and get NO toggle), a
 * "הצג עוד" / "הצג פחות" button flips between the clipped and full
 * render by toggling `truncateChars` on/off.
 *
 * Drop-in replacement for <CommentBody truncateChars={n} …> at every
 * preview / mention / timeline / inbox site.
 */
export default function CommentBodyExpandable({
  body,
  truncateChars,
  className,
  people,
}: {
  body: string;
  /** Collapsed-state clip length. Required here (the whole point is a
   *  clip that can be expanded). */
  truncateChars: number;
  className?: string;
  people?: TasksPerson[];
}) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = wouldTruncate(body, truncateChars);
  return (
    <>
      <CommentBody
        body={body}
        truncateChars={expanded ? undefined : truncateChars}
        className={className}
        people={people}
      />
      {canExpand && (
        <button
          type="button"
          className="comment-readmore-btn"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? "הצג פחות" : "הצג עוד"}
        </button>
      )}
    </>
  );
}
