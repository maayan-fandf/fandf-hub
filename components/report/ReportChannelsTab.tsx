"use client";

import { useMemo, useState } from "react";
import { channelIcon } from "@/lib/channelIcon";
import { pacingChannelKey } from "@/lib/budgetTypes";
import ReportChannelCharts from "@/components/report/ReportChannelCharts";
import {
  computeChannelPacing,
  costHeatStyle,
  convTone,
  pickChannelAlerts,
  fmtInt,
  fmtILS,
  fmtDateHe,
  type ProjectReportData,
  type ReportChannel,
} from "@/lib/reportShared";

/**
 * ערוצים tab — the native rebuild of the legacy 📋 פירוט ערוצים table
 * (Index.html:5770): 12 sortable columns (תקציב + קצב יומי hidden in
 * month mode), cost-per heat coloring, conversion-rate tones, totals
 * row, the pacing cell with the 12% configured-vs-required rule
 * (⬇/⬆/🔍 + ✓טיפלתי snooze sharing the iframe/budget-desk dismissal
 * keys), campaign live/paused dots, flight chips + mini-gantt, and the
 * pickAlerts strip. Not yet ported: pixel-divergence ⚠️, CPL-trend ▲▼,
 * end-date-mismatch ⚠️, per-campaign tooltip detail, free-range mode.
 */

export type PacingDismissal = {
  snooze_until: string;
  dismissed_at: string;
  reason: string;
};

/** "emoji name" channel label (legacy channelIcon returned both; the
 *  hub port returns just the emoji). */
const chLabel = (name: string) =>
  `${channelIcon(name) || "●"} ${name}`.trim();

type FadeState = "active" | "dismissed" | "resurfaced";

function ilToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(
    new Date(),
  );
}

function ilDayOf(ts: string): string {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(
    new Date(ms),
  );
}

/** Port of the shared computeFadeState semantics (BudgetGrid /
 *  legacy `_pacingFadeState`): same-IL-day stays dismissed; overnight
 *  passed AND the gap still fires → resurfaced; expired/restored →
 *  active. `local` is this session's optimistic override. */
function fadeStateOf(
  d: PacingDismissal | undefined,
  today: string,
  local: "on" | "off" | undefined,
  gapStillOff: boolean,
): FadeState {
  if (local === "off") return "active";
  if (local === "on") return "dismissed";
  if (!d) return "active";
  if (!d.snooze_until || d.snooze_until < today) return "active";
  const day = d.dismissed_at ? ilDayOf(d.dismissed_at) : "";
  if (day && day < today && gapStillOff) return "resurfaced";
  return "dismissed";
}

type SortKey =
  | "channel"
  | "budget"
  | "spend"
  | "leads"
  | "cpl"
  | "r1"
  | "scheduled"
  | "cps"
  | "r2"
  | "meetings"
  | "cpm"
  | "daily";

const r1Of = (c: ReportChannel) => (c.leads > 0 ? c.scheduled / c.leads : null);
const r2Of = (c: ReportChannel) =>
  c.scheduled > 0 ? c.meetings / c.scheduled : null;

const SORT_VAL: Record<SortKey, (c: ReportChannel) => number | string> = {
  channel: (c) => c.channel.toLowerCase(),
  budget: (c) => c.budget,
  spend: (c) => c.spend,
  leads: (c) => c.leads,
  cpl: (c) => (c.costPerLead > 0 ? c.costPerLead : -1),
  r1: (c) => r1Of(c) ?? -1,
  scheduled: (c) => c.scheduled,
  cps: (c) => (c.costPerScheduled > 0 ? c.costPerScheduled : -1),
  r2: (c) => r2Of(c) ?? -1,
  meetings: (c) => c.meetings,
  cpm: (c) => (c.costPerMeeting > 0 ? c.costPerMeeting : -1),
  daily: (c) => c.dailyRate,
};

const STATUS_DOT: Record<
  ReportChannel["campaignStatus"],
  { cls: string; title: string } | null
> = {
  none: null,
  active: { cls: "is-ok", title: "קמפיין פעיל" },
  paused: { cls: "is-off", title: "קמפיין מושהה" },
  mixed: { cls: "is-mixed", title: "חלק מהקמפיינים מושהים" },
};

function ConvCell({ r }: { r: number | null }) {
  const tone = convTone(r);
  return (
    <td className={`rpt-conv rpt-conv-${tone}`}>
      {r !== null ? `← ${(Math.round(r * 10000) / 100).toString()}%` : "—"}
    </td>
  );
}

function ChannelGantt({
  channels,
  window,
  currentKey,
}: {
  channels: ReportChannel[];
  window: { startIso: string; endIso: string };
  currentKey: string;
}) {
  const ps = Date.parse(window.startIso);
  const pe = Date.parse(window.endIso);
  const span = Math.max(1, pe - ps);
  const pct = (t: number) => Math.max(0, Math.min(100, ((t - ps) / span) * 100));
  const todayMs = Date.parse(ilToday());
  const todayPct = todayMs >= ps && todayMs <= pe ? pct(todayMs) : null;
  const rows = channels.filter((c) => c.startIso && c.endIso);
  if (!rows.length) return null;
  return (
    <div className="rpt-gantt">
      <div className="rpt-gantt-head">
        טווח הפרויקט · {fmtDateHe(window.startIso)} – {fmtDateHe(window.endIso)}
      </div>
      {rows.map((c) => {
        const left = pct(Date.parse(c.startIso));
        const width = Math.max(1.5, pct(Date.parse(c.endIso)) - left);
        const util =
          c.budget > 0
            ? Math.min(100, (c.spend / c.budget) * 100)
            : c.spend > 0
              ? 100
              : 0;
        const over = c.budget > 0 && c.spend > c.budget;
        const cur = c.channel.toLowerCase() === currentKey;
        return (
          <div key={c.channel} className={"rpt-gantt-row" + (cur ? " is-cur" : "")}>
            <span className="rpt-gantt-label" title={c.channel}>
              {chLabel(c.channel)}
            </span>
            <span className="rpt-gantt-track">
              {todayPct !== null && (
                <span
                  className="rpt-gantt-today"
                  style={{ insetInlineStart: `${todayPct}%` }}
                  title="היום"
                />
              )}
              <span
                className={"rpt-gantt-bar" + (over ? " is-over" : "")}
                style={{ insetInlineStart: `${left}%`, width: `${width}%` }}
              >
                <span className="rpt-gantt-fill" style={{ width: `${util}%` }} />
              </span>
            </span>
            <span className="rpt-gantt-meta">
              {fmtDateHe(c.startIso).slice(0, 5)}–{fmtDateHe(c.endIso).slice(0, 5)}{" "}
              · {fmtILS(c.spend)} / {c.budget > 0 ? fmtILS(c.budget) : "—"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function ReportChannelsTab({
  data,
  pacingDismissals,
}: {
  data: ProjectReportData;
  pacingDismissals: Record<string, PacingDismissal>;
}) {
  const isMonth = data.mode === "month";
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [localDismiss, setLocalDismiss] = useState<Record<string, "on" | "off">>(
    {},
  );
  const [ganttFor, setGanttFor] = useState<string | null>(null);
  const today = useMemo(ilToday, []);

  const channels = data.channels;
  const sorted = useMemo(() => {
    if (!sort) return channels;
    const val = SORT_VAL[sort.key];
    return [...channels].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (typeof av === "string" || typeof bv === "string")
        return String(av).localeCompare(String(bv)) * sort.dir;
      return ((av as number) - (bv as number)) * sort.dir;
    });
  }, [channels, sort]);

  if (data.mode === "range") {
    return (
      <div className="rpt-empty">
        פירוט ערוצים בטווח מותאם עדיין לא זמין בדוח החדש — השתמשו בתצוגה
        הקלאסית לטווחים חופשיים.
      </div>
    );
  }
  if (!channels.length) {
    return <div className="rpt-empty">אין שורות ערוצים לפרויקט בתקופה הזו.</div>;
  }

  const alerts = pickChannelAlerts(channels, chLabel);
  const datesIrregular =
    !isMonth &&
    !!data.window.startIso &&
    !!data.window.endIso &&
    channels.some(
      (c) =>
        c.startIso &&
        c.endIso &&
        (c.startIso !== data.window.startIso || c.endIso !== data.window.endIso),
    );

  const totals = channels.reduce(
    (t, c) => {
      t.budget += c.budget;
      t.spend += c.spend;
      t.leads += c.leads;
      t.scheduled += c.scheduled;
      t.meetings += c.meetings;
      t.daily += c.dailyRate;
      return t;
    },
    { budget: 0, spend: 0, leads: 0, scheduled: 0, meetings: 0, daily: 0 },
  );
  const tCpl = totals.leads > 0 ? totals.spend / totals.leads : 0;
  const tCps = totals.scheduled > 0 ? totals.spend / totals.scheduled : 0;
  const tCpm = totals.meetings > 0 ? totals.spend / totals.meetings : 0;
  const tR1 = totals.leads > 0 ? totals.scheduled / totals.leads : null;
  const tR2 = totals.scheduled > 0 ? totals.meetings / totals.scheduled : null;

  const onSort = (key: SortKey) =>
    setSort((cur) =>
      cur?.key === key
        ? { key, dir: cur.dir === 1 ? -1 : 1 }
        : { key, dir: key === "channel" ? 1 : -1 },
    );

  const Th = ({ k, label }: { k: SortKey; label: string }) => (
    <th
      role="button"
      tabIndex={0}
      onClick={() => onSort(k)}
      className={sort?.key === k ? "is-sorted" : undefined}
      title="מיון"
    >
      {label}
      {sort?.key === k ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
    </th>
  );

  const dismissPacing = async (c: ReportChannel, restore: boolean) => {
    const key = pacingChannelKey(data.slug, c.channel);
    setLocalDismiss((cur) => ({ ...cur, [key]: restore ? "off" : "on" }));
    try {
      const res = await fetch("/api/campaigns/budget-dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: data.slug,
          channel: c.channel,
          platform: c.platform,
          baselineDaily: c.configuredDaily ?? 0,
          restore,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      // Roll back the optimistic state on failure.
      setLocalDismiss((cur) => ({ ...cur, [key]: restore ? "on" : "off" }));
    }
  };

  return (
    <div className="rpt-channels">
      {alerts.length > 0 && (
        <div className="rpt-ch-alerts">
          {alerts.map((a, i) => (
            <div key={i} className={`rpt-ch-alert is-${a.type}`}>
              {a.text}
            </div>
          ))}
        </div>
      )}

      {ganttFor !== null && (
        <ChannelGantt
          channels={channels}
          window={data.window}
          currentKey={ganttFor}
        />
      )}

      <div className="rpt-ch-table-wrap">
        <table className="rpt-ch-table">
          <thead>
            <tr>
              <Th k="channel" label="ערוץ" />
              {!isMonth && <Th k="budget" label="תקציב" />}
              <Th k="spend" label="עלות" />
              <Th k="leads" label="לידים" />
              <Th k="cpl" label="עלות לליד" />
              <Th k="r1" label="המרה לתיאום" />
              <Th k="scheduled" label="תיאומים" />
              <Th k="cps" label="עלות לתיאום" />
              <Th k="r2" label="המרה לביצוע" />
              <Th k="meetings" label="ביצועים" />
              <Th k="cpm" label="עלות לביצוע" />
              {!isMonth && <Th k="daily" label="קצב יומי" />}
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => {
              const subs = c.subCampaigns.filter((s) => s.name);
              const dot = STATUS_DOT[c.campaignStatus];
              const chipDiffers =
                datesIrregular &&
                c.startIso &&
                c.endIso &&
                (c.startIso !== data.window.startIso ||
                  c.endIso !== data.window.endIso);
              const pacing = isMonth
                ? null
                : computeChannelPacing(c);
              const gapStillOff =
                pacing?.action === "lower" || pacing?.action === "raise";
              const paceKey = pacingChannelKey(data.slug, c.channel);
              const fade = fadeStateOf(
                pacingDismissals[paceKey],
                today,
                localDismiss[paceKey],
                !!gapStillOff,
              );
              const chKey = c.channel.toLowerCase();
              return (
                <tr key={c.channel}>
                  <td className="rpt-ch-name">
                    <span className="rpt-ch-label">{chLabel(c.channel)}</span>
                    {dot && (
                      <span
                        className={`rpt-ch-dot ${dot.cls}`}
                        title={dot.title}
                      />
                    )}
                    {subs.length > 1 && (
                      <span
                        className="rpt-ch-subs"
                        title={subs
                          .map(
                            (s) =>
                              `${s.name}: ${fmtILS(s.spend)} · ${fmtInt(s.leads)} לידים`,
                          )
                          .join("\n")}
                      >
                        ({subs.length})
                      </span>
                    )}
                    {chipDiffers && (
                      <button
                        type="button"
                        className={
                          "rpt-ch-datechip" +
                          (ganttFor === chKey ? " is-open" : "")
                        }
                        title="חלון התאריכים של הערוץ — לחצו לתרשים"
                        onClick={() =>
                          setGanttFor((cur) => (cur === chKey ? null : chKey))
                        }
                      >
                        📅 {fmtDateHe(c.startIso).slice(0, 5)}–
                        {fmtDateHe(c.endIso).slice(0, 5)}
                      </button>
                    )}
                  </td>
                  {!isMonth && <td>{fmtILS(c.budget)}</td>}
                  <td>{fmtILS(c.spend)}</td>
                  <td>{fmtInt(c.leads)}</td>
                  <td style={costHeatStyle("costPerLead", c.costPerLead)}>
                    {c.costPerLead > 0 ? fmtILS(c.costPerLead) : "—"}
                  </td>
                  <ConvCell r={r1Of(c)} />
                  <td>{fmtInt(c.scheduled)}</td>
                  <td
                    style={costHeatStyle("costPerScheduled", c.costPerScheduled)}
                  >
                    {c.costPerScheduled > 0 ? fmtILS(c.costPerScheduled) : "—"}
                  </td>
                  <ConvCell r={r2Of(c)} />
                  <td>{fmtInt(c.meetings)}</td>
                  <td style={costHeatStyle("costPerMeeting", c.costPerMeeting)}>
                    {c.costPerMeeting > 0 ? fmtILS(c.costPerMeeting) : "—"}
                  </td>
                  {!isMonth && (
                    <td
                      className={
                        "rpt-pace" +
                        (pacing?.cls ? ` ${pacing.cls}` : "") +
                        (fade === "dismissed" ? " is-handled" : "")
                      }
                      title={pacing?.lines.join("\n") || undefined}
                    >
                      {fade === "dismissed" && (
                        <span className="rpt-pace-mark" title="טופל">
                          ✓
                        </span>
                      )}
                      {gapStillOff && fade !== "dismissed" && (
                        <span
                          className="rpt-pace-alert"
                          title="התקציב היומי בפלטפורמה לא תואם את הנדרש — נדרש עדכון"
                        >
                          ⚠️
                        </span>
                      )}
                      <span className="rpt-pace-num">
                        {c.dailyRate ? fmtILS(c.dailyRate) : "—"}
                      </span>
                      {pacing?.action === "lower" && (
                        <span aria-label="הורד תקציב"> ⬇</span>
                      )}
                      {pacing?.action === "raise" && (
                        <span aria-label="העלה תקציב"> ⬆</span>
                      )}
                      {pacing?.action === "investigate" && (
                        <span aria-label="בדוק delivery"> 🔍</span>
                      )}
                      {gapStillOff && fade !== "dismissed" && (
                        <button
                          type="button"
                          className="rpt-pace-btn"
                          title="טיפלתי — שקט עד מחר; אם עדיין יישאר פער בין התקציב המוגדר לנדרש, ההתראה תחזור מחר"
                          onClick={() => dismissPacing(c, false)}
                        >
                          ✓{fade === "resurfaced" ? " (חזר)" : ""}
                        </button>
                      )}
                      {fade === "dismissed" && (
                        <button
                          type="button"
                          className="rpt-pace-btn"
                          title="בטל טיפול"
                          onClick={() => dismissPacing(c, true)}
                        >
                          ↩︎
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
            <tr className="rpt-ch-totals">
              <td>
                <b>סה״כ</b>
              </td>
              {!isMonth && (
                <td>
                  <b>{fmtILS(totals.budget)}</b>
                </td>
              )}
              <td>
                <b>{fmtILS(totals.spend)}</b>
              </td>
              <td>
                <b>{fmtInt(totals.leads)}</b>
              </td>
              <td style={costHeatStyle("costPerLead", tCpl)}>
                <b>{tCpl > 0 ? fmtILS(tCpl) : "—"}</b>
              </td>
              <ConvCell r={tR1} />
              <td>
                <b>{fmtInt(totals.scheduled)}</b>
              </td>
              <td style={costHeatStyle("costPerScheduled", tCps)}>
                <b>{tCps > 0 ? fmtILS(tCps) : "—"}</b>
              </td>
              <ConvCell r={tR2} />
              <td>
                <b>{fmtInt(totals.meetings)}</b>
              </td>
              <td style={costHeatStyle("costPerMeeting", tCpm)}>
                <b>{tCpm > 0 ? fmtILS(tCpm) : "—"}</b>
              </td>
              {!isMonth && (
                <td>
                  <b>{totals.daily ? fmtILS(totals.daily) : "—"}</b>
                </td>
              )}
            </tr>
          </tbody>
        </table>
      </div>

      <ReportChannelCharts channels={channels} />
    </div>
  );
}
