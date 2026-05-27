import { useId } from "react";

/**
 * Gmail brand glyph. Replaces the earlier hand-drawn four-color M
 * with the canonical envelope mark (asymmetric: red top diagonal,
 * blue-to-green right tray, pink/red/yellow gradient banner across
 * the front). Source: owner-supplied SVG at gmail-2.svg.
 *
 * The SVG carries three linearGradients keyed by short ids ("a",
 * "b", "c"). Two-plus instances of this component on the same page
 * (e.g. the /team grid where every card has a Gmail button) would
 * normally collide on those ids — `fill="url(#a)"` resolves to
 * whichever <linearGradient id="a"> the browser sees first, so the
 * second icon onwards renders with the wrong gradient. `useId()`
 * gives us a stable, render-unique prefix so each instance gets its
 * own gradient namespace.
 *
 * Pure presentational. `size` controls both width + height (string
 * or number, defaults to `1em` so the icon scales with surrounding
 * type). `title` becomes the `<title>` and `aria-label`.
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
  const uid = useId();
  const idA = `gmail-${uid}-a`;
  const idB = `gmail-${uid}-b`;
  const idC = `gmail-${uid}-c`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={title}
      style={{ flexShrink: 0 }}
    >
      <title>{title}</title>
      <path
        d="M29.6 45.7v30.6c0 1-.8 2.2-2.2 2.2h-8.6c-2.3 0-4.5-1.8-4.5-4.4V28.6z"
        fill="#FF4138"
      />
      <linearGradient
        id={idA}
        x1="81.65"
        x2="81.65"
        y1="78.52"
        y2="27.79"
        gradientUnits="userSpaceOnUse"
      >
        <stop stopColor="#3185FF" offset="0" />
        <stop stopColor="#0FA776" offset=".47" />
        <stop stopColor="#59D274" offset="1" />
      </linearGradient>
      <path
        d="M85.8 28.8v45.3c0 2.1-1.9 4.4-4.6 4.4h-8.6c-1 0-2.3-.8-2.3-2.2V45.9z"
        fill={`url(#${idA})`}
      />
      <linearGradient
        id={idB}
        x1="14.47"
        x2="85.79"
        y1="39.5"
        y2="39.5"
        gradientUnits="userSpaceOnUse"
      >
        <stop stopColor="#FF669E" offset="0" />
        <stop stopColor="#FF4138" offset=".5" />
        <stop stopColor="#FFBD09" offset=".965" />
        <stop stopColor="#FFCF09" offset="1" />
      </linearGradient>
      <path
        d="M73.5 23.5 50 43.1 26.9 23.5c-4.7-3.6-12.4-1.2-12.6 5.1v.7c0 1.9.8 4 2.6 5.8L48 60.8c.6.4 1.2.7 1.8.7h.6c.6 0 1.2-.3 1.6-.6l31.3-25.8c1.7-1.4 2.5-3.3 2.5-5.2v-1.3c-.4-5.7-7.8-8.7-12.3-5.1"
        fill={`url(#${idB})`}
      />
      <linearGradient
        id={idC}
        x1="17.75"
        x2="28.59"
        y1="78.14"
        y2="78.14"
        gradientUnits="userSpaceOnUse"
      >
        <stop stopColor="#F31818" offset="0" />
        <stop stopColor="#FF1B1B" offset="1" />
      </linearGradient>
      <path
        d="M17.7 78c.5.2.9.5 1.3.5h8.5c.4 0 .7-.2 1.1-.3v-.3z"
        fill={`url(#${idC})`}
      />
    </svg>
  );
}
