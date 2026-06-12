"use client";

import { useState } from "react";

/**
 * Screenshot figure for /onboarding that HIDES ITSELF when the image
 * is missing (404). Lets the guide ship text-first and light up each
 * figure automatically when its capture lands in public/onboarding/ —
 * no broken-image icons in the meantime.
 */
export default function OnboardingShot({
  src,
  alt,
  caption,
}: {
  /** Filename inside /onboarding/, e.g. "morning-alert.png". */
  src: string;
  alt: string;
  caption: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <figure className="onb-shot">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/onboarding/${src}`}
        alt={alt}
        loading="lazy"
        onError={() => setFailed(true)}
      />
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
