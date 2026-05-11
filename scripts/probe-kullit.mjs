import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local")
  ? fs.readFileSync(".env.local", "utf8")
  : "";
const env = (n) =>
  process.env[n] ||
  (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(/^[^=]+=/, "");

const key = JSON.parse(env("TASKS_SA_KEY_JSON"));
const SUBJECT = "maayan@fandf.co.il";
const auth = new google.auth.JWT({
  email: key.client_email,
  key: key.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  subject: SUBJECT,
});
const sheets = google.sheets({ version: "v4", auth });
const MAIN = env("SHEET_ID_MAIN") || "15GKqEy8OelYtGuuiHYkSAR2xNNL4icwo-Wgiq1suW0Y";

const res = await sheets.spreadsheets.values.get({
  spreadsheetId: MAIN,
  range: "Keys",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const rows = res.data.values || [];
const headers = rows[0].map(h => String(h ?? "").trim());
const idx = name => headers.findIndex(h => h.trim().toLowerCase() === name.toLowerCase().trim());
const colProject = idx("פרוייקט");
const colCompany = idx("חברה");
const colCampaignId = idx("campaign ID");
const colCampaignMatch = idx("Campaign match");
const colCRM = idx("CRM");
const colCRMPlatform = idx("CRM platform");
const colChatSpace = idx("Chat Webhook");
const colInternal = idx("Access — internal only");
const colClientFacing = idx("Client-facing");
const colClientEmails = idx("clientEmails");

console.log("Header indices:", { colProject, colCompany, colCampaignId, colCampaignMatch });
console.log("Header sample:", headers.slice(0, 30));

console.log("\n=== All rows where company contains 'גיא' or 'ודורון' ===");
let any = false;
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const company = String(r[colCompany] ?? "");
  const project = String(r[colProject] ?? "");
  if (company.includes("גיא") || company.includes("דורון") || project.includes("גיא") || project.includes("דורון")) {
    any = true;
    console.log(`Row ${i+1}: project="${project}" company="${company}" campaign ID="${r[colCampaignId] ?? ""}" Campaign match="${r[colCampaignMatch] ?? ""}"`);
  }
}
if (!any) console.log("(none)");

console.log("\n=== All rows where project == 'כללי' ===");
let kullitCount = 0;
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const project = String(r[colProject] ?? "").trim();
  if (project === "כללי") {
    kullitCount++;
    console.log(`Row ${i+1}: company="${r[colCompany] ?? ""}" campaign ID="${r[colCampaignId] ?? ""}" Campaign match="${r[colCampaignMatch] ?? ""}"`);
  }
}
console.log(`Total כללי rows: ${kullitCount}`);
