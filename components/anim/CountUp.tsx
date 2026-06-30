"use client";

import { useRef, useState } from "react";
import { animate } from "animejs";
import { prefersReducedMotion, useIsomorphicLayoutEffect, ANIM } from "@/lib/anim";

/** The subset of an anime.js instance we touch for teardown. */
type AnimInstance = { pause: () => void; cancel?: () => void };

const fmtHe = (n: number) => Math.round(n).toLocaleString("he-IL");

/**
 * Animated number that ticks from 0 → `value` the first time it scrolls
 * into view, then re-tweens from its current figure to the new one
 * whenever `value` changes (e.g. the CRM source-chip filter re-aggregates
 * the KPIs live). The KPI row sits below the dashboard iframe — off-screen
 * on load — so an IntersectionObserver defers the count until it's actually
 * visible instead of finishing unseen.
 *
 * SSR renders the final formatted value (correct for no-JS / hydration);
 * the count-down-to-0-then-up only happens client-side once revealed.
 */
export default function CountUp({
  value,
  format = fmtHe,
  duration = ANIM.countDuration,
  decimals = 0,
  className,
}: {
  value: number;
  format?: (n: number) => string;
  duration?: number;
  /** Precision the in-flight tween is rounded to before formatting.
   *  0 (default) rolls whole numbers; 1 keeps one decimal (percentages). */
  decimals?: number;
  className?: string;
}) {
  const [display, setDisplay] = useState(() => format(value));
  const spanRef = useRef<HTMLSpanElement | null>(null);
  const currentRef = useRef(value); // numeric value currently on screen
  const revealedRef = useRef(false);
  const animRef = useRef<AnimInstance | null>(null);

  useIsomorphicLayoutEffect(() => {
    if (prefersReducedMotion()) {
      currentRef.current = value;
      setDisplay(format(value));
      return;
    }

    let io: IntersectionObserver | null = null;

    // Round the in-flight value to `decimals` places before formatting.
    const f = 10 ** decimals;
    const r = (n: number) => Math.round(n * f) / f;

    const run = (from: number) => {
      animRef.current?.pause?.();
      const obj = { n: from };
      currentRef.current = from;
      // Round the in-flight value before formatting so the counter rolls
      // whole numbers — the raw tween is fractional, and a formatter that
      // doesn't round (e.g. a plain toLocaleString) would otherwise flash
      // "203.4" mid-count. currentRef keeps the true float for smooth
      // re-tween continuation; only the DISPLAY is rounded.
      setDisplay(format(r(from)));
      animRef.current = animate(obj, {
        n: value,
        duration,
        ease: ANIM.ease,
        onUpdate: () => {
          currentRef.current = obj.n;
          setDisplay(format(r(obj.n)));
        },
        onComplete: () => {
          currentRef.current = value;
          setDisplay(format(value));
        },
      }) as unknown as AnimInstance;
    };

    if (!revealedRef.current) {
      // Not yet counted up. Keep the static display in lockstep with the
      // live value (so an off-screen chip-filter change never leaves a
      // stale number on screen), then arm the count-up for first reveal.
      // The KPI row sits below the dashboard iframe — off-screen on load —
      // so we wait for it to scroll into view before ticking 0 → value.
      currentRef.current = value;
      setDisplay(format(value));
      const el = spanRef.current;
      const inView =
        !!el &&
        (() => {
          const r = el.getBoundingClientRect();
          return r.top < window.innerHeight && r.bottom > 0;
        })();
      if (!el || typeof IntersectionObserver === "undefined" || inView) {
        revealedRef.current = true;
        run(0);
      } else {
        io = new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              if (e.isIntersecting) {
                revealedRef.current = true;
                io?.disconnect();
                run(0);
              }
            }
          },
          { threshold: 0.1 },
        );
        io.observe(el);
      }
    } else if (value !== currentRef.current) {
      // Already revealed — a value change (chip filter) tweens from the
      // figure currently shown to the new one.
      run(currentRef.current);
    }

    return () => {
      io?.disconnect();
      // Stop any in-flight tween synchronously so onUpdate can't setState
      // after unmount or before the next run().
      animRef.current?.pause?.();
    };
    // `format` is intentionally excluded — callers pass a module-level
    // formatter, and including an inline fn would re-run every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, duration, decimals]);

  return (
    <span ref={spanRef} className={className} suppressHydrationWarning>
      {display}
    </span>
  );
}
