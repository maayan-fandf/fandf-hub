// CRM-funnel reconciliation harness — compares the Supabase BMBY warehouse
// numbers (what the Hub enrichment will surface) against Nadav's blessed
// definitions, so we can trust them before flipping SUPABASE_CRM_ENRICHMENT
// on in prod. Reads the key from .env.local like the other probes.
//
//   node scripts/diff-crm-funnel.mjs                 # נתיבות 2026-05 (known-good)
//   node scripts/diff-crm-funnel.mjs "אנדה" 2026-05
//
// Known-good baseline (Nadav, re-run 2026-06-14): נתיבות May →
//   leads 933 · held(authoritative) 45 · scheduled(meeting_seq=1) 193 ·
//   Σperformed_appointments 45 · Σapp_unique_coordinate 94.
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const [k, ...r] = l.split("=");
      return [k.trim(), r.join("=").trim().replace(/^["']|["']$/g, "")];
    }),
);
const KEY = env.SUPABASE_CRM_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
const BASE = (env.SUPABASE_URL || "https://zkuzyxrkqjtramucjhid.supabase.co/rest/v1/").replace(/\/?$/, "/");
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const PROJECT = (process.argv[2] || "נתיבות").trim();
const MONTH = (process.argv[3] || "2026-05").trim();
const from = `${MONTH}-01`;
const [y, m] = MONTH.split("-").map(Number);
const toExcl = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;

async function count(path) {
  const r = await fetch(BASE + path, { headers: { ...H, Prefer: "count=exact", Range: "0-0" } });
  const cr = r.headers.get("content-range");
  return cr ? Number(cr.split("/")[1]) : `err${r.status}`;
}
async function rows(path) {
  const r = await fetch(BASE + path, { headers: H });
  return r.ok ? await r.json() : [];
}

console.log(`\nReconciliation — ${PROJECT} · ${MONTH}  (window [${from}, ${toExcl}))\n`);

// Resolve project_id from the blessed project map.
const pr = await rows(`v_report_v2_bmby_projects?select=project_id,project_name&project_name=eq.${encodeURIComponent(PROJECT)}`);
if (!pr.length) {
  console.log(`✗ "${PROJECT}" not found in v_report_v2_bmby_projects — check the name (must match Keys.CRM).`);
  process.exit(1);
}
const projectId = pr[0].project_id;
console.log(`project_id = ${projectId}\n`);

const jm = `v_bmby_journey_meetings?project_he=eq.${encodeURIComponent(PROJECT)}&meeting_date=gte.${from}&meeting_date=lt.${toExcl}`;
const leads = await count(`v_bmby_leads_bucketed?project_id=eq.${projectId}&lead_created_at=gte.${from}&lead_created_at=lt.${toExcl}&select=lead_id`);
const heldAuth = await count(`${jm}&appointment_outcome=eq.held&select=meeting_id`);
const heldEst = await count(`${jm}&held=is.true&select=meeting_id`);
const canceled = await count(`${jm}&appointment_outcome=eq.canceled&select=meeting_id`);
const schedFirst = await count(`${jm}&meeting_seq=eq.1&select=meeting_id`);
const ag = await rows(`bmby_agent_summary?project=eq.${encodeURIComponent(PROJECT)}&month=eq.${from}&is_deleted=eq.false&select=app_unique_coordinate,performed_appointments`);
const sUC = ag.reduce((a, r) => a + (+r.app_unique_coordinate || 0), 0);
const sPA = ag.reduce((a, r) => a + (+r.performed_appointments || 0), 0);

const rowsOut = [
  ["leads created", leads, "v_bmby_leads_bucketed · project_id + lead_created_at"],
  ["held — AUTHORITATIVE", heldAuth, "appointment_outcome='held' (the trustworthy number)"],
  ["held — estimated", heldEst, "held=true (confirmed + status-inferred; over-counts)"],
  ["  of which canceled", canceled, "appointment_outcome='canceled'"],
  ["scheduled (first/lead)", schedFirst, "meeting_seq=1"],
  ["Σ performed_appointments", sPA, "bmby_agent_summary (should tie to authoritative held)"],
  ["Σ app_unique_coordinate", sUC, "bmby_agent_summary (BMBY 'תיאומים')"],
];
for (const [label, val, note] of rowsOut) {
  console.log(`  ${String(label).padEnd(26)} ${String(val).padStart(6)}   ${note}`);
}
console.log(`\n  cross-check: authoritative held (${heldAuth}) ${heldAuth === sPA ? "==" : "≠"} Σperformed_appointments (${sPA})  ${heldAuth === sPA ? "✓" : "⚠ investigate"}`);
if (PROJECT === "נתיבות" && MONTH === "2026-05") {
  const exp = { leads: 933, heldAuth: 45, schedFirst: 193, sPA: 45 };
  const ok = leads === exp.leads && heldAuth === exp.heldAuth && schedFirst === exp.schedFirst && sPA === exp.sPA;
  console.log(`  baseline (Nadav): leads 933 / held 45 / sched 193 / perf 45 → ${ok ? "ALL MATCH ✓" : "MISMATCH ⚠"}`);
}
console.log();
