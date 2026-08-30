// Room-label unit table for lib/priceExtractor.ts. No test runner in this
// repo, so this is the regression guard for findRoomLabel:
//   node scripts/probe-room-labels.mjs
import { extractPrices } from "../lib/priceExtractor.ts";

// [text, expected label for each extracted price, in order]
const cases = [
  // Comma / conjunction lists — the marker spans several room counts,
  // so it must NOT tag the price with the last one.
  ["דירות 3,4,5 חד' ופנטהאוזים החל מ-2,420,000 ₪", ["3,4,5 חד׳"]],
  ["מגוון דירות 4,3, ו-5 חד' מרווחות, ופנטהאוזים החל מ – 2,450,000 ₪", ["3,4,5 חד׳"]],
  ["דירות 3 ו-5 חד' החל מ-4,355,000 ₪", ["3,5 חד׳"]],
  ["מיני פנטהאוז מעוצב 4 ו-5 חד׳ החל מ-3,250,000 ₪", ["4,5 חד׳"]],
  ["דירות 3 ו5 חד׳ החל מ-4,000,000 ₪", ["3,5 חד׳"]],
  ["דירות 3-5 חד׳ ופנטהאוזים החל מ-3,320,000 ₪", ["3-5 חד׳"]],
  // Single / table forms stay untouched.
  ["4 חד׳ 116 מ״ר + מרפסת החל מ-3,110,000 ₪", ["4 חד׳"]],
  ["חדרים: 3 שטח: 80 מ״ר החל מ- 3,320,000 ₪", ["3 חד׳"]],
  ["דירת גן 116 מ״ר 5 חד׳ החל מ-3,000,000 ₪", ["5 חד׳"]],
  ["5 חדרים ו-4 חדרים במחיר החל מ-2,000,000 ₪", ["4 חד׳"]],
  ["גג/פנטהאוז חדרים: 5 שטח: 140 מ״ר החל מ- 4,500,000 ₪", ["פנטהאוז · 5 חד׳"]],
  // Yad2, table layout — label before price.
  [
    "דירה חדרים: 3 שטח: קומה: החל מ- 2,450,000 ₪ דירה חדרים: 4 שטח: קומה: החל מ- 2,770,000 ₪ דירה חדרים: 5 שטח: קומה: החל מ- 3,200,000 ₪",
    ["3 חד׳", "4 חד׳", "5 חד׳"],
  ],
  // Yad2, card layout — same table, label AFTER price, with a filter
  // chip row above it. Back-window-only reading rotates these by one.
  [
    "כל הדירות 3 חד' 4 חד' 5 חד' דירה החל מ- 2,450,000 ₪ דירה • 3 חד' מרפסת שמש • ממ\"ד • חניה החל מ- 2,770,000 ₪ דירה • 4 חד' מרפסת שמש • ממ\"ד • חניה החל מ- 3,200,000 ₪ דירה • 5 חד' מרפסת שמש • ממ\"ד • חניה",
    ["3 חד׳", "4 חד׳", "5 חד׳"],
  ],
];

let bad = 0;
for (const [text, want] of cases) {
  const got = extractPrices(text).map((p) => p.roomsLabel);
  const ok = got.length === want.length && got.every((g, i) => g === want[i]);
  if (!ok) bad++;
  console.log(
    `${ok ? "ok  " : "FAIL"}  want=[${want.join(" | ")}]  got=[${got.join(" | ")}]\n        ${text.slice(0, 70)}…`,
  );
}
console.log(bad ? `\n${bad} FAILED` : `\nall ${cases.length} pass`);
process.exit(bad ? 1 : 0);
