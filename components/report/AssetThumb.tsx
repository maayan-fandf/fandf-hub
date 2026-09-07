"use client";

import { useState } from "react";

/**
 * Screenshot of a page, for the נכסים דיגיטליים cards and the landing
 * preview in the project header.
 *
 * TWO providers, and the order matters: microlink first, thum.io second.
 *
 * thum.io used to be first — it is faster and caches well — but its free
 * tier now answers with a 600×200 image reading "Image not authorized.
 * Please sign-up for a paid account." That is a successful HTTP response
 * carrying a valid image, so `onError` never fires and the card renders
 * the refusal notice as if it were the page. Measured 2026-09-07 with a
 * cache-buster on three different URLs (a landing page, a Yad2 project
 * page and an i11 article): thum.io returned 600×200 for all three,
 * microlink returned a real 2560×1600 screenshot for all three.
 *
 * The dimension check is what makes that recoverable rather than a
 * permanent hard-code: any provider that answers with its own placeholder
 * instead of a screenshot gets skipped, so if thum.io starts working
 * again — or microlink starts refusing — the chain still lands on
 * whichever one is actually returning a page.
 */

/** thum.io's refusal placeholder, exactly. A real screenshot from the
 *  same request is 600×400, so this cannot collide with a good answer. */
const PLACEHOLDER = (w: number, h: number) => w === 600 && h === 200;

export default function AssetThumb({
  url,
  alt,
  className = "da-thumb",
}: {
  url: string;
  alt: string;
  className?: string;
}) {
  const sources = [
    `https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=true&meta=false&embed=screenshot.url`,
    `https://image.thum.io/get/width/600/crop/400/noanimate/wait/4/${encodeURI(url)}`,
  ];
  const [i, setI] = useState(0);
  const next = () => setI((n) => n + 1);

  if (i >= sources.length) {
    return (
      <div className={`${className} ${className}-dead`} aria-hidden>
        🌐
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className}
      src={sources[i]}
      alt={alt}
      loading="lazy"
      onError={next}
      onLoad={(e) => {
        const img = e.currentTarget;
        if (PLACEHOLDER(img.naturalWidth, img.naturalHeight)) next();
      }}
    />
  );
}
