import { driveFolderOwner } from "@/lib/sa";
import { getProjectReportData } from "@/lib/reportData";
import { listAlertDismissals } from "@/lib/alertDismissals";
import ProjectReportTabs from "@/components/report/ProjectReportTabs";
import type { PacingDismissal } from "@/components/report/ReportChannelsTab";

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
  company = "",
  initialTab,
}: {
  projectName: string;
  /** "" (live) | "YYYY-MM" | "YYYY-MM-DD..YYYY-MM-DD" — same slot the iframe URL carries. */
  period: string;
  /** Keys חברה — for the header tag + AI-summary context. */
  company?: string;
  initialTab?: string;
}) {
  let data = null;
  let failed = false;
  // Pacing snoozes — the SAME Firestore alertDismissals keys the iframe,
  // budget desk and morning feed share (<slug>|pacing-variance|channel|…),
  // so a ✓טיפלתי anywhere fades the native channels tab too. Best-effort.
  const pacingDismissals: Record<string, PacingDismissal> = {};
  try {
    const [d, dismissals] = await Promise.all([
      getProjectReportData(driveFolderOwner(), projectName, period, company),
      listAlertDismissals().catch(
        () => ({}) as Awaited<ReturnType<typeof listAlertDismissals>>,
      ),
    ]);
    data = d;
    for (const [key, v] of Object.entries(dismissals)) {
      if (!key.includes("|pacing-variance|")) continue;
      pacingDismissals[key] = {
        snooze_until: v.snooze_until || "",
        dismissed_at: v.dismissed_at || "",
        reason: v.reason || "",
      };
    }
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
  return (
    <ProjectReportTabs
      data={data}
      initialTab={initialTab}
      pacingDismissals={pacingDismissals}
    />
  );
}
