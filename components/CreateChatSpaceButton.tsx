"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * One-click "create Google Chat Space for this project" button. Used
 * by the InternalDiscussionTab empty state so an admin can spin up a
 * space without leaving the project page (the standalone
 * /admin/chat-spaces page works the same way underneath).
 *
 * Calls /api/worktasks/project-space-create which is admin-gated:
 * non-admin clicks get a 403 and the button surfaces the error
 * inline. The hub also writes the new space's URL into Keys col L
 * automatically, so a router.refresh() after success lights up the
 * chat tab on the same render cycle.
 */
export default function CreateChatSpaceButton({
  projectName,
  company,
}: {
  projectName: string;
  /** Disambiguator for project names that recur across companies (כללי
   *  has 4 rows). When present, posted to the route so the helper
   *  matches the right Keys row for both the idempotency pre-read AND
   *  the URL write target. Optional — falls back to first-by-name. */
  company?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Lightweight info banner shown after a successful create — covers
  // partial-fan-out cases (some members invited, some failed) and the
  // "scope not yet granted" first-time setup case. Cleared on the
  // next click.
  const [info, setInfo] = useState<string | null>(null);

  async function onClick() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch("/api/worktasks/project-space-create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: projectName,
          ...(company ? { company } : {}),
        }),
      });
      const data = (await res.json()) as
        | {
            ok: true;
            space: { name: string; spaceUri: string; displayName: string };
            invite?: {
              addedEmails: string[];
              failedEmails: { email: string; reason: string }[];
              scopeMissing: boolean;
            };
          }
        | { ok: false; error: string; howToFix?: string };
      if (!("ok" in data) || !data.ok) {
        const fix = "howToFix" in data && data.howToFix ? `\n${data.howToFix}` : "";
        throw new Error(("error" in data && data.error) || "create failed" + fix);
      }
      // Surface invite outcome. Three cases:
      //   - All members added: show count.
      //   - Some failed (scope missing): one-time setup hint.
      //   - Idempotent return (existing space): empty addedEmails;
      //     skip the banner so we don't confuse the user.
      const inv = data.invite;
      if (inv) {
        if (inv.scopeMissing) {
          setInfo(
            "החלל נוצר, אבל הוספת חברים אוטומטית דורשת סקופ DWD נוסף " +
              "(chat.memberships). הוסף ב-Workspace Admin ונסה שוב, או הזמן ידנית.",
          );
        } else if (inv.addedEmails.length > 0) {
          setInfo(`✓ ${inv.addedEmails.length} חברים הוזמנו אוטומטית.`);
        } else if (inv.failedEmails.length > 0) {
          setInfo(
            `החלל נוצר, אבל ${inv.failedEmails.length} הזמנות נכשלו. בדוק יומנים.`,
          );
        }
      }
      // Keys cache TTL is 5 min; refresh forces a re-render that
      // reads through. The route handler itself busts the keys tag
      // on success so this should be live by the time the new
      // server render runs.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="create-chat-space-button-wrap">
      <button
        type="button"
        className="btn-primary btn-sm"
        onClick={onClick}
        disabled={busy}
      >
        {busy ? "יוצר חלל…" : "🆕 צור חלל Chat לפרויקט"}
      </button>
      {error && (
        <div className="create-chat-space-error" role="alert">
          {error}
        </div>
      )}
      {info && !error && (
        <div className="create-chat-space-info" role="status">
          {info}
        </div>
      )}
    </div>
  );
}
