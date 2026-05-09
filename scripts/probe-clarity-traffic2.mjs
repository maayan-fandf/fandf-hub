/* eslint-disable */
import fs from "node:fs";
const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
const env = (n) => process.env[n] || (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(/^[^=]+=/, "");
import { google } from "googleapis";
const key = JSON.parse(env("TASKS_SA_KEY_JSON"));
const auth = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: ["https://www.googleapis.com/auth/spreadsheets"], subject: "maayan@fandf.co.il" });
const sheets = google.sheets({ version: "v4", auth });
const r = await sheets.spreadsheets.values.get({ spreadsheetId: env("SHEET_ID_MAIN"), range: "Keys", valueRenderOption: "UNFORMATTED_VALUE" });
const rows = r.data.values ?? [];
const headers = (rows[0] ?? []).map((h) => String(h ?? "").trim());
const found = rows.find((r) => String(r[headers.indexOf("פרוייקט")] ?? "").trim() === "קאזר");
const tok = String(found[headers.indexOf("Clarity API Token")] ?? "").trim();
const targetUrl = String(found[headers.indexOf("Landing URL")] ?? "").trim();

const res = await fetch(`https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=3&dimension1=URL`, { headers: { authorization: `Bearer ${tok}` } });
const parsed = JSON.parse(await res.text());

console.log(`Looking for URL match against: ${targetUrl}`);
console.log(`\n=== sample of metric blocks + their information shapes ===`);
for (const block of parsed) {
  console.log(`\n[${block.metricName}] rows=${block.information?.length ?? 0}`);
  if (block.information?.[0]) {
    console.log(`  keys: ${Object.keys(block.information[0]).join(", ")}`);
    console.log(`  sample row: ${JSON.stringify(block.information[0])}`);
  }
}

const traffic = parsed.find((b) => b.metricName === "Traffic");
const norm = (u) => String(u || "").toLowerCase().replace(/\/+$/, "").replace(/^https?:\/\//, "").replace(/^www\./, "");
const matchUrl = (cellUrl, target) => norm(cellUrl) === norm(target);

const matched = traffic.information.filter((row) => matchUrl(row.Url, targetUrl));
console.log(`\nMatched URL rows for קאזר: ${matched.length}`);
for (const m of matched.slice(0, 5)) console.log(`  ${m.Url} → sessions=${m.totalSessionCount}, distinctUsers=${m.distinctUserCount}`);
const totalForUrl = matched.reduce((a, b) => a + Number(b.totalSessionCount ?? 0), 0);
console.log(`\nSum of sessions for קאזר URL: ${totalForUrl}`);

const found2 = rows.find((r) => String(r[headers.indexOf("פרוייקט")] ?? "").trim() === "מרום ראשון");
const targetUrl2 = String(found2[headers.indexOf("Landing URL")] ?? "").trim();
const matched2 = traffic.information.filter((row) => matchUrl(row.Url, targetUrl2));
console.log(`\nLooking for ${targetUrl2}: matched=${matched2.length}, sessions=${matched2.reduce((a, b) => a + Number(b.totalSessionCount ?? 0), 0)}`);

const uniqUrls = new Set(traffic.information.map((r) => r.Url).filter(Boolean));
console.log(`\nDistinct URLs in workspace (first 30):`);
[...uniqUrls].slice(0, 30).forEach((u) => console.log(`  ${u}`));
console.log(`\nTotal distinct: ${uniqUrls.size}`);

// Check if any URLs contain "cazar" or "marom"
console.log(`\nURLs containing 'cazar':`);
[...uniqUrls].filter((u) => String(u).toLowerCase().includes("cazar")).forEach((u) => console.log(`  ${u}`));
console.log(`URLs containing 'marom' or 'muman':`);
[...uniqUrls].filter((u) => /marom|muman/i.test(String(u))).slice(0, 10).forEach((u) => console.log(`  ${u}`));
