"use client";

import ReportFunnelFlow from "@/components/report/ReportFunnelFlow";
import ReportConversionFunnel from "@/components/report/ReportConversionFunnel";
import {
  fmtDateHe,
  type ProjectReportData,
} from "@/lib/reportShared";

/**
 * סקירה tab — the CRM-side overview: the ביצועים-נוכחיים funnel flow, the
 * period/comparison window line, and the conversion funnel. The paid-media
 * block (KPI band + funnel diagnosis + platform pies) moved to the
 * קריאייטיבים tab (see ReportMediaSection).
 */

const MODE_LABELS = { live: "טווח הקמפיין", month: "חודש", range: "טווח מותאם" };

export default function ReportOverviewTab({ data }: { data: ProjectReportData }) {
  // The CRM funnel flow (ביצועים נוכחיים) is CRM data, so it shows even
  // when there are no paid-platform impressions/clicks.
  const funnelFlow = data.totals ? <ReportFunnelFlow data={data} /> : null;

  return (
    <div className="rpt-overview">
      {funnelFlow}
      <div className="rpt-window-line">
        <span className="rpt-window-chip">{MODE_LABELS[data.mode]}</span>
        <span>
          📅 {fmtDateHe(data.window.startIso)} — {fmtDateHe(data.window.endIso)}
        </span>
        {data.prevWindow && (
          <span className="rpt-window-prev">
            ↔ השוואה לתקופה קודמת ({fmtDateHe(data.prevWindow.startIso)} —{" "}
            {fmtDateHe(data.prevWindow.endIso)})
          </span>
        )}
      </div>

      <ReportConversionFunnel data={data} />
    </div>
  );
}
