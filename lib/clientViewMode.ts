/**
 * The global "תצוגת לקוח" switch — shared between the top-nav toggle
 * (components/ClientViewSwitch, which writes it) and the server pages that
 * read it (app/layout.tsx, app/projects/[project]/page.tsx).
 *
 * A COOKIE rather than the old `?clientView=1` query parameter, because the
 * point is to STAY in it: on a Zoom call with a client the owner moves
 * between projects and sections, and a URL flag fell off at the first link
 * that did not carry it. The parameter is still honoured, for old links.
 *
 * Twelve hours, not forever: a switch left on after the call would have an
 * internal user reading stripped reports the next morning with no idea why.
 * A working day covers any call; the next day starts in the full view.
 */
export const CLIENT_VIEW_COOKIE = "hub_client_view";
export const CLIENT_VIEW_MAX_AGE = 60 * 60 * 12;
