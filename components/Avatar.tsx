import { colorForKey, initialsForKey } from "@/lib/colors";

type Props = {
  /** Email or name — used as the hash key for color + initials. */
  name: string;
  /** Optional pretty name to show in the tooltip. Defaults to `name`. */
  title?: string;
  /** Size in px. Defaults to 28. */
  size?: number;
};

/**
 * Colorful initials avatar with a Workspace-photo overlay. The initials
 * (deterministic background color, white letters) render first; for
 * `@fandf.co.il` emails an `<img>` is layered on top via
 * `/api/avatar/<email>`. The proxy returns transparent bytes when the
 * user has no Workspace photo, so the initials remain visible
 * underneath without needing client-side error handling. External
 * (non-fandf) addresses skip the request entirely and keep initials.
 */
export default function Avatar({ name, title, size = 28 }: Props) {
  const { solid } = colorForKey(name);
  const initials = initialsForKey(name);
  const px = `${size}px`;
  const showPhoto = /^[^\s@]+@fandf\.co\.il$/i.test(name);
  const photoSrc = showPhoto
    ? `/api/avatar/${encodeURIComponent(name.toLowerCase().trim())}`
    : null;
  return (
    <span
      className="avatar"
      title={title || name}
      aria-label={title || name}
      dir="ltr"
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
