import { driveFolderOwner } from "@/lib/sa";
import { getProjectReportData } from "@/lib/reportData";
import ProjectReportTabs from "@/components/report/ProjectReportTabs";

/**
 * Server wrapper for the NATIVE project report (the in-hub rebuild of the
 * Apps Script dashboard iframe). Fetches the phase-1 data (top-funnel +
 * daily trends) and renders the tabbed client shell. Rendered only for
 * internal users behind the `?report=native` toggle while the legacy
 * iframe remains the default — parity first, cutover later.
 */
export default async function ProjectReportSection({
  projectName,
  period,
  initialTab,
}: {
  projectName: string;
  /** "" (live) | "YYYY-MM" | "YYYY-MM-DD..YYYY-MM-DD" — same slot the iframe URL carries. */
  period: string;
  initialTab?: string;
}) {
  let data = null;
  let failed = false;
  try {
    data = await getProjectReportData(driveFolderOwner(), projectName, period);
  } catch {
    failed = true;
  }
  if (failed) {
    return (
      <div className="rpt-empty">שגיאה בטעינת נתוני הדוח — נסו לרענן.</div>
    );
  }
  if (!data) {
    return (
      <div className="rpt-empty">
        אין לפרויקט הזה מזהה קמפיינים (Keys → campaign ID), אז אין דרך לשייך
        אליו נתוני פלטפורמות.
      </div>
    );
  }
  return <ProjectReportTabs data={data} initialTab={initialTab} />;
}
