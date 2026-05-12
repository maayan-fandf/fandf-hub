import type React from "react";
import type { TasksPerson } from "@/lib/appsScript";
import { personDisplayName } from "@/lib/personDisplay";
import CommentBodyImage from "./CommentBodyImage";
import Avatar, { avatarHoverText } from "./Avatar";

/**
 * Renders a comment / mention / task body. Supports the markdown-ish
 * tokens we use across the hub:
 *   - `![alt](url)` → inline image (URL whitelisted to drive.google.com /
 *     googleusercontent / docs.google.com / fandf hosts)
 *   - `[label](url)` → anchor link (same whitelist)
 *   - `@<email>` → person mention; rendered as the person's Hebrew
 *     display name (resolved from the optional `people` prop) with the
 *     full email kept as a `title` tooltip. Falls back to the email
 *     prefix when `people` is missing, so the omission only degrades
 *     the rendered name — never the meaning.
 *
 * Anything that doesn't match the whitelist is rendered as plain text —
 * blocks `javascript:` URLs and arbitrary tracking hosts even if a user
 * pastes one in by hand.
 *
 * Lifted from TaskComments.tsx so every preview / inbox / timeline /
 * thread-reply path renders attachments the same way. Without this, the
 * `![image.png](...drive...)` token uploaded from the comment composer
 * showed as raw text (the bug the user hit on the project page).
 *
 * `truncateChars`: when set and the body is longer than the threshold
 * AND contains no image tokens, the text is truncated with an ellipsis.
 * Bodies with images render in full — truncation through an image token
 * would either break the parse or hide the asset, both worse than
 * showing slightly more content.
 */
export default function CommentBody({
  body,
  truncateChars,
  className,
  people,
}: {
  body: string;
  truncateChars?: number;
  className?: string;
  /** Optional roster — when supplied, `@email` tokens are rendered as
   *  the person's Hebrew display name. Without it mentions still render
   *  (just as the email prefix). */
  people?: TasksPerson[];
}) {
  const text = maybeTruncate(body || "", truncateChars);
  // dir="auto" lets the browser pick LTR vs RTL per comment based on
  // the first strong character. Without it every body inherits the
  // page's RTL direction, which mangles English snippets / code
  // pasted into a comment by an English-first user.
  return (
    <div className={className} dir="auto">
      {renderBody(text, people)}
    </div>
  );
}

function maybeTruncate(body: string, max?: number): string {
  if (!max || body.length <= max) return body;
  if (IMG_RE.test(body) || LINK_RE.test(body)) return body;
  const slice = body.slice(0, max).replace(/\s+\S*$/, "");
  return slice + "…";
}

function renderBody(body: string, people?: TasksPerson[]): React.ReactNode {
  const lines = body.split("\n");
  // dir="auto" on each <p> so lines pick LTR/RTL independently from
  // their own first strong character. Container-level dir="auto"
  // computes one direction across all descendants, which mishandles
  // messages that mix Hebrew + English across lines.
  return lines.map((line, i) => {
    const parts = tokenizeLine(line);
    if (parts.length === 1 && parts[0].kind === "text") {
      // Preserve blank lines as empty paragraphs so spacing reads right.
      return <p key={i} dir="auto">{parts[0].text}</p>;
    }
    if (parts.length === 1 && parts[0].kind === "image") {
      // Single-image lines render as block elements so the image gets
      // its natural size instead of being stuck inside an inline <p>.
      // Wrapped in dir="rtl" because an image-only line has no strong
      // text characters for `dir="auto"` on the parent to anchor on,
      // which made the inline-block image float to the LEFT of the
      // RTL comment column. Reported by Maayan 2026-05-06. The hub is
      // Hebrew-first, so RTL is the right default for image-only
      // lines (text + image lines still inherit dir="auto" via their
      // own <p> wrapper below — that case is unchanged).
      return (
        <div key={i} dir="rtl" className="comment-body-image-row">
          {renderPart(parts[0], `${i}-0`, people)}
        </div>
      );
    }
    // Lines that contain ONLY mentions (or only links / autolinks /
    // images mixed with mentions but no strong-direction text) need
    // an explicit dir="rtl" too — same root cause as the image-only
    // case. The leading `@` in `@<HebrewName>` is a weak character,
    // so `dir="auto"` on the parent looked at the next strong
    // character, which (because the chip's body is rendered as
    // independent inline-block content) is whatever comes AFTER the
    // chip on the line. When a line is mention-only, there's nothing
    // after, and the browser fell back to LTR — leaving the chip
    // pinned to the LEFT of an otherwise RTL comment column.
    // Reported by Maayan 2026-05-06.
    const hasStrongText = parts.some(
      (p) => p.kind === "text" && /\S/.test(p.text),
    );
    return (
      <p key={i} dir={hasStrongText ? "auto" : "rtl"}>
        {parts.map((p, j) => (
          <span key={`${i}-${j}`}>{renderPart(p, `${i}-${j}`, people)}</span>
        ))}
      </p>
    );
  });
}

type Part =
  | { kind: "text"; text: string }
  | { kind: "image"; alt: string; viewUrl: string; embedUrl: string }
  | { kind: "link"; label: string; url: string }
  // Bare http(s) URL detected in plain text — rendered as an
  // auto-link with the URL itself as the label. CSS wraps long URLs
  // inside the comment body so they don't blow the column width.
  | { kind: "autolink"; url: string }
  // `@email@host.tld` token — renders as the person's Hebrew display
  // name when the people roster is available, otherwise as the email
  // prefix. Email is preserved on the rendered span as a tooltip so
  // hover reveals who exactly was tagged.
  | { kind: "mention"; email: string };

const IMG_RE = /!\[([^\]\n]*)\]\(([^)\s]+)\)/;
const LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)/;
// Bare URL detector — matches http:// or https:// followed by any
// non-whitespace characters, trimming common trailing punctuation
// (`.`, `,`, `)`, `]`) that's almost always sentence-final rather
// than part of the URL. Tested against Facebook ads-manager URLs
// (which include `?act=...&filter_set=...&selected_ad_ids=...%2C...`)
// — those match cleanly.
const BARE_URL_RE = /https?:\/\/[^\s<>"]+/;
// `@email` mention token — leading `@` followed by a standard email.
// Captures the email (without the leading `@`) as group 1 so the
// renderer can resolve it against the people roster. Conservative
// pattern: stops at whitespace, common punctuation, and angle
// brackets. Not anchored — multiple mentions on a single line are
// matched one by one as the tokenizer advances.
const MENTION_RE = /@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/;
function trimUrlTrailingPunct(url: string): string {
  // Strip trailing punctuation that's typically sentence-final, not
  // part of the URL. Repeatedly trim — `).` happens too.
  return url.replace(/[.,)\]>]+$/g, "");
}

function tokenizeLine(line: string): Part[] {
  const out: Part[] = [];
  let rest = line;
  while (rest.length) {
    const imgMatch = rest.match(IMG_RE);
    const linkMatch = rest.match(LINK_RE);
    const bareMatch = rest.match(BARE_URL_RE);
    const mentionMatch = rest.match(MENTION_RE);
    let chosen: { idx: number; len: number; part: Part } | null = null;
    if (imgMatch && typeof imgMatch.index === "number") {
      const [whole, alt, url] = imgMatch;
      const img = toImagePart(alt, url);
      if (img) chosen = { idx: imgMatch.index, len: whole.length, part: img };
    }
    if (linkMatch && typeof linkMatch.index === "number") {
      // Skip link matches that are actually the `![alt](...)` prefix.
      const isImagePrefix = linkMatch.index > 0 && rest[linkMatch.index - 1] === "!";
      if (
        !isImagePrefix &&
        (!chosen || linkMatch.index < chosen.idx)
      ) {
        const [whole, label, url] = linkMatch;
        const link = toLinkPart(label, url);
        if (link) chosen = { idx: linkMatch.index, len: whole.length, part: link };
      }
    }
    if (bareMatch && typeof bareMatch.index === "number") {
      // Don't auto-link inside a `[...](url)` or `![...](url)` token —
      // the markdown matchers above own those URLs. We detect this
      // by checking whether the bare URL match starts inside a
      // markdown bracket pair: if the chosen markdown match's range
      // covers this bare URL's position, skip.
      const insideMarkdown =
        chosen != null &&
        bareMatch.index >= chosen.idx &&
        bareMatch.index < chosen.idx + chosen.len;
      if (
        !insideMarkdown &&
        (!chosen || bareMatch.index < chosen.idx)
      ) {
        const trimmed = trimUrlTrailingPunct(bareMatch[0]);
        chosen = {
          idx: bareMatch.index,
          len: trimmed.length, // use trimmed length so trailing `.` stays in text
          part: { kind: "autolink", url: trimmed },
        };
      }
    }
    if (mentionMatch && typeof mentionMatch.index === "number") {
      // Mentions live INSIDE no other token (img/link consume their
      // own brackets, bare URLs are http(s)://). We still gate on
      // chosen-precedence to keep the leftmost-match-wins ordering
      // consistent across all token kinds.
      if (!chosen || mentionMatch.index < chosen.idx) {
        const [whole, email] = mentionMatch;
        chosen = {
          idx: mentionMatch.index,
          len: whole.length,
          part: { kind: "mention", email },
        };
      }
    }
    if (!chosen) {
      out.push({ kind: "text", text: rest });
      break;
    }
    if (chosen.idx > 0) {
      out.push({ kind: "text", text: rest.slice(0, chosen.idx) });
    }
    out.push(chosen.part);
    rest = rest.slice(chosen.idx + chosen.len);
  }
  return out;
}

function toImagePart(alt: string, url: string): Part | null {
  const id = extractDriveFileId(url);
  if (!id) return null;
  // Route the inline render through the hub's own Drive-image proxy
  // (`/api/drive/image/<fileId>`) instead of `lh3.googleusercontent.com`.
  // The lh3 CDN only serves files the viewer's Google session can see
  // — pasted-screenshot files end up in the SA's task Drive folder
  // (not publicly shared), so the cross-origin lh3 request 403'd and
  // the comment rendered as a broken-image icon next to the alt text.
  // The proxy reads via DRIVE_FOLDER_OWNER (DWD-scoped SA) and streams
  // the bytes from the same origin as the hub, so cookies/auth work.
  // Reported by Maayan 2026-05-12 on /tasks/T-mp2gzfvi-w8wg. The
  // `viewUrl` (original Drive view link) stays unchanged — it's only
  // used as the lightbox's "פתח ב-Drive" affordance.
  return {
    kind: "image",
    alt: alt || "image",
    viewUrl: url,
    embedUrl: `/api/drive/image/${encodeURIComponent(id)}`,
  };
}

function toLinkPart(label: string, url: string): Part | null {
  if (!isSafeUrl(url)) return null;
  return { kind: "link", label, url };
}

function extractDriveFileId(url: string): string | null {
  const m1 = url.match(/^https:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m1) return m1[1];
  const m2 = url.match(/^https:\/\/drive\.google\.com\/.*[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2) return m2[1];
  const m3 = url.match(/^https:\/\/lh3\.googleusercontent\.com\/d\/([a-zA-Z0-9_-]+)/);
  if (m3) return m3[1];
  return null;
}

function isSafeUrl(url: string): boolean {
  if (!/^https:\/\//.test(url)) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return (
      host === "drive.google.com" ||
      host === "lh3.googleusercontent.com" ||
      host === "docs.google.com" ||
      host === "hub.fandf.co.il" ||
      host.endsWith(".fandf.co.il")
    );
  } catch {
    return false;
  }
}

function renderPart(
  part: Part,
  key: string,
  people?: TasksPerson[],
): React.ReactNode {
  if (part.kind === "text") return <span key={key}>{part.text}</span>;
  if (part.kind === "image") {
    // Image tokens render through a client subcomponent that opens
    // the in-app lightbox on click instead of navigating to Drive.
    // The original viewUrl is preserved on the lightbox's "פתח
    // ב-Drive" button for users who DO want the Drive view.
    return (
      <CommentBodyImage
        key={key}
        alt={part.alt}
        viewUrl={part.viewUrl}
        embedUrl={part.embedUrl}
      />
    );
  }
  if (part.kind === "autolink") {
    // Bare URL — render as a clickable link with the URL itself as
    // the visible text. dir="ltr" forces LTR rendering even inside
    // an RTL paragraph (URLs read left-to-right). The `comment-body-
    // autolink` class adds overflow-wrap so very long URLs (Facebook
    // ads-manager etc.) wrap inside the comment column instead of
    // blowing the row width.
    return (
      <a
        key={key}
        href={part.url}
        target="_blank"
        rel="noreferrer"
        dir="ltr"
        className="comment-body-autolink"
      >
        {part.url}
      </a>
    );
  }
  if (part.kind === "mention") {
    // `@email@host.tld` → `<Avatar/> @<HebrewName>` when the roster
    // is available; falls back to the email prefix when no roster
    // was passed. Full email kept on the title attribute so a hover
    // confirms exactly who was tagged.
    //
    // The Avatar uses the email as its key so the workspace photo
    // overlay (when present) shows directly inside the mention chip
    // — the chip becomes recognizable at a glance even without
    // reading the name. Reported by Maayan 2026-05-06.
    const fallbackHandle = part.email.split("@")[0];
    const display = people
      ? personDisplayName(part.email, people) || fallbackHandle
      : fallbackHandle;
    const mentionedRole = people?.find(
      (p) => p.email.toLowerCase() === part.email.toLowerCase(),
    )?.role;
    return (
      <span
        key={key}
        className="comment-body-mention"
        title={avatarHoverText(display, part.email, mentionedRole)}
        dir="auto"
      >
        <Avatar name={part.email} size={16} role={mentionedRole} />
        @{display}
      </span>
    );
  }
  return (
    <a key={key} href={part.url} target="_blank" rel="noreferrer">
      {part.label}
    </a>
  );
}
