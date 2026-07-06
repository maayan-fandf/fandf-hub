import { latestPrisotForRequest } from "@/lib/driveFolders";
import ApprovePrisaButton from "./ApprovePrisaButton";

/**
 * Sticky client prompt at the top of the project page: while the project's
 * latest פריסה isn't approved, nudge the client to review + approve it. The
 * "צפו בפריסה" link jumps to the plan card (#prisa-section); the approve
 * button locks it as the approved version in place (same action as the card).
 *
 * Renders null when the plan is already approved — or there's no plan — so
 * it only ever appears when the client actually has something to approve.
 * Client-gated at the call site (app/projects/[project]/page.tsx). Reads the
 * plan via the request-cached getter, so it adds no extra Drive fetch on top
 * of LatestPrisotCard's.
 */
export default async function ClientPrisaApprovalPrompt({
  subjectEmail,
  company,
  project,
}: {
  subjectEmail: string;
  company: string;
  project: string;
}) {
  const latest = await latestPrisotForRequest(
    subjectEmail,
    company,
    project,
  ).catch(() => null);
  if (!latest || latest.approvalState === "approved") return null;
  return (
    <div className="client-approve-prompt" role="status">
      <span className="client-approve-prompt-text">
        📐 הפריסה השיווקית ממתינה לאישורכם
      </span>
      <div className="client-approve-prompt-actions">
        <a href="#prisa-section" className="client-approve-prompt-view">
          צפו בפריסה ↓
        </a>
        <ApprovePrisaButton fileId={latest.id} />
      </div>
    </div>
  );
}
