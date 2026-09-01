import { Fragment } from "react";
import {
  getMediaWorkbook,
  ratio,
  cpm,
  type MediaCampaign,
  type MediaChannelRow,
} from "@/lib/mediaCampaigns";

/**
 * Media-performance card for non-real-estate projects — the counterpart
 * to CrmFunnelCard, which reports a sales funnel this client doesn't
 * have. Pure server component: everything here is static once rendered,
 * and per-campaign drill-in uses <details> so it costs no client JS.
 *
 * `view="actuals"` renders the flights that ran; `view="plan"` renders
 * the forward media plan. Both come from one cached workbook read.
 * Returns null when the project has no workbook wired up, so the rail
 * simply doesn't get the section.
 */

const fmtInt = (n: number): string =>
  n.toLocaleString("he-IL", { maximumFractionDigits: 0 });
const fmtILS = (n: number): string => "₪" + fmtInt(n);
const fmtPct = (n: number | null, digits = 1): string =>
  n === null
    ? "—"
    : (n * 100).toLocaleString("he-IL", { maximumFractionDigits: digits }) + "%";
const fmt2 = (n: number | null): string =>
  n === null ? "—" : n.toLocaleString("he-IL", { maximumFractionDigits: 2 });

/** Compact form for the KPI tiles — 6.6M reads better than 6,617,930 at
 *  tile size, and the exact figure is one table down. */
function fmtCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 10_000) return Math.round(n / 1000) + "K";
  return fmtInt(n);
}

function fmtRange(from: string, to: string): string {
  const d = (iso: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    return m ? `${m[3]}.${m[2]}.${m[1].slice(2)}` : iso;
  };
  if (!from && !to) return "";
  return `${d(from)} – ${d(to)}`;
}

function paceTone(pace: number | null): string {
  return pace === null ? "na" : pace >= 0.9 ? "ok" : pace >= 0.6 ? "warn" : "low";
}

const DAY_MS = 86400000;
const tOf = (iso: string): number => Date.parse(iso + "T00:00:00Z");

/**
 * Flight calendar — the campaigns laid out on a real time axis.
 *
 * This is the shape of the account: the budget doesn't run continuously,
 * it fires in short bursts tied to the municipal calendar (חופים in
 * summer, רישום לגנים in January, מקלטים in March, pride in June). A
 * table sorted by date can't show that the gaps are as deliberate as the
 * flights. Bar length is the flight's duration, the fill is how much of
 * its budget it actually spent.
 *
 * Fixed label columns on both sides rather than labels floating at the
 * bar ends: in the rail the track is ~400px for 13 months, so a 4-day
 * flight is a 3px bar and any label anchored to it would collide with
 * its neighbours or overflow the container.
 */
function FlightCalendar({ campaigns }: { campaigns: MediaCampaign[] }) {
  const rows = campaigns
    .filter((c) => Number.isFinite(tOf(c.from)) && Number.isFinite(tOf(c.to)))
    .sort((a, b) => tOf(a.from) - tOf(b.from));
  if (rows.length < 2) return null;

  const t0 = Math.min(...rows.map((c) => tOf(c.from)));
  const t1 = Math.max(...rows.map((c) => tOf(c.to)));
  const pad = 8 * DAY_MS;
  const span = t1 - t0 + pad * 2;
  const pos = (ms: number): number => ((ms - t0 + pad) / span) * 100;

  const ticks: { pos: number; label: string; isYear: boolean }[] = [];
  const cur = new Date(t0);
  cur.setUTCDate(1);
  while (cur.getTime() <= t1) {
    const month = cur.getUTCMonth();
    ticks.push({
      pos: pos(cur.getTime()),
      label: month === 0 ? String(cur.getUTCFullYear()) : String(month + 1),
      isYear: month === 0,
    });
    cur.setUTCMonth(month + 1);
  }

  return (
    <div className="media-cal">
      <div className="media-cal-row media-cal-axis">
        <div className="media-cal-name" />
        <div className="media-cal-track">
          {ticks.map((k, i) => (
            <span
              key={i}
              className={"media-cal-tick" + (k.isYear ? " is-year" : "")}
              style={{ insetInlineStart: `${k.pos}%` }}
            >
              {k.label}
            </span>
          ))}
        </div>
        <div className="media-cal-spend" />
      </div>
      {rows.map((c) => {
        const start = pos(tOf(c.from));
        const width = Math.max(0.8, pos(tOf(c.to)) - start);
        const pace = ratio(c.spent, c.allocated);
        return (
          <div className="media-cal-row" key={c.sheetRow}>
            <div className="media-cal-name" title={c.name}>
              {c.name}
            </div>
            <div className="media-cal-track">
              {ticks.map((k, i) => (
                <span
                  key={i}
                  className={"media-cal-grid" + (k.isYear ? " is-year" : "")}
                  style={{ insetInlineStart: `${k.pos}%` }}
                />
              ))}
              <div
                className="media-cal-bar"
                style={{ insetInlineStart: `${start}%`, width: `${width}%` }}
                title={`${fmtRange(c.from, c.to)} · ${fmtILS(c.spent)} מתוך ${fmtILS(c.allocated)}`}
              >
                <span
                  className={"media-cal-fill is-" + paceTone(pace)}
                  style={{ width: `${Math.min(100, (pace ?? 0) * 100)}%` }}
                />
              </div>
            </div>
            <div className="media-cal-spend">{fmtILS(c.spent)}</div>
          </div>
        );
      })}
    </div>
  );
}

/** Utilisation bar. Over 100% is real (a channel can overshoot), so the
 *  fill is capped for layout but the number next to it isn't. */
function PaceBar({ pace }: { pace: number | null }) {
  if (pace === null) return <span className="media-muted">—</span>;
  const pct = Math.max(0, Math.min(1.2, pace));
  const tone = paceTone(pace);
  return (
    <span className="media-pace">
      <span className="media-pace-track">
        <span
          className={"media-pace-fill is-" + tone}
          style={{ width: `${(pct / 1.2) * 100}%` }}
        />
      </span>
      <span className="media-pace-num">{fmtPct(pace, 0)}</span>
    </span>
  );
}

/** Sum a metric across every channel row of every campaign. */
function totalOf(
  campaigns: MediaCampaign[],
  pick: (c: MediaCampaign) => number,
): number {
  return campaigns.reduce((a, c) => a + pick(c), 0);
}

/**
 * The four efficiency metrics, identical in every table on this card.
 *
 * They used to be picked per table — קמפיינים carried CPM+CTR, the
 * channel drill-ins CPM+CPC, the rollup CPM+CPC — so two tables stacked
 * on the same screen couldn't be read across: the CTR of a campaign had
 * no counterpart in its own channel breakdown. Keeping the header and
 * the cells as one pair is what stops that drifting apart again.
 *
 * Order is counts → rate → costs: CTR reads off the two count columns
 * immediately before it, then the three costs by widening unit (per
 * mille impressions, per click, per install). Every one of them is null
 * on a zero denominator, which `ratio` already returns, so a campaign
 * with no installs shows "—" rather than a fake ₪0.
 */
function MetricHeads() {
  return (
    <>
      <th>CTR</th>
      <th>CPM</th>
      <th>CPC</th>
      <th>CPI</th>
    </>
  );
}

function MetricCells({
  cost,
  impressions,
  clicks,
  installs,
}: {
  cost: number;
  impressions: number;
  clicks: number;
  installs: number;
}) {
  return (
    <>
      <td>{fmtPct(ratio(clicks, impressions), 2)}</td>
      <td>{fmt2(cpm(cost, impressions))}</td>
      <td>{fmt2(ratio(cost, clicks))}</td>
      <td>{fmt2(ratio(cost, installs))}</td>
    </>
  );
}

function ChannelTable({ rows }: { rows: MediaChannelRow[] }) {
  // Totals for the drill-in. Budget is summed only over rows that report
  // one: a channel with a null budget is unreported, not zero, and
  // folding it in as zero would understate the denominator utilisation
  // is measured against.
  const t = rows.reduce(
    (a, r) => ({
      budget: r.budget === null ? a.budget : (a.budget ?? 0) + r.budget,
      cost: a.cost + (r.cost ?? 0),
      impressions: a.impressions + (r.impressions ?? 0),
      clicks: a.clicks + (r.clicks ?? 0),
      installs: a.installs + (r.installs ?? 0),
    }),
    {
      budget: null as number | null,
      cost: 0,
      impressions: 0,
      clicks: 0,
      installs: 0,
    },
  );

  return (
    <table className="media-table media-table-sub">
      <thead>
        <tr>
          <th>ערוץ</th>
          <th>פלטפורמה</th>
          <th>יעד</th>
          <th>תקציב</th>
          <th>הוצאה</th>
          <th>ניצול</th>
          <th>חשיפות</th>
          <th>הקלקות</th>
          <th>התקנות</th>
          <MetricHeads />
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const cost = r.cost ?? 0;
          return (
            <tr key={i}>
              <td className="media-nowrap">{r.channel}</td>
              <td className="media-muted">{r.platform || "—"}</td>
              <td className="media-muted">{r.note || "—"}</td>
              <td>{r.budget === null ? "—" : fmtILS(r.budget)}</td>
              <td>{r.cost === null ? "—" : fmtILS(r.cost)}</td>
              <td>
                <PaceBar pace={r.budget ? ratio(cost, r.budget) : null} />
              </td>
              <td>{r.impressions === null ? "—" : fmtInt(r.impressions)}</td>
              <td>{r.clicks === null ? "—" : fmtInt(r.clicks)}</td>
              <td>{r.installs ? fmtInt(r.installs) : "—"}</td>
              <MetricCells
                cost={cost}
                impressions={r.impressions ?? 0}
                clicks={r.clicks ?? 0}
                installs={r.installs ?? 0}
              />
            </tr>
          );
        })}
        {/* Only worth a footer when there is something to add up — on a
            single-channel flight it would just repeat the row above, and
            the flight's spend is already on the <summary> line. */}
        {rows.length > 1 && (
          <tr className="media-total-row">
            <td>סה״כ</td>
            <td />
            <td />
            <td>{t.budget === null ? "—" : fmtILS(t.budget)}</td>
            <td>{fmtILS(t.cost)}</td>
            <td>
              <PaceBar pace={t.budget ? ratio(t.cost, t.budget) : null} />
            </td>
            <td>{fmtInt(t.impressions)}</td>
            <td>{fmtInt(t.clicks)}</td>
            <td>{t.installs ? fmtInt(t.installs) : "—"}</td>
            <MetricCells
              cost={t.cost}
              impressions={t.impressions}
              clicks={t.clicks}
              installs={t.installs}
            />
          </tr>
        )}
      </tbody>
    </table>
  );
}

export default async function MediaCampaignsCard({
  project,
  view = "actuals",
  clientView = false,
}: {
  project: string;
  view?: "actuals" | "plan";
  /** Hides the data-quality strip. Those flags are notes to ourselves
   *  about the workbook — an unreported DV360 cost, an impossible CPM —
   *  and read to a client as "your report is wrong" without telling them
   *  anything they can act on. The numbers themselves stay identical. */
  clientView?: boolean;
}) {
  const wb = await getMediaWorkbook(project).catch(() => null);
  if (!wb) return null;

  if (view === "plan") {
    if (!wb.plans.length) return null;
    return (
      <div className="media-card">
        <p className="media-intro">
          תחזית מדיה מתוכננת — מה שהוגדר בבריף לפני העלייה לאוויר. הביצועים
          בפועל מוצגים בקטע ״ביצועי מדיה״.
        </p>
        {wb.plans.map((p, i) => (
          <div className="media-block" key={i}>
            <h4 className="media-block-title">
              {p.title}
              {p.from || p.to ? (
                <span className="media-block-dates">
                  {fmtRange(p.from, p.to)}
                </span>
              ) : null}
            </h4>
            <div className="media-tw">
            <table className="media-table">
              <thead>
                <tr>
                  <th>ערוץ</th>
                  <th>תקציב ברוטו</th>
                  <th>נטו מדיה</th>
                  <th>חשיפות (תחזית)</th>
                  <th>הקלקות (תחזית)</th>
                  <th>תוצאות (תחזית)</th>
                  <th>CPA</th>
                </tr>
              </thead>
              <tbody>
                {p.rows.map((r, j) => (
                  <tr key={j}>
                    <td className="media-nowrap">{r.channel}</td>
                    <td>{r.grossBudget === null ? "—" : fmtILS(r.grossBudget)}</td>
                    <td>{r.netMedia === null ? "—" : fmtILS(r.netMedia)}</td>
                    <td>{r.impressions === null ? "—" : fmtInt(r.impressions)}</td>
                    <td>{r.clicks === null ? "—" : fmtInt(r.clicks)}</td>
                    <td>{r.results === null ? "—" : fmtInt(r.results)}</td>
                    <td>{fmt2(ratio(r.netMedia ?? 0, r.results ?? 0))}</td>
                  </tr>
                ))}
                <tr className="media-total-row">
                  <td>סה״כ</td>
                  <td>{fmtILS(p.grossBudget)}</td>
                  <td />
                  <td>{fmtInt(p.impressions)}</td>
                  <td>{fmtInt(p.clicks)}</td>
                  <td>{fmtInt(p.results)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
            </div>
          </div>
        ))}
      </div>
    );
  }

  const cs = wb.campaigns;
  if (!cs.length) return null;

  const allocated = totalOf(cs, (c) => c.allocated);
  const spent = totalOf(cs, (c) => c.spent);
  const impressions = totalOf(cs, (c) => c.impressions);
  const clicks = totalOf(cs, (c) => c.clicks);
  const installs = totalOf(cs, (c) => c.installs);
  const views = totalOf(cs, (c) => c.views);

  // Channel rollup across every flight.
  const byChannel = new Map<
    string,
    { spend: number; impressions: number; clicks: number; installs: number }
  >();
  for (const c of cs) {
    for (const ch of c.channels) {
      const cur = byChannel.get(ch.channel) ?? {
        spend: 0,
        impressions: 0,
        clicks: 0,
        installs: 0,
      };
      cur.spend += ch.cost ?? 0;
      cur.impressions += ch.impressions ?? 0;
      cur.clicks += ch.clicks ?? 0;
      cur.installs += ch.installs ?? 0;
      byChannel.set(ch.channel, cur);
    }
  }
  const channelRows = [...byChannel.entries()].sort(
    (a, b) => b[1].spend - a[1].spend,
  );
  const channelSpend = channelRows.reduce((a, [, v]) => a + v.spend, 0);
  const channelImpressions = channelRows.reduce(
    (a, [, v]) => a + v.impressions,
    0,
  );
  const channelClicks = channelRows.reduce((a, [, v]) => a + v.clicks, 0);
  const channelInstalls = channelRows.reduce((a, [, v]) => a + v.installs, 0);

  // Data-quality strip. Both checks describe the SOURCE, not the media:
  // an allocation with no spend is an import gap (DV360 actuals never
  // reach this workbook — its DV tab is #REF!), and a sub-shekel CPM is
  // not a rate anyone buys, so the impression count is wrong.
  const unfunded = cs.filter((c) => c.unfundedChannels.length > 0);
  const suspectCpm = cs.flatMap((c) =>
    c.channels
      .filter((ch) => {
        const v = cpm(ch.cost ?? 0, ch.impressions ?? 0);
        return v !== null && v < 1 && (ch.cost ?? 0) > 0;
      })
      .map((ch) => ({ campaign: c.name, channel: ch.channel })),
  );

  return (
    <div className="media-card">
      <h4 className="media-block-title">
        לוח העלייה לאוויר
        <span className="media-block-dates">
          אורך הפס = משך הטיסה · המילוי = ניצול התקציב
        </span>
        {/* The one thing the removed intro paragraph carried that wasn't
            prose — keep the route back to the source, drop the narration. */}
        <a
          className="media-source-link"
          href={wb.sheetUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          גיליון המקור
        </a>
      </h4>
      <FlightCalendar campaigns={cs} />

      <div className="media-kpi-row">
        <div className="crm-kpi-tile">
          <div className="crm-kpi-value">{fmtILS(allocated)}</div>
          <div className="crm-kpi-label">תקציב מוקצה</div>
        </div>
        <div className="crm-kpi-tile">
          <div className="crm-kpi-value">{fmtILS(spent)}</div>
          <div className="crm-kpi-label">הוצאה בפועל</div>
          <div className="crm-kpi-sub">
            ניצול {fmtPct(ratio(spent, allocated), 0)}
          </div>
        </div>
        <div className="crm-kpi-tile">
          <div className="crm-kpi-value">{fmtCompact(impressions)}</div>
          <div className="crm-kpi-label">חשיפות</div>
          <div className="crm-kpi-sub">CPM {fmt2(cpm(spent, impressions))}</div>
        </div>
        <div className="crm-kpi-tile">
          <div className="crm-kpi-value">{fmtCompact(clicks)}</div>
          <div className="crm-kpi-label">הקלקות לחנות</div>
          <div className="crm-kpi-sub">CTR {fmtPct(ratio(clicks, impressions), 2)}</div>
        </div>
        <div className="crm-kpi-tile">
          <div className="crm-kpi-value">{fmtCompact(installs)}</div>
          <div className="crm-kpi-label">התקנות</div>
          <div className="crm-kpi-sub">
            {installs > 0 ? `₪${fmt2(ratio(spent, installs))} להתקנה` : "—"}
          </div>
        </div>
        <div className="crm-kpi-tile">
          <div className="crm-kpi-value">{fmtCompact(views)}</div>
          <div className="crm-kpi-label">צפיות בווידאו</div>
        </div>
      </div>

      {!clientView && (unfunded.length > 0 || suspectCpm.length > 0) && (
        <div className="media-flags">
          {unfunded.length > 0 && (
            <div className="media-flag">
              <strong>תקציב ללא דיווח הוצאה</strong> —{" "}
              {unfunded
                .map((c) => `${c.name} (${c.unfundedChannels.join(", ")})`)
                .join(" · ")}
              . הערוצים האלה מקבלים הקצאה בבריף אבל לא מדווחים עלות לגיליון, כך
              שאחוז הניצול המוצג נמוך מהאמיתי.
            </div>
          )}
          {suspectCpm.length > 0 && (
            <div className="media-flag">
              <strong>בדיקת נתונים</strong> — CPM מתחת לשקל בקמפיינים{" "}
              {suspectCpm.map((s) => `${s.campaign} / ${s.channel}`).join(" · ")}
              . מחיר כזה לא נרכש בפועל, כך שספירת החשיפות שם כנראה שגויה.
            </div>
          )}
        </div>
      )}

      <h4 className="media-block-title">קמפיינים</h4>
      <div className="media-tw">
      <table className="media-table">
        <thead>
          <tr>
            <th>קמפיין</th>
            <th>תקופה</th>
            <th>תקציב</th>
            <th>הוצאה</th>
            <th>ניצול</th>
            <th>חשיפות</th>
            <th>הקלקות</th>
            <th>התקנות</th>
            <MetricHeads />
          </tr>
        </thead>
        <tbody>
          {cs.map((c) => (
            <Fragment key={c.sheetRow}>
              <tr>
                <td className="media-nowrap">{c.name}</td>
                <td className="media-muted media-nowrap">
                  {fmtRange(c.from, c.to)}
                </td>
                <td>{fmtILS(c.allocated)}</td>
                <td>{fmtILS(c.spent)}</td>
                <td>
                  <PaceBar pace={ratio(c.spent, c.allocated)} />
                </td>
                <td>{fmtInt(c.impressions)}</td>
                <td>{fmtInt(c.clicks)}</td>
                <td>{c.installs ? fmtInt(c.installs) : "—"}</td>
                <MetricCells
                  cost={c.spent}
                  impressions={c.impressions}
                  clicks={c.clicks}
                  installs={c.installs}
                />
              </tr>
            </Fragment>
          ))}
          <tr className="media-total-row">
            <td>סה״כ</td>
            <td />
            <td>{fmtILS(allocated)}</td>
            <td>{fmtILS(spent)}</td>
            <td>
              <PaceBar pace={ratio(spent, allocated)} />
            </td>
            <td>{fmtInt(impressions)}</td>
            <td>{fmtInt(clicks)}</td>
            <td>{fmtInt(installs)}</td>
            <MetricCells
              cost={spent}
              impressions={impressions}
              clicks={clicks}
              installs={installs}
            />
          </tr>
        </tbody>
      </table>
      </div>

      {/* Channel breakdowns as SIBLINGS of the campaigns table, not rows
          inside it. A table nested in a cell hands that cell its own
          max-content width — the 11-column channel table was dragging the
          10-column campaigns table out to 885px in a 667px rail, and no
          amount of overflow/width containment on the inner wrapper cuts
          that off, because the <details> in between passes the
          contribution straight through even while closed. */}
      <h4 className="media-block-title">פילוח ערוצים</h4>
      <div className="media-drills">
        {cs.map((c) => (
          <details className="media-details media-drill" key={c.sheetRow}>
            <summary>
              {c.name}
              <span className="media-drill-meta">
                {c.channels.length} ערוצים · {fmtILS(c.spent)}
              </span>
            </summary>
            <div className="media-tw">
              <ChannelTable rows={c.channels} />
            </div>
          </details>
        ))}
      </div>

      <h4 className="media-block-title">ערוצים</h4>
      <div className="media-tw">
      <table className="media-table">
        <thead>
          <tr>
            <th>ערוץ</th>
            <th>הוצאה</th>
            <th>נתח</th>
            <th>חשיפות</th>
            <th>הקלקות</th>
            <th>התקנות</th>
            <MetricHeads />
          </tr>
        </thead>
        <tbody>
          {channelRows.map(([name, v]) => (
            <tr key={name}>
              <td className="media-nowrap">{name}</td>
              <td>{fmtILS(v.spend)}</td>
              <td>{fmtPct(ratio(v.spend, spent), 0)}</td>
              <td>{fmtInt(v.impressions)}</td>
              <td>{fmtInt(v.clicks)}</td>
              <td>{v.installs ? fmtInt(v.installs) : "—"}</td>
              <MetricCells
                cost={v.spend}
                impressions={v.impressions}
                clicks={v.clicks}
                installs={v.installs}
              />
            </tr>
          ))}
          {/* The rollup's own footer. Its counts come from the channel
              rows, so they can legitimately fall short of the campaign
              totals above when a flight reports at campaign level only —
              that gap is the point, not a bug to paper over. */}
          <tr className="media-total-row">
            <td>סה״כ</td>
            <td>{fmtILS(channelSpend)}</td>
            <td>{fmtPct(ratio(channelSpend, spent), 0)}</td>
            <td>{fmtInt(channelImpressions)}</td>
            <td>{fmtInt(channelClicks)}</td>
            <td>{channelInstalls ? fmtInt(channelInstalls) : "—"}</td>
            <MetricCells
              cost={channelSpend}
              impressions={channelImpressions}
              clicks={channelClicks}
              installs={channelInstalls}
            />
          </tr>
        </tbody>
      </table>
      </div>
    </div>
  );
}
