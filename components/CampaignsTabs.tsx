import Link from "next/link";

/**
 * Sub-tabs for the קמפיינים zone: the alert triage feed (/morning) and
 * the master budget desk (/morning/budgets). Rendered at the top of
 * both pages so managers can flip between "what needs attention" and
 * "is every budget distributed + pacing".
 */
export default function CampaignsTabs({
  active,
}: {
  active: "alerts" | "budgets";
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
    </nav>
  );
}
