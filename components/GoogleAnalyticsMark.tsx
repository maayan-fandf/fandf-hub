/**
 * The Google Analytics mark, inlined.
 *
 * Inlined rather than served as a file so it costs no request and can
 * inherit sizing from the heading it sits in. Colours are GA's own
 * (#f9ab00 / #e37400) and are deliberately NOT themed — a brand mark
 * that shifts hue between light and dark stops reading as the brand.
 *
 * `aria-hidden` because it always sits beside the section's own text
 * label; announcing "Google Analytics" twice helps nobody.
 */
export default function GoogleAnalyticsMark({
  size = 18,
}: {
  size?: number;
}) {
  return (
    <svg
      className="ga-mark"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <g transform="matrix(.363638 0 0 .363636 -3.272763 -2.909091)">
        <path
          d="M130 29v132c0 14.77 10.2 23 21 23 10 0 21-7 21-23V30c0-13.54-10-22-21-22s-21 9.33-21 21z"
          fill="#f9ab00"
        />
        <g fill="#e37400">
          <path d="M75 96v65c0 14.77 10.2 23 21 23 10 0 21-7 21-23V97c0-13.54-10-22-21-22s-21 9.33-21 21z" />
          <circle cx="41" cy="163" r="21" />
        </g>
      </g>
    </svg>
  );
}
