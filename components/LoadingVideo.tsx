/**
 * Hub-wide loading video. Used by every app/.../loading.tsx fallback
 * Next.js streams while the page's server data is fetching. The video
 * is autoplay-muted-looped so it shows life on the screen instead of
 * the static skeleton boxes that were there before.
 *
 * Server component — `<video>` autoplay/muted/loop works without JS.
 * The video file is served from /public/loading.mp4 and gets cached
 * on first load (3.5MB one-time hit, then instant on every reload).
 *
 * Props:
 *   - `label`: optional headline shown next to / below the video so
 *     each loading boundary can still read as e.g. "טוען פרויקטים…"
 *     when the video alone is too generic.
 *   - `compact`: smaller variant for nested loading boundaries that
 *     don't want to take over the whole viewport.
 */
export default function LoadingVideo({
  label,
  compact = false,
}: {
  label?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={"loading-video-wrap" + (compact ? " is-compact" : "")}
      role="status"
      aria-live="polite"
      aria-label={label || "טוען…"}
    >
      <video
        className="loading-video"
        src="/loading.mp4"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        aria-hidden
      />
      {label ? <div className="loading-video-label">{label}</div> : null}
    </div>
  );
}
