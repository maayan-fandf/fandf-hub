import { colorForKey, initialsForKey } from "@/lib/colors";
import { roleEmoji } from "./RoleChip";

type Props = {
  /** Email or name — used as the hash key for color + initials. */
  name: string;
  /** Optional pretty name to show in the tooltip. Defaults to `name`. */
  title?: string;
  /** Optional role string from names_to_emails. When provided, the
   *  tooltip becomes `<title> · <emoji> <role>` so hovering reveals
   *  who the person is + what dept they're in. */
  role?: string;
  /** Size in px. Defaults to 28. */
  size?: number;
};

/** Build the hover tooltip text. Pure helper so the surrounding-name
 *  span (where applicable) can mirror the same string and hovering
 *  either part of the row shows identical info. */
export function avatarHoverText(
  title: string | undefined,
  name: string,
  role: string | undefined,
): string {
  const base = title || name;
  const r = (role || "").trim();
  if (!r) return base;
  const emoji = roleEmoji(r);
  return emoji ? `${base} · ${emoji} ${r}` : `${base} · ${r}`;
}

/**
 * Colorful initials avatar with a Workspace-photo overlay. The initials
 * (deterministic background color, white letters) render first; for
 * `@fandf.co.il` emails an `<img>` is layered on top via
 * `/api/avatar/<email>`. The proxy returns transparent bytes when the
 * user has no Workspace photo, so the initials remain visible
 * underneath without needing client-side error handling. External
 * (non-fandf) addresses skip the request entirely and keep initials.
 */
export default function Avatar({ name, title, role, size = 28 }: Props) {
  const { solid } = colorForKey(name);
  const initials = initialsForKey(name);
  const px = `${size}px`;
  const showPhoto = /^[^\s@]+@fandf\.co\.il$/i.test(name);
  const photoSrc = showPhoto
    ? `/api/avatar/${encodeURIComponent(name.toLowerCase().trim())}`
    : null;
  const hover = avatarHoverText(title, name, role);
  // Hover-card trigger attributes — picked up by the global
  // <UserHoverCard> listener mounted in app/layout.tsx. We only set
  // them when `name` looks like an email (so the card has someone to
  // open Google/Hub actions for); plain-display-name avatars
  // (e.g., "צוות") get no card.
  const isUserEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name);
  return (
    <span
      className="avatar"
      title={hover}
      aria-label={hover}
      dir="ltr"
      data-user-email={isUserEmail ? name : undefined}
      data-user-name={isUserEmail ? title || name : undefined}
      data-user-role={isUserEmail && role ? role : undefined}
      style={{
        position: "relative",
        width: px,
        height: px,
        lineHeight: px,
        background: solid,
        fontSize: `${Math.max(10, Math.round(size * 0.42))}px`,
      }}
    >
      {initials}
      {photoSrc && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photoSrc}
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            borderRadius: "999px",
            display: "block",
          }}
        />
      )}
    </span>
  );
}
