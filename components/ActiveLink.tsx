"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentProps, ReactNode } from "react";

type Props = Omit<ComponentProps<typeof Link>, "className" | "children"> & {
  className?: string;
  /** Class added when the link matches the current path. Default "is-active". */
  activeClassName?: string;
  /**
   * How to decide "active":
   * - "exact": pathname must equal href exactly.
   * - "section": pathname starts with href (default — keeps e.g.
   *   `/inbox/whatever` lighting up the top-level תיוגים link).
   * The "/" home link auto-degrades to exact to avoid matching every path.
   */
  match?: "exact" | "section";
  /**
   * Additional path prefixes that should also count as active. Used e.g. on
   * the Projects nav trigger (`href="/"`) to keep it lit on `/projects/...`.
   */
  matchAlso?: string[];
  children: ReactNode;
};

/**
 * Next Link wrapper that appends an active-state class when the current
 * route matches. Used by the top nav to highlight which page the user is
 * on. Client component because usePathname() only runs client-side.
 */
export default function ActiveLink({
  href,
  className = "",
  activeClassName = "is-active",
  match = "section",
  matchAlso = [],
  children,
  ...rest
}: Props) {
  const pathname = usePathname();
  const target = String(href);

  // "/" forces exact match to avoid trivially matching every path.
  const effectiveMatch = target === "/" ? "exact" : match;

  const matchesPath = (p: string, t: string): boolean => {
    if (p === t) return true;
    if (effectiveMatch === "exact") return false;
    if (t === "/") return false;
    return p.startsWith(t + "/") || p.startsWith(t);
  };

  const isActive =
    matchesPath(pathname, target) ||
    matchAlso.some((prefix) => {
      if (!prefix) return false;
      if (pathname === prefix) return true;
      return pathname.startsWith(prefix + "/") || pathname.startsWith(prefix);
    });

  const finalClass = [className, isActive ? activeClassName : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <Link href={href} className={finalClass} {...rest}>
      {children}
    </Link>
  );
}
