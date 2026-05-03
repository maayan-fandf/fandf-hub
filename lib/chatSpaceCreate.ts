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
import { parseSpaceId } from "@/lib/chat";

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
  /**
   * Disambiguator for project names that recur across companies (כללי
   * has 4 rows, אחוזת אפרידר 2, …). When supplied, the (project,
   * company) tuple gates BOTH the idempotency pre-read AND the Keys
   * write target, so we don't read a sibling company's existing space
   * id or write the new URL into the wrong row. Optional — falls back
   * to first-by-name match when omitted (legacy /admin/chat-spaces
   * caller, where unique-by-name was implicit).
   */
  companyHint?: string,
): Promise<ChatSpaceCreateResult> {
  const project = String(projectName ?? "").trim();
  if (!project) return { ok: false, error: "project required" };
  const companyFilter = String(companyHint ?? "").trim();
  // Locate the right Keys row when the project name is non-unique.
  // Prefer (project, company) when companyFilter is supplied. When the
  // tuple doesn't match anything in Keys we deliberately do NOT fall
  // back to first-by-name — the caller knows the company, so a name-
  // only match would silently target the wrong row (this is exactly
  // the bug that bit the 2026-05-03 כללי report). Returns -1 in that
  // case so the caller can preflight before creating an orphan space.
  const findRowIndex = (
    values: unknown[][],
    iProj: number,
    iCo: number,
  ): number => {
    let firstByName = -1;
    for (let r = 1; r < values.length; r++) {
      if (String(values[r][iProj] ?? "").trim() !== project) continue;
      if (firstByName === -1) firstByName = r;
      if (!companyFilter) return r;
      if (
        iCo >= 0 &&
        String(values[r][iCo] ?? "").trim() === companyFilter
      ) {
        return r;
      }
    }
    // companyFilter not supplied → first-by-name (legacy behavior).
    // companyFilter supplied but no exact match → -1 (strict).
    return companyFilter ? -1 : firstByName;
  };

  // Step 0: pre-read Keys for two purposes:
  //   (a) Grab company so the displayName follows the canonical
  //       "<company> | <project>" convention (project names alone
  //       collide across companies — 4× כללי, 2× אחוזת אפרידר, etc.).
  //   (b) IDEMPOTENT GUARD — if Keys already references a real Chat
  //       space for this project, return it instead of creating a
  //       duplicate. Without this guard, repeated button clicks (or
  //       page-state staleness leaving the create-button visible
  //       even after a successful create) bleed orphan spaces into
  //       the workspace. Today's chat-space inventory shows the
  //       result: many empty duplicates needing manual cleanup.
  let company = "";
  let existingSpaceId = "";
  // Tracks whether the pre-read SUCCESSFULLY ran (regardless of match
  // outcome). When pre-read throws (Sheets API down, perms drift, …)
  // we don't know whether the row exists — skip the strict preflight
  // below rather than fail-closed on infra blips.
  let preReadOk = false;
  // -1 means "row not found in Keys"; only meaningful when preReadOk
  // is true. Used by the preflight to refuse creating an orphan space
  // when the caller passed a company hint but Keys has no row for the
  // (project, company) tuple. Common with `כללי` rows, which are
  // user-created on demand (memory: project_general_project_manual).
  let foundRowIndex = -1;
  try {
    const preReadSheets = sheetsClient(adminEmail);
    const ssId = envOrThrow("SHEET_ID_MAIN");
    const r = await preReadSheets.spreadsheets.values.get({
      spreadsheetId: ssId,
      range: "Keys",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    preReadOk = true;
    const values = (r.data.values ?? []) as unknown[][];
    if (values.length) {
      const headers = (values[0] as unknown[]).map((h) =>
        String(h ?? "").replace(/[​-‏‪-‮⁠­﻿]/g, "").replace(/\s+/g, " ").trim(),
      );
      const iProj = headers.indexOf("פרוייקט");
      const iCo = headers.indexOf("חברה");
      const iChat = findChatSpaceColumnIndex(headers);
      if (iProj >= 0) {
        const r = findRowIndex(values, iProj, iCo);
        foundRowIndex = r;
        if (r >= 1) {
          company = iCo >= 0 ? String(values[r][iCo] ?? "").trim() : "";
          existingSpaceId =
            iChat >= 0 ? parseSpaceId(String(values[r][iChat] ?? "").trim()) : "";
        }
      }
    }
  } catch {
    // Non-fatal — if pre-read fails we just create without the company
    // prefix and skip the idempotency check. The downstream Keys-write
    // step will surface a clearer error if Keys is genuinely
    // unreachable.
  }

  // Preflight: the caller passed a company hint but Keys has no row
  // for the (project, company) tuple. Refuse to create the Chat space
  // — it would land as an orphan that the user has to clean up
  // manually. For כללי this usually means "add the row to Keys first".
  if (preReadOk && companyFilter && foundRowIndex < 0) {
    return {
      ok: false,
      error: `אין שורה ב-Keys עבור (${project}, ${companyFilter}). הוסף את השורה לפני יצירת חלל הצ׳אט.`,
    };
  }

  // (b) Idempotency: if a space is already linked, return early. The
  // caller (CreateChatSpaceButton on the project page) will treat
  // this as success — router.refresh() picks up the existing URL on
  // the next render, exactly the same as a fresh create would.
  if (existingSpaceId) {
    const keysCellUrl = `https://mail.google.com/chat/u/0/#chat/space/${existingSpaceId}`;
    return {
      ok: true,
      project,
      spaceName: `spaces/${existingSpaceId}`,
      spaceUri: keysCellUrl,
      keysCellUrl,
    };
  }

  const displayName = company ? `${company} | ${project}` : project;

  // Step 1: create the Space via Chat API.
  let spaceName = "";
  let spaceUri = "";
  try {
    const chat = chatSpaceCreateClient(adminEmail);
    const res = await chat.spaces.create({
      requestBody: {
        spaceType: "SPACE",
        displayName,
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
    const iCo = headers.indexOf("חברה");
    const iChat = findChatSpaceColumnIndex(headers);
    if (iProj < 0 || iChat < 0) {
      return {
        ok: false,
        error:
          "Space created but Keys is missing פרוייקט or Chat Space column. Paste manually: " +
          spaceUri,
      };
    }
    const rowIndex = findRowIndex(values, iProj, iCo);
    if (rowIndex < 0) {
      const scope = companyFilter ? ` (company "${companyFilter}")` : "";
      return {
        ok: false,
        error: `Space created but project "${project}"${scope} not found in Keys. Paste manually into the right row: ${spaceUri}`,
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
