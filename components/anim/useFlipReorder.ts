"use client";

import { useRef } from "react";
import { animate } from "animejs";
import { prefersReducedMotion, useIsomorphicLayoutEffect } from "@/lib/anim";

/**
 * FLIP reorder for a keyed list. When the items inside the returned ref
 * change order (React re-renders the keyed children in a new sequence) or
 * a new item appears, each one slides from where it WAS to where it now IS
 * instead of snapping — the "the data is responding to me" feel.
 *
 * How to use:
 *   const listRef = useFlipReorder<HTMLUListElement>(depKey);
 *   <ul ref={listRef}>
 *     {rows.map(r => <li key={r.id} data-flip={r.id}>…</li>)}
 *   </ul>
 *
 * Mark every animatable child with a STABLE `data-flip="<id>"`. Pass a
 * `depKey` that changes whenever the data changes (e.g. the filter
 * selection) so the layout effect re-measures after each re-render.
 *
 * Technique = FLIP: this runs in a layout effect AFTER React has already
 * moved the rows to their new DOM positions, so we read the NEW rect, diff
 * it against the rect cached last render (the OLD position), jump the
 * element back by that delta with anime's [from,to] syntax, and tween it to
 * 0 — the browser only ever paints the smooth slide. Reduced-motion just
 * records positions and skips the tween.
 */
export function useFlipReorder<T extends HTMLElement>(
  depKey: unknown,
  /** When false, positions are still tracked but no tween plays — pass the
   *  negation of "is a drag in progress" so FLIP yields to dnd-kit. */
  enabled = true,
) {
  const ref = useRef<T | null>(null);
  const prev = useRef<Map<string, DOMRect>>(new Map());

  useIsomorphicLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;

    const items = Array.from(
      root.querySelectorAll<HTMLElement>("[data-flip]"),
    );
    const next = new Map<string, DOMRect>();
    const reduced = prefersReducedMotion() || !enabled;

    for (const el of items) {
      const id = el.dataset.flip;
      if (!id) continue;
      const rect = el.getBoundingClientRect();
      next.set(id, rect);
      if (reduced) continue;

      const old = prev.current.get(id);
      if (old) {
        const dx = old.left - rect.left;
        const dy = old.top - rect.top;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          // Invert to the old spot, then play to the new one.
          animate(el, {
            translateX: [dx, 0],
            translateY: [dy, 0],
            duration: 520,
            ease: "outCubic",
          });
        }
      } else if (prev.current.size > 0) {
        // A genuinely new row (not the first render) — fade + rise in.
        animate(el, {
          opacity: [0, 1],
          translateY: [10, 0],
          duration: 420,
          ease: "outCubic",
        });
      }
    }

    prev.current = next;
    // depKey drives re-measurement; `prev`/`ref` are stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey]);

  return ref;
}
