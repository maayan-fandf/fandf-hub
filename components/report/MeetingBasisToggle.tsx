"use client";

import { useState, useTransition } from "react";
import { useMeetingBasis } from "@/components/report/MeetingBasisContext";
import {
  BASIS_COPY,
  BASIS_LABELS,
  BASIS_TITLES,
  MEETING_BASES,
  type MeetingBasis,
} from "@/lib/meetingBasis";

/**
 * The page-level meeting-count switch: "ספירת פגישות: לפי כניסת ליד | לפי
 * מועד הפגישה". Sits in the sticky header's .header-actions directly after
 * the period picker — the other page-wide filter — and decides what every
 * תיאומים / ביצועים number below it counts (see lib/meetingBasis for the two
 * rules, and why there is ONE switch instead of the ערוצים table's own).
 *
 * VISIBLE TO CLIENTS (owner decision D4). They already had the ערוצים table
 * toggle and the period picker; both bases are client-safe numbers, and the
 * default a link opens on is lead-entry, which is what ALL CLIENTS shows.
 *
 * STATE lives in MeetingBasisProvider (wrapping <main>), not here: this
 * component only reads it and asks for a flip. The provider was seeded from
 * `?meetings=` on the server, so the SSR HTML already has the right button
 * pressed — no flash, nothing to reconcile on hydration.
 *
 * A FLIP IS A TRANSITION, and that is load-bearing rather than a perf nicety.
 * The provider's value is context above the rail, and the rail is a
 * Suspense boundary that streams in seconds after the header is interactive
 * (the report read is the slow part of the page). A SYNC context update that
 * reaches a boundary still waiting to hydrate makes React throw that
 * boundary's server HTML away and client-render it ("received an update
 * before it finished hydrating … wrap the original update in
 * startTransition"). Inside a transition React hydrates the boundary first
 * and applies the flip after. The same transition also keeps a flip from
 * janking the header while every chart consumer re-renders. The picker next
 * door wraps its router.push the same way for its own reason (a server
 * round trip); this flip has none — the provider mirrors the URL with
 * history.replaceState, so no RSC request is made.
 *
 * Because the context value only moves when the transition commits, the
 * pressed state would lag a click by that whole re-render. `pending` is the
 * urgent local echo: the clicked button shows pressed at once, and
 * aria-busy says the page is still catching up.
 */
export default function MeetingBasisToggle() {
  const { basis, requestedBasis, setBasis, datedAvailable } = useMeetingBasis();
  const [isPending, startTransition] = useTransition();
  const [pending, setPending] = useState<MeetingBasis | null>(null);

  // What the buttons show: the in-flight choice while a flip renders, else
  // the EFFECTIVE basis (lead-entry when the project turned out to have no
  // dated source, even if the URL asks for dated).
  const shown: MeetingBasis = isPending && pending ? pending : basis;

  const pick = (next: MeetingBasis) => {
    if (next === "dated" && !datedAvailable) return;
    // Compared with the REQUESTED basis (or the one still in flight), not the
    // shown one: on a project with no dated source a `?meetings=dated` link
    // shows lead-entry pressed, and clicking it is the reader saying "lead"
    // on purpose — that should clear the param, which the provider
    // otherwise deliberately keeps.
    const current = isPending && pending ? pending : requestedBasis;
    if (next === current) return;
    setPending(next);
    startTransition(() => setBasis(next));
  };

  return (
    <span className="rpt-basis">
      <span className="rpt-basis-lbl" aria-hidden>
        {BASIS_COPY.groupLabel}
      </span>
      <span
        className="rpt-basis-group"
        role="group"
        aria-label={BASIS_COPY.groupAria}
        aria-busy={isPending || undefined}
      >
        {MEETING_BASES.map((b) => {
          const active = shown === b;
          // Disabled, not hidden: the reader learns the option exists and
          // the title says why this project cannot use it. Availability is
          // reported by the rail (MeetingBasisAvailability) once the report
          // payload is in; until then the button is optimistically enabled.
          const disabled = b === "dated" && !datedAvailable;
          return (
            <button
              key={b}
              type="button"
              className={"rpt-basis-btn" + (active ? " is-active" : "")}
              aria-pressed={active}
              disabled={disabled}
              title={disabled ? BASIS_COPY.datedDisabled : BASIS_TITLES[b]}
              onClick={() => pick(b)}
            >
              {BASIS_LABELS[b]}
            </button>
          );
        })}
      </span>
    </span>
  );
}
