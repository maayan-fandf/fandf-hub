import PlatformIcon from "@/components/PlatformIcon";
import { channelIcon, channelPlatform } from "@/lib/channelIcon";

/**
 * Icon for a free-form media-channel string.
 *
 * Renders the real brand mark where the channel resolves to a platform
 * we buy on (Google, Facebook, Instagram, TikTok, Taboola, Outbrain) and
 * falls back to the existing emoji otherwise. Both branches come from
 * the SAME rule list in lib/channelIcon.ts, so a channel can never be
 * Facebook to one and something else to the other.
 *
 * The emoji fallback is deliberate rather than a gap: כתבה, שילוט, פניה
 * טלפונית, קשר אישי, וייז and the rest have no brand mark, and inventing
 * one would be worse than 📄. This keeps the visual language the CRM
 * card inherited from the dashboard while upgrading the handful of rows
 * that represent actual ad platforms.
 */
export default function ChannelIcon({
  name,
  size = "1em",
  fallback = "",
}: {
  name: string;
  size?: string | number;
  /** Rendered when the channel matches no rule at all — callers that
   *  want a neutral bullet pass "●". */
  fallback?: string;
}) {
  const platform = channelPlatform(name);
  if (platform) return <PlatformIcon platform={platform} size={size} />;
  const emoji = channelIcon(name);
  if (emoji) {
    return (
      <span aria-hidden style={{ fontSize: size, lineHeight: 1 }}>
        {emoji}
      </span>
    );
  }
  return fallback ? <span aria-hidden>{fallback}</span> : null;
}
