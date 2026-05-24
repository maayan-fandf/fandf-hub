/* eslint-disable */
/** Probe ALL CLIENTS flight-date envelope for the 2 Salesforce projects. */
import { google } from "googleapis";
import fs from "node:fs";
const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
const env = (n) => process.env[n] || (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(/^[^=]+=/, "");
const k = JSON.parse(env("TASKS_SA_KEY_JSON"));
const jwt = (sc, subject = "maayan@fandf.co.il") => new google.auth.JWT({ email: k.client_email, key: k.private_key, scopes: sc, subject });
const SHEET_ID_MAIN = env("SHEET_ID_MAIN");
const sheets = google.sheets({ version: "v4", auth: jwt(["https://www.googleapis.com/auth/spreadsheets"]) });

const serialToIso = (v) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 25000 || v >= 80000) return "";
  return new Date((v - 25569) * 86400 * 1000).toISOString().slice(0, 10);
};

// Keys → slug (campaign ID) for the 2 projects
const keys = (await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID_MAIN, range: "Keys!A1:P200", valueRenderOption: "UNFORMATTED_VALUE" })).data.values || [];
const kh = (keys[0] || []).map((h) => String(h ?? "").replace(/\s+/g, " ").trim());
const kProj = kh.indexOf("פרוייקט"), kSlug = kh.indexOf("campaign ID");
const want = ["Essence", "שיכון ובינוי חולון"];
const slugs = {};
for (let r = 1; r < keys.length; r++) {
  const p = String(keys[r][kProj] ?? "").trim();
  if (want.includes(p)) slugs[p] = String(keys[r][kSlug] ?? "").trim();
}
console.log("slugs:", slugs);

// ALL CLIENTS
const ac = (await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID_MAIN, range: "ALL CLIENTS", valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER" })).data.values || [];
const ah = (ac[0] || []).map((h) => String(h ?? "").replace(/[​-‏‪-‮⁠­﻿]/g, "").replace(/\s+/g, " ").trim());
const iStart = ah.indexOf("התחלה"), iEnd = ah.indexOf("סיום"), iCh = ah.indexOf("מזהה BMBY");
const iSlug = ah.indexOf('מזהה מע"פ'), iRt = ah.indexOf("סוג שורה"), iProj = ah.indexOf("פרוייקט");
console.log(`cols: start=${iStart} end=${iEnd} channel=${iCh} slug=${iSlug} rowtype=${iRt} proj=${iProj}`);

for (const p of want) {
  const slug = (slugs[p] || "").toLowerCase();
  const pl = p.toLowerCase();
  let from = "", to = "";
  console.log(`\n=== ${p} (slug=${slugs[p]}) ===`);
  for (let r = 1; r < ac.length; r++) {
    const row = ac[r];
    if (String(row[iRt] ?? "").trim() !== "current") continue;
    const rp = String(row[iProj] ?? "").toLowerCase().trim();
    const rs = String(row[iSlug] ?? "").toLowerCase().trim();
    if (!((rp && rp === pl) || (slug && rs === slug))) continue;
    const s = serialToIso(row[iStart]), e = serialToIso(row[iEnd]);
    console.log(`   ch=${String(row[iCh] ?? "").trim().padEnd(18)} start=${s} end=${e}`);
    if (s && (!from || s < from)) from = s;
    if (e && (!to || e > to)) to = e;
  }
  console.log(`   ENVELOPE: ${from} → ${to}`);
}
