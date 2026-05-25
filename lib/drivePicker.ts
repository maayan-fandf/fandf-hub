"use client";

/**
 * Shared Google Drive Picker SDK helpers — load the SDK once and open a
 * folder-scoped picker. Extracted from DrivePickerButton so the per-
 * folder-row "פתח ב-Picker" icon in DriveFolderPicker can open a picker
 * rooted at ANY folder id without duplicating the SDK bootstrap.
 *
 * Auth model (same as DrivePickerButton): user OAuth `drive.file` token
 * + public browser API key. Both flow from the NextAuth session into the
 * form props, then here.
 */

declare global {
  interface Window {
    // Google ships no official TS types for the Picker SDK — `any` is
    // intentional (see DrivePickerButton for the same note).
    google?: any;
    gapi?: any;
  }
}

const PICKER_SCRIPT_SRC = "https://apis.google.com/js/api.js";
// Module-level singleton so multiple callers (the standalone button +
// every per-row icon) share one script load.
let loadPromise: Promise<void> | null = null;

export function ensurePickerSdk(): Promise<void> {
  if (typeof window !== "undefined" && window.google?.picker) {
    return Promise.resolve();
  }
  if (loadPromise) return loadPromise;
  loadPromise = new Promise<void>((resolve, reject) => {
    const onLoaded = () => {
      if (!window.gapi) return reject(new Error("gapi unavailable"));
      window.gapi.load("picker", {
        callback: () => resolve(),
        onerror: () => reject(new Error("Picker SDK load failed")),
      });
    };
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${PICKER_SCRIPT_SRC}"]`,
    );
    if (existing) {
      existing.addEventListener("load", onLoaded);
      existing.addEventListener("error", () =>
        reject(new Error("Picker script load failed")),
      );
      if (
        (existing as unknown as { readyState?: string }).readyState ===
        "complete"
      ) {
        onLoaded();
      }
    } else {
      const script = document.createElement("script");
      script.src = PICKER_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onload = onLoaded;
      script.onerror = () => reject(new Error("Picker script load failed"));
      document.head.appendChild(script);
    }
  });
  return loadPromise;
}

export type DrivePickerFolderPick = {
  id: string;
  name: string;
  mimeType?: string;
};

/**
 * Open a folder-select Drive Picker rooted at `parentFolderId` (or at My
 * Drive root when omitted). Folder picks fire `onFolderPick`; file picks
 * open in a new tab (browse semantics, same as DrivePickerButton).
 */
export async function openDrivePicker(opts: {
  accessToken: string;
  apiKey: string;
  parentFolderId?: string;
  onFolderPick: (pick: DrivePickerFolderPick) => void;
  onError?: (msg: string) => void;
}): Promise<void> {
  const { accessToken, apiKey, parentFolderId, onFolderPick, onError } = opts;
  if (!accessToken || !apiKey) return;
  try {
    await ensurePickerSdk();
    const view = new window.google.picker.DocsView()
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true);
    if (parentFolderId) view.setParent(parentFolderId);

    const picker = new window.google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(accessToken)
      .setDeveloperKey(apiKey)
      .setLocale("he")
      .setTitle("בחר ב-Drive")
      .setCallback((data: any) => {
        const Action = window.google.picker.Action;
        if (data.action !== Action.PICKED) return;
        const FOLDER_MIME = "application/vnd.google-apps.folder";
        const docs = data.docs || [];
        const folderDoc = docs.find(
          (d: any) => d?.mimeType === FOLDER_MIME && d?.id,
        );
        if (folderDoc) {
          onFolderPick({
            id: String(folderDoc.id),
            name: String(folderDoc.name || ""),
            mimeType: String(folderDoc.mimeType),
          });
        } else {
          for (const d of docs) {
            if (d?.url) {
              window.open(String(d.url), "_blank", "noopener,noreferrer");
            }
          }
        }
      })
      .build();
    picker.setVisible(true);
  } catch (e) {
    onError?.(e instanceof Error ? e.message : String(e));
  }
}
