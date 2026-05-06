"use client";

import { useLightbox } from "./LightboxProvider";

/**
 * Client subcomponent for one tile in the קבצים מהדיון grid. Image
 * files open in the in-app lightbox on click; non-image files keep
 * the existing "open in Drive" behaviour (no useful in-browser
 * preview for PDFs / Sheets / Docs without specialized tooling).
 *
 * Reported by Maayan 2026-05-06.
 */
type Props = {
  fileId: string;
  name: string;
  mimeType: string;
  viewUrl: string;
  thumbnailLink?: string;
  iconLink?: string;
};

export default function TaskAttachmentTile({
  name,
  mimeType,
  viewUrl,
  thumbnailLink,
  iconLink,
}: Props) {
  const { open } = useLightbox();
  const isImage = (mimeType || "").startsWith("image/");

  // Images: render a button-style trigger that opens the lightbox.
  // The thumbnail bytes drive the in-list preview; the lightbox
  // upgrades to the same `viewUrl` Drive serves at fuller resolution
  // when followed (the thumbnail itself is fine for ~most use cases
  // — Drive's own thumbnail endpoint scales up cleanly).
  if (isImage && thumbnailLink) {
    return (
      <button
        type="button"
        className="task-attachment-link task-attachment-trigger"
        onClick={() => open(thumbnailLink, name, viewUrl)}
        title={name}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={thumbnailLink}
          alt={name}
          className="task-attachment-thumb"
          loading="lazy"
        />
        <span className="task-attachment-name">{name}</span>
      </button>
    );
  }

  // Non-image: keep the existing "open in Drive" anchor. No lightbox
  // (no preview value for opaque file types) — Drive's native viewer
  // is still the right destination.
  return (
    <a
      href={viewUrl}
      target="_blank"
      rel="noreferrer"
      className="task-attachment-link"
      title={name}
    >
      {iconLink ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={iconLink}
          alt=""
          className="task-attachment-icon"
          loading="lazy"
        />
      ) : (
        <span className="task-attachment-icon-fallback" aria-hidden>
          📄
        </span>
      )}
      <span className="task-attachment-name">{name}</span>
    </a>
  );
}
