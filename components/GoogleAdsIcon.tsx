/**
 * Google Ads brand mark — two slanted bars forming an "A" with a small
 * green dot at the lower-left, in Google's standard yellow / blue /
 * green palette. Inlined as SVG so it renders crisp at any size and
 * inherits theme transitions without an extra HTTP request.
 *
 * Pure presentational, no interactivity — safe in server components.
 * Sized via `size` (defaults to `1em`).
 */
export default function GoogleAdsIcon({
  size = "1em",
  className = "",
  title = "Google Ads",
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
      {/* Yellow left bar — slanting up-right toward the apex */}
      <path fill="#FBBC04" d="M6 21H3l6-15h3z" />
      {/* Blue right bar — slanting up-left toward the apex */}
      <path fill="#4285F4" d="M18 21h3l-6-15h-3z" />
      {/* Green dot — the "click result" at the lower-left corner */}
      <circle fill="#34A853" cx="3" cy="21" r="1.6" />
    </svg>
  );
}
