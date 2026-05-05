/* eslint-disable */
// Adds the `pending_complete` column to the Comments tab — companion
// to the autoTransition banner-based confirmation flow shipped
// 2026-05-05. Idempotent: exits cleanly if the column already exists.
// Mirrors scripts/add-file-order-column.mjs.
import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local")
  ? fs.readFileSync(".env.local", "utf8")
  : "";
const env = (n) =>
  process.env[n] ||
  (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(
    /^[^=]+=/,
    "",
  );

const NEW_HEADER = "pending_complete";
const SUBJECT = "maayan@fandf.co.il";

const key = JSON.parse(env("TASKS_SA_KEY_JSON"));
const auth = new google.auth.JWT({
  email: key.client_email,
  key: key.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  subject: SUBJECT,
});
const sheets = google.sheets({ version: "v4", auth });
const ssId = env("SHEET_ID_COMMENTS");

const r = await sheets.spreadsheets.values.get({
  spreadsheetId: ssId,
  range: "Comments!1:1",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const headers = (r.data.values?.[0] ?? []).map((h) =>
  String(h ?? "").trim(),
);
console.log(`Current header count: ${headers.length}`);

if (headers.includes(NEW_HEADER)) {
  const idx = headers.indexOf(NEW_HEADER);
  console.log(`✓ Column "${NEW_HEADER}" already exists at index ${idx}.`);
  process.exit(0);
}

const meta = await sheets.spreadsheets.get({ spreadsheetId: ssId });
const commentsSheet = meta.data.sheets?.find(
  (s) => s.properties?.title === "Comments",
);
if (!commentsSheet || commentsSheet.properties?.sheetId == null) {
  console.error('Could not find sheet "Comments" in spreadsheet.');
  process.exit(1);
}
const sheetId = commentsSheet.properties.sheetId;
const currentColCount =
  commentsSheet.properties.gridProperties?.columnCount ?? 0;
console.log(`Current grid column count: ${currentColCount}`);

const newColIndex = headers.length;
const colLetter = (n) => {
  let s = "";
  let x = n;
  while (x >= 0) {
    s = String.fromCharCode((x % 26) + 65) + s;
    x = Math.floor(x / 26) - 1;
  }
  return s;
};
const cell = `${colLetter(newColIndex)}1`;

const requests = [];
if (currentColCount <= newColIndex) {
  requests.push({
    appendDimension: {
      sheetId,
      dimension: "COLUMNS",
      length: newColIndex + 1 - currentColCount,
    },
  });
  console.log(
    `Will append ${newColIndex + 1 - currentColCount} column(s) to fit the new header.`,
  );
}
requests.push({
  updateCells: {
    range: {
      sheetId,
      startRowIndex: 0,
      endRowIndex: 1,
      startColumnIndex: newColIndex,
      endColumnIndex: newColIndex + 1,
    },
    rows: [
      {
        values: [{ userEnteredValue: { stringValue: NEW_HEADER } }],
      },
    ],
    fields: "userEnteredValue",
  },
});

await sheets.spreadsheets.batchUpdate({
  spreadsheetId: ssId,
  requestBody: { requests },
});

console.log(
  `✓ Added "${NEW_HEADER}" at Comments!${cell} (column index ${newColIndex}).`,
);

const r2 = await sheets.spreadsheets.values.get({
  spreadsheetId: ssId,
  range: `Comments!${cell}`,
});
const wrote = String(r2.data.values?.[0]?.[0] ?? "");
if (wrote === NEW_HEADER) {
  console.log("✓ Verified — header is in place.");
} else {
  console.warn(
    `⚠ Verification mismatch: cell reads "${wrote}" instead of "${NEW_HEADER}".`,
  );
}
