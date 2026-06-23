"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Inline-editable management-fee % cell for /morning/forecast.
 *
 * Read state: shows the percent + a click hint. Click → enters edit
 * state with a number input pre-filled. Blur or Enter persists to
 * /api/management-fees and triggers a router.refresh() so the
 * computed ₪ ניהול cell + per-manager + grand totals all re-derive
 * from the new value. Esc cancels without saving.
 *
 * Optimistic update: we set the local state immediately so the UI
 * doesn't flicker waiting on the API + page re-render. If the save
 * fails we roll back AND surface the error inline.
 */

function fmtPercent(n: number): string {
  // One decimal max — matches the round-to-tenths the upsert does.
  const rounded = Math.round(n * 10) / 10;
  return `${rounded}%`;
}

export default function ManagementFeeCell({
  slug,
  channel,
  company,
  scope = "channel",
  initialPercent,
}: {
  /** Required for scope="channel". */
  slug?: string;
  /** Required for scope="channel". */
  channel?: string;
  /** Required for scope="company". */
  company?: string;
  /** Which cascade tier this editor writes. Defaults to the per-
   *  (project, channel) override so existing call-sites are unchanged. */
  scope?: "channel" | "company" | "global";
  /** Server-resolved percent (with the cascade already applied). */
  initialPercent: number;
}) {
  const router = useRouter();
  const [percent, setPercent] = useState(initialPercent);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(initialPercent));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function openEdit() {
    setDraft(String(percent));
    setErr("");
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
    setErr("");
  }

  async function commit() {
    const raw = draft.trim().replace(",", ".");
    const next = Number(raw);
    if (!Number.isFinite(next)) {
      setErr("מספר לא תקין");
      return;
    }
    if (next < 0 || next > 100) {
      setErr("טווח: 0-100");
      return;
    }
    if (Math.abs(next - percent) < 0.05) {
      // No real change — just exit edit mode.
      setEditing(false);
      setErr("");
      return;
    }
    setBusy(true);
    setErr("");
    const previous = percent;
    setPercent(next); // Optimistic
    setEditing(false);
    try {
      const payload =
        scope === "global"
          ? { scope, percent: next }
          : scope === "company"
            ? { scope, company, percent: next }
            : { scope, slug, channel, percent: next };
      const res = await fetch("/api/management-fees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `שמירה נכשלה (${res.status})`);
      }
      // Server returns the canonical clamped/rounded value — sync.
      const saved = Number(data.fee?.percent);
      if (Number.isFinite(saved)) setPercent(saved);
      // Refresh the SSR data so the row's ₪ ניהול cell + the
      // per-manager + grand totals re-derive from the new percent.
      router.refresh();
    } catch (e) {
      setPercent(previous); // Roll back optimistic update
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <span className="mgmt-fee-cell is-editing">
        <input
          type="number"
          inputMode="decimal"
          step="0.5"
          min="0"
          max="100"
          autoFocus
          className="mgmt-fee-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.currentTarget as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          aria-label="עריכת אחוז דמי ניהול"
        />
        <span className="mgmt-fee-suffix" aria-hidden>
          %
        </span>
      </span>
    );
  }

  return (
    <span
      className={`mgmt-fee-cell${busy ? " is-busy" : ""}`}
      title={err || "לחץ לעריכה"}
    >
      <button
        type="button"
        className="mgmt-fee-btn"
        onClick={openEdit}
        disabled={busy}
      >
        {fmtPercent(percent)}
      </button>
      {err && <span className="mgmt-fee-err">⚠ {err}</span>}
    </span>
  );
}
