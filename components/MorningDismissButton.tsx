"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  signalKey: string;
  kind: string;
  revisit?: boolean;
};

const SNOOZE_OPTIONS = [
  { label: "יום", days: 1 },
  { label: "3 ימים", days: 3 },
  { label: "שבוע", days: 7 },
  { label: "חודש", days: 30 },
  { label: "לצמיתות", days: 3650 },
];

/* Dismissal control for a morning-feed signal. One-click "✓ טיפלתי" applies
   the default snooze for that kind; the "⋯" opens a custom-duration menu.
   Dismissals are team-wide — the Apps Script stores them in the
   "Alert Dismissals" sheet tab, keyed by signal_key. */
export default function MorningDismissButton({ signalKey, revisit }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  async function dismiss(customDays?: number) {
    setBusy(true);
    setOpen(false);
    try {
      let snoozeUntil = "";
      if (customDays != null) {
        const d = new Date();
        d.setDate(d.getDate() + customDays);
        snoozeUntil = d.toISOString().slice(0, 10);
      }
      const res = await fetch("/api/morning/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signalKey, snoozeUntil }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      router.refresh();
    } catch (err) {
      alert("שגיאה בדחייה: " + (err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  async function unsnooze() {
    setBusy(true);
    setOpen(false);
    try {
      const res = await fetch("/api/morning/unsnooze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signalKey }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      router.refresh();
    } catch (err) {
      alert("שגיאה: " + (err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="morning-dismiss" dir="rtl">
      <button
        type="button"
        className="morning-dismiss-primary"
        disabled={busy}
        onClick={() => dismiss()}
        title="טיפלתי — השקט את ההתראה"
      >
        {busy ? "…" : "✓ טיפלתי"}
      </button>
      <button
        type="button"
        className="morning-dismiss-more"
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="אפשרויות דחייה"
      >
        ⋯
      </button>
      {open && (
        <div className="morning-dismiss-menu" role="menu">
          <div className="morning-dismiss-menu-label">השקט ל־</div>
          {SNOOZE_OPTIONS.map((opt) => (
            <button
              key={opt.days}
              type="button"
              role="menuitem"
              className="morning-dismiss-menu-item"
              onClick={() => dismiss(opt.days)}
            >
              {opt.label}
            </button>
          ))}
          {revisit && (
            <>
              <div className="morning-dismiss-menu-sep" />
              <button
                type="button"
                role="menuitem"
                className="morning-dismiss-menu-item morning-dismiss-menu-unsnooze"
                onClick={unsnooze}
              >
                בטל השקטה קודמת
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
