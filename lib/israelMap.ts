/**
 * Gazetteer + projection for the visitor map in the אנליטיקס section.
 *
 * GA4 has no latitude/longitude — only a `city` string — so plotting
 * anything requires our own lookup. The keys here are the EXACT strings
 * GA4 returns for Israel, which are English transliterations with their
 * own spelling conventions: `Rishon LeZion` (not LeẔiyyon),
 * `Be'er Ya'akov` and `Kefar Sava` with apostrophes, `Modi'in-Maccabim-
 * Re'ut` fully hyphenated. Matching is done through `normCity` so
 * apostrophe and hyphen variants of one place collapse together.
 *
 * Foreign cities are deliberately absent. GA4 reports real overseas
 * traffic on these properties (Delhi 192, Dhaka 185, Addis Ababa 124
 * sessions on one property in 28 days) which is bot/proxy noise; the
 * caller filters to country == Israel, and anything still unmatched is
 * reported as a residual count rather than silently dropped.
 */

export type CityPoint = { lat: number; lon: number };

/** Fold apostrophes, hyphens, accents and case so `Be'er Sheva`,
 *  `Beer Sheva` and `be'er-sheva` are one key. */
export function normCity(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’'`´]/g, "")
    .replace(/[\s\-_]+/g, " ")
    .trim();
}

const RAW: Record<string, CityPoint> = {
  // Tel Aviv metro
  "Tel Aviv-Yafo": { lat: 32.0853, lon: 34.7818 },
  "Ramat Gan": { lat: 32.0684, lon: 34.8248 },
  "Givatayim": { lat: 32.0722, lon: 34.8106 },
  "Bnei Brak": { lat: 32.0807, lon: 34.8338 },
  "Holon": { lat: 32.0114, lon: 34.7722 },
  "Bat Yam": { lat: 32.0171, lon: 34.75 },
  "Petah Tikva": { lat: 32.0878, lon: 34.8878 },
  "Ramat HaSharon": { lat: 32.1461, lon: 34.8394 },
  "Herzliya": { lat: 32.1663, lon: 34.8436 },
  "Kiryat Ono": { lat: 32.0636, lon: 34.8553 },
  "Ganei Tikva": { lat: 32.0603, lon: 34.8744 },
  "Or Yehuda": { lat: 32.03, lon: 34.8547 },
  "Yehud": { lat: 32.0333, lon: 34.8833 },
  "Yehud-Monosson": { lat: 32.0333, lon: 34.8833 },
  "Rosh Haayin": { lat: 32.0956, lon: 34.9567 },
  "Elad": { lat: 32.0525, lon: 34.9508 },
  "Shoham": { lat: 31.9992, lon: 34.9469 },

  // Sharon
  "Ra'anana": { lat: 32.1848, lon: 34.8713 },
  "Kefar Sava": { lat: 32.175, lon: 34.907 },
  "Hod Hasharon": { lat: 32.15, lon: 34.8892 },
  "Netanya": { lat: 32.3215, lon: 34.8532 },
  "Even Yehuda": { lat: 32.27, lon: 34.8869 },
  "Tel Mond": { lat: 32.25, lon: 34.9167 },
  "Kadima": { lat: 32.2792, lon: 34.9036 },
  "Kfar Yona": { lat: 32.3172, lon: 34.9358 },
  "Tira": { lat: 32.2333, lon: 34.95 },
  "Tayibe": { lat: 32.2667, lon: 35.0083 },

  // Central / Shfela
  "Rishon LeZion": { lat: 31.973, lon: 34.7925 },
  "Nes Ziona": { lat: 31.9293, lon: 34.7986 },
  "Rehovot": { lat: 31.8947, lon: 34.8093 },
  "Yavne": { lat: 31.8781, lon: 34.7397 },
  "Gedera": { lat: 31.8139, lon: 34.7775 },
  "Gan Yavne": { lat: 31.7883, lon: 34.705 },
  "Ramla": { lat: 31.9288, lon: 34.8667 },
  "Lod": { lat: 31.9514, lon: 34.8953 },
  "Be'er Ya'akov": { lat: 31.9333, lon: 34.8333 },
  "Modi'in-Maccabim-Re'ut": { lat: 31.8969, lon: 35.0104 },
  "Beit Shemesh": { lat: 31.7457, lon: 34.9887 },

  // South
  "Ashdod": { lat: 31.804, lon: 34.6553 },
  "Ashkelon": { lat: 31.6688, lon: 34.5742 },
  "Kiryat Malakhi": { lat: 31.73, lon: 34.7472 },
  "Kiryat Gat": { lat: 31.61, lon: 34.7642 },
  "Sderot": { lat: 31.525, lon: 34.5964 },
  "Netivot": { lat: 31.4222, lon: 34.5889 },
  "Ofakim": { lat: 31.3139, lon: 34.6203 },
  "Rahat": { lat: 31.3925, lon: 34.7544 },
  "Be'er Sheva": { lat: 31.253, lon: 34.7915 },
  "Dimona": { lat: 31.07, lon: 35.0325 },
  "Arad": { lat: 31.2589, lon: 35.2137 },
  "Eilat": { lat: 29.5577, lon: 34.9519 },

  // Jerusalem area
  "Jerusalem": { lat: 31.7683, lon: 35.2137 },
  "Ma'ale Adumim": { lat: 31.7772, lon: 35.2983 },
  "Ariel": { lat: 32.1056, lon: 35.1878 },

  // Haifa / north
  "Haifa": { lat: 32.794, lon: 34.9896 },
  "Nesher": { lat: 32.7667, lon: 35.05 },
  "Tirat Karmel": { lat: 32.7614, lon: 34.9714 },
  "Kiryat Ata": { lat: 32.8114, lon: 35.1128 },
  "Kiryat Bialik": { lat: 32.83, lon: 35.0864 },
  "Kiryat Motzkin": { lat: 32.8378, lon: 35.0728 },
  "Kiryat Yam": { lat: 32.8478, lon: 35.0669 },
  "Akko": { lat: 32.9281, lon: 35.0818 },
  "Nahariya": { lat: 33.0058, lon: 35.0947 },
  "Karmiel": { lat: 32.9186, lon: 35.2951 },
  "Safed": { lat: 32.9646, lon: 35.496 },
  "Rosh Pina": { lat: 32.9694, lon: 35.5425 },
  "Tiberias": { lat: 32.7959, lon: 35.53 },
  "Nazareth": { lat: 32.7021, lon: 35.2978 },
  "Nof HaGalil": { lat: 32.7, lon: 35.3167 },
  "Migdal HaEmek": { lat: 32.6708, lon: 35.24 },
  "Afula": { lat: 32.6078, lon: 35.2897 },
  "Yokneam Illit": { lat: 32.6572, lon: 35.1103 },
  "Umm al-Fahm": { lat: 32.5194, lon: 35.1522 },
  "Hadera": { lat: 32.434, lon: 34.9196 },
  "Pardes Hanna-Karkur": { lat: 32.4747, lon: 34.975 },
  "Binyamina": { lat: 32.5167, lon: 34.95 },
  "Zikhron Ya'akov": { lat: 32.5731, lon: 34.9531 },
  "Baqa al-Gharbiyye": { lat: 32.4167, lon: 35.0333 },
};

export const CITY_COORDS: Map<string, CityPoint> = new Map(
  Object.entries(RAW).map(([k, v]) => [normCity(k), v]),
);

export function lookupCity(name: string): CityPoint | null {
  return CITY_COORDS.get(normCity(name)) ?? null;
}

/**
 * Landmark cities, in Hebrew, for orienting a ZOOMED map.
 *
 * The gazetteer above is keyed by GA4's English strings, which is right for
 * matching GA4 rows and wrong for labelling a Hebrew UI. This is the other
 * half: a short list of places a reader recognises instantly, so a cropped
 * map can say "this circle sits between הרצליה and כפר סבא" instead of
 * showing an anonymous stretch of coastline.
 *
 * Deliberately SHORT. Every entry is a label competing for room on a map an
 * inch across; the point is one or two recognisable neighbours, not a
 * gazetteer. Chosen for spread and name-recognition rather than population,
 * so that anywhere in the country has something known within ~25km.
 */
export const ANCHORS: { he: string; lat: number; lon: number; rank: 1 | 2 | 3 }[] = [
  // rank 1 — read at any zoom, and worth keeping even when a smaller town
  // sits nearer the middle of the frame.
  { he: "תל אביב", lat: 32.0853, lon: 34.7818, rank: 1 },
  { he: "ירושלים", lat: 31.7683, lon: 35.2137, rank: 1 },
  { he: "חיפה", lat: 32.794, lon: 34.9896, rank: 1 },
  { he: "באר שבע", lat: 31.253, lon: 34.7915, rank: 1 },
  { he: "אשדוד", lat: 31.804, lon: 34.6553, rank: 1 },
  { he: "נתניה", lat: 32.3215, lon: 34.8532, rank: 1 },
  { he: "ראשון לציון", lat: 31.973, lon: 34.7925, rank: 1 },
  { he: "פתח תקווה", lat: 32.0878, lon: 34.8878, rank: 1 },
  // rank 2 — the city you name to place a neighbourhood.
  { he: "הרצליה", lat: 32.1663, lon: 34.8436, rank: 2 },
  { he: "כפר סבא", lat: 32.175, lon: 34.907, rank: 2 },
  { he: "רעננה", lat: 32.1848, lon: 34.8713, rank: 2 },
  { he: "הוד השרון", lat: 32.15, lon: 34.8892, rank: 2 },
  { he: "רמת גן", lat: 32.0684, lon: 34.8248, rank: 2 },
  { he: "בני ברק", lat: 32.0807, lon: 34.8338, rank: 2 },
  { he: "חולון", lat: 32.0114, lon: 34.7722, rank: 2 },
  { he: "בת ים", lat: 32.0171, lon: 34.75, rank: 2 },
  { he: "רמת השרון", lat: 32.1461, lon: 34.8394, rank: 2 },
  { he: "ראש העין", lat: 32.0956, lon: 34.9567, rank: 2 },
  { he: "רחובות", lat: 31.8947, lon: 34.8093, rank: 2 },
  { he: "נס ציונה", lat: 31.9293, lon: 34.7986, rank: 2 },
  { he: "יבנה", lat: 31.8781, lon: 34.7397, rank: 2 },
  { he: "רמלה", lat: 31.9288, lon: 34.8667, rank: 2 },
  { he: "לוד", lat: 31.9514, lon: 34.8953, rank: 2 },
  { he: "מודיעין", lat: 31.8969, lon: 35.0104, rank: 2 },
  { he: "בית שמש", lat: 31.7457, lon: 34.9887, rank: 2 },
  { he: "אשקלון", lat: 31.6688, lon: 34.5742, rank: 2 },
  { he: "קרית גת", lat: 31.61, lon: 34.7642, rank: 2 },
  { he: "חדרה", lat: 32.434, lon: 34.9196, rank: 2 },
  { he: "עכו", lat: 32.9281, lon: 35.0818, rank: 2 },
  { he: "נהריה", lat: 33.0058, lon: 35.0947, rank: 2 },
  { he: "טבריה", lat: 32.7959, lon: 35.53, rank: 2 },
  { he: "נצרת", lat: 32.7021, lon: 35.2978, rank: 2 },
  { he: "עפולה", lat: 32.6078, lon: 35.2897, rank: 2 },
  { he: "צפת", lat: 32.9646, lon: 35.496, rank: 2 },
  { he: "כרמיאל", lat: 32.9186, lon: 35.2951, rank: 2 },
  { he: "אריאל", lat: 32.1056, lon: 35.1878, rank: 2 },
  { he: "מעלה אדומים", lat: 31.7772, lon: 35.2983, rank: 2 },
  { he: "דימונה", lat: 31.07, lon: 35.0325, rank: 2 },
  { he: "אילת", lat: 29.5577, lon: 34.9519, rank: 2 },
  // rank 3 — only when the frame is tight enough that nothing bigger is in it.
  { he: "גבעתיים", lat: 32.0722, lon: 34.8106, rank: 3 },
  { he: "קרית אונו", lat: 32.0636, lon: 34.8553, rank: 3 },
  { he: "אור יהודה", lat: 32.03, lon: 34.8547, rank: 3 },
  { he: "יהוד", lat: 32.0333, lon: 34.8833, rank: 3 },
  { he: "גני תקווה", lat: 32.0603, lon: 34.8744, rank: 3 },
  { he: "שוהם", lat: 31.9992, lon: 34.9469, rank: 3 },
  { he: "אלעד", lat: 32.0525, lon: 34.9508, rank: 3 },
  { he: "כפר יונה", lat: 32.3172, lon: 34.9358, rank: 3 },
  { he: "אבן יהודה", lat: 32.27, lon: 34.8869, rank: 3 },
  { he: "תל מונד", lat: 32.25, lon: 34.9167, rank: 3 },
  { he: "קדימה", lat: 32.2792, lon: 34.9036, rank: 3 },
  { he: "טירה", lat: 32.2333, lon: 34.95, rank: 3 },
  { he: "טייבה", lat: 32.2667, lon: 35.0083, rank: 3 },
  { he: "באר יעקב", lat: 31.9333, lon: 34.8333, rank: 3 },
  { he: "גדרה", lat: 31.8139, lon: 34.7775, rank: 3 },
  { he: "גן יבנה", lat: 31.7883, lon: 34.705, rank: 3 },
  { he: "קרית מלאכי", lat: 31.73, lon: 34.7472, rank: 3 },
  { he: "שדרות", lat: 31.525, lon: 34.5964, rank: 3 },
  { he: "נתיבות", lat: 31.4222, lon: 34.5889, rank: 3 },
  { he: "אופקים", lat: 31.3139, lon: 34.6203, rank: 3 },
  { he: "רהט", lat: 31.3925, lon: 34.7544, rank: 3 },
  { he: "ערד", lat: 31.2589, lon: 35.2137, rank: 3 },
  { he: "פרדס חנה", lat: 32.4747, lon: 34.975, rank: 3 },
  { he: "בנימינה", lat: 32.5167, lon: 34.95, rank: 3 },
  { he: "זכרון יעקב", lat: 32.5731, lon: 34.9531, rank: 3 },
  { he: "נשר", lat: 32.7667, lon: 35.05, rank: 3 },
  { he: "קרית אתא", lat: 32.8114, lon: 35.1128, rank: 3 },
  { he: "קרית ביאליק", lat: 32.83, lon: 35.0864, rank: 3 },
  { he: "קרית מוצקין", lat: 32.8378, lon: 35.0728, rank: 3 },
  { he: "טירת כרמל", lat: 32.7614, lon: 34.9714, rank: 3 },
  { he: "יקנעם", lat: 32.6572, lon: 35.1103, rank: 3 },
  { he: "מגדל העמק", lat: 32.6708, lon: 35.24, rank: 3 },
  { he: "נוף הגליל", lat: 32.7, lon: 35.3167, rank: 3 },
  { he: "אום אל-פחם", lat: 32.5194, lon: 35.1522, rank: 3 },
  { he: "ראש פינה", lat: 32.9694, lon: 35.5425, rank: 3 },
];

/**
 * Schematic corridors for the trunk roads, as [lon, lat] waypoints.
 *
 * ── READ THIS BEFORE TRUSTING A LINE ──
 * These are NOT surveyed centrelines. There is no road dataset in this repo
 * and no network call to fetch one, so each route is a handful of waypoints
 * through towns and junctions the route is known to pass, drawn straight
 * between them. At the zoom this map uses — tens of kilometres across — that
 * is close enough to answer "is the targeted circle east or west of the
 * highway", which is the question. It is NOT close enough to say which side
 * of a road a street is on, and the map labels them as approximate so nobody
 * reads them that way.
 *
 * Only the trunk routes are here. A denser network would turn a one-inch
 * locator into a road atlas nobody can read.
 */
export const ROADS: { no: string; pts: [number, number][] }[] = [
  {
    // 2 — the coastal road, Tel Aviv to Haifa.
    no: "2",
    pts: [
      [34.77, 32.09], [34.8, 32.17], [34.85, 32.32], [34.89, 32.44],
      [34.92, 32.56], [34.96, 32.7], [34.99, 32.79],
    ],
  },
  {
    // 1 — Tel Aviv to Jerusalem, via Latrun and Sha'ar HaGai.
    no: "1",
    pts: [
      [34.8, 32.08], [34.88, 32.0], [34.98, 31.83], [35.05, 31.81],
      [35.13, 31.79], [35.21, 31.79],
    ],
  },
  {
    // 6 — the cross-Israel toll road, well inland of the coast.
    no: "6",
    pts: [
      [34.8, 31.55], [34.86, 31.7], [34.95, 31.87], [34.96, 32.02],
      [34.99, 32.15], [35.03, 32.33], [35.06, 32.5], [35.08, 32.62],
    ],
  },
  {
    // 4 — the older coastal artery, inland of route 2 and through the towns.
    no: "4",
    pts: [
      [34.66, 31.8], [34.73, 31.88], [34.8, 31.97], [34.83, 32.06],
      [34.87, 32.19], [34.9, 32.32], [34.93, 32.44], [35.0, 32.72],
    ],
  },
  {
    // 40 — Kfar Saba down the middle of the country to Be'er Sheva.
    no: "40",
    pts: [
      [34.92, 32.17], [34.89, 32.09], [34.88, 31.99], [34.87, 31.93],
      [34.82, 31.83], [34.79, 31.7], [34.78, 31.5], [34.79, 31.26],
    ],
  },
  {
    // 90 — the Jordan valley road along the eastern edge.
    no: "90",
    pts: [
      [35.57, 33.05], [35.58, 32.87], [35.55, 32.72], [35.5, 32.4],
      [35.47, 32.0], [35.45, 31.7], [35.39, 31.35], [35.05, 30.6],
      [34.96, 29.65],
    ],
  },
];

/* ── Projection ───────────────────────────────────────────────────── */

// Bounds chosen to frame the whole country with a little margin.
const LON_MIN = 34.2;
const LON_MAX = 35.95;
const LAT_MIN = 29.45;
const LAT_MAX = 33.35;
// Equirectangular needs an x correction or Israel comes out too wide.
const COS_LAT = Math.cos((31.5 * Math.PI) / 180);

export const MAP_W = 100;
export const MAP_H =
  (MAP_W * (LAT_MAX - LAT_MIN)) / ((LON_MAX - LON_MIN) * COS_LAT);

export function project(lat: number, lon: number): { x: number; y: number } {
  const x = ((lon - LON_MIN) / (LON_MAX - LON_MIN)) * MAP_W;
  const y = ((LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) * MAP_H;
  return { x, y };
}

/**
 * Simplified silhouette of the country, as [lon, lat] pairs.
 *
 * Deliberately a single coarse outline with no internal boundaries —
 * it exists to give the dots somewhere to sit, not to make any claim
 * about borders. Roughly 30 points, which is enough to read as Israel
 * at 100px wide and no more.
 */
const OUTLINE: [number, number][] = [
  [35.10, 33.09], [35.55, 33.25], [35.63, 33.24], [35.78, 33.20],
  [35.87, 32.98], [35.68, 32.71], [35.57, 32.65], [35.55, 32.38],
  [35.54, 32.00], [35.47, 31.49], [35.40, 31.10], [35.47, 30.95],
  [35.19, 30.60], [35.00, 30.10], [34.93, 29.55], [34.90, 29.49],
  [34.88, 29.55], [34.55, 30.40], [34.40, 30.90], [34.27, 31.22],
  [34.48, 31.59], [34.65, 31.85], [34.75, 32.07], [34.85, 32.33],
  [34.92, 32.55], [34.95, 32.82], [35.06, 32.92],
];

export const OUTLINE_PATH: string =
  OUTLINE.map(([lon, lat], i) => {
    const { x, y } = project(lat, lon);
    return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ") + " Z";
