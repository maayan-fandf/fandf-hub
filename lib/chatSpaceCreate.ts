/**
 * Create a Google Chat space for a project + write the deep-link
 * back into the project's Keys row's `Chat Space` cell.
 *
 * Replaces the Apps Script `projectSpaceCreateForUser_` flow. Same
 * end result; runs entirely in hub-next via SA + DWD impersonation.
 *
 * Bidirectional sync principle holds: the cell stays the source of
 * truth (the hub reads it everywhere via `chatSpaceUrlFromWebhook`).
 * Admin can paste a URL into the cell directly and the hub picks it
 * up — this function is the "do both steps with one click" shortcut.
 */

import { revalidateTag } from "next/cache";
import { sheetsClient, chatSpaceCreateClient } from "@/lib/sa";
import { findChatSpaceColumnIndex, invalidateKeysCache } from "@/lib/keys";
import { chatSpaceUrlFromWebhook } from "@/lib/projectsDirect";

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function columnLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export type ChatSpaceCreateResult =
  | {
      ok: true;
      project: string;
      spaceName: string; // e.g. "spaces/AAAA..."
      spaceUri: string; // chat.google.com/room/<id>
      keysCellUrl: string; // mail-embedded deep-link as written to Keys
    }
  | {
      ok: false;
      error: string;
      /** When true, the user-facing "how to fix" hint should mention DWD
       *  scope setup. Returned for 403 / chat.spaces.create-related
       *  failures so the UI can render targeted help text. */
      howToFix?: string;
    };

export async function createChatSpaceForProject(
  adminEmail: string,
  projectName: string,
): Promise<ChatSpaceCreateResult> {
  const project = String(projectName ?? "").trim();
  if (!project) return { ok: false, error: "project required" };

  // Step 1: create the Space via Chat API.
  let spaceName = "";
  let spaceUri = "";
  try {
    const chat = chatSpaceCreateClient(adminEmail);
    const res = await chat.spaces.create({
      requestBody: {
        spaceType: "SPACE",
        displayName: project,
        externalUserAllowed: true,
      },
    });
    spaceName = res.data.name || "";
    spaceUri = res.data.spaceUri || "";
  } catch (e) {
    const code = (e as { code?: number; response?: { status?: number } }).code
      ?? (e as { response?: { status?: number } }).response?.status;
    const msg = e instanceof Error ? e.message : String(e);
    // `unauthorized_client` comes from google-auth-library during the
    // JWT.authorize() step — fired BEFORE any API call when the
    // requested scope isn't in the DWD allowlist. 403 is the same
    // condition surfacing from a successful token but rejected API
    // call. Treat both as "missing DWD scope".
    const isMissingScope =
      code === 403 ||
      /unauthorized_client/i.test(msg) ||
      /client not authorized/i.test(msg);
    if (isMissingScope) {
      return {
        ok: false,
        error: msg,
        howToFix:
          "DWD scope `https://www.googleapis.com/auth/chat.spaces.create` not granted. Workspace Admin → Security → API controls → Domain-wide delegation → client 102907403320696302169 → add the scope. (Propagation can take a few minutes after saving.)",
      };
    }
    return { ok: false, error: msg };
  }

  if (!spaceName) {
    return { ok: false, error: "Chat API returned no space name" };
  }

  // Normalize the Keys cell value. The hub's `chatSpaceUrlFromWebhook`
  // accepts any of four shapes; we write the mail-embedded form
  // because that's the most clickable from inside Workspace mail.
  const keysCellUrl =
    chatSpaceUrlFromWebhook(spaceUri || spaceName) || spaceName;

  // Step 2: write the URL back into the project's Keys row.
  try {
    const sheets = sheetsClient(adminEmail);
    const ssId = envOrThrow("SHEET_ID_MAIN");
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: ssId,
      range: "Keys",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const values = (res.data.values ?? []) as unknown[][];
    if (!values.length) {
      return {
        ok: false,
        error:
          "Space created but Keys lookup failed: empty Keys tab. Paste the URL manually: " +
          spaceUri,
      };
    }
    const headers = (values[0] as unknown[]).map((h) =>
      String(h ?? "")
        .replace(/[​-‏‪-‮⁠­﻿]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    );
    const iProj = headers.indexOf("פרוייקט");
    const iChat = findChatSpaceColumnIndex(headers);
    if (iProj < 0 || iChat < 0) {
      return {
        ok: false,
        error:
          "Space created but Keys is missing פרוייקט or Chat Space column. Paste manually: " +
          spaceUri,
      };
    }
    let rowIndex = -1;
    for (let r = 1; r < values.length; r++) {
      if (String(values[r][iProj] ?? "").trim() === project) {
        rowIndex = r;
        break;
      }
    }
    if (rowIndex < 0) {
      return {
        ok: false,
        error: `Space created but project "${project}" not found in Keys. Paste manually into the right row: ${spaceUri}`,
      };
    }
    const sheetRow = rowIndex + 1;
    const colA1 = columnLetter(iChat + 1);
    await sheets.spreadsheets.values.update({
      spreadsheetId: ssId,
      range: `Keys!${colA1}${sheetRow}`,
      valueInputOption: "RAW",
      requestBody: { values: [[keysCellUrl]] },
    });
    invalidateKeysCache();
    // Also bust the my-projects layer (separate unstable_cache wrapper
    // around getMyProjectsDirect with its own 60s TTL). Without this,
    // /projects/<name> would keep rendering the empty state for up to
    // 60s after the button click — projectMeta.chatSpaceUrl is built
    // inside that cached layer, not re-derived per request.
    revalidateTag("my-projects");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `Space created (${spaceUri}) but Keys write failed: ${msg}. Paste the URL manually.`,
    };
  }

  return { ok: true, project, spaceName, spaceUri, keysCellUrl };
}
