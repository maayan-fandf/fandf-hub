import { getLeadJourney } from "@/lib/leadJourney";
import LeadJourneyPanel from "@/components/report/LeadJourneyPanel";

/**
 * Server half of מקור מול טריגר. Reads the matrix and hands it to the
 * client panel, which only needs interaction.
 *
 * Renders NOTHING when there is no journey data rather than an empty
 * card: a Sehel-only or Salesforce project has no first/last channel pair
 * in the warehouse at all, and a blank panel there would read as "no lead
 * ever changed channel", which is a claim we are in no position to make.
 */
export default async function LeadJourneySection({
  project,
  company,
  from,
  to,
}: {
  project: string;
  company: string;
  from: string;
  to: string;
}) {
  const data = await getLeadJourney({ project, company, from, to }).catch(
    () => null,
  );
  if (!data || data.total < 2) return null;
  return (
    <div className="lj-wrap">
      <div className="lj-title">
        🧭 מקור מול טריגר
        <span className="lj-title-sub">
          הדוח מייחס ליד למגע האחרון. זה מה שקרה לפניו.
        </span>
      </div>
      <LeadJourneyPanel data={data} />
    </div>
  );
}
