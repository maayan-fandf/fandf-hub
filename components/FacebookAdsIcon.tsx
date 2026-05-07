/**
 * Facebook brand "f" mark in its standard #1877F2 blue circle.
 * Used as the icon on the "Facebook Ads" deep-link button so the affordance
 * is recognizable at glance instead of leaning on a generic blue-book emoji.
 *
 * Pure presentational, no interactivity — safe in server components.
 * Sized via `size` (defaults to `1em` so it inherits the surrounding
 * font-size, matching how GoogleDriveIcon is used).
 */
export default function FacebookAdsIcon({
  size = "1em",
  className = "",
  title = "Facebook Ads",
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
      <path
        fill="#1877F2"
        d="M24 12c0-6.627-5.373-12-12-12S0 5.373 0 12c0 5.99 4.388 10.954 10.125 11.854V15.469H7.078V12h3.047V9.356c0-3.007 1.792-4.668 4.533-4.668 1.312 0 2.686.234 2.686.234v2.953H15.83c-1.491 0-1.956.925-1.956 1.874V12h3.328l-.532 3.469h-2.796v8.385C19.612 22.954 24 17.99 24 12z"
      />
    </svg>
  );
}
