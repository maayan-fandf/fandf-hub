/**
 * Brand marks for the traffic-source table.
 *
 * Only the platforms we actually buy media on get a logo — Meta, Meta's
 * Audience Network, Google Ads and Taboola/Outbrain. Organic, direct and
 * referral keep the plain colour dot, because giving every row a badge
 * would flatten exactly the distinction the logos are there to draw:
 * these are the rows with money behind them.
 *
 * Inlined rather than served as files so they cost no request and
 * inherit sizing from the row. Brand colours are fixed and NOT themed —
 * a logo that changes hue between light and dark stops being the logo.
 */
export default function ChannelMark({
  channel,
  size = 14,
}: {
  channel: string;
  size?: number;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    xmlns: "http://www.w3.org/2000/svg",
    "aria-hidden": true as const,
    focusable: "false" as const,
    className: "ga4w-chmark",
  };

  if (channel === "meta" || channel === "audiencenetwork") {
    // Meta's infinity mark, simplified to two linked loops. Audience
    // Network is Meta inventory, so it carries the same mark — the row
    // label is what distinguishes them.
    return (
      <svg {...common}>
        <path
          d="M3.2 14.4c0-3.6 1.9-6.8 4.3-6.8 1.4 0 2.4.8 3.9 3 .5.7.9 1.4 1.4 2.2.5-.8 1-1.5 1.4-2.2 1.5-2.2 2.5-3 3.9-3 2.4 0 4.3 3.2 4.3 6.8 0 2.4-1.1 3.9-2.9 3.9-1.4 0-2.4-.7-3.9-3l-1-1.6-1 1.6c-1.5 2.3-2.5 3-3.9 3-1.8 0-2.9-1.5-2.9-3.9zm2.1 0c0 1.2.4 1.8 1 1.8.6 0 1.1-.4 2.2-2.1l.9-1.4-.9-1.4c-1.1-1.7-1.6-2.1-2.2-2.1-.9 0-1.7 1.9-1.7 4.2h.7zm11 1.8c.6 0 1-.6 1-1.8 0-2.3-.8-4.2-1.7-4.2-.6 0-1.1.4-2.2 2.1l-.9 1.4.9 1.4c1.1 1.7 1.6 2.1 2.2 2.1z"
          fill="#0081FB"
          opacity={channel === "audiencenetwork" ? 0.55 : 1}
        />
      </svg>
    );
  }

  if (channel === "googleads") {
    // Google Ads: the three angled bars in Google's yellow/blue/green.
    return (
      <svg {...common}>
        <rect x="2" y="14.2" width="7.2" height="7.2" rx="3.6" fill="#34A853" />
        <path d="M9.6 3.4 3.9 13.3a3.6 3.6 0 0 0 6.2 3.6L15.8 7a3.6 3.6 0 0 0-6.2-3.6z" fill="#FBBC04" />
        <path d="M14.4 3.4a3.6 3.6 0 0 0-1.3 4.9l5.7 9.9a3.6 3.6 0 0 0 6.2-3.6l-5.7-9.9a3.6 3.6 0 0 0-4.9-1.3z" fill="#4285F4" transform="translate(-2.6 0)" />
      </svg>
    );
  }

  if (channel === "taboola") {
    return (
      <svg {...common}>
        <circle cx="8" cy="12" r="4.6" fill="none" stroke="#0442BF" strokeWidth="2.4" />
        <circle cx="17.2" cy="12" r="4.6" fill="none" stroke="#0442BF" strokeWidth="2.4" />
      </svg>
    );
  }

  return null;
}
