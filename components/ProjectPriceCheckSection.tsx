import {
  getProjectPriceCheck,
  type ProjectPriceSurface,
} from "@/lib/appsScript";

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

  // Self-hide when every surface is dark — no landing scrape AND no ad
  // copy on either platform. (`hasInput` is true for any surface where
  // SOME source content existed, even if no price could be extracted.)
  const anyInput = data.surfaces.some((s) => s.hasInput);
  if (!anyInput) return null;

  // The mismatch status pill shown next to the section title. Four states:
  //   - "פערים בדירת <room> · X%" (warn/severe) — per-room mismatch fired
  //   - "פערים זוהו · X%" (warn/severe) — headline-fallback mismatch
  //   - "כל המקורות זהים" — at least 2 sources, all within tolerance
  //   - "מקור יחיד" — only 1 source has a price, can't compare
  // Room-aware path skips the "min/max" outlier highlighting on the
  // cards because the headline-min/max axis isn't what's mismatched
  // there — the room-level inventory rows tell that story instead.
  const detectedCount = data.surfaces.filter((s) => s.price != null).length;
  const cmp = data.comparison;
  const statusPill =
    cmp && cmp.mismatched
      ? {
          tone: cmp.severe ? "severe" : "warn",
          text: cmp.mismatchRoom
            ? `פערים בדירת ${cmp.mismatchRoom} · ${cmp.driftPct.toFixed(1)}%`
            : `פערים זוהו · ${cmp.driftPct.toFixed(1)}%`,
        }
      : cmp
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
  const prices = data.surfaces
    .map((s) => s.price)
    .filter((p): p is number => p != null);
  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;
  const isHeadlineMismatch = !!cmp && cmp.mismatched && !cmp.mismatchRoom;
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
        {data.surfaces.map((s) => (
          <PriceCheckCard
            key={s.name}
            surface={s}
            clientMode={clientMode}
            isOutlier={!clientMode && isOutlier(s)}
            isMin={!clientMode && s.price != null && s.price === minPrice && cmp?.mismatched}
            isMax={!clientMode && s.price != null && s.price === maxPrice && cmp?.mismatched}
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
}: {
  surface: ProjectPriceSurface;
  isOutlier: boolean;
  isMin: boolean | undefined;
  isMax: boolean | undefined;
  /** Client viewer — hides the ad-status chip and the FB/Google Ads
   *  deep-links (internal ad-ops surfaces the client can't use). */
  clientMode?: boolean;
}) {
  const icon = SURFACE_ICONS[surface.name] ?? "•";
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
          {icon}
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

const SURFACE_ICONS: Record<ProjectPriceSurface["name"], string> = {
  landing: "🌐",
  yad2: "🏠",
  google: "🔍",
  facebook: "📘",
};

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
