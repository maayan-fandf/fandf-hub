"use client";

import { useMemo, useRef, useState } from "react";

/**
 * Cascading company + project pickers for the /tasks filter bar.
 *
 * Two behaviours that the previous server-only selects didn't have:
 *
 *   1. **Live project-list narrowing.** When the user picks a company,
 *      the project options reduce to that company's projects without
 *      waiting for a form submit. Critical for medium portfolios — a
 *      user looking at "Essence" doesn't want to scroll through 60
 *      project names from the rest of the agency.
 *
 *   2. **Auto-submit on change.** Selecting a company OR a project
 *      submits the parent form via requestSubmit(). The page re-renders
 *      with the new filter applied so downstream dropdowns (campaign,
 *      assignee, etc.) re-narrow against the actually-loaded tasks.
 *
 * Project options are pre-computed server-side and passed in as the
 * `companyToProjects` map, so we don't need to ship the full project
 * list as state. The fallback `allProjects` list is what shows when
 * no company is selected.
 */
export default function TasksFilterCompanyProject({
  defaultCompany,
  defaultProject,
  companies,
  allProjects,
  companyToProjects,
}: {
  defaultCompany: string;
  defaultProject: string;
  companies: string[];
  allProjects: string[];
  companyToProjects: Record<string, string[]>;
}) {
  const [company, setCompany] = useState(defaultCompany);
  // Track project locally so when the company change resets it (because
  // the previously-selected project doesn't belong to the new company),
  // the form submit reflects the cleared value.
  const [project, setProject] = useState(defaultProject);
  const companyRef = useRef<HTMLSelectElement | null>(null);

  const projectOptions = useMemo(() => {
    if (!company) return allProjects;
    return companyToProjects[company] ?? [];
  }, [company, allProjects, companyToProjects]);

  function submitParentForm() {
    const form = companyRef.current?.form;
    if (form && typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else if (form) {
      // Older browsers — fall back to .submit(). Doesn't fire validation
      // but our form has none, so it's equivalent.
      form.submit();
    }
  }

  function onCompanyChange(next: string) {
    setCompany(next);
    // Reset project when its company no longer matches.
    if (project) {
      const list = next ? companyToProjects[next] ?? [] : allProjects;
      if (!list.includes(project)) setProject("");
    }
    // Defer submit to next tick so React updates the controlled value
    // before the form snapshots the field set.
    queueMicrotask(submitParentForm);
  }

  function onProjectChange(next: string) {
    setProject(next);
    queueMicrotask(submitParentForm);
  }

  return (
    <>
      <label>
        חברה
        <select
          ref={companyRef}
          name="company"
          value={company}
          onChange={(e) => onCompanyChange(e.target.value)}
          data-active={company ? "1" : undefined}
        >
          <option value="">הכל</option>
          {companies.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <label>
        פרויקט
        <select
          name="project"
          value={project}
          onChange={(e) => onProjectChange(e.target.value)}
          data-active={project ? "1" : undefined}
        >
          <option value="">הכל</option>
          {projectOptions.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
