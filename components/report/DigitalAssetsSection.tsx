import { getDigitalAssets, type AssetKind } from "@/lib/digitalAssets";
import AssetThumb from "@/components/report/AssetThumb";

/**
 * נכסים דיגיטליים — what is running for this project outside the paid
 * campaigns, and whether it still says the right thing.
 *
 * A link list on its own is a bookmark folder. What makes this worth a
 * section is the two columns beside the link: the price the page
 * publishes, and how many leads it brought. An article bought in June and
 * never revisited while the landing page moved to a new price is exactly
 * the drift nobody notices, and it is visible here in one glance.
 *
 * Server component: the prices come from a Sheet the nightly scraper
 * writes, read through an hour-long cache. Nothing here fetches a page —
 * those renders take 5–20 seconds each and belong in the nightly job.
 */

const ICON: Record<AssetKind, string> = {
  landing: "🌐",
  minisite: "🪟",
  yad2: "🏘️",
  article: "📰",
};

/** Which CRM channel each asset shows up as. The labels are the ones the
 *  ערוצים table already displays, so the number here and the number there
 *  are the same number rather than two takes on it. A kind with no
 *  channel (a minisite is not separately attributed) reads "—". */
const CHANNEL_LABEL: Partial<Record<AssetKind, string[]>> = {
  yad2: ["יד2", "yad2"],
  article: ["כתבה", "article"],
  landing: ["אתר החברה", "מיניסייט"],
};

function fmtPrice(v: number | null): string {
  return v == null ? "—" : `₪${v.toLocaleString("he-IL")}`;
}

function fmtWhen(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return "נבדק היום";
  if (days === 1) return "נבדק אתמול";
  return `נבדק לפני ${days} ימים`;
}

export default async function DigitalAssetsSection({
  project,
  channels,
}: {
  project: string;
  /** The report's own channel rows — leads per channel, already computed. */
  channels: { channel: string; leads: number }[];
}) {
  const data = await getDigitalAssets(project).catch(() => null);
  if (!data) {
    return (
      <div className="rpt-empty">
        לא נסרקו נכסים לפרויקט הזה. הסריקה הלילית קוראת דף נחיתה מ-Keys, יד2
        דרך <code>yad2lookup</code>, וכתבה דרך <code>בנפיט</code> — פרויקט בלי
        אף אחד מהם לא מופיע בה.
      </div>
    );
  }

  // Spaces and hyphens are not a distinction here: the same channel is
  // written "יד2" in one table and "יד 2" in another, and matching
  // literally meant גינות showed a Yad2 card with no leads beside a
  // Yad2 channel row that had them.
  const norm = (s: string) => s.replace(/[\s\-־]/g, "").toLowerCase();
  const leadsFor = (kind: AssetKind): number | null => {
    const labels = CHANNEL_LABEL[kind]?.map(norm);
    if (!labels) return null;
    let sum = 0;
    let hit = false;
    for (const c of channels) {
      if (labels.includes(norm(String(c.channel ?? "")))) {
        sum += Number(c.leads) || 0;
        hit = true;
      }
    }
    return hit ? sum : null;
  };

  // Only compare surfaces that are actually comparable. A Yad2 organic
  // listing has no "starting from" anchor — its lowest row is the
  // smallest apartment, not the headline — so including it would
  // manufacture a mismatch out of two different questions.
  const comparable = data.assets.filter(
    (a) => a.price != null && !(a.kind === "yad2" && a.pageType === "organic"),
  );
  const prices = comparable.map((a) => a.price as number);
  const spread =
    prices.length > 1 ? Math.max(...prices) - Math.min(...prices) : 0;
  const mismatch = prices.length > 1 && spread / Math.max(...prices) > 0.01;

  return (
    <div className="da-wrap" dir="rtl">
      <div className="da-head">
        <span className="da-when">🕒 {fmtWhen(data.checkedAt)}</span>
        {prices.length > 1 &&
          (mismatch ? (
            <span className="da-verdict is-bad">
              ⚠️ פער מחירים בין המשטחים · {fmtPrice(Math.min(...prices))} עד{" "}
              {fmtPrice(Math.max(...prices))}
            </span>
          ) : (
            <span className="da-verdict is-ok">✅ כל המשטחים מפרסמים אותו מחיר</span>
          ))}
      </div>

      <div className="da-grid">
        {data.assets.map((a) => {
          const leads = leadsFor(a.kind);
          return (
            <a
              key={`${a.kind}-${a.url}`}
              className="da-card"
              href={a.url}
              target="_blank"
              rel="noreferrer"
            >
              <AssetThumb url={a.url} alt={`${a.label} — ${project}`} />
              <div className="da-card-head">
                <span aria-hidden>{ICON[a.kind]}</span>
                <span className="da-label">{a.label}</span>
                {a.kind === "yad2" && a.pageType === "organic" && (
                  <span
                    className="da-tag"
                    title="דף אורגני של יד2 — טבלת מחירים לפי סוג דירה, בלי כותרת 'החל מ־'. לא בר-השוואה למחיר שיווקי."
                  >
                    אורגני
                  </span>
                )}
              </div>
              <div className="da-price">{fmtPrice(a.price)}</div>
              <div className="da-meta">
                {a.price == null
                  ? "לא מפרסם מחיר"
                  : a.allPrices.length > 1
                    ? `${a.allPrices.length} מחירים בדף`
                    : "מחיר יחיד"}
                {leads != null && <> · {leads} לידים</>}
              </div>
              <div className="da-url">{a.url.replace(/^https?:\/\//, "")}</div>
            </a>
          );
        })}
      </div>

      <p className="da-note">
        המחירים נקראים בסריקה לילית של הדפים עצמם, לא מהגיליון — כך שדף שהמחיר
        בו השתנה מופיע כאן בלי שאף אחד יעדכן. הלידים הם אותם מספרים שבטבלת
        הערוצים; נכס בלי ערוץ CRM משלו לא מציג לידים במקום להציג אפס.
        {data.status && data.status !== "ok" && (
          <>
            {" "}
            סטטוס הסריקה האחרונה: <b>{data.status}</b>.
          </>
        )}
      </p>
    </div>
  );
}
