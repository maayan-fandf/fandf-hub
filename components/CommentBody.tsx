import type React from "react";

/**
 * Renders a comment / mention / task body. Supports two markdown-ish
 * tokens we use across the hub:
 *   - `![alt](url)` → inline image (URL whitelisted to drive.google.com /
 *     googleusercontent / docs.google.com / fandf hosts)
 *   - `[label](url)` → anchor link (same whitelist)
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
}: {
  body: string;
  truncateChars?: number;
  className?: string;
}) {
  const text = maybeTruncate(body || "", truncateChars);
  return <div className={className}>{renderBody(text)}</div>;
}

function maybeTruncate(body: string, max?: number): string {
  if (!max || body.length <= max) return body;
  if (IMG_RE.test(body) || LINK_RE.test(body)) return body;
  const slice = body.slice(0, max).replace(/\s+\S*$/, "");
  return slice + "…";
}

function renderBody(body: string): React.ReactNode {
  const lines = body.split("\n");
  return lines.map((line, i) => {
    const parts = tokenizeLine(line);
    if (parts.length === 1 && parts[0].kind === "text") {
      // Preserve blank lines as empty paragraphs so spacing reads right.
      return <p key={i}>{parts[0].text}</p>;
    }
    if (parts.length === 1 && parts[0].kind === "image") {
      // Single-image lines render as block elements so the image gets
      // its natural size instead of being stuck inside an inline <p>.
      return renderPart(parts[0], `${i}-0`);
    }
    return (
      <p key={i}>
        {parts.map((p, j) => (
          <span key={`${i}-${j}`}>{renderPart(p, `${i}-${j}`)}</span>
        ))}
      </p>
    );
  });
}

type Part =
  | { kind: "text"; text: string }
  | { kind: "image"; alt: string; viewUrl: string; embedUrl: string }
  | { kind: "link"; label: string; url: string };

const IMG_RE = /!\[([^\]\n]*)\]\(([^)\s]+)\)/;
const LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)/;

function tokenizeLine(line: string): Part[] {
  const out: Part[] = [];
  let rest = line;
  while (rest.length) {
    const imgMatch = rest.match(IMG_RE);
    const linkMatch = rest.match(LINK_RE);
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
  return {
    kind: "image",
    alt: alt || "image",
    viewUrl: url,
    embedUrl: `https://lh3.googleusercontent.com/d/${id}=w1600`,
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

function renderPart(part: Part, key: string): React.ReactNode {
  if (part.kind === "text") return <span key={key}>{part.text}</span>;
  if (part.kind === "image") {
    return (
      <a
        key={key}
        href={part.viewUrl}
        target="_blank"
        rel="noreferrer"
        className="comment-body-image-link"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={part.embedUrl}
          alt={part.alt}
          className="comment-body-image"
          loading="lazy"
        />
      </a>
    );
  }
  return (
    <a key={key} href={part.url} target="_blank" rel="noreferrer">
      {part.label}
    </a>
  );
}
