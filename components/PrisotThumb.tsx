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
        decoding="async"
        onLoad={() => setState("ready")}
        onError={() => setState("error")}
        // Position absolute + opacity-0 keeps the img in the layout
        // tree (so the browser actually fetches it), but invisible until
        // onLoad fires. Earlier version used `display: none` here which
        // ALSO removes the element from layout — combined with
        // `loading="lazy"` the browser never started the fetch (no
        // intersection-observer hit because no layout box), `onLoad`
        // never fired, the state stayed "loading", `display: none`
        // stayed, and the image was permanently stuck loading. Lazy
        // loading was also dropped: the card is in a Suspense boundary
        // already so the page doesn't block on this fetch, and the
        // image is small.
        style={
          state === "loading"
            ? {
                position: "absolute",
                opacity: 0,
                pointerEvents: "none",
                width: 1,
                height: 1,
              }
            : undefined
        }
      />
    </>
  );
}
