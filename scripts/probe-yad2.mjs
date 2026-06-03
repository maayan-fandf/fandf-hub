// One-off diagnostic: open a Yad2 URL in puppeteer, dump what the
// price extractor sees in the rendered page text. Use it to debug
// "Yad2 returns no-price but I can see the price on the page".
//
//   node --experimental-strip-types scripts/probe-yad2.mjs "<url>"
//
// Prints:
//   - rendered title (sanity: were we served the listing or a bot page?)
//   - any text containing "החל" within ±60 chars (the anchor + neighbourhood)
//   - extractPrices() output
//   - startingPrice() output
import { readFileSync } from "node:fs";
import puppeteer from "puppeteer";
import { extractPrices, startingPrice, htmlToText } from "../lib/priceExtractor.ts";

const url = (process.argv[2] || "").trim();
if (!url) {
  console.error('Usage: node scripts/probe-yad2.mjs "<yad2-url>"');
  process.exit(1);
}

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=he-IL"],
});
const page = await browser.newPage();
await page.setUserAgent(
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
);
await page.setExtraHTTPHeaders({ "Accept-Language": "he,en;q=0.8" });
await page.setViewport({ width: 1280, height: 800 });
console.log(`navigating to ${url}…`);
await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
await new Promise((r) => setTimeout(r, 2000));
const title = await page.title();
console.log(`\nTitle: "${title}"`);
const html = await page.content();
console.log(`html length: ${html.length}`);
const text = htmlToText(html);
console.log(`text length: ${text.length}`);

console.log("\n── 'החל' neighbourhoods (±60 chars) ─────────────────────────");
const startRe = /החל\s*מ/g;
let m;
let n = 0;
while ((m = startRe.exec(text)) !== null && n < 8) {
  const a = Math.max(0, m.index - 60);
  const b = Math.min(text.length, m.index + 60);
  console.log(`  [@${m.index}] …${text.slice(a, b)}…`);
  n++;
}
if (n === 0) console.log("  (no 'החל' anchor found anywhere in the rendered text)");

console.log("\n── '3,199,000' / '3199000' raw matches ──────────────────────");
const moneyRe = /3[,.]?199[,.]?000|3199000/g;
n = 0;
while ((m = moneyRe.exec(text)) !== null && n < 8) {
  const a = Math.max(0, m.index - 60);
  const b = Math.min(text.length, m.index + 60);
  console.log(`  [@${m.index}] …${text.slice(a, b)}…`);
  n++;
}
if (n === 0) console.log("  (price string not present in the rendered text — page didn't load the listing description)");

console.log("\n── extractPrices() output ────────────────────────────────");
const all = extractPrices(text);
console.log(JSON.stringify(all, null, 2));

console.log("\n── startingPrice() output ────────────────────────────────");
console.log(JSON.stringify(startingPrice(text), null, 2));

await browser.close();
