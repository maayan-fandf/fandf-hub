import type React from "react";

/**
 * Auto-link bare URLs inside a free-form text string. Returns React
 * nodes alternating between plain `<span>` text and `<a target="_blank">`
 * links. Use anywhere user-entered text might contain a URL but the
 * surrounding component doesn't run it through `CommentBody` (which has
 * its own richer markdown-ish parser).
 *
 * Surfaces today:
 *   - Task description on /tasks/[id] (`task-detail-body`)
 *   - Status history notes (`task-status-history-note`)
 *   - Notification body on /notifications (`notification-row-text`)
 *   - Task description preview on the /tasks queue
 *     (`tasks-desc-preview`)
 *
 * Mirrors `CommentBody`'s bare-URL detection so behaviour is uniform:
 *   - Matches `http://` / `https://` followed by non-whitespace
 *   - Strips trailing sentence-final punctuation (`.`, `,`, `)`, `]`,
 *     `>`) from the link target — the punct stays in the surrounding
 *     text so a URL at the end of a sentence reads naturally
 *   - LTR direction on the anchor so URLs render left-to-right inside
 *     RTL paragraphs
 *   - `.autolink` class for shared CSS (long-URL wrapping etc.)
 */
const BARE_URL_RE = /https?:\/\/[^\s<>"']+/g;

function trimUrlTrailingPunct(url: string): string {
  // Repeatedly strip sentence-final punctuation. `).` happens.
  let out = url;
  while (/[.,)\]>]$/.test(out)) {
    out = out.slice(0, -1);
  }
  return out;
}

export function linkifyText(text: string): React.ReactNode {
  if (!text) return text;
  // Reset matchAll's lastIndex implicitly by creating a fresh string
  // iterator; safe because BARE_URL_RE is `g` but we only iterate once
  // per call.
  const matches: { idx: number; raw: string; trimmed: string }[] = [];
  for (const m of text.matchAll(BARE_URL_RE)) {
    if (typeof m.index !== "number") continue;
    matches.push({
      idx: m.index,
      raw: m[0],
      trimmed: trimUrlTrailingPunct(m[0]),
    });
  }
  if (matches.length === 0) return text;

  const out: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const m of matches) {
    if (m.idx > cursor) {
      out.push(<span key={`t${key++}`}>{text.slice(cursor, m.idx)}</span>);
    }
    out.push(
      <a
        key={`l${key++}`}
        href={m.trimmed}
        target="_blank"
        rel="noopener noreferrer"
        dir="ltr"
        className="autolink"
      >
        {m.trimmed}
      </a>,
    );
    // Advance past the trimmed URL — any trailing punctuation we
    // stripped falls back into the next plain-text run.
    cursor = m.idx + m.trimmed.length;
  }
  if (cursor < text.length) {
    out.push(<span key={`t${key++}`}>{text.slice(cursor)}</span>);
  }
  return out;
}

/**
 * Convenience: split a string on `\n` and linkify each line, returning
 * an array of `<p>` elements. The dominant pattern across the hub for
 * rendering multi-line free-form text — task descriptions and the
 * notifications body both use this shape.
 *
 * Pass an existing `className` for the wrapping `<p>` tags, or omit
 * for unstyled.
 */
export function linkifyParagraphs(
  text: string,
  paragraphClassName?: string,
): React.ReactNode {
  if (!text) return null;
  return text.split("\n").map((line, i) => (
    <p key={i} dir="auto" className={paragraphClassName}>
      {linkifyText(line)}
    </p>
  ));
}
