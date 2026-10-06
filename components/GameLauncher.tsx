"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** WWF&F — the office fighting game. A static bundle built from
 *  nadav-source/WWF-F and deployed to its own Firebase Hosting site, so the
 *  hub only frames it. */
const GAME_URL = "https://fandf-wwff.web.app/";

/** The game's own numbers (src/main.ts in its repo): a 384×224 canvas, drawn
 *  with a 16px margin inside its window, at a whole-number scale once that
 *  is 2× or more. */
const VIEW_W = 384;
const VIEW_H = 224;
const GAME_MARGIN = 16;

/** The scale the game will pick for the room the popup has. Sizing the popup
 *  to exactly that, and tucking the game's margin out of sight, is what
 *  leaves no black band around the picture. */
function fitScale() {
  const s = Math.min(
    (window.innerWidth * 0.94) / VIEW_W,
    (window.innerHeight - 88) / VIEW_H,
  );
  return s >= 2 ? Math.floor(s) : s;
}

/**
 * 🥊 in the topnav — opens the game in a popup.
 *
 * The iframe exists only while the popup is open, which is what stops the
 * game's music on close. It is cross-origin, so once it has focus the hub
 * hears none of its key presses: the hub's shortcuts stay out of the fight,
 * and Esc inside the game cannot close the popup — the × and a click on
 * the backdrop do.
 *
 * On a touch screen the game lays its own controls out round the picture, in
 * the corners and under it (src/touch.ts in its repo), so there the popup is
 * the whole screen with nothing clipped, and the × has a strip of its own
 * above the game rather than sitting on one of its buttons.
 */
export default function GameLauncher() {
  const [open, setOpen] = useState(false);
  const [scale, setScale] = useState(2);
  const [touch, setTouch] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onResize = () => setScale(fitScale());
    onResize();
    setTouch(window.matchMedia("(pointer: coarse)").matches);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
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
              className={"game-modal" + (touch ? " is-touch" : "")}
              role="dialog"
              aria-modal="true"
              aria-label="WWF&F"
              style={
                touch
                  ? undefined
                  : { width: VIEW_W * scale, height: VIEW_H * scale }
              }
            >
              <button
                type="button"
                className="game-close"
                onClick={() => setOpen(false)}
                aria-label="סגור"
              >
                ×
              </button>
              <div className="game-screen">
                <iframe
                  ref={frameRef}
                  className="game-frame"
                  src={GAME_URL}
                  title="WWF&F"
                  allow="autoplay; fullscreen; gamepad"
                  style={
                    touch
                      ? undefined
                      : {
                          inset: -GAME_MARGIN,
                          width: VIEW_W * scale + GAME_MARGIN * 2,
                          height: VIEW_H * scale + GAME_MARGIN * 2,
                        }
                  }
                  onLoad={() => frameRef.current?.focus()}
                />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
