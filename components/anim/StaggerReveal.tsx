"use client";

import { useRef } from "react";
import { animate, stagger } from "animejs";
import { prefersReducedMotion, useIsomorphicLayoutEffect, ANIM } from "@/lib/anim";

/**
 * Wraps a set of (usually server-rendered) children and cascades them in —
 * opacity + a small upward translate, staggered — the first time the
 * container scrolls into view. The wrapper itself renders as a plain div
 * with whatever `className` it replaces, so it can stand in for an existing
 * layout container (`.company-groups`, `.crm-kpi-row`, …) without changing
 * the grid/flow.
 *
 * Children are passed through opaque — a server component can be a child of
 * this client component, so this adds motion to server-rendered markup with
 * no client-boundary churn. Reduced-motion / no-JS leave the children fully
 * visible and untouched.
 */
export default function StaggerReveal({
  children,
  className,
  childSelector = ":scope > *",
  staggerMs = ANIM.stagger,
  y = ANIM.revealY,
  as: Tag = "div",
}: {
  children: React.ReactNode;
  className?: string;
  /** CSS selector (relative to the wrapper) for the items to stagger. */
  childSelector?: string;
  staggerMs?: number;
  y?: number;
  /** Container element to render — e.g. "ul" to wrap <li> rows without an
   *  invalid ul>div>li nesting. Defaults to "div". */
  as?: React.ElementType;
}) {
  const ref = useRef<HTMLElement | null>(null);

  useIsomorphicLayoutEffect(() => {
    const root = ref.current;
    if (!root || prefersReducedMotion()) return;

    const kids = Array.from(
      root.querySelectorAll<HTMLElement>(childSelector),
    );
    if (kids.length === 0) return;

    // Pre-hide before the browser paints so there's no flash of the final
    // laid-out grid before the cascade begins.
    for (const k of kids) {
      k.style.opacity = "0";
      k.style.willChange = "opacity, transform";
    }

    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      // Clamp the per-item delay so a long list (many companies) still
      // finishes its cascade in ~half a second rather than crawling.
      const step =
        kids.length > 1 ? Math.min(staggerMs, 480 / (kids.length - 1)) : 0;
      animate(kids, {
        opacity: [0, 1],
        translateY: [y, 0],
        duration: ANIM.revealDuration,
        delay: stagger(step),
        ease: ANIM.revealEase,
        onComplete: () => {
          // Hand styling back to the stylesheet once settled.
          for (const k of kids) {
            k.style.opacity = "";
            k.style.transform = "";
            k.style.willChange = "";
          }
        },
      });
    };

    let io: IntersectionObserver | null = null;
    const rect = root.getBoundingClientRect();
    const inView = rect.top < window.innerHeight && rect.bottom > 0;
    if (inView || typeof IntersectionObserver === "undefined") {
      start();
    } else {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              io?.disconnect();
              start();
            }
          }
        },
        { threshold: 0.08 },
      );
      io.observe(root);
    }

    return () => {
      io?.disconnect();
      // Never animated (fast unmount while still hidden) → restore so we
      // can't leave orphaned invisible content behind.
      if (!started) {
        for (const k of kids) {
          k.style.opacity = "";
          k.style.willChange = "";
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Tag ref={ref} className={className}>
      {children}
    </Tag>
  );
}
