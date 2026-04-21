import { type MorningSignal, type MorningSeverity } from "@/lib/appsScript";
import CopyAmountButton from "./CopyAmountButton";
import MorningDismissButton from "./MorningDismissButton";

/* Single alert row — used by the morning-dashboard page AND by the
   per-project alert section on the project overview. Keeps visual +
   behavior parity between the two entry points. */
export default function MorningSignalRow({ signal }: { signal: MorningSignal }) {
  const sevEmoji: Record<MorningSeverity, string> = {
    severe: "🔥",
    warn: "⚠️",
    info: "📅",
  };
  const isDismissed = !!signal.dismissed;
  return (
    <li
      className={[
        "morning-signal",
        `morning-signal-${signal.severity}`,
        isDismissed ? "morning-signal-dismissed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="morning-signal-main">
        <span className="morning-signal-sev" aria-hidden>
          {sevEmoji[signal.severity]}
        </span>
        <div className="morning-signal-body">
          <div className="morning-signal-title">
            {signal.title}
            {signal.dismissed && (
              <span
                className="morning-signal-dismissed-chip"
                title={
                  `טופל ${signal.dismissedBy ? "ע״י " + signal.dismissedBy : ""}` +
                  (signal.dismissedAt
                    ? ` · ${signal.dismissedAt.slice(0, 10)}`
                    : "") +
                  (signal.dismissedUntil
                    ? ` · ישוקט עד ${signal.dismissedUntil.slice(0, 10)}`
                    : "")
                }
              >
                ✓ טופל
              </span>
            )}
            {signal.revisit && !signal.dismissed && (
              <span
                className="morning-signal-revisit"
                title={`חזר — הושקט ${
                  signal.previouslyDismissedAt?.slice(0, 10) ?? ""
                } והבעיה עדיין פעילה`}
              >
                🔁 חזר
              </span>
            )}
          </div>
          <div className="morning-signal-detail">{signal.detail}</div>
        </div>
      </div>
      <div className="morning-signal-actions">
        {!isDismissed && signal.copy && (
          <CopyAmountButton
            amount={signal.copy}
            url={signal.url}
            label={`📋 העתק ₪${signal.copy}${signal.url ? " ופתח" : ""}`}
          />
        )}
        {!isDismissed && !signal.copy && signal.url && (
          <a
            href={signal.url}
            target="_blank"
            rel="noreferrer"
            className="morning-link morning-link-fb"
          >
            🔍 בדוק delivery
          </a>
        )}
        <MorningDismissButton
          signalKey={signal.key}
          kind={signal.kind}
          revisit={signal.revisit}
          dismissed={isDismissed}
        />
      </div>
    </li>
  );
}
