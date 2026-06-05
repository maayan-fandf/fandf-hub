// Generic probe: fetch any URL in puppeteer, run extractPrices on the
// rendered text, dump the inventory + headline. Useful for spot-checking
// extractor behavior on landing pages NOT in Keys yet.
//
//   node --experimental-strip-types scripts/probe-url.mjs "<url>"

import puppeteer from "puppeteer";
import {
  extractPrices,
  startingPrice,
  htmlToText,
} from "../lib/priceExtractor.ts";

const url = (process.argv[2] || "").trim();
if (!url) {
  console.error('Usage: node scripts/probe-url.mjs "<url>"');
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
await page.goto(url, { waitUntil: "networkidle2", timeout: 45_000 });
await new Promise((r) => setTimeout(r, 2500));
console.log(`Title: "${await page.title()}"`);
const html = await page.content();
const text = htmlToText(html);

console.log("\n── 'החל' neighbourhoods ─────────────────────");
const startRe = /החל\s*מ/g;
let m;
let n = 0;
while ((m = startRe.exec(text)) !== null && n < 12) {
  const a = Math.max(0, m.index - 80);
  const b = Math.min(text.length, m.index + 80);
  console.log(`  [@${m.index}] …${text.slice(a, b)}…`);
  n++;
}

console.log("\n── extractPrices() ─────────────────────────");
console.log(JSON.stringify(extractPrices(text), null, 2));

console.log("\n── startingPrice() ─────────────────────────");
console.log(JSON.stringify(startingPrice(text), null, 2));

await browser.close();
