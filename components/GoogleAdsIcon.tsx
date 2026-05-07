/**
 * Google Ads brand mark — the post-2018 yellow + blue overlapping triangle
 * pair. Inlined as SVG so it renders crisp at any size and inherits theme
 * transitions without an extra HTTP request.
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
      viewBox="0 0 192 192"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={title}
      style={{ flexShrink: 0 }}
    >
      <title>{title}</title>
      {/* Larger blue parallelogram — represents the "Ads" delivery beam */}
      <path
        fill="#4285F4"
        d="M167.3 168.8c-2.6 4.6-8.5 6.2-13.1 3.4L18.6 95.9c-4.6-2.7-6.2-8.5-3.4-13.1L88.5 9.4c2.7-4.6 8.5-6.2 13.1-3.4l135.6 76.3c4.6 2.7 6.2 8.5 3.4 13.1L167.3 168.8z"
      />
      {/* Yellow triangle in front — the "ad" indicator */}
      <path
        fill="#FBBC04"
        d="M76 143.7l-37.9 21.9c-4.7 2.7-10.5 1.1-13.3-3.5L8.5 135c-2.7-4.7-1.1-10.5 3.5-13.3l37.9-21.9c4.7-2.7 10.5-1.1 13.3 3.5l16.4 28.4c2.6 4.7.9 10.5-3.6 13z"
      />
      {/* Green dot — the "click / outcome" marker */}
      <circle cx="153" cy="153" r="20" fill="#34A853" />
    </svg>
  );
}
