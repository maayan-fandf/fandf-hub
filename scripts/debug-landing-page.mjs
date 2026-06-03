// Dump the rendered text of a landing page to figure out why the
// extractor isn't picking up prices. Usage:
//   node scripts/debug-landing-page.mjs "https://lp.afridar.co.il/ahuzat-afridar/"
import puppeteer from "puppeteer";
import { htmlToText, extractPrices } from "../lib/priceExtractor.ts";

const url = process.argv[2];
if (!url) {
  console.error("Usage: node scripts/debug-landing-page.mjs <url>");
  process.exit(1);
}
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
await page.setUserAgent(
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
);
await page.setExtraHTTPHeaders({ "Accept-Language": "he,en;q=0.8" });
await page.goto(url, { waitUntil: "networkidle2", timeout: 25_000 });
await new Promise((r) => setTimeout(r, 1500));

const html = await page.content();
console.log("HTML size:", html.length);
const text = htmlToText(html);
console.log("\nText size:", text.length);
console.log("\n--- All numbers ≥6 digits or with comma groups (first 30) ---");
const numbers = text.match(/\d{1,3}(?:,\d{3})+|\d{6,}/g) || [];
console.log(numbers.slice(0, 30).join("\n"));
console.log("\n--- Currency-adjacent windows (first 10) ---");
const cur = /.{0,40}(?:₪|ש"ח|ש״ח|שח|NIS|nis).{0,40}/g;
let m;
let i = 0;
while ((m = cur.exec(text)) && i < 10) {
  console.log("  [" + m[0].replace(/\s+/g, " ").trim() + "]");
  i++;
}
console.log("\n--- Mentions of מיליון or מ-X ---");
const mil = /.{0,30}(?:מיליון|מ[-־]\d|מ\.\d|החל מ).{0,30}/g;
i = 0;
while ((m = mil.exec(text)) && i < 10) {
  console.log("  [" + m[0].replace(/\s+/g, " ").trim() + "]");
  i++;
}
console.log("\n--- Extractor output ---");
const prices = extractPrices(text);
if (prices.length === 0) console.log("  (none)");
for (const p of prices) console.log(`  ₪${p.value.toLocaleString("he-IL")}  matched="${p.matched}"`);

await browser.close();
