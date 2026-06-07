// Offline fixture test for findRoomLabel / extractPrices room-labelling.
//
//   node --experimental-strip-types scripts/test-room-labels.mjs
//
// Each case is a string of marketing copy + the expected extractor
// output (value → roomsLabel). Cheaper + more deterministic than
// hammering Yad2 with another probe + survives anti-bot rate limits.

import { extractPrices } from "../lib/priceExtractor.ts";

const cases = [
  {
    name: "Yad2 sponsored: headline range + per-type table",
    text:
      "ממשכנתה אקסקלוסיבית בתנאי מימון יוצאי דופן! דירות 3-5 חד' ופנטהאוזים יוקרתיים החל מ – 3,320,000 ₪. " +
      "פרויקט בוטיק יוצא דופן. " +
      "דירה חדרים: 3 שטח: 80 מ\"ר קומה: 1-8 החל מ- 3,320,000 ₪ " +
      "דירה חדרים: 4 שטח: 105 מ\"ר קומה: 1-8 החל מ- 3,930,000 ₪ " +
      "דירה חדרים: 5 שטח: 127 מ\"ר קומה: 1-2 החל מ- 4,970,000 ₪ " +
      "גג/פנטהאוז חדרים: 5 שטח: 152 מ\"ר קומה: החל מ- 8,290,000 ₪",
    expected: {
      3320000: { rooms: 3, roomsLabel: "3 חד׳" }, // table row promotes
      3930000: { rooms: 4, roomsLabel: "4 חד׳" },
      4970000: { rooms: 5, roomsLabel: "5 חד׳" },
      8290000: { rooms: 5, roomsLabel: "פנטהאוז · 5 חד׳" },
    },
  },
  {
    name: "Landing-page hero blocks (Prashkovsky case)",
    text:
      "4 חד' 116 מ\"ר + 10 מ\"ר מרפסת החל מ-3,110,000 ₪ — " +
      "5 חד' 136 מ\"ר + 14 מ\"ר החל מ-3,410,000 ₪",
    expected: {
      3110000: { rooms: 4, roomsLabel: "4 חד׳" },
      3410000: { rooms: 5, roomsLabel: "5 חד׳" },
    },
  },
  {
    name: "Headline range only (no table)",
    text: "דירות 3-5 חד׳ החל מ-2,800,000 ₪ בלבד.",
    expected: {
      2800000: { rooms: null, roomsLabel: "3-5 חד׳" },
    },
  },
  {
    name: "Yad2 אנדה case: comma-list headline + per-room table",
    text:
      "בפרויקט היוקרתי בבאר יעקב. דירות 3,4,5 חד', דירות גן ופנטהאוזים " +
      "עם מרפסות ענק החל מ- 2,420,000 ₪ ותנאי תשלום ל-15/85. " +
      "דירה חדרים: 3 שטח: 79.93 מ\"ר קומה: 10 החל מ- 2,420,000 ₪ " +
      "דירה חדרים: 4 שטח: 107.85 מ\"ר קומה: 1 החל מ- 2,980,000 ₪ " +
      "דירה חדרים: 5 שטח: 127.79 מ\"ר קומה: 1 החל מ- 3,230,000 ₪",
    expected: {
      // Table-form "חדרים: 3" overrides the comma-list grabbing "5"
      // from "3,4,5 חד'" at the headline (the original bug).
      2420000: { rooms: 3, roomsLabel: "3 חד׳" },
      2980000: { rooms: 4, roomsLabel: "4 חד׳" },
      3230000: { rooms: 5, roomsLabel: "5 חד׳" },
    },
  },
  {
    name: "Plain headline with no room marker at all",
    text: "פרויקט מבטיח. כניסה צפויה 2027. החל מ-3,500,000 ₪.",
    expected: {
      3500000: { rooms: null, roomsLabel: "" },
    },
  },
  {
    name: "Loan / payment-plan figure should still NOT pick up rooms (anti-anchor)",
    text:
      "דירות 4 חד׳ החל מ-3,500,000 ₪. מימון נוח: מקדמה החל מ-500,000 ₪.",
    expected: {
      3500000: { rooms: 4, roomsLabel: "4 חד׳", anchored: true },
      500000: { anchored: false }, // anti-anchor kept it unanchored
    },
  },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const out = extractPrices(c.text);
  const byVal = new Map(out.map((p) => [p.value, p]));
  const failures = [];
  for (const [valStr, exp] of Object.entries(c.expected)) {
    const value = Number(valStr);
    const got = byVal.get(value);
    if (!got) {
      failures.push(`  missing value ${value}`);
      continue;
    }
    for (const [k, v] of Object.entries(exp)) {
      const actual = got[k];
      if (actual !== v) {
        failures.push(`  ${value}.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(actual)}`);
      }
    }
  }
  if (failures.length) {
    fail++;
    console.log(`✗ ${c.name}`);
    console.log(failures.join("\n"));
    console.log(`  full output: ${JSON.stringify(out, null, 2)}`);
  } else {
    pass++;
    console.log(`✓ ${c.name}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
