/**
 * Capture a snapshot of "what the user is currently looking at" for
 * the chat drawer to send with every Gemini turn. Two layers, both
 * always shipped:
 *
 *   1. Auto-extracted base — `pathname`, `title`, and the visible text
 *      of `.app-shell-main` (capped). Works on every page without
 *      per-page wiring.
 *   2. Structured override — whatever the page registered via
 *      `useRegisterPageContext`. When present, it sits alongside the
 *      auto-extracted base (does NOT replace it) — Gemini gets both
 *      the rich structured object AND the rendered text, and picks
 *      whichever is more useful for the question.
 *
 * Browser-only — uses `document` / `location`. Safe to call from any
 * client component. Returns a JSON-serializable payload ready to ship
 * to /api/gemini/chat.
 */

import type { PageContextPayload } from "@/components/PageContextProvider";

/** Cap on auto-extracted visible text. ~3000 chars ≈ 750 tokens at
 *  Gemini's roughly 4 chars / token average for Hebrew + English mix.
 *  Cheap context cost; large enough to capture a typical page section
 *  without dragging in screens of dense data. */
const VISIBLE_TEXT_CHAR_CAP = 3000;
/** Cap on auto-extracted hub-internal links. 60 links × ~80 bytes/link
 *  ≈ ~5KB worst case; typical /tasks page has 30-40 task-row anchors. */
const VISIBLE_LINKS_CAP = 60;

export type PageContextSnapshot = {
  pathname: string;
  title: string;
  /** Cap-trimmed innerText of the main content area. Includes a
   *  trailing `…` marker when truncated so the LLM knows there's
   *  more it can request via tool calls. */
  visibleText: string;
  /** Hub-internal anchors visible on the page (`<a href="/...">`).
   *  Captured because they carry the canonical IDs (e.g. /tasks/T-…
   *  ids that aren't otherwise visible as text), so the model can
   *  emit real /tasks/<id> citations instead of fabricating ids
   *  from the row title alone. Deduped + capped. */
  visibleLinks?: { href: string; text: string }[];
  /** From the page-registered structured payload; absent when the
   *  page didn't register one. */
  label?: string;
  data?: unknown;
};

/** Read the current page's URL + title + visible-text into a payload
 *  and merge in any structured payload the page registered. Browser-
 *  only — calling from a server component throws on `location`. */
export function capturePageContext(
  registered: PageContextPayload | null,
): PageContextSnapshot {
  const pathname =
    typeof location !== "undefined" ? location.pathname : "/";
  const title = typeof document !== "undefined" ? document.title : "";

  let visibleText = "";
  let visibleLinks: { href: string; text: string }[] = [];
  if (typeof document !== "undefined") {
    // `.app-shell-main` is the wrapper around the page content (set
    // in app/layout.tsx). Falls back to <main> then <body> so this
    // never returns empty even if the layout markup changes.
    const root =
      document.querySelector<HTMLElement>(".app-shell-main") ||
      document.querySelector<HTMLElement>("main") ||
      document.body;
    const raw = (root?.innerText || "").replace(/\s+\n/g, "\n").trim();
    visibleText =
      raw.length > VISIBLE_TEXT_CHAR_CAP
        ? raw.slice(0, VISIBLE_TEXT_CHAR_CAP) + "\n…"
        : raw;
    // Harvest hub-internal anchors. We scope to relative paths so
    // off-site URLs (Google Drive, etc.) don't drown out the canonical
    // hub IDs the model actually wants for citations.
    if (root) {
      const seen = new Set<string>();
      const links: { href: string; text: string }[] = [];
      for (const a of Array.from(root.querySelectorAll("a[href^='/']"))) {
        const href = (a as HTMLAnchorElement).getAttribute("href") || "";
        if (!href || seen.has(href)) continue;
        const text = ((a as HTMLAnchorElement).innerText || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 100);
        if (!text) continue;
        seen.add(href);
        links.push({ href, text });
        if (links.length >= VISIBLE_LINKS_CAP) break;
      }
      visibleLinks = links;
    }
  }

  return {
    pathname,
    title,
    visibleText,
    ...(visibleLinks.length > 0 ? { visibleLinks } : {}),
    ...(registered?.label ? { label: registered.label } : {}),
    ...(registered?.data !== undefined ? { data: registered.data } : {}),
  };
}

/** Render the snapshot into a system-prompt block the chat route
 *  prepends to Gemini's system instruction. Format chosen so the
 *  model can clearly tell the structured payload apart from the
 *  rendered text and from the user's message. */
export function snapshotToSystemBlock(snap: PageContextSnapshot): string {
  const lines: string[] = [];
  lines.push("=== USER'S CURRENT SCREEN ===");
  lines.push(`Path: ${snap.pathname}`);
  lines.push(`Title: ${snap.title}`);
  if (snap.label) lines.push(`Label: ${snap.label}`);
  if (snap.data !== undefined) {
    lines.push("Structured data (JSON):");
    try {
      lines.push(JSON.stringify(snap.data, null, 2));
    } catch {
      lines.push("(could not serialize)");
    }
  }
  if (snap.visibleText) {
    lines.push("Visible text on screen:");
    lines.push(snap.visibleText);
  }
  if (snap.visibleLinks && snap.visibleLinks.length > 0) {
    lines.push("Hub-internal links on this page (use these EXACT hrefs");
    lines.push("when emitting markdown citations — never invent ids):");
    for (const l of snap.visibleLinks) {
      lines.push(`  ${l.href} — ${l.text}`);
    }
  }
  lines.push("=== END SCREEN ===");
  return lines.join("\n");
}
