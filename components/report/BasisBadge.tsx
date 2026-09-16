import {
  BASIS_COPY,
  FIXED_BADGES,
  untaggedMeetingsLine,
  type FixedBadge,
  type FixedBadgeKey,
  type MeetingBasis,
} from "@/lib/meetingBasis";
import { fmtInt, type ReportMeetingPair } from "@/lib/reportShared";

/**
 * The small visual vocabulary of the page-level meeting switch, shared by
 * every surface so "this has no number on this basis" and "this never
 * follows the switch" look and read the same everywhere.
 *
 * No hooks and no "use client": these render from server and client
 * components alike. Whether a lead-only badge shows at all (only under
 * "dated") is the calling surface's decision — it already has the basis
 * from useMeetingBasis().
 *
 * Styles: .rpt-basis-badge / .rpt-basis-dash / .rpt-basis-untagged in
 * app/globals.css. The untagged line is internal-only and hidden under
 * .rpt-clientview by CSS, so callers need not branch on the viewer.
 */

type BadgeProps =
  | { kind: FixedBadgeKey; className?: string }
  | {
      kind?: undefined;
      label: string;
      title: string;
      tone?: FixedBadge["tone"];
      className?: string;
    };

/**
 * A basis badge. Pass `kind` for one of the fixed badges in
 * lib/meetingBasis FIXED_BADGES (the normal case), or `label` + `title`
 * for a one-off. The explanation lives in the tooltip; the badge itself
 * stays a few words.
 */
export function BasisBadge(props: BadgeProps) {
  const b: FixedBadge = props.kind
    ? FIXED_BADGES[props.kind]
    : { label: props.label, title: props.title, tone: props.tone ?? "fixed" };
  return (
    <span
      className={
        `rpt-basis-badge is-${b.tone}` +
        (props.className ? ` ${props.className}` : "")
      }
      title={b.title}
    >
      {b.label}
    </span>
  );
}

export type BasisDashReason = "no-source" | "cross-basis";

/**
 * "—" for a cell that has no number on the current basis, with the reason
 * in its tooltip (and as its accessible name, so a screen reader says why
 * rather than "dash").
 *
 *   reason "no-source"   — `basis` has no source for this project/platform
 *                          (undefined in the payload). Default basis: dated.
 *   reason "cross-basis" — a ratio whose sides would be counted on different
 *                          bases (ליד→תיאום, המרה לתיאום under dated).
 *   title                — overrides both.
 */
export function BasisDash({
  reason = "no-source",
  basis = "dated",
  title,
  className,
}: {
  reason?: BasisDashReason;
  basis?: MeetingBasis;
  title?: string;
  className?: string;
}) {
  const tip =
    title ??
    (reason === "cross-basis"
      ? BASIS_COPY.dashCrossBasis
      : BASIS_COPY.dashNoSource[basis]);
  return (
    <span
      className={"rpt-basis-dash" + (className ? ` ${className}` : "")}
      title={tip}
      aria-label={tip}
    >
      —
    </span>
  );
}

/**
 * A basis-dependent number: formatted when it is a number, BasisDash when
 * it is null / undefined / NaN — the payload's way of saying "this basis
 * has no source". A 0 is a measured zero and prints as 0.
 */
export function BasisNum({
  value,
  format = fmtInt,
  reason,
  basis,
  title,
}: {
  value: number | null | undefined;
  format?: (n: number) => string;
  reason?: BasisDashReason;
  basis?: MeetingBasis;
  title?: string;
}) {
  if (value == null || Number.isNaN(value)) {
    return <BasisDash reason={reason} basis={basis} title={title} />;
  }
  return <>{format(value)}</>;
}

/**
 * The internal "עוד N תיאומים · M ביצועים מלידים ללא תגית UTM" line under a
 * platform's group cards (ReportCreatives.untagged / fbBreakdown.untagged,
 * picked for the current basis). Renders nothing when the pair is missing
 * or both counts are 0.
 */
export function UntaggedMeetingsLine({
  pair,
  className,
}: {
  pair: ReportMeetingPair | null | undefined;
  className?: string;
}) {
  if (!pair || (pair.scheduled <= 0 && pair.held <= 0)) return null;
  return (
    <span className={"rpt-basis-untagged" + (className ? ` ${className}` : "")}>
      {untaggedMeetingsLine(pair.scheduled, pair.held)}
    </span>
  );
}
