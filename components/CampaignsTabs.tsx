import Link from "next/link";

/**
 * Sub-tabs for the קמפיינים zone: alert triage feed (/morning), master
 * budget desk (/morning/budgets), and admin-only month-end spend
 * forecast (/morning/forecast). Rendered at the top of each page so
 * managers can flip between them.
 *
 * The `showForecast` flag is set by the parent page based on admin
 * status — the tab disappears for non-admins instead of taking up a
 * slot that would 404 / redirect them out. Same pattern as the
 * UserSettingsMenu's admin-only entries.
 */
export default function CampaignsTabs({
  active,
  showForecast = false,
}: {
  active: "alerts" | "budgets" | "forecast";
  showForecast?: boolean;
}) {
  return (
    <nav className="campaigns-tabs" aria-label="קמפיינים">
      <Link
        href="/morning"
        className={`campaigns-tab ${active === "alerts" ? "is-active" : ""}`}
      >
        📢 התראות
      </Link>
      <Link
        href="/morning/budgets"
        className={`campaigns-tab ${active === "budgets" ? "is-active" : ""}`}
      >
        💰 תקציבים
      </Link>
      {showForecast && (
        <Link
          href="/morning/forecast"
          className={`campaigns-tab ${active === "forecast" ? "is-active" : ""}`}
        >
          🔮 תחזית חודש
        </Link>
      )}
    </nav>
  );
}
