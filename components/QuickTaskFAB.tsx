"use client";

/**
 * Bottom-left floating action button — third entry point into
 * QuickNoteModal alongside Ctrl+Shift+M and the "g n" chord. The button
 * is the only thing this component renders; the modal itself lives in
 * QuickNoteModal and listens for the `hub:open-quick-note` custom event
 * that this button (and the palette + chord) dispatch.
 *
 * Single capture surface for the whole hub:
 *   - Save → modal stays open with "✓ נשמר — פתח" link
 *   - Click link → land on /tasks/[id]?edit=1 (refine path)
 *   - Close without clicking → keep capturing the next thought
 */
export default function QuickTaskFAB() {
  function open() {
    window.dispatchEvent(new CustomEvent("hub:open-quick-note"));
  }
  return (
    <button
      type="button"
      className="quick-task-fab"
      onClick={open}
      aria-label="הערה אישית מהירה"
      title="הערה אישית מהירה (Ctrl+Shift+M)"
    >
      +
    </button>
  );
}
