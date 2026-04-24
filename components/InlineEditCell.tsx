"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * Generic click-to-edit popover for a table cell. Wraps a display
 * trigger + a portaled editor that floats over the page (not clipped
 * by the table's overflow-x wrapper). Same mechanics as the status
 * cell — click to open, outside-click / Escape / scroll to close,
 * position calculated against the trigger's getBoundingClientRect().
 *
 * The editor receives a `close()` callback so it can dismiss the
 * popover after a successful save without the parent having to wire
 * that up explicitly.
 *
 * Usage:
 *   <InlineEditCell
 *     display={<span>{value || "—"}</span>}
 *     title="Click to edit"
 *   >
 *     {(close) => <MyEditor onSave={() => close()} />}
 *   </InlineEditCell>
 */
export default function InlineEditCell({
  display,
  title,
  children,
  minWidth = 14,
}: {
  display: ReactNode;
  title?: string;
  children: (close: () => void) => ReactNode;
  /** Min-width of the popover in em; bump when the editor has more
   *  fields (e.g. assignees chip picker needs ~20em). */
  minWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(
    null,
  );
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onScroll() {
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setCoords({
      top: r.bottom + 4,
      right: window.innerWidth - r.right,
    });
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="inline-edit-trigger"
        onClick={() => setOpen((o) => !o)}
        title={title || "לחץ לעריכה"}
      >
        {display}
      </button>
      {open &&
        coords &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            className="inline-edit-popover"
            role="dialog"
            style={{
              position: "fixed",
              top: `${coords.top}px`,
              right: `${coords.right}px`,
              minWidth: `${minWidth}em`,
            }}
          >
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </>
  );
}
