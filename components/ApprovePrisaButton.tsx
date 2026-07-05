"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Client-facing "✓ אשר פריסה" button on the LatestPrisotCard. Rendered
 * for client users when the latest פריסה isn't approved yet. A two-step
 * confirm (so a stray tap doesn't lock the file), then POSTs to
 * /api/drive/approvals/approve — which locks the sheet read-only as the
 * approved version. On success the badge flips to ✓ מאושר after
 * router.refresh() re-reads the approval state on the server.
 */
export default function ApprovePrisaButton({ fileId }: { fileId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function approve() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/drive/approvals/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.error || `שגיאה ${res.status}`);
        setSubmitting(false);
        return;
      }
      setDone(true);
      // Give the success state a beat to register, then re-read the
      // approval state (badge flips to ✓ מאושר server-side).
      setTimeout(() => router.refresh(), 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <span className="prisot-approved-badge" title="הפריסה אושרה">
        ✓ אושר
      </span>
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        className="prisot-client-approve-btn"
        onClick={() => setConfirming(true)}
        title="אשר את הפריסה — הקובץ יינעל כגרסה מאושרת"
      >
        ✓ אשר פריסה
      </button>
    );
  }

  return (
    <span className="prisot-client-approve-confirm" dir="rtl">
      <span className="prisot-client-approve-q">לאשר את הפריסה?</span>
      <button
        type="button"
        className="prisot-client-approve-yes"
        onClick={approve}
        disabled={submitting}
      >
        {submitting ? "מאשר…" : "כן, אשר"}
      </button>
      <button
        type="button"
        className="prisot-client-approve-no"
        onClick={() => setConfirming(false)}
        disabled={submitting}
      >
        ביטול
      </button>
      {error && (
        <span className="prisot-client-approve-error">{error}</span>
      )}
    </span>
  );
}
