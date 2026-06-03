// Quick exploration of how to find a project's Yad2 page by name.
// Tries several search URL patterns + scans the rendered DOM for
// `/yad1/project/{id}` links. Goal: validate one search pattern that
// reliably returns the right project's Yad2 ID.
//
// Usage:  node scripts/probe-yad2-search.mjs "שלישייה על הפארק"
import puppeteer from "puppeteer";

const query = process.argv[2] || "שלישייה על הפארק";
const PATTERNS = [
  // Generic /realestate/forsale with text query (most likely entry point)
  `https://www.yad2.co.il/realestate/forsale?text=${encodeURIComponent(query)}`,
  // Project-search prefix
  `https://www.yad2.co.il/yad1/projects?searchTerm=${encodeURIComponent(query)}`,
  // Site-wide search
  `https://www.yad2.co.il/s/search?q=${encodeURIComponent(query)}`,
];

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--lang=he-IL"],
});

for (const url of PATTERNS) {
  console.log(`\n━━━ ${url} ━━━`);
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "he,en;q=0.8" });
    const r = await page.goto(url, { waitUntil: "networkidle2", timeout: 25_000 });
    console.log(`  status: ${r?.status?.() || "?"}`);
    await new Promise((res) => setTimeout(res, 1500));
    // Find every /yad1/project/{id} link
    const projectLinks = await page.evaluate(() => {
      const out = new Set();
      for (const a of document.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/\/yad1\/project\/(?:[a-z-]+\/)?(\d+)/i);
        if (m) {
          // Also capture the link's visible text so we can match by name
          const text = (a.textContent || "").trim().slice(0, 100);
          out.add(JSON.stringify({ id: m[1], href, text }));
        }
      }
      return [...out];
    });
    if (projectLinks.length === 0) {
      console.log("  no /yad1/project/ links found");
    } else {
      console.log(`  ${projectLinks.length} project link(s):`);
      for (const j of projectLinks.slice(0, 8)) {
        const o = JSON.parse(j);
        console.log(`    id=${o.id}   text="${o.text}"`);
      }
    }
    // Also check the final URL (Yad2 may redirect)
    console.log(`  final url: ${page.url()}`);
  } catch (e) {
    console.log(`  error: ${e.message}`);
  } finally {
    await page.close();
  }
}

await browser.close();
