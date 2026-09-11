"use client";

import { use, useEffect, useMemo, useState } from "react";
import CrmFunnelTrendline from "@/components/CrmFunnelTrendline";
import {
  fillDailySeries,
  horizonKey,
  isoAddDays,
  lastReportedDay,
  paletteFor,
  platformHorizon,
  type CrmDailyBundle,
} from "@/lib/crmDailyShared";

const PLATFORM_LABEL: Record<string, string> = {
  bmby: "BMBY",
  sehel: "Sehel",
  salesforce: "Salesforce",
};

function ddmm(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}` : iso;
}

/**
 * One project's daily CRM leads on the budget desk, at the bottom of its
 * card: a one-line summary, and — while the CARD is open — the project
 * page's "מגמה לאורך זמן — לידים לפי ערוץ" chart, fed the same numbers.
 *
 * THE CHART FOLLOWS THE CARD, per Maayan: first "collapsed by default inside
 * each card" (2026-09-10), then "opening the project should look like this,
 * not with a fold of its own" (2026-09-11). So there is no second disclosure:
 * a closed card shows the summary line — the zero-day chip is the at-a-glance
 * answer — and opening the card (its summary, or this line) shows the chart
 * under the channel table. No channel legend: the hover card on each day
 * already names every channel.
 *
 * Three kinds of day, kept apart on purpose:
 *   - a day with leads → the usual stacked bar (a day whose only leads
 *     have no source has no bar, but it is NOT a zero day — dayTotals);
 *   - a day with none, up to lastReportedDay → a red mark, counted in the
 *     "N ימים ללא לידים" chip;
 *   - any later day → a grey mark. Today is not over, and past the feed's
 *     last fully-reported day the CRM has not caught up; calling either a
 *     zero would be a guess (lib/crmDailyShared, lastReportedDay).
 */
export default function BudgetCrmDaily({
  bundle,
  tab,
  today,
  expanded,
  onOpen,
}: {
  bundle: Promise<CrmDailyBundle>;
  tab: string;
  today: string;
  /** The card's own open state — the chart shows exactly when it does. */
  expanded: boolean;
  /** Opens the card, from the summary line of a closed one. */
  onOpen: () => void;
}) {
  // Keep the bundle already on screen until a newer one SETTLES. Every
  // server render hands down a fresh promise, and a router.refresh() — the
  // view-as switch, a quick-note save — runs in a transition, where React
  // will not swap visible content for a fallback: it holds the WHOLE refresh
  // until the new promise resolves. On a cold compute that froze the desk
  // for 20-30 s (found in review, 2026-09-10). Reading the previous bundle
  // means nothing here suspends on a refresh; the row swaps when the new
  // data lands. A freshly-mounted row (the toggle just switched on) still
  // suspends and shows the loading line.
  const [shown, setShown] = useState(bundle);
  useEffect(() => {
    if (bundle === shown) return;
    let live = true;
    const swap = () => {
      if (live) setShown(bundle);
    };
    bundle.then(swap, swap);
    return () => {
      live = false;
    };
  }, [bundle, shown]);
  const b = use(shown);
  const d = b.byTab[tab.toLowerCase().trim()];
  const yesterday = isoAddDays(today, -1);

  const model = useMemo(() => {
    if (!d || d.status !== "ok") return null;
    const end = d.to < today ? d.to : today;
    const series = fillDailySeries(d.days, d.from, end);
    const flagUntil = lastReportedDay(
      b.horizon[horizonKey(d.platform, d.source)] || d.dataTo,
      today,
    );
    let zero = 0;
    for (const day of series) {
      if (day.date > flagUntil) break;
      if (!((d.dayTotals[day.date] ?? 0) > 0)) zero++;
    }
    return {
      series,
      flagUntil,
      zero,
      stale: flagUntil < yesterday ? flagUntil : "",
      palette: paletteFor(d.allSources),
      selected: new Set(d.allSources),
    };
  }, [d, b.horizon, today, yesterday]);

  const title = <span className="budget-crm-title">📈 לידים יומיים מה-CRM</span>;
  const line = (text: string, alert = false) => (
    <div className="budget-crm-head is-static">
      {title}
      <span className={`budget-crm-note${alert ? " is-alert" : ""}`}>{text}</span>
    </div>
  );

  if (b.error) return line(`לא הצלחנו לקרוא את ה-CRM: ${b.error}`, true);
  if (!d) return line("אין נתוני CRM לפרויקט הזה.");
  if (d.status === "no-crm") {
    return line("לפרויקט אין מיפוי CRM ב-Keys, אז אין ממה לצייר.");
  }
  if (d.status === "unsupported") {
    return line(
      `פלטפורמת ה-CRM ב-Keys היא „${d.platform}” — לא אחת מהשלוש שה-hub יודע לקרוא (bmby / sehel / salesforce).`,
    );
  }
  if (d.status === "error") return line(`שגיאה בקריאת ה-CRM: ${d.message}`, true);
  if (d.status === "no-leads") {
    const flagUntil = lastReportedDay(platformHorizon(b.horizon, d.platform), today);
    const end = d.to < flagUntil ? d.to : flagUntil;
    const n = fillDailySeries([], d.from, end).length;
    return (
      <div className="budget-crm-head is-static">
        {title}
        {n > 0 ? (
          <span className="budget-crm-chip is-zero">
            {n} ימים ללא לידים — אף ליד מאז {ddmm(d.from)}
          </span>
        ) : (
          <span className="budget-crm-note">
            עוד אין ימים שה-CRM דיווח עליהם מאז {ddmm(d.from)}.
          </span>
        )}
      </div>
    );
  }
  if (!model || model.series.length === 0) {
    return line(`הפריסה מתחילה ב-${ddmm(d.from)} — עוד אין ימים להציג.`);
  }

  const summary = (
    <>
      {title}
      {model.zero > 0 ? (
        <span className="budget-crm-chip is-zero">
          {model.zero} ימים ללא לידים
        </span>
      ) : (
        <span className="budget-crm-chip is-clean">כל יום עם לידים</span>
      )}
      <span>
        <b>{d.leads}</b> לידים · <b>{d.scheduled}</b> תיאומים ·{" "}
        <b>{d.held}</b> פגישות
      </span>
      <span title="מאיפה נקראו הלידים — אותה בחירה שעמוד הפרויקט עושה (warehouse כשיש בו לפחות כמו בגיליון, אחרת הגיליון)">
        {PLATFORM_LABEL[d.platform] || d.platform} ·{" "}
        {d.source === "warehouse" ? "warehouse" : "גיליון"}
      </span>
      {model.stale && (
        <span
          className="budget-crm-note"
          title="היום האחרון שהפיד הזה של ה-CRM דיווח עליו במלואו. ימים אחריו מסומנים באפור ולא נספרים כימים ריקים."
        >
          ה-CRM מעודכן עד {ddmm(model.stale)}
        </span>
      )}
      {d.unsourced > 0 && (
        <span
          className="budget-crm-note"
          title="לידים בלי מקור הגעה נספרים בסך הלידים ולא נחשבים ליום ריק, אבל אין עמודה שאפשר לשים אותם בה — כמו בעמוד הפרויקט. ההובר על היום אומר כמה היו."
        >
          {d.unsourced} לידים בלי מקור לא מופיעים בגרף
        </span>
      )}
    </>
  );

  if (!expanded) {
    // A closed card: the line is a shortcut into the card, not a fold of its
    // own — one click from a red chip to the chart.
    return (
      <button
        type="button"
        className="budget-crm-head"
        onClick={onOpen}
        title="פתיחת הפרויקט מציגה את הגרף"
      >
        {summary}
      </button>
    );
  }

  return (
    <>
      <div className="budget-crm-head is-static">{summary}</div>
      {d.allSources.length === 0 ? (
        <div className="budget-crm-note">
          כל הלידים בחלון הזה בלי מקור הגעה — אין עמודות לצייר.
        </div>
      ) : (
        <CrmFunnelTrendline
          dailyTimeSeries={model.series}
          selectedSources={model.selected}
          sourceColors={model.palette}
          title={null}
          zeroDays={{ flagUntil: model.flagUntil, dayTotals: d.dayTotals }}
          portalHover
          fitWidth
          height={150}
          legend={false}
        />
      )}
    </>
  );
}
