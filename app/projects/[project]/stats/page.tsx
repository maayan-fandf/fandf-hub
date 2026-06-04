import { redirect } from "next/navigation";

/**
 * Legacy /projects/[project]/stats route — redirects to the central
 * /stats page with ?project=X. The owner wanted one stats page total
 * with a project dropdown (2026-06-04), so this route became
 * redundant; keeping it as a redirect so any existing bookmarks /
 * links keep working.
 */
export default async function LegacyProjectStatsRedirect({
  params,
}: {
  params: Promise<{ project: string }>;
}) {
  const { project } = await params;
  const projectName = decodeURIComponent(project);
  redirect(`/stats?project=${encodeURIComponent(projectName)}`);
}
