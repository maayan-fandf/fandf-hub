"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** WWF&F — the office fighting game. A static bundle built from
 *  nadav-source/WWF-F and deployed to its own Firebase Hosting site, so the
 *  hub only frames it. */
const GAME_URL = "https://fandf-wwff.web.app/";

/**
 * 🥊 in the topnav — opens the game in a popup.
 *
 * The iframe exists only while the popup is open, which is what stops the
 * game's music on close. It is cross-origin, so once it has focus the hub
 * hears none of its key presses: the hub's shortcuts stay out of the fight,
 * and Esc inside the game cannot close the popup — the × and a click on
 * the backdrop do.
 */
export default function GameLauncher() {
  const [open, setOpen] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="theme-toggle"
        onClick={() => setOpen(true)}
        title="WWF&F — המשחק"
        aria-label="פתח את המשחק WWF&F"
        aria-haspopup="dialog"
      >
        <span aria-hidden>🥊</span>
      </button>
      {open &&
        createPortal(
          <div
            className="game-backdrop"
            onClick={(e) => {
              if (e.target === e.currentTarget) setOpen(false);
            }}
          >
            <div
              className="game-modal"
              role="dialog"
              aria-modal="true"
              aria-label="WWF&F"
            >
              <button
                type="button"
                className="game-close"
                onClick={() => setOpen(false)}
                aria-label="סגור"
              >
                ×
              </button>
              <iframe
                ref={frameRef}
                className="game-frame"
                src={GAME_URL}
                title="WWF&F"
                allow="autoplay; fullscreen; gamepad"
                onLoad={() => frameRef.current?.focus()}
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
