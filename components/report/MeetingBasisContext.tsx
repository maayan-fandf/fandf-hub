"use client";

import Link, { useLinkStatus } from "next/link";
import { useSearchParams } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  MEETING_BASIS_PARAM,
  effectiveMeetingBasis,
  hrefWithMeetingBasis,
  parseMeetingBasis,
  type MeetingBasis,
} from "@/lib/meetingBasis";

/**
 * The page-level meeting-count switch, as React state.
 *
 * One provider wraps the children of the project page's <main>, so the
 * sticky header (where the switch sits) AND the rail below it read the same
 * value — CrmSourceFilterProvider sits lower and would not reach the
 * header. The server seeds it from `?meetings=` (parseMeetingBasis), so a
 * client component's FIRST render already matches the URL: the SSR HTML
 * shows the right basis, no flash, no hydration mismatch.
 *
 * A flip is pure client state plus `history.replaceState` — no navigation,
 * no RSC request. Next ≥15.1 syncs replaceState into useSearchParams, so the
 * month picker's router.push and the rail's section sync carry `meetings`
 * forward on their own. Hidden rail panels are frozen by FreezeWhenHidden,
 * but context still reaches their consumers.
 *
 * EXCEPT while a router navigation is in flight. Next patches replaceState
 * (next 15.5.15, client/components/app-router.js) into an ACTION_RESTORE
 * built from the URL plus the tree in history.state — still the OLD tree,
 * since history is only written when a navigation commits — and a RESTORE
 * marks whatever action is pending as discarded (app-router-instance.js
 * dispatchAction). So a flip during the several seconds the month picker's
 * router.push takes silently cancelled it: the page stayed on September,
 * the picker's "מעדכן…" cleared, and August never loaded (reproduced in a
 * minimal app on the repo's own Next). A flip therefore applies its STATE
 * at once but defers the URL write until every reported navigation has
 * committed (useReportNavigationPending — the month picker and BasisLink
 * report theirs), then writes it from an effect, which runs after Next's
 * HistoryUpdater has put the new tree in history.state. Navigations that
 * do not report (a stray router.refresh) keep the old hazard.
 *
 * URL ONLY — no localStorage, no cookie. A remembered "dated" would make one
 * link show two people different numbers, which is the disagreement the
 * switch exists to remove. A link without the param opens on lead-entry.
 */

export type MeetingBasisContextValue = {
  /**
   * The EFFECTIVE basis — what every surface renders and passes to the
   * reportShared swap helpers. It is the requested basis, except lead-entry
   * once the page has reported that the project has no dated source at all.
   * A surface whose OWN dated data is missing (datedSource null, SF joins,
   * sourceMatrices.dated undefined) still shows "—" under "dated"; this
   * only covers the whole-project case.
   */
  basis: MeetingBasis;
  /** What the URL / the switch asked for. The switch's aria-pressed state
   *  uses `basis`; this exists for the rare page where they differ. */
  requestedBasis: MeetingBasis;
  /** Flip the page. Mirrors to the URL (`?meetings=dated`, or removes the
   *  param for lead) keeping every other param and the hash. A request for
   *  "dated" is ignored once the project was reported to have no dated
   *  source. Stable identity. */
  setBasis: (basis: MeetingBasis) => void;
  /**
   * Whether the project has ANY dated source (ערוצים datedSource or dated
   * creatives joins) — the switch disables its dated button when false.
   * Inside the provider it is optimistic (true) until
   * <MeetingBasisAvailability> reports, because the rail's data streams in
   * after the header renders; outside any provider it is false.
   */
  datedAvailable: boolean;
  /** Called by <MeetingBasisAvailability>. Stable identity. */
  setDatedAvailable: (available: boolean) => void;
  /** Called by useReportNavigationPending: `id` (a useId) has a router
   *  navigation in flight, or no longer does. While any has, a flip defers
   *  its URL write (see the file doc). Stable identity. */
  reportNavigationPending: (id: string, pending: boolean) => void;
};

const noop = () => {};

/** Outside a provider (the ?report=classic layout's inner components, a
 *  stray render in tests) everything reads lead-entry and cannot flip. */
const DEFAULT_VALUE: MeetingBasisContextValue = {
  basis: "lead",
  requestedBasis: "lead",
  setBasis: noop,
  datedAvailable: false,
  setDatedAvailable: noop,
  reportNavigationPending: noop,
};

/** Write `basis` into the address bar, keeping every other param and the
 *  hash. Goes through Next's patched replaceState on purpose: that is what
 *  moves useSearchParams, which the picker builds its next URL from. */
function mirrorBasisToUrl(basis: MeetingBasis): void {
  const { pathname, search, hash } = window.location;
  window.history.replaceState(null, "", hrefWithMeetingBasis(pathname + search + hash, basis));
}

const MeetingBasisCtx = createContext<MeetingBasisContextValue>(DEFAULT_VALUE);

export function MeetingBasisProvider({
  initial,
  children,
}: {
  /** parseMeetingBasis(searchParams.meetings), server-side. */
  initial: MeetingBasis;
  children: ReactNode;
}) {
  const [requested, setRequested] = useState<MeetingBasis>(initial);
  // Re-sync to the URL whenever the URL's basis changes. A soft navigation
  // within the page (a link that drops the param, the period reset) keeps
  // this provider instance — same route segment — and with it the state, so
  // without this a page flipped to dated would keep showing dated under a
  // URL that no longer says so. Keyed on the URL value, NOT on `initial`:
  // after a flip to dated, a link back to a param-less URL re-renders the
  // server tree with the same `initial` ("lead") it started with, and a
  // prop comparison would miss it. Our own replaceState also moves the URL
  // value, but to what `requested` already holds, so it is a no-op. Done
  // during render (React's "adjust state when an input changes" pattern) so
  // the new page's first paint is already right. useSearchParams is safe
  // here without a Suspense boundary because the page is force-dynamic.
  const searchParams = useSearchParams();
  const urlBasis = searchParams
    ? parseMeetingBasis(searchParams.get(MEETING_BASIS_PARAM))
    : initial;
  const [seenUrlBasis, setSeenUrlBasis] = useState<MeetingBasis>(urlBasis);
  if (urlBasis !== seenUrlBasis) {
    setSeenUrlBasis(urlBasis);
    setRequested(urlBasis);
  }
  // null = not reported yet (treated as available, see datedAvailable).
  const [reported, setReported] = useState<boolean | null>(null);

  // Navigations in flight, by reporter id — a ref, so setBasis reads the
  // current set without re-creating itself — and the state that re-runs the
  // flush effect when the last one commits. Kept OUT of the context value:
  // every chart consumer re-rendering on each navigation start would be
  // pure cost.
  const pendingNavs = useRef(new Set<string>());
  const [navPending, setNavPending] = useState(false);
  // The basis a flip asked for while a navigation was pending — written to
  // the URL once none is. The latest flip wins.
  const deferredUrl = useRef<MeetingBasis | null>(null);

  const setBasis = useCallback(
    (next: MeetingBasis) => {
      if (next === "dated" && reported === false) return;
      setRequested(next);
      if (pendingNavs.current.size > 0) deferredUrl.current = next;
      else mirrorBasisToUrl(next);
    },
    [reported],
  );

  const reportNavigationPending = useCallback((id: string, pending: boolean) => {
    const set = pendingNavs.current;
    if (pending) set.add(id);
    else set.delete(id);
    setNavPending(set.size > 0);
  }, []);

  // Flush after the navigation committed. The URL-basis re-sync above does
  // not undo the flip on the way: the navigation's URL was built before the
  // flip, so it carries the basis `seenUrlBasis` already holds, and nothing
  // changes until this write moves it.
  useEffect(() => {
    if (navPending || !deferredUrl.current) return;
    const b = deferredUrl.current;
    deferredUrl.current = null;
    mirrorBasisToUrl(b);
  }, [navPending]);

  const setDatedAvailable = useCallback((available: boolean) => {
    setReported(available);
  }, []);

  const datedAvailable = reported !== false;
  const value = useMemo<MeetingBasisContextValue>(
    () => ({
      basis: effectiveMeetingBasis(requested, datedAvailable),
      requestedBasis: requested,
      setBasis,
      datedAvailable,
      setDatedAvailable,
      reportNavigationPending,
    }),
    [requested, datedAvailable, setBasis, setDatedAvailable, reportNavigationPending],
  );

  return <MeetingBasisCtx.Provider value={value}>{children}</MeetingBasisCtx.Provider>;
}

export function useMeetingBasis(): MeetingBasisContextValue {
  return useContext(MeetingBasisCtx);
}

/**
 * Tell the provider a router navigation this component started is in
 * flight (`pending`), so a meeting-switch flip in the meantime does not
 * write the URL and discard it (see the file doc). Pass the `isPending` of
 * the transition that wraps router.push / router.refresh. Clears itself on
 * unmount. A no-op outside a provider.
 */
export function useReportNavigationPending(pending: boolean): void {
  const { reportNavigationPending } = useMeetingBasis();
  const id = useId();
  useEffect(() => {
    reportNavigationPending(id, pending);
  }, [id, pending, reportNavigationPending]);
  useEffect(() => () => reportNavigationPending(id, false), [id, reportNavigationPending]);
}

/**
 * Renders nothing; tells the provider whether the project has any dated
 * source. Mounted once by the (server) NativeProjectRail with
 *   dated={!!data?.datedSource || !!data?.creatives?.meetingBases?.dated}
 *
 * When it reports false while the URL asks for dated, the page renders
 * lead-entry and the switch shows its dated button disabled — but the URL
 * param is deliberately NOT stripped: a transient warehouse miss nulls
 * datedSource for one render, and the next navigation should come back to
 * the reader's choice rather than silently resetting it.
 */
export function MeetingBasisAvailability({ dated }: { dated: boolean }) {
  const { setDatedAvailable } = useMeetingBasis();
  useEffect(() => {
    setDatedAvailable(dated);
  }, [dated, setDatedAvailable]);
  return null;
}

/** Rendered inside a BasisLink: reports that link's own navigation
 *  (useLinkStatus reads the nearest enclosing Link) to the provider. */
function LinkNavigationPending() {
  const { pending } = useLinkStatus();
  useReportNavigationPending(pending);
  return null;
}

/**
 * A next/link whose href carries the CURRENT basis. For links the server
 * builds once (client preview on/off, period reset): after a flip their
 * server-side href is stale, so the param is re-applied from context on
 * every render, i.e. by the time anyone can click. Carries the REQUESTED
 * basis, so a reader's "dated" survives a page where it could not apply.
 * `href` must be a string.
 *
 * PREFETCH IS OFF, because of that re-applied href. In Next 15.5 the Link's
 * visibility ref callback depends on `href` (app-dir/link.js), so a flip
 * unmounts and re-observes the anchor, and in production a visible link is
 * then prefetched: once the page's seeded same-path cache entry has aged
 * past 5 minutes, every flip with the rail bar in view sent a real `?_rsc`
 * request rendering up to loading.tsx — breaking "a flip makes no network
 * request", and invisibly in dev, which never prefetches on visibility.
 * Both links are internal-only rail-bar controls; a click still navigates
 * normally, streaming loading.tsx as usual.
 *
 * Its own navigation is reported to the provider (LinkNavigationPending),
 * so a flip while it loads defers the URL write instead of discarding it.
 */
export function BasisLink({
  href,
  children,
  ...rest
}: Omit<ComponentProps<typeof Link>, "href"> & { href: string }) {
  const { requestedBasis } = useMeetingBasis();
  return (
    <Link {...rest} prefetch={false} href={hrefWithMeetingBasis(href, requestedBasis)}>
      {children}
      <LinkNavigationPending />
    </Link>
  );
}
