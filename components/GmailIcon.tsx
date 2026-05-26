/**
 * Gmail brand glyph (the envelope with the colored M), inlined as SVG.
 * Reproduces the well-known four-color envelope mark — red top-bar,
 * white envelope body, blue + green + yellow + red M strokes. Used
 * inside the user hover-card's Email action button so it reads as
 * "Gmail" rather than the generic "envelope" emoji.
 *
 * Pure presentational. Sized via `size` (defaults to `1em`).
 */
export default function GmailIcon({
  size = "1em",
  className = "",
  title = "Gmail",
}: {
  size?: string | number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={title}
      style={{ flexShrink: 0 }}
    >
      <title>{title}</title>
      {/* Blue left-side panel */}
      <path
        fill="#4285F4"
        d="M2 8.4v9.1A1.5 1.5 0 0 0 3.5 19H6V11L2 8.4z"
      />
      {/* Green right-side panel */}
      <path
        fill="#34A853"
        d="M18 11v8h2.5a1.5 1.5 0 0 0 1.5-1.5V8.4L18 11z"
      />
      {/* Red diagonal fold (top crease) */}
      <path
        fill="#EA4335"
        d="M2 8.4 6 11l6-4.4L18 11l4-2.6V6.5A1.5 1.5 0 0 0 20.5 5h-17A1.5 1.5 0 0 0 2 6.5v1.9z"
      />
      {/* Yellow inner V (the M's center) */}
      <path
        fill="#FBBC04"
        d="M6 11v8h12v-8L12 15.4 6 11z"
      />
      {/* Red top accent — the small triangle that bumps over the envelope */}
      <path
        fill="#C5221F"
        d="M22 6.5V8.4l-4 2.6V6.6L20.5 5A1.5 1.5 0 0 1 22 6.5zM2 6.5V8.4l4 2.6V6.6L3.5 5A1.5 1.5 0 0 0 2 6.5z"
      />
    </svg>
  );
}
