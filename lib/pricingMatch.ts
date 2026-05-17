/**
 * Client-safe pricing types + matcher (no server imports — TaskCreateForm
 * is a client component and computes the price reactively as the user
 * picks company / project / department / kind).
 *
 * Data source: the "Pricingsetup" tab on the Comments spreadsheet
 * (read server-side by lib/pricing.ts). Columns:
 *   חברה (company) | פרוייקט (project, OPTIONAL) | מחלקה (department) |
 *   סוג (type — matches the task's kind) | מחיר יחידה (unit price)
 *
 * Lookup rule (per the request): project is not mandatory. For each
 * selected department, prefer a row matching
 * (company, project, department, kind); if none, FALL BACK to a
 * company-level row where the project cell is blank
 * (company, "", department, kind). A task with no project selected
 * therefore resolves straight to the company-level price.
 */

export type PricingRow = {
  company: string;
  project: string;
  department: string;
  /** Matches the task's `kind` (the "סוג" column). */
  type: string;
  unitPrice: number;
};

export type PricingLine = {
  department: string;
  unitPrice: number | null;
  /** Which row satisfied the match — drives the "(לפי פרוייקט/חברה)"
   *  hint. null = no price configured for this combination. */
  basis: "project" | "company" | null;
};

export type PricingResult = {
  lines: PricingLine[];
  /** Sum of the resolved (non-null) unit prices. */
  total: number;
  /** True when at least one selected department had no matching row. */
  anyMissing: boolean;
  /** True when at least one department resolved to a price. */
  hasAny: boolean;
};

const norm = (s: string | undefined) =>
  String(s ?? "").trim().toLowerCase();

export function resolvePricing(
  rows: PricingRow[],
  sel: {
    company: string;
    project: string;
    departments: string[];
    kind: string;
  },
): PricingResult {
  const company = norm(sel.company);
  const project = norm(sel.project);
  const kind = norm(sel.kind);
  const lines: PricingLine[] = [];

  for (const deptRaw of sel.departments) {
    const dept = norm(deptRaw);
    if (!dept) continue;

    const sameDeptKind = (r: PricingRow) =>
      norm(r.company) === company &&
      norm(r.department) === dept &&
      norm(r.type) === kind;

    // Project-specific row (only when a project is actually selected).
    const projectMatch =
      project &&
      rows.find(
        (r) => sameDeptKind(r) && r.project.trim() && norm(r.project) === project,
      );
    // Company-level fallback: project cell blank.
    const companyMatch = rows.find(
      (r) => sameDeptKind(r) && !r.project.trim(),
    );

    const chosen = projectMatch || companyMatch || null;
    lines.push({
      department: deptRaw,
      unitPrice: chosen ? chosen.unitPrice : null,
      basis: projectMatch ? "project" : companyMatch ? "company" : null,
    });
  }

  const total = lines.reduce((s, l) => s + (l.unitPrice ?? 0), 0);
  return {
    lines,
    total,
    anyMissing: lines.some((l) => l.unitPrice == null),
    hasAny: lines.some((l) => l.unitPrice != null),
  };
}
