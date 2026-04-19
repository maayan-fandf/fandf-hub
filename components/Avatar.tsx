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
 * Colorful initials avatar. Deterministic — same email always produces the
 * same background color so users are recognizable across pages. Text color
 * is always white for simplicity.
 */
export default function Avatar({ name, title, size = 28 }: Props) {
  const { solid } = colorForKey(name);
  const initials = initialsForKey(name);
  const px = `${size}px`;
  return (
    <span
      className="avatar"
      title={title || name}
      aria-label={title || name}
      dir="ltr"
      style={{
        width: px,
        height: px,
        lineHeight: px,
        background: solid,
        fontSize: `${Math.max(10, Math.round(size * 0.42))}px`,
      }}
    >
      {initials}
    </span>
  );
}
