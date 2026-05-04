"use client";

import { useState } from "react";

type Props = {
  src: string;
  alt: string;
};

/**
 * Client wrapper around the prisot thumbnail <img>. Handles load failure
 * gracefully — Drive's thumbnailLink is best-effort, sometimes returns a
 * non-image (just-created sheets, files without a renderable preview, or
 * the SA's auth misalignment). Without this, broken renders show the
 * raw alt text in the middle of the card, which looks worse than a
 * clean placeholder.
 *
 * Loading state shows a subtle pulsing skeleton; error state shows a
 * static icon + "תצוגה מקדימה אינה זמינה" message. Clicking the card
 * still works in any state — the link wraps the whole tile.
 */
export default function PrisotThumb({ src, alt }: Props) {
  const [state, setState] = useState<"loading" | "ready" | "error">(
    "loading",
  );

  if (state === "error") {
    return (
      <div className="prisot-thumb-fallback" aria-label={alt}>
        <span className="prisot-thumb-fallback-icon" aria-hidden>
          📊
        </span>
        <span className="prisot-thumb-fallback-text">
          תצוגה מקדימה אינה זמינה
        </span>
      </div>
    );
  }

  return (
    <>
      {state === "loading" && (
        <div className="prisot-thumb-skeleton" aria-hidden />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setState("ready")}
        onError={() => setState("error")}
        style={state === "loading" ? { display: "none" } : undefined}
      />
    </>
  );
}
