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
