/* eslint-disable */
/**
 * Probe: post a Card V2 message to a chat space, then PATCH it to confirm
 * round-trip update works. Validates the Path-C "Living Card" architecture
 * before we commit to building lib/chatMirror.ts.
 *
 * Run: node scripts/probe-chat-mirror.mjs
 *
 * Target space: צרפתי | כללי (spaces/AAQADrawbBo).
 * Subject: maayan@fandf.co.il (member of every F&F space).
 */
import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
function envFromFile(name) {
  const line = envText.split("\n").find((l) => l.startsWith(name + "="));
  return line ? line.replace(/^[^=]+=/, "") : "";
}

const SPACE_ID = "AAQADrawbBo"; // צרפתי | כללי
const SUBJECT = "maayan@fandf.co.il";

const raw = process.env.TASKS_SA_KEY_JSON || envFromFile("TASKS_SA_KEY_JSON");
if (!raw) {
  console.log("[FAIL] TASKS_SA_KEY_JSON not set");
  process.exit(1);
}
const k = JSON.parse(raw);

const auth = new google.auth.JWT({
  email: k.client_email,
  key: k.private_key,
  scopes: [
    "https://www.googleapis.com/auth/chat.messages",
    "https://www.googleapis.com/auth/chat.messages.readonly",
  ],
  subject: SUBJECT,
});

const chat = google.chat({ version: "v1", auth });

// Card v1: status badge + assignee + due + button. Mirrors the shape we'd ship.
function buildCard(status) {
  const palette = {
    "לבצע":   { hex: "#5b8def", emoji: "📋" },
    "בעבודה": { hex: "#f0a830", emoji: "🛠️" },
    "לאישור": { hex: "#a168e6", emoji: "👀" },
    "done":   { hex: "#2eb886", emoji: "✅" },
  };
  const p = palette[status] || palette["לבצע"];
  return {
    cardId: "task-mirror-probe",
    card: {
      header: {
        title: `${p.emoji} משימת PROBE`,
        subtitle: `סטטוס: ${status}`,
      },
      sections: [
        {
          widgets: [
            { decoratedText: { topLabel: "אחראי", text: "Nadav Eedelman" } },
            { decoratedText: { topLabel: "יעד", text: "2026-05-10" } },
            { decoratedText: { topLabel: "סבב", text: "#1" } },
          ],
        },
        {
          widgets: [
            {
              buttonList: {
                buttons: [
                  {
                    text: "פתח בהאב",
                    onClick: {
                      openLink: { url: "https://hub.fandf.co.il/tasks/T-PROBE" },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  };
}

function buildText(status) {
  const palette = {
    "לבצע":   "📋",
    "בעבודה": "🛠️",
    "לאישור": "👀",
    "done":   "✅",
  };
  const e = palette[status] || "📋";
  return [
    `${e} *משימת PROBE*`,
    `סטטוס: *${status}*`,
    `אחראי: Nadav Eedelman`,
    `יעד: 2026-05-10`,
    `סבב: #1`,
  ].join("\n");
}

const accessoryButton = {
  buttonList: {
    buttons: [
      {
        text: "פתח בהאב",
        onClick: { openLink: { url: "https://hub.fandf.co.il/tasks/T-PROBE" } },
      },
    ],
  },
};

async function run() {
  console.log("[1/3] Posting text + accessoryWidget to space …");
  let name;
  try {
    const created = await chat.spaces.messages.create({
      parent: `spaces/${SPACE_ID}`,
      requestBody: {
        text: buildText("בעבודה"),
        accessoryWidgets: [accessoryButton],
      },
    });
    name = created.data.name;
    console.log("    ✓ created:", name);
  } catch (e) {
    console.log("    ✗ create with accessoryWidgets failed:", e?.message);
    if (e?.response?.data) console.log("      detail:", JSON.stringify(e.response.data));
    // fallback: plain text only
    console.log("    → falling back to plain text only …");
    const created = await chat.spaces.messages.create({
      parent: `spaces/${SPACE_ID}`,
      requestBody: { text: buildText("בעבודה") + "\n\n→ https://hub.fandf.co.il/tasks/T-PROBE" },
    });
    name = created.data.name;
    console.log("    ✓ created (plain):", name);
  }

  await new Promise((r) => setTimeout(r, 5000));

  console.log("[2/3] PATCHing message to status='done' …");
  try {
    const patched = await chat.spaces.messages.patch({
      name,
      updateMask: "text,accessoryWidgets",
      requestBody: {
        text: buildText("done"),
        accessoryWidgets: [accessoryButton],
      },
    });
    console.log("    ✓ patched. lastUpdateTime:", patched.data.lastUpdateTime || "?");
  } catch (e) {
    console.log("    ✗ patch (with widgets) failed:", e?.message);
    // retry text-only
    try {
      const patched = await chat.spaces.messages.patch({
        name,
        updateMask: "text",
        requestBody: { text: buildText("done") + "\n\n→ https://hub.fandf.co.il/tasks/T-PROBE" },
      });
      console.log("    ✓ patched (text only). lastUpdateTime:", patched.data.lastUpdateTime || "?");
    } catch (e2) {
      console.log("    ✗ text-only patch also failed:", e2?.message);
      if (e2?.response?.data) console.log("      detail:", JSON.stringify(e2.response.data));
    }
  }

  console.log("[3/3] GET message back to verify final state …");
  try {
    const got = await chat.spaces.messages.get({ name });
    console.log("    ✓ text:", (got.data.text || "").split("\n").join(" | "));
    console.log("    ✓ has accessoryWidgets:", Array.isArray(got.data.accessoryWidgets) && got.data.accessoryWidgets.length > 0);
  } catch (e) {
    console.log("    ✗ get failed:", e?.message);
  }

  console.log("\nDONE — message:", name);
}

run().catch((e) => {
  console.log("[FATAL]", e?.message || e);
  if (e?.response?.data) console.log("detail:", JSON.stringify(e.response.data));
  process.exit(1);
});
