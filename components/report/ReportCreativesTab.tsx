"use client";

import { useState, type ReactNode } from "react";
import ReportMediaSection, {
  PlatformKpiBand,
} from "@/components/report/ReportMediaSection";
import AdHistoryPopover from "@/components/report/AdHistoryPopover";
import AdSetZoneMap from "@/components/report/AdSetZoneMap";
import {
  fbStatusInfo,
  fmtInt,
  fmtILS,
  fmtPct2,
  fmtDateHe,
  type ProjectReportData,
  type ReportAdDaily,
  type ReportFbAd,
  type ReportFbAdSet,
} from "@/lib/reportShared";

/**
 * קריאייטיבים tab — native rebuild of the legacy 🎨 creatives section
 * (renderCreativeSection, Index.html:7630): FB KPI strip, ad-card grid
 * (image→thumb→placeholder fallback chain, status pills, 🏆 winner,
 * fatigue badges, ad copy, CRM meetings row, hover trendline), ad-set
 * list, Google RSA assets by campaign, and the top-keywords table.
 */

/** image → thumb → placeholder chain. fbcdn URLs are signed and expire,
 *  and cdninstagram frequently 403s on hotlink — the onError fallback is
 *  load-bearing (legacy v562/v563). */
function FbAdImage({
  ad,
  landing = "",
}: {
  ad: ReportFbAd;
  /** Landing page. Wraps the IMAGE only — a dead card offers a link to the
   *  creative instead, and an anchor inside an anchor is invalid HTML that
   *  swallows the inner one. */
  landing?: string;
}) {
  const primary = ad.image || ad.thumb;
  const fallback = ad.thumb && ad.thumb !== primary ? ad.thumb : "";
  const [src, setSrc] = useState(primary);
  const [dead, setDead] = useState(!primary);
  if (dead) {
    // A dead image is not a dead ad, and on VIDEO creatives it is the normal
    // case rather than a fault. Meta hands the warehouse two URL forms: the
    // stable "facebook.com/ads/image/?d=…" and the signed
    // "scontent-*.fbcdn.net/…" whose signature expires within days. Image
    // creatives get the stable one and keep rendering; a video creative's
    // image_url IS the signed thumbnail, so BOTH it and the thumbnail
    // fallback are the same expiring URL and both come back 403 — measured on
    // אחוזת אפרידר, where the one card that renders is the only `image` row and
    // the three blanks are all `video`.
    //
    // Nothing here can re-sign that URL, and this state no longer carries a
    // link of its own. It used to, because the links row below had none to
    // give — `url` comes from the assets tab, which is empty. That row now
    // falls back to the same preview URL on every card, so repeating it here
    // would put one link twice on the card that can least afford clutter.
    return (
      <div className="rpt-cr-noimg">
        <span className="rpt-cr-noimg-icon" aria-hidden>
          🖼
        </span>
        <span className="rpt-cr-noimg-label">אין תצוגה</span>
      </div>
    );
  }
  const body = (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={ad.ad}
        loading="lazy"
        onError={() => {
          if (fallback && src !== fallback) setSrc(fallback);
          else setDead(true);
        }}
      />
      {/* Provenance, only on the fallback path. The warehouse holds a creative
          long after it stops running, so the image can be older than the
          numbers beside it — say so rather than let it pass as live. */}
      {ad.imageFromWarehouse && (
        <span
          className="rpt-cr-whimg"
          title={
            "התמונה נטענה ממאגר הנתונים (Supabase) ולא מגיליון הקריאייטיבים — " +
            "הגיליון ריק כרגע." +
            (ad.imageLastSeen ? ` הופעה אחרונה של הקריאייטיב: ${ad.imageLastSeen}.` : "")
          }
        >
          🗄️
        </span>
      )}
    </>
  );
  return landing ? (
    <a href={landing} target="_blank" rel="noopener noreferrer">
      {body}
    </a>
  ) : (
    body
  );
}

/**
 * Demand Gen asset image.
 *
 * Exists for the onError branch the DG grid was missing. These are served from
 * `tpc.googlesyndication.com` — a Google ad-serving host that ad blockers block
 * by default — so for anyone running one, the request never leaves the browser
 * and the figure rendered as blank space above a caption, which reads as a
 * broken report rather than a blocked request. The URLs themselves are healthy
 * (verified 2026-08-13: HTTP 200, real JPEG/PNG bytes), and the hub sends no
 * CSP, so when these don't appear it is the viewer's extension, not us.
 *
 * Same discipline as FbAdImage, which has had a fallback chain since v562.
 */
function DgAssetImage({ src, alt }: { src: string; alt: string }) {
  const [dead, setDead] = useState(false);
  if (dead) {
    return (
      <div
        className="rpt-cr-dgnoimg"
        title="התמונה מתארחת ב-tpc.googlesyndication.com — דומיין שחוסמי פרסומות חוסמים כברירת מחדל. אם מותקן לך חוסם, זו כנראה הסיבה."
      >
        🚫 נחסמה
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setDead(true)}
    />
  );
}

/** Meta ad-preview links (`כל מודעות פפיסבוק`, 365-day window — the assets
 *  tab only reaches 60, so most cards showing 📷 אין תצוגה still have one).
 *
 *  No role check here on purpose: `previews` is stripped from the payload for
 *  client viewers in NativeProjectRail, so the field being present IS the
 *  permission. The link needs a Business Manager session on the ad account to
 *  resolve — a client would land on a Facebook error page.
 *
 *  One row per creative, so an ad name fronting several creatives gets one
 *  link each: the card shows a single ad name but Meta ran more than one
 *  image behind it. */
function AdPreviewLinks({ previews }: { previews?: string[] }) {
  if (!previews?.length) return null;
  const single = previews.length === 1;
  return (
    <div className="rpt-cr-previews">
      {previews.map((url, i) => (
        <a
          key={url}
          className="rpt-cr-preview"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title={
            single
              ? "פתיחת תצוגת המודעה בפייסבוק (דורש חיבור ל-Business Manager)"
              : `גרסה ${i + 1} מתוך ${previews.length} שרצו תחת שם המודעה הזה`
          }
        >
          {/* 🖼 not 👁️ — the links row already has "👁️ תצוגת מודעה", which is
              the promoted POST (public). This one renders the creative as it
              appeared in feed, and is the only route to it once the 60-day
              assets window has dropped the image. */}
          🖼 {single ? "קריאייטיב" : `גרסה ${i + 1}`}
        </a>
      ))}
    </div>
  );
}

/** Hover trendline (legacy _buildAdTrendlinePopover_): dense calendar
 *  days over the report window clamped to the last date with data; two
 *  sparklines — cost --teal, leads --violet. Through the tokens rather
 *  than the literals they used to name, so a skin can restyle them; both
 *  vars default to exactly those two hex values, so the default look is
 *  unchanged. */
function AdTrend({
  title,
  daily,
  window,
  /** Which shell to wear. The default is the absolutely-positioned hover
   *  popover the ad cards use; the ad-set panel passes its own class to drop
   *  the sparklines INTO a bigger card instead of floating a second one over
   *  the first. Same markup either way, so the two cannot drift. */
  className = "rpt-cr-trend",
}: {
  title: string;
  daily: ReportAdDaily[];
  window: { startIso: string; endIso: string };
  className?: string;
}) {
  if (!daily.length) return null;
  const dataLast = daily[daily.length - 1].date;
  const from = window.startIso || daily[0].date;
  const to = window.endIso && window.endIso < dataLast ? window.endIso : dataLast;
  if (!from || !to || from > to) return null;
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const days: ReportAdDaily[] = [];
  let d = from;
  let guard = 0;
  while (d <= to && guard++ < 400) {
    days.push(byDate.get(d) ?? { date: d, cost: 0, leads: 0 });
    const [y, m, dd] = d.split("-").map(Number);
    const nx = new Date(Date.UTC(y, m - 1, dd + 1));
    d = nx.toISOString().slice(0, 10);
  }
  if (days.length < 2) return null;
  const W = 240;
  const H = 42;
  const PAD = 2;
  const line = (get: (p: ReportAdDaily) => number) => {
    const max = Math.max(...days.map(get), 1);
    return days
      .map((p, i) => {
        const x = PAD + (i / (days.length - 1)) * (W - PAD * 2);
        const y = H - PAD - (get(p) / max) * (H - PAD * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  };
  const totalCost = days.reduce((s, p) => s + p.cost, 0);
  const totalLeads = days.reduce((s, p) => s + p.leads, 0);
  return (
    <div className={className} aria-hidden>
      <div className="rpt-cr-trend-head">
        {title} · {fmtDateHe(from).slice(0, 5)} ← {fmtDateHe(to).slice(0, 5)}
      </div>
      <div className="rpt-cr-trend-row">
        <span style={{ color: "var(--teal)" }}>{fmtILS(totalCost)}</span>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
          <polyline points={line((p) => p.cost)} fill="none" style={{ stroke: "var(--teal)" }} strokeWidth={1.6} />
        </svg>
      </div>
      <div className="rpt-cr-trend-row">
        <span style={{ color: "var(--violet)" }}>{fmtInt(totalLeads)} לידים</span>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
          <polyline points={line((p) => p.leads)} fill="none" style={{ stroke: "var(--violet)" }} strokeWidth={1.6} />
        </svg>
      </div>
    </div>
  );
}

function CrmRow({
  crmLeads,
  scheduled,
  held,
  costPerSched,
  costPerHeld,
  groupLevel = false,
}: {
  crmLeads: number;
  scheduled: number;
  held: number;
  costPerSched: number;
  costPerHeld: number;
  /** These counts cover every format variant of this creative, not just this
   *  card — the CRM can't tell Video/Static/Carousel apart. Say so rather
   *  than letting the number read as this one ad's. */
  groupLevel?: boolean;
}) {
  if (!crmLeads && !scheduled && !held) return null;
  return (
    <div
      className="rpt-cr-stats rpt-cr-stats-crm"
      title={
        groupLevel
          ? "לידים, תואמו ובוצעו מה-CRM עבור הקריאייטיב כולו — כל הווריאציות (Video / Static / Carousel) יחד. ה-CRM לא מבדיל ביניהן, ולכן הנתון מוצג פעם אחת ולא על כל וריאציה"
          : "לידים, תואמו ובוצעו מה-CRM שמקורם בקריאייטיב זה — כולל עלות לתיאום ולביצוע"
      }
    >
      <div className="rpt-cr-stat">
        <span className="rpt-cr-stat-l">לידים</span>
        <span className="rpt-cr-stat-v" style={{ color: "#6366f1" }}>
          {fmtInt(crmLeads)}
        </span>
      </div>
      {/* count and ₪-per stack rather than sharing one line: at three columns
          in a ~215px card a inline "1 · ₪1,964" is wider than its 1fr share,
          and the card is overflow:hidden so it got clipped rather than
          wrapped. The clipping fix pushed these figures UP, which is what
          made a latent squeeze visible. */}
      <div className="rpt-cr-stat">
        <span className="rpt-cr-stat-l">תואמו</span>
        <span className="rpt-cr-stat-v" style={{ color: "#ec4899" }}>
          {fmtInt(scheduled)}
        </span>
        {costPerSched > 0 && (
          <span className="rpt-cr-stat-sub" style={{ color: "#ec4899" }}>
            {fmtILS(costPerSched)}
          </span>
        )}
      </div>
      <div className="rpt-cr-stat">
        <span className="rpt-cr-stat-l">בוצעו</span>
        <span className="rpt-cr-stat-v" style={{ color: "#f5576c" }}>
          {fmtInt(held)}
        </span>
        {costPerHeld > 0 && (
          <span className="rpt-cr-stat-sub" style={{ color: "#f5576c" }}>
            {fmtILS(costPerHeld)}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The one-line audience summary under an ad set's name: age range, then the
 * geographic zones, joined with the same separator the rest of the tab uses.
 *
 * Kept to ONE line and truncated in CSS because the ad-set grid is
 * minmax(260px) and its rows equalise height — a five-zone ad set would
 * otherwise stretch every card beside it. The full list lives in the
 * tooltip, which is where the detail belongs.
 */
/** 65 is Meta's open-ended top bucket, and the ads manager itself renders it
 *  "65+". Shared by the line and its tooltip so the two cannot drift. */
function ageRangeOf(s: ReportFbAdSet): string {
  if (!s.targetAgeMin && !s.targetAgeMax) return "";
  const hi = s.targetAgeMax && s.targetAgeMax >= 65 ? "65+" : String(s.targetAgeMax || "?");
  return `${s.targetAgeMin || "?"}–${hi}`;
}

function adSetAudience(s: ReportFbAdSet): string {
  const bits: string[] = [];
  const age = ageRangeOf(s);
  if (age) bits.push(age);
  if (s.targetZones?.length) bits.push(s.targetZones.join(" · "));
  return bits.join(" · ");
}

function adSetAudienceTitle(s: ReportFbAdSet): string {
  const lines: string[] = [];
  if (s.targetAgeMin || s.targetAgeMax) {
    lines.push(`גילאים ${s.targetAgeMin || "?"}–${s.targetAgeMax || "?"}`);
  }
  if (s.targetZones?.length) lines.push(`אזורים: ${s.targetZones.join(", ")}`);
  // home = lives there, recent = was there lately. Meta's default is both,
  // and the difference is the whole question on a 1-mile pin.
  if (s.targetLocTypes?.length) {
    const he = s.targetLocTypes
      .map((t) => (t === "home" ? "תושבי האזור" : t === "recent" ? "מי שהיה שם לאחרונה" : t))
      .join(" + ");
    lines.push(`נוכחות: ${he}`);
  }
  if (s.targetAmbiguous) {
    lines.push(
      "שימו לב: הכרטיס הזה מאחד כמה קהלים בעלי אותו שם עם טירגוט שונה — המוצג הוא של הקהל הפעיל, ולא בהכרח של כולם.",
    );
  }
  lines.push("נמשך מפייסבוק בסנכרון הלילי.");
  return lines.join("\n");
}
/* Kept as the aim line's own tooltip: the rich panel needs a hover, and a
   touch device never sends one. On a phone the line is all there is. */

/**
 * The whole ad set, on hover: who it targeted, where, what it cost and what
 * the CRM did with the leads.
 *
 * ONE PANEL, not several. The card already had a hover trendline, and the
 * targeting map arrived as a second popover on the line above it — two
 * floating panels racing to cover the same card, each holding a third of the
 * story. A reader asking "why is this audience expensive" wants the age, the
 * radius, the spend curve and the meeting count in one glance, so they are in
 * one place, in that order: who → where → how it went.
 *
 * Pure CSS hover, no state: the panel is in the DOM and the card's :hover
 * reveals it. Nothing to fetch, nothing to time, and it works on keyboard
 * focus for free.
 */
function AdSetHoverCard({
  s,
  window,
}: {
  s: ReportFbAdSet;
  window: { startIso: string; endIso: string };
}) {
  const zones = s.targetZones ?? [];
  const pts = s.targetZonePoints ?? [];
  const hasMap = pts.some(Boolean);
  const crm = s.crmLeads > 0 || s.scheduled > 0 || s.held > 0;
  const loc = (s.targetLocTypes ?? [])
    .map((t) => (t === "home" ? "תושבי האזור" : t === "recent" ? "מי שהיה שם לאחרונה" : t))
    .join(" + ");

  return (
    <div className="rpt-cr-adset-pop">
      <div className="rpt-cr-adset-pop-head">{s.name}</div>

      {(adSetAudience(s) || loc) && (
        <div className="rpt-cr-adset-pop-sec">
          <div className="rpt-cr-adset-pop-lbl">קהל</div>
          <div className="rpt-cr-adset-pop-val">
            <bdi>{ageRangeOf(s) || "—"}</bdi>
            {s.targetGenders && (
              <> · {s.targetGenders === "male" ? "גברים" : "נשים"}</>
            )}
            {loc && <> · {loc}</>}
          </div>
        </div>
      )}

      {zones.length > 0 && (
        <div className="rpt-cr-adset-pop-sec">
          <div className="rpt-cr-adset-pop-lbl">מיקום</div>
          <div className="rpt-cr-adset-pop-val">{zones.join(" · ")}</div>
        </div>
      )}

      {hasMap && (
        <>
          <AdSetZoneMap
            zones={zones.map((label, i) => ({ label, point: pts[i] ?? null }))}
          />
          {/* Said out loud rather than left to be inferred: the road lines are
              drawn from a few waypoints, not from a road dataset. Good enough
              to tell which side of a highway the circle is on, and no more. */}
          <div className="rpt-cr-zonemap-note">
            העיגול הוא רדיוס הטירגוט בפועל · הכבישים סכמטיים
          </div>
        </>
      )}

      {/* The same sparklines the card used to float on its own, now sitting
          inside instead of over. */}
      <AdTrend
        title="השקעה ולידים"
        daily={s.daily}
        window={window}
        className="rpt-cr-adset-pop-trend"
      />

      <div className="rpt-cr-adset-pop-grid">
        <span>
          עלות <b>{fmtILS(s.cost)}</b>
        </span>
        <span>
          לידים <b>{fmtInt(s.leads)}</b>
        </span>
        <span>
          CPL <b>{s.cpl > 0 ? fmtILS(s.cpl) : "—"}</b>
        </span>
      </div>

      {crm && (
        <div className="rpt-cr-adset-pop-grid is-crm">
          <span style={{ color: "#6366f1" }}>
            לידים ב-CRM <b>{fmtInt(s.crmLeads)}</b>
          </span>
          <span style={{ color: "#ec4899" }}>
            תואמו <b>{fmtInt(s.scheduled)}</b>
            {s.costPerSched > 0 && ` (${fmtILS(s.costPerSched)})`}
          </span>
          <span style={{ color: "#f5576c" }}>
            בוצעו <b>{fmtInt(s.held)}</b>
            {s.costPerHeld > 0 && ` (${fmtILS(s.costPerHeld)})`}
          </span>
        </div>
      )}

      {s.targetAmbiguous && (
        <div className="rpt-cr-adset-pop-note">
          ⚠️ הכרטיס מאחד כמה קהלים בעלי אותו שם עם טירגוט שונה. המוצג הוא של
          הקהל הפעיל.
        </div>
      )}
    </div>
  );
}

export default function ReportCreativesTab({
  data,
  showPreviews = false,
  fbNode = null,
}: {
  data: ProjectReportData;
  /** The Facebook/Meta UTM breakdown ("פילוח פייסבוק"). Rendered HERE, at
   *  the end of the Facebook run and before the Google bands, rather than
   *  appended after the whole tab — where it sat below the Google keyword
   *  table, three Google blocks away from the Facebook data it breaks down.
   *  Passed in rather than built here because it is a server component
   *  (CrmFunnelCard) and this tab is a client one. */
  fbNode?: ReactNode;
  /** Render the Meta ad-preview links on each card.
   *
   *  OFF by default, and deliberately opt-in per project rather than "show
   *  them whenever we have them". On a normal project the assets tab's 60-day
   *  window covers the campaigns you're actually looking at, so the creative
   *  is already on the card — the links add nothing and a six-variant ad turns
   *  into six chips of clutter over an image you can see perfectly well.
   *
   *  They earn their place only where the creative CAN'T be shown: דיגיתל שלי
   *  runs in bursts around municipal dates, so most of its ads aged out of
   *  that window and the card has no image at all. NativeProjectRail passes
   *  this for media-workbook projects only. */
  showPreviews?: boolean;
}) {
  /* Ads pulled live from Meta by the רענון button — see the handler below
     and lib/fbNewAds.ts. Declared before the `!c` early return because hooks
     cannot sit after one. An overlay rather than a replacement: the server's
     cards stay exactly as rendered and these are prepended, so a page reload
     (which will eventually carry them for real, once the feeds catch up)
     simply drops the overlay. Same shape as ReportChannelsTab's budgetEdits. */
  const [liveAds, setLiveAds] = useState<ReportFbAd[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState("");

  const c = data.creatives;
  if (!c) {
    return (
      <div className="rpt-creatives">
        <ReportMediaSection data={data} />
        <div className="rpt-empty">
          אין נתוני קריאייטיבים לפרויקט בתקופה הזו (חשבון הפרסום אינו ברשימת
          ה-Supermetrics, או שאין פעילות בטווח).
        </div>
        {/* Still shown when there are no creatives: the UTM breakdown comes
            from the CRM warehouse, not the ad-assets feed, so it can be the
            only Facebook detail a project has. */}
        {fbNode}
      </div>
    );
  }
  const { fb, google } = c;
  const ap = data.adPlatform;
  const prevAp = data.prevAdPlatform;
  const googleActiveAds = google.ads.filter(
    (a) => a.status === "Enabled",
  ).length;

  /* The cards the page is already showing, keyed the way lib/reportCreatives
     keys them, so the server can tell us only what is genuinely NEW and the
     count in the note means what it says. */
  const knownKeys = [...fb.topAds, ...liveAds].map((a) =>
    `${a.campaign}|${a.ad}`.toLowerCase(),
  );

  async function refreshNewAds() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshNote("");
    try {
      const res = await fetch("/api/report/fb-new-ads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: data.project, knownKeys }),
      });
      const j = (await res.json()) as {
        ok?: boolean;
        ads?: ReportFbAd[];
        hours?: number;
        sweptAll?: boolean;
        failed?: { accountId: string }[];
        error?: string;
      };
      if (!res.ok || !j.ok) {
        setRefreshNote(
          j.error === "too-soon"
            ? "רגע אחד — נסו שוב בעוד כמה שניות"
            : "לא הצלחנו לבדוק מול פייסבוק כרגע",
        );
        return;
      }
      const found = j.ads ?? [];
      if (found.length) setLiveAds((prev) => [...found, ...prev]);
      // A partial answer must not read as a whole one: if an account errored
      // we cannot claim there is nothing new, only that we found nothing.
      const partial = (j.failed?.length ?? 0) > 0;
      const days = Math.round((j.hours ?? 72) / 24);
      setRefreshNote(
        found.length
          ? `נמצאו ${found.length} מודעות חדשות`
          : partial
            ? "חלק מחשבונות המודעות לא ענו — נסו שוב"
            : `אין מודעות חדשות מ-${days} הימים האחרונים`,
      );
    } catch {
      setRefreshNote("לא הצלחנו לבדוק מול פייסבוק כרגע");
    } finally {
      setRefreshing(false);
    }
  }

  /* Live cards first: the ad someone just launched is the one they opened
     the page to look at. They carry no numbers, so they cannot distort the
     ranking of the cards that do. */
  const fbCards = [...liveAds, ...fb.topAds];

  return (
    <div className="rpt-creatives">
      <ReportMediaSection data={data} />
      {/* Facebook funnel summary — the rich per-platform band (impressions →
          clicks → CTR/CPC → לידים → CPL + rates, with prev-window deltas),
          replacing the old flat FB strip. */}
      <PlatformKpiBand
        plat="facebook"
        totals={ap.facebook}
        prev={prevAp?.facebook ?? null}
        activeAds={fb.adCount}
      />

      {fbCards.length > 0 && (
        <>
          {/* The refresh lives on this header rather than beside the tab
              because it acts on exactly what sits under it. Note that a
              project with no FB cards at all shows no header and therefore
              no button — the feeds have never carried it, so there is
              nothing to compare a live pull against. */}
          <div className="rpt-cr-titlerow">
            <h3 className="rpt-cr-title">🎨 מודעות פייסבוק</h3>
            <button
              type="button"
              className="rpt-cr-refresh"
              onClick={refreshNewAds}
              disabled={refreshing}
              title="בודק מול פייסבוק אילו מודעות עלו בימים האחרונים ועדיין לא הופיעו כאן. הנתונים בדוח מתעדכנים פעם ביום, אז מודעה שעלתה היום עוד לא בפנים."
            >
              {refreshing ? "בודק…" : "🔄 מודעות שעלו עכשיו"}
            </button>
            {refreshNote && (
              <span className="rpt-cr-refresh-note">{refreshNote}</span>
            )}
          </div>
          <div className="rpt-cr-grid">
            {fbCards.map((a) => {
              const status = fbStatusInfo(a.status);
              const isActive = String(a.status).toUpperCase().trim() === "ACTIVE";
              const landing = a.destUrl || a.url || "";
              return (
                <div
                  key={`${a.campaign}|${a.ad}`}
                  className={
                    "rpt-cr-card" +
                    (a.isWinner ? " is-winner" : "") +
                    (a.fatigued ? " is-fatigued" : "") +
                    (a.liveCreatedIso ? " is-live" : "") +
                    (isActive ? "" : " is-paused")
                  }
                >
                  {a.liveCreatedIso && (
                    <div
                      className="rpt-cr-badge rpt-cr-badge-new"
                      title={`נמשכה עכשיו ישירות מפייסבוק — עלתה ב-${fmtDateHe(a.liveCreatedIso)}. עוד אין לה נתונים בדוח: הפידים מתעדכנים פעם ביום.`}
                    >
                      ✨ עלתה {fmtDateHe(a.liveCreatedIso)}
                    </div>
                  )}
                  {a.isWinner && (
                    <div className="rpt-cr-badge rpt-cr-badge-win">🏆 הכי משתלם</div>
                  )}
                  {a.fatigued && a.fatigueReason === "declining" && (
                    <div
                      className="rpt-cr-badge rpt-cr-badge-fatigue"
                      title={`CTR ירד מ-${fmtPct2(a.ctrEarly)} ל-${fmtPct2(a.ctrRecent)} — המודעה פעילה ${a.ageDays} ימים`}
                    >
                      ⚠️ CTR יורד
                    </div>
                  )}
                  {a.fatigued && a.fatigueReason === "long" && (
                    <div
                      className="rpt-cr-badge rpt-cr-badge-fatigue"
                      title={`המודעה פעילה ${a.ageDays} ימים`}
                    >
                      ⏳ שקלו לרענן
                    </div>
                  )}
                  <div className="rpt-cr-thumb">
                    <FbAdImage ad={a} landing={landing} />
                    {status.label && (
                      <span
                        className={`rpt-cr-status is-${status.cls}`}
                        title={
                          a.statusFromWarehouse
                            ? `${a.status} — נקרא ממאגר הנתונים (Supabase), לא מגיליון הקריאייטיבים. ` +
                              `זהו הסטטוס האפקטיבי: הוא מביא בחשבון גם קמפיין או קהל מושהים, ולא רק את מצב המודעה עצמה.`
                            : a.statusFromMeta
                              ? `${a.status} — נמשך ישירות מפייסבוק בסנכרון הלילי. ` +
                                `זהו הסטטוס האפקטיבי: הוא מביא בחשבון גם קמפיין או קהל מושהים, ולא רק את מצב המודעה עצמה.`
                              : a.status
                        }
                      >
                        {status.label}
                      </span>
                    )}
                    {/* Only the EXTRA versions: the first preview is now the
                        links row's תצוגת מודעה, so listing it here again
                        would put the same URL on the card twice. */}
                    {showPreviews && (a.previews?.length ?? 0) > 1 && (
                      <AdPreviewLinks previews={a.previews} />
                    )}
                  </div>
                  <div className="rpt-cr-body">
                    <div className="rpt-cr-name" title={a.ad}>
                      {a.ad}
                    </div>
                    <div className="rpt-cr-campaign" title={a.campaign}>
                      {a.campaign}
                    </div>
                    {a.title && (
                      <div className="rpt-cr-adtitle" title={a.title}>
                        {a.title}
                      </div>
                    )}
                    {!a.fatigued && a.ageDays >= 14 && (
                      <div
                        className="rpt-cr-age"
                        // Paused ads reach this chip now that "שקלו לרענן"
                        // is gated on still running, so the tooltip can't
                        // keep claiming the ad is active.
                        title={
                          isActive
                            ? `מודעה פעילה ${a.ageDays} ימים`
                            : `המודעה רצה ${a.ageDays} ימים`
                        }
                      >
                        📅 {a.ageDays} ימים
                      </div>
                    )}
                    {a.body && (
                      <details className="rpt-cr-copy">
                        <summary>📝 טקסט המודעה</summary>
                        <div className="rpt-cr-copy-text">{a.body}</div>
                      </details>
                    )}
                    {/* An archive card: the creative outlived its metrics.
                        Every figure would be a zero meaning "not measured in
                        this window", which reads as "spent nothing" — so say
                        the true thing instead of drawing an empty grid. */}
                    {a.unmappedCampaign && (
                      <div
                        className="rpt-cr-unmapped"
                        title="שם הקמפיין הזה לא תואם לאף תבנית ב-campaign ID בגיליון Keys. המודעה רצה בחשבון של הפרויקט, אבל כל שאר הדוח לא יספור אותה עד שהקמפיין ימופה."
                      >
                        ⚠️ קמפיין לא ממופה ל-Keys
                      </div>
                    )}
                    {a.noWindowData ? (
                      <div
                        className="rpt-cr-nodata"
                        title={
                          a.liveCreatedIso
                            ? "המודעה עלתה זה עתה. הנתונים בדוח מגיעים מפידים שמתעדכנים פעם ביום, אז עלות, חשיפות ולידים יופיעו כאן בעדכון הבא."
                            : "הקריאייטיב נשמר בארכיון של 365 יום, אבל הקמפיין רץ לפני תחילת חלון הנתונים של הדוח — אין לו עלות או חשיפות למדוד"
                        }
                      >
                        {a.liveCreatedIso ? "טרם נצברו נתונים" : "אין נתונים בטווח"}
                      </div>
                    ) : (
                      <>
                        <div className="rpt-cr-stats">
                          <div className="rpt-cr-stat">
                            <span className="rpt-cr-stat-l">עלות</span>
                            <span className="rpt-cr-stat-v">{fmtILS(a.cost)}</span>
                          </div>
                          <div className="rpt-cr-stat">
                            <span className="rpt-cr-stat-l">לידים</span>
                            <span className="rpt-cr-stat-v">{fmtInt(a.leads)}</span>
                          </div>
                          <div className="rpt-cr-stat">
                            <span className="rpt-cr-stat-l">CPL</span>
                            <span className="rpt-cr-stat-v">
                              {a.cpl > 0 ? fmtILS(a.cpl) : "—"}
                            </span>
                          </div>
                        </div>
                        {(a.impressions > 0 || a.clicks > 0) && (
                          <div className="rpt-cr-stats rpt-cr-stats-sec">
                            <div className="rpt-cr-stat">
                              <span className="rpt-cr-stat-l">חשיפות</span>
                              <span className="rpt-cr-stat-v">{fmtInt(a.impressions)}</span>
                            </div>
                            <div className="rpt-cr-stat">
                              <span className="rpt-cr-stat-l">קליקים</span>
                              <span className="rpt-cr-stat-v">{fmtInt(a.clicks)}</span>
                            </div>
                            <div className="rpt-cr-stat">
                              <span className="rpt-cr-stat-l">CTR</span>
                              <span className="rpt-cr-stat-v">
                                {a.ctr > 0 ? fmtPct2(a.ctr) : "—"}
                              </span>
                            </div>
                          </div>
                        )}
                        <CrmRow
                          crmLeads={a.crmLeads}
                          scheduled={a.scheduled}
                          held={a.held}
                          costPerSched={a.costPerSched}
                          costPerHeld={a.costPerHeld}
                          groupLevel={a.meetingsAtGroupLevel}
                        />
                      </>
                    )}
                  </div>
                  {/* Wrapper exists purely to give AdTrend something to sit on
                      top of. The trend overlay used to hang off the CARD at a
                      fixed `bottom`, which assumed the links row was one line —
                      the moment it wrapped (דף נחיתה + תצוגת מודעה, then
                      היסטוריה) the panel covered the first line. Anchored to
                      this wrapper it clears the row at any height. */}
                  <div className="rpt-cr-foot">
                    <div className="rpt-cr-links">
                      {landing && (
                        <a href={landing} target="_blank" rel="noopener noreferrer">
                          🔗 דף נחיתה
                        </a>
                      )}
                      {/* `url` is the assets tab's "Link to promoted post",
                          and that tab has been empty since its Supermetrics
                          query broke — so this link, which was on every card,
                          silently disappeared from all of them. The preview
                          tab (`כל מודעות פפיסבוק`, 8,524 live URLs) carries a
                          working preview for the same ad, so it stands in.
                          Second-choice on purpose: the promoted post is the
                          real thing, the preview is a rendering of it. */}
                      {(a.url || a.previews?.[0]) && (
                        <a
                          href={a.url || a.previews![0]}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={
                            a.url
                              ? "פתח את הפוסט המקודם בפייסבוק"
                              : "פתח תצוגה מקדימה של המודעה (דורש חיבור ל-Business Manager)"
                          }
                        >
                          👁️ תצוגת מודעה
                        </a>
                      )}
                      {/* In the links row rather than the card body: it is one
                          of the card's three ways out, so it belongs with the
                          other two instead of as a stray pill above them.

                          Still deliberately OUTSIDE CrmRow — that returns null
                          when the in-window CRM figures are all zero, i.e.
                          exactly the paused/old cards whose history is most
                          worth reading. */}
                      {a.history && (
                        <AdHistoryPopover ad={a.ad} history={a.history} />
                      )}
                    </div>
                    <AdTrend title={a.ad} daily={a.daily} window={data.window} />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {fb.topAdSets.length > 0 && (
        <>
          <h3 className="rpt-cr-title">🎯 קהלים (Ad Sets) — לפי עלות לליד</h3>
          <div className="rpt-cr-adsets">
            {fb.topAdSets.map((s, i) => (
              <div
                key={s.name}
                className={
                  "rpt-cr-adset" + (i === 0 && s.cpl > 0 ? " is-winner" : "")
                }
              >
                <div className="rpt-cr-adset-name">
                  {i === 0 && s.cpl > 0 ? "🏆 " : ""}
                  {s.name}
                </div>
                {/* Who it was aimed at. Sits directly under the name rather
                    than at the foot of the card on purpose: the hover
                    trendline is absolutely positioned at bottom:2.2rem, and
                    anything added below the stats disappears behind it. */}
                {adSetAudience(s) && (
                  <div
                    className="rpt-cr-adset-aim"
                    title={adSetAudienceTitle(s)}
                  >
                    🎯 <bdi>{adSetAudience(s)}</bdi>
                    {s.targetAmbiguous && (
                      <span className="rpt-cr-adset-aim-warn" aria-hidden>
                        {" "}
                        ~
                      </span>
                    )}
                  </div>
                )}
                <div className="rpt-cr-adset-stats">
                  <span>
                    עלות: <b>{fmtILS(s.cost)}</b>
                  </span>
                  <span>
                    לידים: <b>{fmtInt(s.leads)}</b>
                  </span>
                  <span>
                    CPL: <b>{s.cpl > 0 ? fmtILS(s.cpl) : "—"}</b>
                  </span>
                </div>
                {(s.crmLeads > 0 || s.scheduled > 0 || s.held > 0) && (
                  <div
                    className="rpt-cr-adset-stats rpt-cr-adset-crm"
                    title="לידים, תואמו ובוצעו מה-CRM מקהל זה"
                  >
                    <span style={{ color: "#6366f1" }}>
                      לידים: <b>{fmtInt(s.crmLeads)}</b>
                    </span>
                    <span style={{ color: "#ec4899" }}>
                      תואמו: <b>{fmtInt(s.scheduled)}</b>
                      {s.costPerSched > 0 ? ` (${fmtILS(s.costPerSched)})` : ""}
                    </span>
                    <span style={{ color: "#f5576c" }}>
                      בוצעו: <b>{fmtInt(s.held)}</b>
                      {s.costPerHeld > 0 ? ` (${fmtILS(s.costPerHeld)})` : ""}
                    </span>
                  </div>
                )}
                <AdSetHoverCard s={s} window={data.window} />
              </div>
            ))}
          </div>
        </>
      )}

      {fbNode}

      {/* Google funnel summary — same band, scoped to Google (המרות /
          קליק→המרה / חשיפה→המרה), heading the Google Ads detail. */}
      <PlatformKpiBand
        plat="google"
        totals={ap.google}
        prev={prevAp?.google ?? null}
        activeAds={googleActiveAds}
      />

      {google.dgAds.length > 0 && <GoogleDgBlock ads={google.dgAds} />}

      {google.ads.length > 0 && <GoogleAdsBlock ads={google.ads} />}

      {google.topKeywords.length > 0 && (
        <>
          <h3 className="rpt-cr-title">🔍 מילות חיפוש מובילות — Google</h3>
          <div className="rpt-ch-table-wrap">
            <table className="rpt-ch-table">
              <thead>
                <tr>
                  <th>מילת חיפוש</th>
                  <th>חשיפות</th>
                  <th>קליקים</th>
                  <th>המרות</th>
                  <th>תיאומים</th>
                  <th>ביצועים</th>
                </tr>
              </thead>
              <tbody>
                {google.topKeywords.map((k) => (
                  <tr key={k.keyword}>
                    <td className="rpt-cr-kw">{k.keyword}</td>
                    <td>{fmtInt(k.impressions)}</td>
                    <td>{fmtInt(k.clicks)}</td>
                    <td>{fmtInt(k.conversions)}</td>
                    <td style={{ color: "#ec4899" }}>{fmtInt(k.scheduled)}</td>
                    <td style={{ color: "#f5576c" }}>{fmtInt(k.held)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Demand Gen creatives, grouped the way Google's own asset list shows them:
 * ONE AD is assembled from several images plus several headlines and
 * descriptions, and Google scores each asset separately.
 *
 * No ad-level total is printed. Metrics here are per asset, and an impression
 * is credited to every asset shown in it, so adding an ad's rows up overstates
 * its spend — measured at a median 1.8x across the portfolio, worst case 6x.
 * The per-asset figures are the real ones; the ad's own total lives in the
 * ערוצים tab.
 */
/** Google's ad status → pill, mirroring fbStatusInfo. "mixed" appears when a
 *  merged card's ads don't agree — e.g. the creative is live against one
 *  audience and paused against another. */
function dgStatusInfo(raw: string): {
  label: string;
  cls: string;
  off: boolean;
} {
  const s = String(raw || "").toUpperCase().trim();
  if (!s) return { label: "", cls: "", off: false };
  if (s === "ENABLED") return { label: "🟢 פעילה", cls: "on", off: false };
  if (s === "PAUSED") return { label: "⏸️ מושהית", cls: "off", off: true };
  if (s === "REMOVED") return { label: "🗑️ הוסרה", cls: "off", off: true };
  if (s === "MIXED") return { label: "◐ חלקית", cls: "mixed", off: false };
  return { label: s, cls: "", off: false };
}

function GoogleDgBlock({
  ads,
}: {
  ads: NonNullable<ProjectReportData["creatives"]>["google"]["dgAds"];
}) {
  // Paused creatives are reference material, not what you came to look at —
  // on נתיבות four of six cards are paused and they pushed the live pair off
  // the first screen. Live stays open, paused folds into one summary line.
  const live = ads.filter((a) => !dgStatusInfo(a.status).off);
  const paused = ads.filter((a) => dgStatusInfo(a.status).off);
  return (
    <>
      {/* Not titled "Demand Gen": AdGroupAdAssetView returns assets for EVERY
          Google ad type, so a search campaign shows up here too as a card with
          19 headlines/descriptions and no images. The title says Google so the
          search cards aren't read as mislabelled. */}
      <h3 className="rpt-cr-title">
        🖼️ נכסי קריאייטיב — Google
        <span className="rpt-cr-title-note">
          {" "}
          · 60 הימים האחרונים (לא לפי תקופת הדוח) · הנתונים הם לכל נכס בנפרד
        </span>
      </h3>
      {live.length > 0 && (
        <div className="rpt-cr-dgads">
          {live.map((ad) => (
            <DgAdCard key={ad.adIds.join("+") || ad.campaign} ad={ad} />
          ))}
        </div>
      )}
      {paused.length > 0 && (
        <details className="rpt-cr-dgpaused">
          <summary>
            ⏸️ {paused.length} קריאייטיבים מושהים
            <span className="rpt-cr-dgpaused-hint">לחצו להצגה</span>
          </summary>
          <div className="rpt-cr-dgads">
            {paused.map((ad) => (
              <DgAdCard key={ad.adIds.join("+") || ad.campaign} ad={ad} />
            ))}
          </div>
        </details>
      )}
    </>
  );
}

function DgAdCard({
  ad,
}: {
  ad: NonNullable<ProjectReportData["creatives"]>["google"]["dgAds"][number];
}) {
  const st = dgStatusInfo(ad.status);
  return (
    <div className={"rpt-cr-dgad" + (st.off ? " is-off" : "")}>
            <div className="rpt-cr-dgad-head">
              {st.label && (
                <span
                  className={`rpt-cr-dgstatus is-${st.cls}`}
                  title={
                    ad.adIds.length > 1
                      ? `סטטוס של ${ad.adIds.length} המודעות המשתמשות בקריאייטיב הזה`
                      : "סטטוס המודעה ב-Google Ads"
                  }
                >
                  {st.label}
                </span>
              )}
              <span className="rpt-cr-dgad-camp" title={ad.campaign}>
                {ad.campaign}
              </span>
              <span className="rpt-cr-dgad-meta">
                {ad.images.length} תמונות · {ad.copy.length} טקסטים
              </span>
            </div>
            {/* The same creative typically runs against several audiences.
                They're merged into one card; this says which. */}
            {ad.adGroups.length > 0 && (
              <div
                className="rpt-cr-dggroups"
                title={ad.adGroups.join("\n")}
              >
                <span className="rpt-cr-dggroups-l">
                  {ad.adGroups.length > 1
                    ? `רץ ב-${ad.adGroups.length} קבוצות מודעות:`
                    : "קבוצת מודעות:"}
                </span>
                {ad.adGroups.map((g) => (
                  <span key={g} className="rpt-cr-dggroup">
                    {g}
                  </span>
                ))}
              </div>
            )}

            {ad.images.length > 0 && (
              <div className="rpt-cr-dgimgs themed-scrollbar">
                {ad.images.map((im, i) => (
                  <figure key={`${im.imageUrl}-${i}`} className="rpt-cr-dgimg">
                    {im.imageUrl ? (
                      <DgAssetImage
                        src={im.imageUrl}
                        alt={im.name || im.fieldType}
                      />
                    ) : (
                      <a
                        className="rpt-cr-dgvid"
                        href={im.videoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        ▶ וידאו
                      </a>
                    )}
                    <figcaption title={im.name || im.fieldType}>
                      <span className="rpt-cr-dgimg-kind">{im.fieldType}</span>
                      <span className="rpt-cr-dgimg-nums">
                        {fmtILS(im.cost)} · {fmtInt(im.clicks)} קליקים
                      </span>
                      {im.sharedWith > 0 && (
                        <span
                          className="rpt-cr-dgimg-shared"
                          title={`התמונה משמשת גם ב-${im.sharedWith} מודעות נוספות בפרויקט`}
                        >
                          ↻ {im.sharedWith}
                        </span>
                      )}
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}

            {ad.copy.length > 0 && (
              <ul className="rpt-cr-dgcopy">
                {ad.copy.map((c, i) => (
                  <li key={`${c.fieldType}-${i}`}>
                    <span className="rpt-cr-dgcopy-kind">{c.fieldType}</span>
                    <span className="rpt-cr-dgcopy-text">{c.text}</span>
                    <span className="rpt-cr-dgcopy-nums">
                      {fmtInt(c.impressions)} חשיפות · {fmtInt(c.clicks)} קליקים
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {/* Copy that ran and was then unlinked. Folded away by default so
                the open card is exactly what Google Ads shows — the numbers are
                real spend, but reading them as live copy is how the card ended
                up claiming 7 headlines on a 3-headline ad. See copyRetired. */}
            {ad.copyRetired.length > 0 && (
              <details className="rpt-cr-dgretired">
                <summary>
                  🗄️ {ad.copyRetired.length} טקסטים היסטוריים
                  <span className="rpt-cr-dgretired-hint">
                    כבר לא במודעה · לחצו להצגה
                  </span>
                </summary>
                <ul className="rpt-cr-dgcopy">
                  {ad.copyRetired.map((c, i) => (
                    <li key={`${c.fieldType}-${i}`}>
                      <span className="rpt-cr-dgcopy-kind">{c.fieldType}</span>
                      <span className="rpt-cr-dgcopy-text">{c.text}</span>
                      <span className="rpt-cr-dgcopy-nums">
                        {fmtInt(c.impressions)} חשיפות · {fmtInt(c.clicks)} קליקים
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {/* Creatives that ran and were then unlinked. Folded away for the
                same reason as the copy above: the 🟢 פעילה pill is the AD's
                status, so anything sitting open under it reads as currently
                running. Shbn-holon showed four swapped-out images beside the
                five live ones. The spend is real, so it stays reachable. */}
            {ad.imagesRetired.length > 0 && (
              <details className="rpt-cr-dgretired">
                <summary>
                  🗄️ {ad.imagesRetired.length === 1
                    ? "קריאייטיב היסטורי אחד"
                    : `${ad.imagesRetired.length} קריאייטיבים היסטוריים`}
                  <span className="rpt-cr-dgretired-hint">
                    כבר לא במודעה · לחצו להצגה
                  </span>
                </summary>
                <div className="rpt-cr-dgimgs themed-scrollbar">
                  {ad.imagesRetired.map((im, i) => (
                    <figure key={`${im.imageUrl}-${i}`} className="rpt-cr-dgimg">
                      {im.imageUrl ? (
                        <DgAssetImage
                          src={im.imageUrl}
                          alt={im.name || im.fieldType}
                        />
                      ) : (
                        <a
                          className="rpt-cr-dgvid"
                          href={im.videoUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          ▶ וידאו
                        </a>
                      )}
                      <figcaption title={im.name || im.fieldType}>
                        <span className="rpt-cr-dgimg-kind">{im.fieldType}</span>
                        <span className="rpt-cr-dgimg-nums">
                          {fmtILS(im.cost)} · {fmtInt(im.clicks)} קליקים
                        </span>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </details>
            )}

            {(ad.images[0]?.cta || ad.images[0]?.finalUrl) && (
              <div className="rpt-cr-gmeta">
                {ad.images[0]?.cta && (
                  <span className="rpt-cr-gcta" title="Call to action">
                    {ad.images[0].cta}
                  </span>
                )}
                {ad.images[0]?.finalUrl && (
                  <a
                    className="rpt-cr-glink"
                    href={ad.images[0].finalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={ad.images[0].finalUrl}
                  >
                    דף נחיתה ↗
                  </a>
                )}
              </div>
            )}
    </div>
  );
}

function GoogleAdsBlock({
  ads,
}: {
  ads: NonNullable<ProjectReportData["creatives"]>["google"]["ads"];
}) {
  // Group by campaign, order groups by total impressions desc (legacy).
  const byCamp = new Map<string, typeof ads>();
  for (const a of ads) {
    const k = a.campaign || "—";
    const arr = byCamp.get(k) ?? [];
    arr.push(a);
    byCamp.set(k, arr);
  }
  const groups = [...byCamp.entries()].sort((x, y) => {
    const xi = x[1].reduce((s, a) => s + a.impressions, 0);
    const yi = y[1].reduce((s, a) => s + a.impressions, 0);
    return yi - xi;
  });
  return (
    <>
      <h3 className="rpt-cr-title">📝 מודעות Google Ads — לפי קמפיין</h3>
      <div className="rpt-cr-gcamps">
        {groups.map(([camp, list]) => {
          const totalImp = list.reduce((s, a) => s + a.impressions, 0);
          return (
            <div key={camp} className="rpt-cr-gcamp">
              <div className="rpt-cr-gcamp-head">
                <span className="rpt-cr-gcamp-name" title={camp}>
                  {camp}
                </span>
                <span className="rpt-cr-gcamp-meta">
                  {list.length} מודעות · {fmtInt(totalImp)} חשיפות
                </span>
                {/* CRM outcomes for the campaign, the same pair the Facebook
                    cards and the keyword table below already carry. Every ad
                    in the group shares one campaign, so the first row's join
                    IS the group's — summing them would multiply it by the ad
                    count. Omitted entirely when no CRM row matched, so a
                    blank never reads as a measured zero. */}
                {list[0]?.hasCrm && (
                  <span
                    className="rpt-cr-gcamp-crm"
                    title="תיאומים וביצועים של הלידים שהקמפיין הזה הביא, לפי אירועי פגישה בתקופה — אותה הגדרה כמו במודעות פייסבוק"
                  >
                    <span className="rpt-cr-gcamp-sched">
                      {fmtInt(list[0].scheduled)} תיאומים
                    </span>
                    <span className="rpt-cr-gcamp-held">
                      {fmtInt(list[0].held)} ביצועים
                    </span>
                  </span>
                )}
              </div>
              {list.map((a, i) => (
                <div key={i} className="rpt-cr-gad">
                  <div className="rpt-cr-gad-row">
                    <span
                      className={
                        "rpt-cr-gad-status" +
                        (a.status === "Enabled" ? " is-on" : " is-off")
                      }
                    >
                      {a.status || "—"}
                    </span>
                    <span>{fmtInt(a.impressions)} חשיפות</span>
                    {a.finalUrl && (
                      <a href={a.finalUrl} target="_blank" rel="noopener noreferrer">
                        🔗 דף נחיתה
                      </a>
                    )}
                  </div>
                  {a.headlines.length > 0 && (
                    <div className="rpt-cr-gad-assets">
                      <span className="rpt-cr-gad-label">כותרות</span>
                      <div className="rpt-cr-pills">
                        {a.headlines.map((t, j) => (
                          <span key={j} className="rpt-cr-pill">
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {a.descriptions.length > 0 && (
                    <div className="rpt-cr-gad-assets">
                      <span className="rpt-cr-gad-label">תיאורים</span>
                      <div className="rpt-cr-pills">
                        {a.descriptions.map((t, j) => (
                          <span key={j} className="rpt-cr-pill is-desc">
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}
