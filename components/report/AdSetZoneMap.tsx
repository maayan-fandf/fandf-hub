import { ANCHORS, MAP_H, OUTLINE_PATH, ROADS, project } from "@/lib/israelMap";

/**
 * Where an ad set was actually aimed, drawn.
 *
 * WHY IT EXISTS. Meta stores a radius target as a bare coordinate —
 * "31.778,35.192 (10mi)" — and the export names the city it sits in, which
 * answers "which town" but not "how much of it". A 1-mile pin on one
 * neighbourhood and a 10-mile pin covering half a metropolitan area both read
 * as "ירושלים" on the line; only the circle shows the difference, and that
 * difference is usually the reason one ad set costs three times the other.
 *
 * No tiles, no map provider, no API key: this reuses the country outline and
 * the equirectangular projection that lib/israelMap already carries for the
 * GA4 city map.
 *
 * ── WHY LANDMARKS, NOT JUST A COASTLINE ──
 * The first version cropped to the pin and drew only the outline. At city
 * zoom that outline is a single diagonal line, and the result was a white
 * panel with a green dot on it — you could see there was a circle, but not
 * where on earth it was. The country silhouette carries no information once
 * you are inside it. Named neighbours do: "between הרצליה and כפר סבא" places
 * the ring instantly, and it is the same judgement a person makes reading any
 * map. So the frame is grown until at least two landmarks are in it, and they
 * are labelled.
 *
 * Stateless and pure: imported by the (client) creatives tab, so it ships in
 * that bundle, but it adds no hooks, no effects and no listeners — the hover
 * is CSS.
 */

/** Degrees of latitude per kilometre — the constant that turns Meta's radius
 *  into SVG units. Longitude degrees shrink with latitude, but the projection
 *  already applies that correction on the x axis, so scaling the circle by
 *  the LATITUDE ratio keeps it round and correctly sized at Israel's span. */
const KM_PER_DEG_LAT = 111.32;

/** Portrait, matching both the country and the popover's shape. */
const ASPECT = 0.82;
/** Tightest useful frame, in projected units (≈33km tall). Below this a
 *  4-mile ring stops being a circle and becomes the whole picture. */
const MIN_SPAN = 22;
/** Never zoom out past this — beyond it the ring is a dot again and the
 *  caption already names the city. */
const MAX_SPAN = 120;
/** Enough to orient by. One landmark tells you the neighbourhood; two tell
 *  you the direction and the distance. */
const WANT_ANCHORS = 2;

export type Zone = { label: string; point: [number, number, number] | null };

export default function AdSetZoneMap({ zones }: { zones: Zone[] }) {
  const pins = zones
    .map((z) => (z.point ? { label: z.label, p: z.point } : null))
    .filter((v): v is { label: string; p: [number, number, number] } => !!v);
  if (!pins.length) return null;

  // One SVG unit on the y axis = this many degrees of latitude.
  const degPerUnitY = (33.35 - 29.45) / MAP_H;
  const radiusUnits = (km: number) =>
    km > 0 ? km / KM_PER_DEG_LAT / degPerUnitY : 0;

  // Bounding box of every pin and its radius.
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const { p } of pins) {
    const { x, y } = project(p[0], p[1]);
    const r = radiusUnits(p[2]);
    x0 = Math.min(x0, x - r);
    x1 = Math.max(x1, x + r);
    y0 = Math.min(y0, y - r);
    y1 = Math.max(y1, y + r);
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;

  const projected = ANCHORS.map((a) => ({ ...a, ...project(a.lat, a.lon) }));
  const inFrame = (h: number) => {
    const w = h * ASPECT;
    return projected.filter(
      (a) =>
        Math.abs(a.x - cx) < w / 2 - w * 0.06 &&
        Math.abs(a.y - cy) < h / 2 - h * 0.05,
    );
  };

  // Start snug around the pins, then widen until the frame has something
  // recognisable in it. Geometric steps rather than linear so a pin in an
  // empty part of the country reaches its nearest town in a few iterations
  // instead of thirty.
  let h = Math.max((y1 - y0) * 1.9, ((x1 - x0) * 1.9) / ASPECT, MIN_SPAN);
  let anchors = inFrame(h);
  while (anchors.length < WANT_ANCHORS && h < MAX_SPAN) {
    h = Math.min(h * 1.35, MAX_SPAN);
    anchors = inFrame(h);
  }
  h = Math.min(h, MAP_H);
  const w = h * ASPECT;

  // Labels and dots are sized against the FRAME, not the projection, so they
  // stay the same physical size on screen at every zoom level.
  const font = h / 15;
  const anchorR = h / 130;
  const pinR = h / 55;

  /**
   * Thin the labels, because the raw list collides with itself.
   *
   * Two rules, both from watching it render. First, drop any landmark that
   * falls INSIDE a targeted ring: that is the target's own city, the caption
   * already names it, and its label lands under the circle where it cannot be
   * read anyway. Second, keep the ones nearest the middle and refuse any that
   * would sit on top of one already kept — around Jerusalem the list offered
   * four towns inside a few kilometres and drew them as a smudge.
   */
  const rings = pins.map(({ p }) => ({ ...project(p[0], p[1]), r: radiusUnits(p[2]) }));

  /**
   * Overlap is tested BOX against BOX, not centre against centre.
   *
   * The first version compared distances between the anchor points and let
   * anything more than a couple of font-heights apart through. But a label is
   * far wider than it is tall — "בית שמש" measures 15 units against a 3-unit
   * font — so two names 8 units apart still printed straight through each
   * other, and "פתח תקוה" and "תל אביב" came out as one unreadable row of
   * interleaved letters.
   *
   * The width is estimated rather than measured: this renders on the server,
   * where there is no text metric to ask for. 0.55em per character is a
   * deliberate over-estimate for Rubik's Hebrew — erring wide drops a label,
   * erring narrow prints a smudge, and the first is the better failure.
   */
  const labelBox = (a: { x: number; y: number; he: string }) => {
    const w = a.he.length * font * 0.55;
    const yTop = a.y - anchorR * 2.4 - font;
    return { x0: a.x - w / 2, x1: a.x + w / 2, y0: yTop, y1: yTop + font * 1.35 };
  };
  const hits = (
    p: ReturnType<typeof labelBox>,
    q: ReturnType<typeof labelBox>,
  ) => p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1;

  const vx0 = cx - w / 2;
  const vx1 = cx + w / 2;
  const vy0 = cy - h / 2;
  const vy1 = cy + h / 2;

  const placed: { x: number; y: number; he: string }[] = [];
  const boxes: ReturnType<typeof labelBox>[] = [];
  // Nearest first, but weighted by how well-known the place is: a village
  // half a kilometre closer to the middle should not push תל אביב out of a
  // frame that contains both. Rank 1 competes as if it were half as far.
  const cost = (a: (typeof anchors)[number]) =>
    Math.hypot(a.x - cx, a.y - cy) * (a.rank === 1 ? 0.5 : a.rank === 2 ? 0.8 : 1.15);
  for (const a of [...anchors].sort((m, n) => cost(m) - cost(n))) {
    if (rings.some((g) => Math.hypot(a.x - g.x, a.y - g.y) < g.r)) continue;
    const box = labelBox(a);
    if (boxes.some((b) => hits(box, b))) continue;
    placed.push(a);
    boxes.push(box);
    if (placed.length >= 4) break;
  }

  /**
   * The roads, projected, and their numbers placed LAST.
   *
   * The line itself is always drawn once any of it crosses the frame — that
   * is the orientation cue and it cannot collide with anything. The NUMBER
   * is the fussy part: placed at the route's midpoint it landed on top of the
   * target ring, which is the one thing on this map that must stay readable.
   * So each in-frame waypoint is tried from the middle outward and the first
   * clear one wins; a route with no clear spot keeps its line and loses its
   * number, which is the right trade.
   */
  const roadNumBox = (p: { x: number; y: number }) => {
    const s = font * 0.8;
    return { x0: p.x - s, x1: p.x + s, y0: p.y - s, y1: p.y + s * 0.4 };
  };
  const roads = ROADS.map((r) => {
    const pts = r.pts.map(([lon, lat]) => project(lat, lon));
    const inside = pts.filter((p) => p.x > vx0 && p.x < vx1 && p.y > vy0 && p.y < vy1);
    if (!inside.length) return null;
    // Middle first, then alternating outward — the middle of the visible run
    // is where a number reads as belonging to this line and not a neighbour.
    const order = [...inside].sort(
      (a, b) =>
        Math.abs(inside.indexOf(a) - (inside.length - 1) / 2) -
        Math.abs(inside.indexOf(b) - (inside.length - 1) / 2),
    );
    let label: { x: number; y: number } | null = null;
    for (const p of order) {
      if (rings.some((g) => Math.hypot(p.x - g.x, p.y - g.y) < g.r + font * 0.7)) continue;
      const nb = roadNumBox(p);
      if (boxes.some((b) => hits(nb, b))) continue;
      label = p;
      boxes.push(nb);
      break;
    }
    return {
      no: r.no,
      d: pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" "),
      label,
    };
  }).filter(
    (r): r is { no: string; d: string; label: { x: number; y: number } | null } => !!r,
  );

  return (
    <svg
      className="rpt-cr-zonemap-svg"
      viewBox={`${(cx - w / 2).toFixed(2)} ${(cy - h / 2).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`אזורי טירגוט: ${pins.map((p) => p.label).join(", ")}`}
    >
      <path className="ga4w-map-land" d={OUTLINE_PATH} />

      {/* Trunk roads, drawn under everything else. Schematic — see ROADS. */}
      {roads.map((r) => (
        <path key={r.no} className="rpt-cr-zonemap-road" d={r.d} />
      ))}
      {roads.map((r) =>
        r.label ? (
          <text
            key={`n${r.no}`}
            className="rpt-cr-zonemap-roadno"
            x={r.label.x}
            y={r.label.y}
            fontSize={font * 0.8}
            textAnchor="middle"
          >
            {r.no}
          </text>
        ) : null,
      )}

      {placed.map((a) => (
        <g key={a.he}>
          <circle className="rpt-cr-zonemap-anchor" cx={a.x} cy={a.y} r={anchorR} />
          <text
            className="rpt-cr-zonemap-label"
            x={a.x}
            y={a.y - anchorR * 2.4}
            fontSize={font}
            textAnchor="middle"
          >
            {a.he}
          </text>
        </g>
      ))}

      {pins.map(({ label, p }, i) => {
        const { x, y } = project(p[0], p[1]);
        const r = radiusUnits(p[2]);
        return (
          <g key={`${label}-${i}`}>
            {r > 0 && <circle className="rpt-cr-zonemap-ring" cx={x} cy={y} r={r} />}
            {/* The centre dot is what says "here" when the radius is too
                small to read as an area at this frame. */}
            <circle className="rpt-cr-zonemap-dot" cx={x} cy={y} r={pinR} />
          </g>
        );
      })}
    </svg>
  );
}
