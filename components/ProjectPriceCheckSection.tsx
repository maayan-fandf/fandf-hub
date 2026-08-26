import {
  getProjectPriceCheck,
  type ProjectPriceSurface,
} from "@/lib/appsScript";
import { getArtworkPrice, type ArtworkPrice } from "@/lib/artworkPrice";
import {
  getArtworkPriceFlag,
  type ArtworkPriceFlag,
} from "@/lib/creativePriceTags";
import {
  getWarehouseFbPrice,
  type WarehouseFbPrice,
} from "@/lib/fbPriceFromWarehouse";
import { comparePrices } from "@/lib/priceExtractor";
import { driveFolderOwner } from "@/lib/sa";
import PlatformIcon from "@/components/PlatformIcon";

/**
 * "מחירים מפורסמים" section — renders the project's advertised
 * starting-from price across 4 surfaces (אתר landing / יד2 / גוגל / פייסבוק)
 * with each card linking back to its source. The same data the morning-
 * feed `price-mismatch` signal uses; exposed standalone here so users can
 * spot-check what each surface is currently showing even when no
 * mismatch fires.
 *
 * - Server component, mounted under <Suspense fallback={null}> at the
 *   page level so the Apps-Script call doesn't block the rest of the
 *   render.
 * - Visible to clients too (2026-07-05) via the `isClientUser` prop, which
 *   strips the internal ad-ops chrome (FB/Google Ads deep-links, ad-status
 *   chips, mismatch/QA pill). The report's projectPriceCheck endpoint
 *   enforces the caller's own per-project access (col E) server-side.
 * - Self-hides when the project has nothing to show — neither a landing
 *   scrape NOR any ad copy. Avoids an empty "💰 מחירים מפורסמים" shelf
 *   on projects the price feature doesn't cover yet.
 */
export default async function ProjectPriceCheckSection({
  projectName,
  isClientUser = false,
}: {
  projectName: string;
  /** Client viewer — strips the internal ad-ops chrome: the FB/Google
   *  "פתח ב-Ads" deep-links, the "מודעות מושהות" ad-status chips, and
   *  the internal mismatch/QA status pill + min/max outlier badges.
   *  Clients keep the published prices, the landing/Yad2 links, and the
   *  per-room inventory. */
  isClientUser?: boolean;
}) {
  const clientMode = !!isClientUser;
  const data = await getProjectPriceCheck(projectName).catch(() => null);
  if (!data || !data.ok) return null;

  // Warehouse creative tags — internal only, and only fetched when we are
  // going to render them. Returns null on any failure, so the card simply
  // loses the chip rather than the section failing.
  const artwork = clientMode
    ? null
    : await getArtworkPriceFlag(driveFolderOwner(), projectName);

  // FB ad-copy price from the warehouse, used only when the report saw NO
  // ad copy at all — not merely when it found no price. Those are very
  // different answers. "no-price" means it read the live ads and they
  // genuinely do not advertise one, which is authoritative: אנדה's four
  // active ads carry no price, and an earlier version of this happily
  // published ₪2,420,000 read off an ad paused since June.
  const fbSurface = data.surfaces.find((s) => s.name === "facebook");
  const warehouseFb =
    fbSurface && fbSurface.price == null && fbSurface.status === "no-input"
      ? await getWarehouseFbPrice(driveFolderOwner(), projectName)
      : null;

  // The price printed on the creative. Read for every internal render, not
  // only when the text sources came up empty: the artwork is the surface
  // most likely to go stale unnoticed, and a text price that DISAGREES with
  // the running artwork is the case worth catching — suppressing the read
  // whenever text succeeded meant it could only ever be seen on projects
  // whose ads carry no copy price at all.
  const fbTextPrice = fbSurface?.price ?? warehouseFb?.price ?? null;
  const artworkPrice =
    !clientMode && fbSurface
      ? await getArtworkPrice(driveFolderOwner(), projectName)
      : null;

  // What it is ALLOWED to do is unchanged. It becomes the card's published
  // FB price only when NO text source produced one — additional
  // information rather than a competing reading, so it fills a gap and
  // never argues with a text price. אנדה is the case that exists for: its
  // live ad carries no price in its copy, so every text surface correctly
  // says "לא זוהה מחיר" while the artwork plainly reads
  // "החל מ-3,250,000 ₪ בלבד". Everywhere else it is shown beside the price,
  // by ArtworkPriceChip, and compared rather than substituted.
  const artworkIsSource = fbTextPrice == null && artworkPrice != null;
  const injectedFbPrice =
    warehouseFb?.price ?? (artworkIsSource ? artworkPrice.value : null);
  const surfaces: ProjectPriceSurface[] =
    injectedFbPrice != null
      ? data.surfaces.map((s) =>
          s.name === "facebook"
            ? {
                ...s,
                price: injectedFbPrice,
                status: "ok",
                hasInput: true,
                // Only the text reader produces a per-room inventory; the
                // artwork gives a single headline figure.
                inventory: warehouseFb?.inventory ?? s.inventory,
              }
            : s,
        )
      : data.surfaces;

  // Self-hide when every surface is dark — no landing scrape AND no ad
  // copy on either platform. (`hasInput` is true for any surface where
  // SOME source content existed, even if no price could be extracted.)
  const anyInput = surfaces.some((s) => s.hasInput);
  if (!anyInput) return null;

  // The mismatch status pill shown next to the section title. Four states:
  //   - "פערים בדירת <room> · X%" (warn/severe) — per-room mismatch fired
  //   - "פערים זוהו · X%" (warn/severe) — headline-fallback mismatch
  //   - "כל המקורות זהים" — at least 2 sources, all within tolerance
  //   - "מקור יחיד" — only 1 source has a price, can't compare
  // Room-aware path skips the "min/max" outlier highlighting on the
  // cards because the headline-min/max axis isn't what's mismatched
  // there — the room-level inventory rows tell that story instead.
  const prices = surfaces
    .map((s) => s.price)
    .filter((p): p is number => p != null);
  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;
  const detectedCount = surfaces.filter((s) => s.price != null).length;
  const cmp = data.comparison;

  // Apps Script compared the surfaces it could see. If we injected an FB
  // price it never saw, its verdict is stale in the one direction that
  // matters: it can still say "כל המקורות זהים" while the price we just
  // put on the card disagrees with the landing page. Re-run the canonical
  // comparator over the surfaces as rendered, and let a local mismatch
  // override an Apps Script all-clear. A mismatch Apps Script already
  // found wins, because its per-room verdict is richer than this one.
  const localCmp =
    injectedFbPrice != null
      ? comparePrices(surfaces.map((s) => ({ name: s.name, price: s.price })))
      : null;
  const localDriftPct =
    prices.length >= 2
      ? ((Math.max(...prices) - Math.min(...prices)) / Math.min(...prices)) * 100
      : 0;

  const statusPill =
    cmp && cmp.mismatched
      ? {
          tone: cmp.severe ? "severe" : "warn",
          text: cmp.mismatchRoom
            ? `פערים בדירת ${cmp.mismatchRoom} · ${cmp.driftPct.toFixed(1)}%`
            : `פערים זוהו · ${cmp.driftPct.toFixed(1)}%`,
        }
      : localCmp?.mismatched
        ? {
            tone: "warn" as const,
            text: `פערים זוהו · ${localDriftPct.toFixed(1)}%`,
          }
        : cmp || localCmp
          ? { tone: "ok" as const, text: "כל המקורות זהים" }
          : detectedCount >= 1
            ? { tone: "muted" as const, text: "מקור יחיד" }
            : null;

  // Min/max outlier highlighting on the cards — only meaningful in the
  // legacy headline-fallback path (where the mismatch IS about the
  // headline picks differing). In the per-room path, the room rows
  // beneath each card already show the comparison; tinting headline
  // surfaces with min/max badges would be misleading because the
  // headlines may differ legitimately (different products per surface).
  const isHeadlineMismatch =
    (!!cmp && cmp.mismatched && !cmp.mismatchRoom) || !!localCmp?.mismatched;
  const isOutlier = (s: ProjectPriceSurface) =>
    isHeadlineMismatch &&
    s.price != null &&
    (s.price === minPrice || s.price === maxPrice);

  return (
    <section className="project-section project-section-price-check">
      <div className="section-head">
        <h2>
          💰 מחירים מפורסמים
          {!clientMode && statusPill && (
            <span
              className={`price-check-status-pill price-check-status-${statusPill.tone}`}
            >
              {statusPill.text}
            </span>
          )}
        </h2>
        {data.scrapedAt && (
          <span
            className="section-link section-link-static"
            title={`עודכן ב-${formatScrapedAt(data.scrapedAt)}`}
          >
            עודכן {formatScrapedAtRelative(data.scrapedAt)}
          </span>
        )}
      </div>

      <p className="section-subtitle">
        {clientMode
          ? "מחיר ה״החל מ-״ שמפורסם בכל ערוץ עבור הפרויקט. מתחת לכל כרטיס מופיע מלאי המחירים המלא לפי חדרים כשמזוהה יותר ממחיר אחד."
          : "מחיר ה״החל מ-״ שזוהה בכל מקור פרסומי לפרויקט. כשמופיע פער של מעל 1%, המקור הנמוך והגבוה ביותר מודגשים — אלו השניים שצריך לתאם. מתחת לכל כרטיס מופיע גם מלאי המחירים המלא לפי חדרים כשמזוהים יותר ממחיר אחד באותו מקור."}
      </p>

      <div className="price-check-grid">
        {surfaces.map((s) => (
          <PriceCheckCard
            key={s.name}
            surface={s}
            clientMode={clientMode}
            isOutlier={!clientMode && isOutlier(s)}
            isMin={!clientMode && s.price != null && s.price === minPrice && isHeadlineMismatch}
            isMax={!clientMode && s.price != null && s.price === maxPrice && isHeadlineMismatch}
            artwork={artwork}
            warehouseFb={s.name === "facebook" ? warehouseFb : null}
            artworkPrice={s.name === "facebook" ? artworkPrice : null}
            artworkIsSource={s.name === "facebook" && artworkIsSource}
          />
        ))}
      </div>
    </section>
  );
}

/* ─── Internals ────────────────────────────────────────────────────── */

function PriceCheckCard({
  surface,
  isOutlier,
  isMin,
  isMax,
  clientMode = false,
  artwork = null,
  warehouseFb = null,
  artworkPrice = null,
  artworkIsSource = false,
}: {
  surface: ProjectPriceSurface;
  isOutlier: boolean;
  isMin: boolean | undefined;
  isMax: boolean | undefined;
  /** Creative-tag flag for the FB card; null when unknown. See
   *  ArtworkPriceChip for why it is a warning and not a price. */
  artwork?: ArtworkPriceFlag | null;
  /** Set on the FB card when the price shown came from the warehouse
   *  rather than the usual Apps Script path — the card says so, because a
   *  number with no provenance is one nobody can check. */
  warehouseFb?: WarehouseFbPrice | null;
  /** The price(s) burned into the FB card's live creatives. Present on any
   *  internal render that found one — it is shown next to the card price
   *  for comparison, and only BECOMES the card price when
   *  `artworkIsSource`. */
  artworkPrice?: ArtworkPrice | null;
  /** True when the number on the card came off the creative because no
   *  text source produced one — switches the chip from "compare these" to
   *  the provenance note. */
  artworkIsSource?: boolean;
  /** Client viewer — hides the ad-status chip and the FB/Google Ads
   *  deep-links (internal ad-ops surfaces the client can't use). */
  clientMode?: boolean;
}) {
  // Empty-state copy — distinguishes "we don't have a source for this
  // channel yet" (`no-input`) from "we tried and the source had nothing"
  // (`no-price` / scraper error). The first invites the user to add the
  // source; the second invites them to check the ad copy / page.
  const emptyState = (() => {
    if (surface.price != null) return null;
    if (surface.status === "no-input") {
      switch (surface.name) {
        case "landing":
          return "אין דף נחיתה ב-Keys";
        case "yad2":
          return "אין קישור יד2 ב-Keys";
        case "facebook":
          return "אין קמפיינים פעילים ב-FB";
        case "google":
          return "אין קמפיינים פעילים בגוגל";
      }
    }
    if (surface.status === "fetch-error") return "שגיאת קריאה — בדוק ידנית";
    if (surface.status === "skipped") return "המתנה לסריקה הבאה";
    if (surface.status === "organic-no-anchor") {
      // Yad2-specific: the page IS a listing but it's the generic
      // aggregator format (per-apartment-type table) without a
      // marketing 'החל מ-' headline. Comparing its smallest row
      // against landing/FB/Google would be apples-to-oranges, so we
      // deliberately skip the value. Explain that to the reader.
      return "רישום גנרי ביד2 — אין כותרת מחיר";
    }
    return "לא זוהה מחיר";
  })();

  const cls = [
    "price-check-card",
    `price-check-card-${surface.name}`,
    surface.price == null && "price-check-card-empty",
    isOutlier && "price-check-card-outlier",
    isMin && "price-check-card-min",
    isMax && "price-check-card-max",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls}>
      <div className="price-check-card-head">
        <span className="price-check-card-icon" aria-hidden>
          <SurfaceIcon name={surface.name} />
        </span>
        <span className="price-check-card-label">{surface.label}</span>
        {!clientMode && <AdStatusChip surface={surface} />}
        <Yad2MetaChip surface={surface} />
        {isMin && (
          <span
            className="price-check-card-badge price-check-card-badge-min"
            title="המקור הנמוך ביותר — בדוק אם יש לעדכן את המקור הגבוה"
          >
            הנמוך ביותר
          </span>
        )}
        {isMax && (
          <span
            className="price-check-card-badge price-check-card-badge-max"
            title="המקור הגבוה ביותר — בדוק אם יש לעדכן את המקור הנמוך"
          >
            הגבוה ביותר
          </span>
        )}
      </div>
      <div className="price-check-card-price">
        {surface.price != null ? fmtIls(surface.price) : "—"}
      </div>
      {emptyState && (
        <div className="price-check-card-empty-state">{emptyState}</div>
      )}
      {!clientMode && warehouseFb?.price != null && (
        <div
          className="price-check-card-empty-state price-check-card-src"
          title={
            `נקרא מטקסט המודעות במאגר (Supabase), לא מהדוח — נתיב הפייסבוק בדוח לא מחזיר כרגע טקסט מודעות כלל. ` +
            `נבדקו ${warehouseFb.adsWithText} מודעות עם טקסט מתוך ${warehouseFb.adsChecked} שרצו ב-10 הימים האחרונים.`
          }
        >
          ↩ מטקסט המודעות במאגר ·{" "}
          {warehouseFb.adsWithText === 1
            ? "מודעה אחת"
            : `${warehouseFb.adsWithText} מודעות`}
        </div>
      )}
      {!clientMode && artworkIsSource && artworkPrice && (
        <div
          className="price-check-card-empty-state price-check-card-src"
          title={
            `נקרא מהקריאייטיב עצמו, לא מטקסט המודעה — אף מודעה פעילה לא מציינת מחיר בטקסט. ` +
            (artworkPrice.raw ? `הזיהוי: "${artworkPrice.raw}". ` : "") +
            (artworkPrice.basis === "spend"
              ? "המודעות הפעילות זוהו לפי הוצאה אחרונה ולא לפי סטטוס, אז ייתכן שנכללת מודעה שהושהתה לאחרונה. "
              : "") +
            (artworkPrice.pending
              ? "חלק מהקריאייטיבים עדיין ממתינים לקריאה, ייתכן שקיים מחיר נמוך יותר."
              : "")
          }
        >
          🖼️ נקרא מהקריאייטיב
          {artworkPrice.pending && " · קריאה חלקית"}
        </div>
      )}
      {!clientMode && surface.name === "facebook" && (artwork || artworkPrice) && (
        <ArtworkPriceChip
          flag={artwork}
          price={artworkIsSource ? null : artworkPrice}
          cardPrice={surface.price ?? null}
        />
      )}
      <InventoryRows surface={surface} />
      {surface.url &&
        !(
          clientMode &&
          (surface.name === "google" || surface.name === "facebook")
        ) && (
          <a
            className="price-check-card-link"
            href={surface.url}
            target="_blank"
            rel="noreferrer"
          >
            {LINK_LABEL[surface.name]} ↗
          </a>
        )}
    </div>
  );
}

/** How far the artwork price may sit from the card price before the chip
 *  calls it a mismatch. Same 1% the section's own comparator uses
 *  (comparePrices), so the two can't disagree about what "זהה" means. */
const ARTWORK_TOLERANCE_PCT = 1;

/**
 * "what the artwork itself says" chip — FB card, internal only.
 *
 * Every surface on this card is read from TEXT, so a price that lives only
 * in the creative image is invisible to the comparison. That is the case
 * most likely to go stale unnoticed: the landing page gets updated and the
 * artwork keeps running with the old number.
 *
 * Two shapes, because two different things can be known:
 *
 *  - `price` present — the tagger read the NUMBER off the live creatives
 *    (`price_on_image_value`, shipped 2026-08-24). The chip prints it and
 *    says whether it matches the card's own price. Every distinct value is
 *    listed rather than reduced to one: creatives carry deposits and
 *    payment terms next to unit prices, and picking for the reader would
 *    silently promote one of those to "the artwork price".
 *
 *  - `price` absent, `flag.withPrice > 0` — the tagger's boolean pass knows
 *    a price is SHOWN but no value was readable. The chip can only tell you
 *    to go look, which is what it did before values existed.
 *
 * It states its own coverage in both shapes: the tagger has seen a fraction
 * of live creatives, and a bare verdict from a sample that small would be a
 * claim we cannot support. Silent when there is nothing to say.
 */
function ArtworkPriceChip({
  flag,
  price,
  cardPrice,
}: {
  flag: ArtworkPriceFlag | null;
  price: ArtworkPrice | null;
  cardPrice: number | null;
}) {
  const values = price?.all ?? [];
  if (!values.length && !(flag && flag.withPrice > 0)) return null;
  const partial = !!flag && flag.tagged < flag.adsChecked;
  const coverage = partial
    ? ` (נבדקו ${flag.tagged} מתוך ${flag.adsChecked} המודעות הפעילות; לשאר אין עדיין תיוג.)`
    : "";

  // Nothing readable — the pre-value behaviour, unchanged.
  if (!values.length) {
    return (
      <div
        className="price-check-card-empty-state price-check-card-artwork"
        title={
          `${flag!.withPrice} מתוך ${flag!.tagged} מודעות שנבדקו מציגות מחיר על התמונה עצמה, ` +
          `אבל לא ניתן היה לקרוא את המספר עצמו. ` +
          `לכן כדאי לוודא ידנית שהוא עדיין תואם לדף הנחיתה.` +
          coverage
        }
      >
        🖼️ מחיר מוטבע על הקריאייטיב ({flag!.withPrice})
        {partial && ` · נבדקו ${flag!.tagged}/${flag!.adsChecked}`}
      </div>
    );
  }

  // A value matches the card when it lands inside the same tolerance the
  // section compares surfaces with. Any of them matching is enough — the
  // others are the deposits and payment terms sharing the creative.
  const near = (v: number) =>
    cardPrice != null &&
    cardPrice > 0 &&
    (Math.abs(v - cardPrice) / Math.min(v, cardPrice)) * 100 <=
      ARTWORK_TOLERANCE_PCT;
  const agrees = cardPrice != null && values.some((x) => near(x.value));
  const verdict = cardPrice == null ? "none" : agrees ? "ok" : "gap";

  return (
    <div
      className={
        "price-check-card-empty-state price-check-card-artwork" +
        (verdict === "gap" ? " price-check-card-artwork-gap" : "")
      }
      title={
        `נקרא מהקריאייטיב של המודעות ה${price!.basis === "spend" ? "פעילות (לפי הוצאה אחרונה)" : "פעילות"}:\n` +
        values.map((x) => `• ${fmtIls(x.value)} — "${x.raw}"`).join("\n") +
        (verdict === "gap"
          ? `\n\nאף אחד מהמספרים האלה לא תואם את ${fmtIls(cardPrice!)} שמפורסם בטקסט. ` +
            `או שאחד מהשניים לא עודכן, או שהמספר על הקריאייטיב הוא תנאי תשלום ולא מחיר דירה — הניסוח למעלה יגיד מה מהם.`
          : verdict === "ok"
            ? `\n\nתואם למחיר שמפורסם בטקסט.`
            : `\n\nאין מחיר בטקסט המודעות להשוות אליו.`) +
        (price!.pending
          ? `\nחלק מהקריאייטיבים הפעילים עדיין ממתינים לקריאה, ייתכן שקיים מחיר נוסף.`
          : "") +
        coverage
      }
    >
      {/* Capped at 3 so a project running many distinct creatives can't
          stretch the card — the tooltip always lists all of them. Live
          filtering leaves one value on every project measured so far, so
          this is insurance, not the normal path. */}
      🖼️ על הקריאייטיב:{" "}
      {values
        .slice(0, 3)
        .map((x) => fmtIls(x.value))
        .join(" · ")}
      {values.length > 3 && ` +${values.length - 3}`}
      {/* "שונה מהטקסט" and not "לא תואם": all we know is that no artwork
          number equals the text price. Which of the two is wrong — or
          whether the artwork number is a payment term rather than a price
          at all — is in the raw string, one hover away. */}
      {verdict === "gap" && " ⚠ שונה מהטקסט"}
      {verdict === "ok" && " ✓ תואם"}
    </div>
  );
}

/**
 * Ad-status chip on the FB / Google cards. Shows three states:
 *   - all paused (active=0, paused>0)  → severe red "⚠ כל המודעות מושהות (N)"
 *   - mixed (active>0, paused>0)       → warn amber "X פעילות · Y מושהות"
 *   - all active (paused=0, active>0)  → no chip (the quiet path)
 *   - empty (total=0)                  → no chip (the empty-state copy
 *                                        on the card body already
 *                                        explains "no campaigns")
 * Tooltip carries the breakdown so the user can hover for detail.
 * Only renders for surfaces that carry `adStatus` (FB + Google);
 * landing / yad2 don't have a paid-ad concept.
 */
function AdStatusChip({ surface }: { surface: ProjectPriceSurface }) {
  const s = surface.adStatus;
  if (!s || s.total === 0) return null;
  const isAllPaused = s.paused > 0 && s.active === 0;
  const isMixed = s.paused > 0 && s.active > 0;
  if (!isAllPaused && !isMixed) return null; // all-active = quiet
  const tone = isAllPaused ? "severe" : "warn";
  const text = isAllPaused
    ? `⚠ כל המודעות מושהות (${s.paused})`
    : `${s.active} פעילות · ${s.paused} מושהות`;
  const title = isAllPaused
    ? `כל ${s.total} המודעות המכילות מחיר בערוץ זה כרגע מושהות — הקהל לא רואה אותן`
    : `מתוך ${s.total} מודעות עם מחיר: ${s.active} פעילות, ${s.paused} מושהות`;
  return (
    <span
      className={`price-check-card-ad-status price-check-card-ad-status-${tone}`}
      title={title}
    >
      {text}
    </span>
  );
}

/**
 * Yad2 affiliate-package chip on the יד2 card. Hover shows the full
 * package details Yad2's account team set in their sheet — חבילה /
 * זמן חבילה / תאריך סיום / באוויר או לא. Visible label is a tight
 * "<package> · <duration>" badge so the head row stays compact;
 * expanded form is in the tooltip + the hidden multi-line breakdown
 * the browser surfaces on hover via title.
 *
 * Renders only when yad2Meta is present (i.e., the project has a
 * yad2lookup in Keys that matched a row in the affiliate sheet).
 * Shows nothing on landing / google / facebook surfaces — the
 * concept doesn't apply.
 */
function Yad2MetaChip({ surface }: { surface: ProjectPriceSurface }) {
  if (surface.name !== "yad2") return null;
  const m = surface.yad2Meta;
  if (!m) return null;
  const isLive = m.liveStatus === "באוויר";
  const compact = [m.package, m.packageDuration].filter(Boolean).join(" · ");
  // Multi-line tooltip — browser title shows each on its own line.
  const tooltip = [
    m.package && `חבילה: ${m.package}`,
    m.packageDuration && `זמן חבילה: ${m.packageDuration}`,
    m.endDate && `תאריך סיום: ${m.endDate}`,
    m.liveStatus && `סטטוס: ${m.liveStatus}`,
  ]
    .filter(Boolean)
    .join("\n");
  if (!compact && !m.endDate) return null;
  return (
    <span
      className={`price-check-card-yad2-meta price-check-card-yad2-meta-${
        isLive ? "live" : "off"
      }`}
      title={tooltip}
    >
      {compact || m.liveStatus}
    </span>
  );
}

/**
 * Renders the per-surface inventory of advertised prices beneath the
 * headline number. Only kicks in when the surface has MORE THAN ONE
 * distinct anchored price — otherwise the card would just show the
 * headline twice. Each row carries the value + the apartment-type
 * label the page used (`4 חד׳` / `פנטהאוז · 5 חד׳` / `3-5 חד׳` …).
 * The row matching the headline pick is visually highlighted so the
 * user knows "this is the number the comparison alert uses".
 *
 * No-op (returns null) when the inventory is missing (server-side
 * legacy Apps Script before 2026-06-05) or carries 0–1 entries.
 */
function InventoryRows({ surface }: { surface: ProjectPriceSurface }) {
  const inv = surface.inventory ?? [];
  // Only anchored entries are "real" advertised prices. The
  // unanchored ones are anti-anchor / loan / down-payment figures
  // (`מקדמה החל מ-500,000`, `יתרת הלוואת יזם 4,123,787` etc.) — the
  // extractor flags them but they shouldn't pollute the campaign-
  // manager-facing inventory. Yad2 sponsored pages routinely add 6-10
  // of these per-apartment-type loan figures and rendering them all
  // would drown the actual apartment prices.
  const anchored = inv.filter((e) => e.anchored);
  if (anchored.length <= 1) return null;
  // Ascending — pages typically list cheapest first; the user scans
  // top-to-bottom for the room count they care about.
  const sorted = [...anchored].sort((a, b) => a.value - b.value);
  return (
    <ul className="price-check-card-inventory" dir="rtl">
      {sorted.map((entry, i) => (
        <li
          key={`${entry.value}-${i}`}
          className={[
            "price-check-card-inventory-row",
            entry.value === surface.price &&
              "price-check-card-inventory-row-headline",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <span className="price-check-card-inventory-rooms">
            {entry.roomsLabel || "—"}
          </span>
          <span className="price-check-card-inventory-value">
            {fmtIls(entry.value)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Emoji only where no brand exists. Google and Facebook render their
 *  real logos via PlatformIcon — see SurfaceIcon below. */
const SURFACE_ICONS: Record<ProjectPriceSurface["name"], string> = {
  landing: "🌐",
  yad2: "",
  google: "",
  facebook: "",
};

function SurfaceIcon({ name }: { name: ProjectPriceSurface["name"] }) {
  if (name === "google" || name === "facebook" || name === "yad2") {
    return <PlatformIcon platform={name} size="1em" />;
  }
  return <>{SURFACE_ICONS[name]}</>;
}

const LINK_LABEL: Record<ProjectPriceSurface["name"], string> = {
  landing: "פתח דף נחיתה",
  yad2: "פתח ביד2",
  google: "פתח בגוגל Ads",
  facebook: "פתח בפייסבוק Ads",
};

function fmtIls(n: number): string {
  return "₪" + Math.round(n).toLocaleString("he-IL");
}

/** Hebrew-friendly relative-time formatter for the "עודכן …" caption.
 *  Identical style to the formatRelativeIso helper in projects/page.tsx —
 *  kept local so this component is drop-in without an import dependency. */
function formatScrapedAtRelative(iso: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "לפני רגע";
  if (m < 60) return `לפני ${m} דקות`;
  const h = Math.floor(m / 60);
  if (h < 24) return `לפני ${h} שעות`;
  const d = Math.floor(h / 24);
  if (d === 1) return "אתמול בלילה";
  if (d < 7) return `לפני ${d} ימים`;
  return iso.slice(0, 10);
}

function formatScrapedAt(iso: string): string {
  // Absolute version for the tooltip — DD/MM/YYYY HH:MM in IL timezone.
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("he-IL", {
      timeZone: "Asia/Jerusalem",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
