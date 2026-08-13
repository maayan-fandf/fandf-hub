import GoogleAdsIcon from "@/components/GoogleAdsIcon";
import FacebookAdsIcon from "@/components/FacebookAdsIcon";

/**
 * One place that turns a platform key into its brand logo.
 *
 * This used to be a local helper inside BudgetGrid that fell back to 🎵
 * for TikTok and 📰 for Taboola/Outbrain, while other surfaces reached
 * for their own emoji — ProjectPriceCheckSection used 🔍 for Google and
 * 📘 for Facebook. The result was that the same platform wore a
 * different face depending on which card you were looking at. This is
 * the shared version; the emoji fallbacks are gone.
 *
 * Pure presentational and server-safe. Sized in `em` by default so it
 * inherits the surrounding type, matching GoogleDriveIcon and friends.
 *
 * Brand colours are fixed and deliberately NOT themed — a logo that
 * shifts hue between light and dark stops reading as the logo.
 */
export type PlatformKey =
  | "google"
  | "facebook"
  | "instagram"
  | "meta"
  | "audiencenetwork"
  | "tiktok"
  | "taboola"
  | "outbrain"
  | "other"
  | string;

export default function PlatformIcon({
  platform,
  size = "1em",
  className = "",
}: {
  platform: PlatformKey;
  size?: string | number;
  className?: string;
}) {
  const p = String(platform || "").toLowerCase();
  const cls = `plat-ic ${className}`.trim();

  if (p === "google" || p === "googleads") return <GoogleAdsIcon size={size} className={cls} />;
  if (p === "facebook") return <FacebookAdsIcon size={size} className={cls} />;

  const svg = (children: React.ReactNode, viewBox = "0 0 24 24", title?: string) => (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      xmlns="http://www.w3.org/2000/svg"
      className={cls}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );

  if (p === "instagram") {
    return svg(
      <>
        <defs>
          <radialGradient id="ig-g" cx="0.3" cy="1" r="1.1">
            <stop offset="0" stopColor="#FFD776" />
            <stop offset="0.35" stopColor="#F3736B" />
            <stop offset="0.7" stopColor="#D62E86" />
            <stop offset="1" stopColor="#8E3AC4" />
          </radialGradient>
        </defs>
        <rect x="2" y="2" width="20" height="20" rx="5.6" fill="url(#ig-g)" />
        <rect x="6.3" y="6.3" width="11.4" height="11.4" rx="4" fill="none" stroke="#fff" strokeWidth="1.7" />
        <circle cx="17.4" cy="6.7" r="1.15" fill="#fff" />
      </>,
      "0 0 24 24",
      "Instagram",
    );
  }

  // Meta's infinity mark. Audience Network is Meta inventory and carries
  // the same mark at reduced opacity — the label distinguishes them, and
  // giving it a separate logo would imply a separate platform.
  if (p === "meta" || p === "audiencenetwork") {
    return svg(
      <path
        d="M3.2 14.4c0-3.6 1.9-6.8 4.3-6.8 1.4 0 2.4.8 3.9 3 .5.7.9 1.4 1.4 2.2.5-.8 1-1.5 1.4-2.2 1.5-2.2 2.5-3 3.9-3 2.4 0 4.3 3.2 4.3 6.8 0 2.4-1.1 3.9-2.9 3.9-1.4 0-2.4-.7-3.9-3l-1-1.6-1 1.6c-1.5 2.3-2.5 3-3.9 3-1.8 0-2.9-1.5-2.9-3.9zm2.1 0c0 1.2.4 1.8 1 1.8.6 0 1.1-.4 2.2-2.1l.9-1.4-.9-1.4c-1.1-1.7-1.6-2.1-2.2-2.1-.9 0-1.7 1.9-1.7 4.2h.7zm11 1.8c.6 0 1-.6 1-1.8 0-2.3-.8-4.2-1.7-4.2-.6 0-1.1.4-2.2 2.1l-.9 1.4.9 1.4c1.1 1.7 1.6 2.1 2.2 2.1z"
        fill="#0081FB"
        opacity={p === "audiencenetwork" ? 0.5 : 1}
      />,
      "0 0 24 24",
      p === "audiencenetwork" ? "Meta Audience Network" : "Meta",
    );
  }

  if (p === "tiktok") {
    return svg(
      <>
        <path d="M16.1 2h-2.9v13.1a2.5 2.5 0 1 1-2.1-2.5v-3a5.5 5.5 0 1 0 5 5.5V8.6a6.6 6.6 0 0 0 3.9 1.3V7a3.8 3.8 0 0 1-3.9-3.7V2z" fill="#000" />
        <path d="M17.3 3.2h-2.9v13.1a2.5 2.5 0 1 1-2.1-2.5v-3a5.5 5.5 0 1 0 5 5.5V9.8a6.6 6.6 0 0 0 3.9 1.3V8.2a3.8 3.8 0 0 1-3.9-3.7V3.2z" fill="#25F4EE" opacity=".85" />
        <path d="M16.7 2.6h-2.9v13.1a2.5 2.5 0 1 1-2.1-2.5v-3a5.5 5.5 0 1 0 5 5.5V9.2a6.6 6.6 0 0 0 3.9 1.3V7.6a3.8 3.8 0 0 1-3.9-3.7V2.6z" fill="#FE2C55" opacity=".85" />
      </>,
      "0 0 24 24",
      "TikTok",
    );
  }

  if (p === "taboola") {
    return svg(
      <>
        <circle cx="8" cy="12" r="4.6" fill="none" stroke="#0442BF" strokeWidth="2.4" />
        <circle cx="17.2" cy="12" r="4.6" fill="none" stroke="#0442BF" strokeWidth="2.4" />
      </>,
      "0 0 24 24",
      "Taboola",
    );
  }

  if (p === "yad2") {
    // Yad2's wordmark is unreadable at 14px, so this is the monogram:
    // their orange with the "2" that carries the brand at small sizes.
    return svg(
      <>
        <rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="#FF4B00" />
        <text
          x="12"
          y="17.4"
          textAnchor="middle"
          fontSize="15"
          fontWeight="800"
          fill="#fff"
          fontFamily="Arial, Helvetica, sans-serif"
        >
          2
        </text>
      </>,
      "0 0 24 24",
      "יד2",
    );
  }

  if (p === "outbrain") {
    return svg(
      <>
        <circle cx="12" cy="12" r="9" fill="#EE6513" />
        <circle cx="12" cy="12" r="3.6" fill="#fff" />
      </>,
      "0 0 24 24",
      "Outbrain",
    );
  }

  return null;
}
