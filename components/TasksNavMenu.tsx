import Link from "next/link";
import ActiveLink from "./ActiveLink";
import NavTasksBadge from "./NavTasksBadge";

/**
 * Top-nav dropdown rooted at 📋 משימות. The trigger is still a real
 * Link to /tasks — clicking it navigates as before. HOVER (or
 * keyboard focus-within) reveals a dropdown that bundles the
 * task-adjacent surfaces: the queue itself, the team directory,
 * and "create task" shortcut.
 *
 * Reuses the same CSS shell as ProjectsNavMenu (.projects-nav-*
 * classes) so both dropdowns share visual chrome; a few
 * .tasks-nav-* overrides handle the slightly slimmer width and the
 * lack of a nested sub-menu. State is pure CSS — :hover /
 * :focus-within — so this stays a server component (no client JS
 * required, same as ProjectsNavMenu).
 *
 * Why fold /team under /tasks? Both surfaces answer "who's doing
 * what right now" — the queue from the work side, the directory
 * from the people side. Maayan asked 2026-05-27 to consolidate
 * the topnav so /team doesn't claim its own top-level slot.
 */
export default function TasksNavMenu() {
  return (
    <div className="projects-nav-menu tasks-nav-menu">
      <ActiveLink
        href="/tasks"
        className="topnav-link projects-nav-trigger topnav-link-with-badge"
        aria-haspopup="menu"
      >
        📋 משימות
        <NavTasksBadge />
        <span className="projects-nav-chev" aria-hidden>
          ▾
        </span>
      </ActiveLink>
      <div
        className="projects-nav-dropdown tasks-nav-dropdown"
        role="menu"
      >
        <Link
          href="/tasks"
          className="projects-nav-all"
          role="menuitem"
        >
          📋 רשימת המשימות
        </Link>
        <Link
          href="/team"
          className="tasks-nav-item"
          role="menuitem"
        >
          👥 צוות
        </Link>
        <Link
          href="/tasks/new"
          className="tasks-nav-item"
          role="menuitem"
        >
          ➕ משימה חדשה
        </Link>
      </div>
    </div>
  );
}
