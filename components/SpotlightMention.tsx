"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";

/**
 * Global "you were tagged" spotlight bar.
 *
 * Design intent: of all the noise in the hub (open tasks, project
 * cards, alerts, comments), the SINGLE thing the user can least afford
 * to miss is a personal tag waiting for them. So we elevate the most
 * recent unresolved mention into a sticky bar just under the topnav,
 * on every authenticated page, until they acknowledge it. Once they
 * click through (or explicitly dismiss), the bar advances to the next
 * mention down the list, or disappears entirely when the inbox is clean.
 *
 * Why localStorage for "seen" state (not server-side prefs):
 *   - Cheap, no extra Sheets write on every click-through.
 *   - Per-device is acceptable — if Maayan dismisses on desktop and
 *     reopens on mobile, the bar reappears for one beat on mobile;
 *     that's correct behavior, not a bug. Each device gets one nudge.
 *   - The server still owns the authoritative "resolved" state via the
 *     existing thread-resolve flow — the spotlight bar is a visibility
 *     layer ON TOP of that, not a replacement.
 *
 * Why we fetch top-10 (not just top-1):
 *   - Lets us advance past locally-dismissed ids without a second
 *     round-trip. If the user dismissed mention #1 yesterday and #2
 *     isn't resolved yet, today they see #2 as the spotlight
 *     immediately on page load.
 */

const DISMISSED_KEY = "__fandf_spotlight_dismissed_ids";
const DISMISSED_CAP = 50; // keep the localStorage payload small

type SpotlightMentionData = {
  comment_id: string;
  thread_root_id?: string;
  parent_id: string;
  project: string;
  author_email: string;
  author_name: string;
  body: string;
  timestamp: string;
  deep_link: string;
};

function readDismissed(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeDismissed(ids: string[]): void {
  if (typeof window === "undefined") return;
  try {
    // Trim from the front (oldest) so the cap stays sane forever.
    const trimmed = ids.length > DISMISSED_CAP ? ids.slice(-DISMISSED_CAP) : ids;
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(trimmed));
  } catch {
    // Storage full / disabled — degrade silently. Worst case is the bar
    // reappears next page nav. That's annoying, not broken.
  }
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

/** Strip @-mention markup from a comment body for the preview line.
 *  Comment bodies store mentions as `@email@host` literals; the inbox's
 *  CommentBody component does the prettified rendering server-side
 *  with the people roster. For a short preview we just collapse the
 *  whole email reference to "@<local-part>" so the bar stays readable
 *  even when the body opens with five @-tags. */
function flattenMentions(body: string): string {
  return body
    .replace(/@([A-Za-z0-9._%+-]+)@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "@$1")
    .replace(/\s+/g, " ")
    .trim();
}

function shortAuthor(name: string, email: string): string {
  const trimmed = (name || "").trim();
  if (trimmed) return trimmed;
  return (email || "").split("@")[0] || "מישהו";
}

export default function SpotlightMention() {
  const pathname = usePathname();
  const [mentions, setMentions] = useState<SpotlightMentionData[] | null>(null);
  // Re-read localStorage on every render trigger — dismissed ids may
  // change via another tab. Avoids stuck-bar UX when the same user has
  // two hub tabs open.
  const [dismissedTick, setDismissedTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/mentions/spotlight", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { mentions?: SpotlightMentionData[] };
        if (!cancelled) setMentions(data.mentions ?? []);
      } catch {
        // Silent — better to skip the bar than crash the page.
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-fetch on route change so the bar reflects mentions resolved
    // server-side while the user was browsing. Lightweight: same
    // pattern as NavInboxLink.
  }, [pathname]);

  // Cross-tab sync — when another tab dismisses, our bar should hide
  // without waiting for a route change.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === DISMISSED_KEY) setDismissedTick((t) => t + 1);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const current = useMemo(() => {
    if (!mentions || mentions.length === 0) return null;
    const dismissed = new Set(readDismissed());
    return mentions.find((m) => !dismissed.has(m.comment_id)) ?? null;
    // dismissedTick deliberately listed — bumping it forces re-evaluation
    // after a storage event from another tab.
  }, [mentions, dismissedTick]);

  const markDismissed = useCallback((id: string) => {
    const ids = readDismissed();
    if (!ids.includes(id)) {
      ids.push(id);
      writeDismissed(ids);
    }
    setDismissedTick((t) => t + 1);
  }, []);

  if (!current) return null;

  const author = shortAuthor(current.author_name, current.author_email);
  const preview = truncate(flattenMentions(current.body), 140);

  return (
    <div className="spotlight-bar" role="status" aria-live="polite">
      <span className="spotlight-icon" aria-hidden>
        🏷️
      </span>
      <span className="spotlight-text">
        <b className="spotlight-author">{author}</b>
        <span className="spotlight-sep"> · </span>
        <span className="spotlight-project">{current.project}</span>
        <span className="spotlight-sep"> · </span>
        <span className="spotlight-body">{preview}</span>
      </span>
      <Link
        href={current.deep_link}
        className="spotlight-open"
        onClick={() => markDismissed(current.comment_id)}
      >
        פתח ←
      </Link>
      <button
        type="button"
        className="spotlight-dismiss"
        aria-label="סגור התראת תיוג"
        title="סגור (התיוג עצמו יישאר פתוח עד שתסמן 'טופל')"
        onClick={() => markDismissed(current.comment_id)}
      >
        ✕
      </button>
    </div>
  );
}
