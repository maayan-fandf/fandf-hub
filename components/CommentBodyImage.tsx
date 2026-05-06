"use client";

import { useLightbox } from "./LightboxProvider";

/**
 * Client subcomponent for the image part of a CommentBody render.
 * Replaces the previous `<a target="_blank" href={viewUrl}>` element
 * with a button that opens the in-app lightbox. CommentBody itself
 * stays a server component — only this leaf needs the click handler.
 *
 * The original Drive viewUrl is forwarded to the lightbox so users
 * who DO want the full Drive view (download, comments) can reach it
 * via the lightbox's "פתח ב-Drive" button.
 *
 * Reported by Maayan 2026-05-06: opening Drive in a new tab disrupts
 * the discussion flow when the user just wants a bigger look at a
 * pasted screenshot.
 */
export default function CommentBodyImage({
  alt,
  viewUrl,
  embedUrl,
}: {
  alt: string;
  viewUrl: string;
  embedUrl: string;
}) {
  const { open } = useLightbox();
  return (
    <button
      type="button"
      className="comment-body-image-link comment-body-image-trigger"
      onClick={(e) => {
        // Stop propagation so a parent (e.g. the SortableContext
        // drag listener on TaskFilesPanel tiles) doesn't intercept.
        e.stopPropagation();
        open(embedUrl, alt, viewUrl);
      }}
      title={alt || "הצג תמונה"}
      aria-label={alt || "הצג תמונה"}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={embedUrl}
        alt={alt}
        className="comment-body-image"
        loading="lazy"
      />
    </button>
  );
}
