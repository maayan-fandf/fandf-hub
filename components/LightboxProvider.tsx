"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import GoogleDriveIcon from "./GoogleDriveIcon";

/**
 * Image viewer overlay shared across the hub. Replaces the previous
 * "click image → new tab → Drive viewer" flow with an in-app lightbox
 * for chat-attachment images. Reported by Maayan 2026-05-06: opening
 * Drive disrupts the discussion flow when a user just wants a bigger
 * look at a pasted screenshot.
 *
 * Single instance lives in app/layout.tsx via `<LightboxProvider>`.
 * Consumers call `useLightbox().open(src, alt, viewUrl)` to display.
 * The viewUrl is preserved on a "Open in Drive" affordance inside the
 * overlay so users who DO want the full Drive view (download,
 * comments, etc.) can still get there in one click.
 *
 * UX contract:
 *   - Esc closes
 *   - Click outside the image closes
 *   - Body scroll-locked while open
 *   - "Open in Drive" + close (×) buttons in the corners
 *   - Image keeps aspect ratio, fits within ~92vw × 92vh
 */

type LightboxItem = {
  src: string;
  alt: string;
  /** Full Drive viewer URL — surfaced on a "פתח ב-Drive" button so the
   *  user can still escape to Drive's native viewer (download,
   *  comments, etc.). Optional. */
  viewUrl?: string;
};

type LightboxContextValue = {
  open: (src: string, alt: string, viewUrl?: string) => void;
  close: () => void;
};

const Ctx = createContext<LightboxContextValue | null>(null);

export function useLightbox(): LightboxContextValue {
  const v = useContext(Ctx);
  if (!v) {
    // Falling back to a no-op rather than throwing keeps SSR + tests
    // working without a provider mount; image-click handlers just
    // navigate via their existing href fallback (callers should
    // render an <a href={viewUrl}> alongside their button).
    return {
      open: () => {},
      close: () => {},
    };
  }
  return v;
}

export default function LightboxProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [item, setItem] = useState<LightboxItem | null>(null);
  const [mounted, setMounted] = useState(false);

  // Portal target only exists on the client. setMounted gates the
  // createPortal call so the server render emits nothing.
  useEffect(() => {
    setMounted(true);
  }, []);

  const open = useCallback(
    (src: string, alt: string, viewUrl?: string) => {
      setItem({ src, alt: alt || "", viewUrl });
    },
    [],
  );
  const close = useCallback(() => {
    setItem(null);
  }, []);

  // Esc-to-close + body-scroll-lock while open. The cleanup restores
  // the previous overflow value rather than hard-coding "auto" so
  // callers that nested overflow:hidden for their own reasons aren't
  // disturbed.
  useEffect(() => {
    if (!item) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setItem(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [item]);

  return (
    <Ctx.Provider value={{ open, close }}>
      {children}
      {mounted &&
        item &&
        createPortal(
          <div
            className="lightbox-overlay"
            role="dialog"
            aria-modal="true"
            aria-label={item.alt || "תצוגת תמונה"}
            onClick={(e) => {
              // Click on the backdrop (this element itself) closes.
              // Clicks that bubble up from the image / buttons are
              // intercepted with stopPropagation below.
              if (e.target === e.currentTarget) close();
            }}
          >
            <div className="lightbox-actions">
              {item.viewUrl && (
                <a
                  href={item.viewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="lightbox-action lightbox-action-drive"
                  title="פתח ב-Drive (מסך מלא, הערות, הורדה)"
                  aria-label="פתח ב-Drive"
                  onClick={(e) => e.stopPropagation()}
                >
                  <GoogleDriveIcon size="1.1em" />
                </a>
              )}
              <button
                type="button"
                className="lightbox-action lightbox-action-close"
                title="סגור (Esc)"
                aria-label="סגור"
                onClick={(e) => {
                  e.stopPropagation();
                  close();
                }}
              >
                ✕
              </button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.src}
              alt={item.alt}
              className="lightbox-image"
              onClick={(e) => e.stopPropagation()}
            />
            {item.alt && (
              <div className="lightbox-caption" dir="auto">
                {item.alt}
              </div>
            )}
          </div>,
          document.body,
        )}
    </Ctx.Provider>
  );
}
