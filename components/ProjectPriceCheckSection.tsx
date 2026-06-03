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
 * - Internal-only — gated at the call site (mirrors LatestPrisotCard /
 *   ClarityInsightsSection). Apps Script ALSO enforces it server-side.
 * - Self-hides when the project has nothing to show — neither a landing
 *   scrape NOR any ad copy. Avoids an empty "💰 מחירים מפורסמים" shelf
 *   on projects the price feature doesn't cover yet.
 */
export default async function ProjectPriceCheckSection({
  projectName,
}: {
  projectName: string;
}) {
  const data = await getProjectPriceCheck(projectName).catch(() => null);
  if (!data || !data.ok) return null;

  // Self-hide when every surface is dark — no landing scrape AND no ad
  // copy on either platform. (`hasInput` is true for any surface where
  // SOME source content existed, even if no price could be extracted.)
  const anyInput = data.surfaces.some((s) => s.hasInput);
  if (!anyInput) return null;

  // The mismatch status pill shown next to the section title. Three states:
  //   - "פערים זוהו · X%" (warn / severe) — driftPct > 1%
  //   - "כל המקורות זהים" — at least 2 sources, all within tolerance
  //   - "מקור יחיד" — only 1 source has a price, can't compare
  const detectedCount = data.surfaces.filter((s) => s.price != null).length;
  const cmp = data.comparison;
  const statusPill =
    cmp && cmp.mismatched
      ? {
          tone: cmp.severe ? "severe" : "warn",
          text: `פערים זוהו · ${cmp.driftPct.toFixed(1)}%`,
        }
      : cmp
        ? { tone: "ok" as const, text: "כל המקורות זהים" }
        : detectedCount >= 1
          ? { tone: "muted" as const, text: "מקור יחיד" }
          : null;

  // When mismatched, highlight the min/max endpoints — they're the two
  // surfaces the user needs to reconcile. Other sources fall in the
  // tolerance band and don't need attention.
  const prices = data.surfaces
    .map((s) => s.price)
    .filter((p): p is number => p != null);
  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;
  const isOutlier = (s: ProjectPriceSurface) =>
    !!cmp &&
    cmp.mismatched &&
    s.price != null &&
    (s.price === minPrice || s.price === maxPrice);

  return (
    <section className="project-section project-section-price-check">
      <div className="section-head">
        <h2>
          💰 מחירים מפורסמים
          {statusPill && (
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
        מחיר ה״החל מ-״ שזוהה בכל מקור פרסומי לפרויקט. כשמופיע פער של מעל
        1%, המקור הנמוך והגבוה ביותר מודגשים — אלו השניים שצריך לתאם.
      </p>

      <div className="price-check-grid">
        {data.surfaces.map((s) => (
          <PriceCheckCard
            key={s.name}
            surface={s}
            isOutlier={isOutlier(s)}
            isMin={s.price != null && s.price === minPrice && cmp?.mismatched}
            isMax={s.price != null && s.price === maxPrice && cmp?.mismatched}
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
}: {
  surface: ProjectPriceSurface;
  isOutlier: boolean;
  isMin: boolean | undefined;
  isMax: boolean | undefined;
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
      {surface.url && (
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
