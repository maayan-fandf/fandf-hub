"use client";

/**
 * Google Drive Picker SDK wrapper — test-drive sibling of the inline
 * `DriveFolderPicker`. Mounts as a single button on `/tasks/new` next
 * to the existing custom picker so the user can compare both side-by-
 * side before we commit to one.
 *
 * Auth model — short version:
 *   - User OAuth `drive.file` scope (added to NextAuth on 2026-05-05;
 *     narrowest possible, NOT a Google "restricted" scope so we don't
 *     need annual app verification).
 *   - Browser API key (`NEXT_PUBLIC_GOOGLE_PICKER_API_KEY`) — designed
 *     to be public; lock it down in GCP with a referer + API
 *     restriction.
 *   - The user's `accessToken` flows from the NextAuth session callback
 *     to props on `TaskCreateForm`, then into this component.
 *
 * The Picker is modal: click button → Google iframe opens → user
 * picks → onPick fires with `{ id, name }`. Wire that into the parent's
 * folder-selection state alongside the inline picker so either path
 * produces the same `FolderPickerValue` shape.
 *
 * Loads google's `apis.google.com/js/api.js` once per page (lazy on
 * first button click — saves ~30KB on the cold render). Subsequent
 * clicks reuse the loaded SDK.
 */

import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    // The Picker SDK exposes itself on `window.google.picker.*` and the
    // shared loader on `window.gapi`. Typed as `any` here because
    // Google doesn't ship official TS types for the Picker SDK and
    // building accurate ones for an experimental surface isn't worth
    // the maintenance cost.
    google?: any;
    gapi?: any;
  }
}

export type DrivePickerPick = {
  id: string;
  name: string;
  /** "application/vnd.google-apps.folder" for folders. The new-task
   *  flow only allows folder picks today, but the field is exposed so
   *  callers wanting to extend to file-pickers can branch on it. */
  mimeType?: string;
};

type Props = {
  /** OAuth access_token from NextAuth session.user.accessToken. When
   *  empty, the button stays disabled with a tooltip explaining why. */
  accessToken: string | undefined | null;
  /** Browser API key. When empty, button disabled. */
  apiKey: string | undefined | null;
  /** When provided, scopes the Picker view to this folder's children
   *  (the F&F shared drive's project sub-folder). Optional — without it
   *  the Picker opens at "My Drive" root. */
  parentFolderId?: string;
  /** Fired once after a successful pick. Single-select today; expand
   *  the SDK call to allow multi later if needed. */
  onPick: (pick: DrivePickerPick) => void;
  /** Optional disabled override (e.g. when the parent form's project
   *  isn't selected yet). */
  disabled?: boolean;
};

const PICKER_SCRIPT_SRC = "https://apis.google.com/js/api.js";

export default function DrivePickerButton({
  accessToken,
  apiKey,
  parentFolderId,
  onPick,
  disabled,
}: Props) {
  const [sdkReady, setSdkReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Avoid loading the SDK twice if the user double-clicks before the
  // first load finishes. The ref tracks the in-flight Promise.
  const loadingRef = useRef<Promise<void> | null>(null);

  // Detect already-loaded SDK on mount — useful when navigating between
  // pages on the same hub session. No network on the second page.
  useEffect(() => {
    if (window.google?.picker) setSdkReady(true);
  }, []);

  function ensureSdkLoaded(): Promise<void> {
    if (sdkReady) return Promise.resolve();
    if (loadingRef.current) return loadingRef.current;
    loadingRef.current = new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(
        `script[src="${PICKER_SCRIPT_SRC}"]`,
      );
      const onLoaded = () => {
        if (!window.gapi) return reject(new Error("gapi unavailable"));
        window.gapi.load("picker", {
          callback: () => {
            setSdkReady(true);
            resolve();
          },
          onerror: () => reject(new Error("Picker SDK load failed")),
        });
      };
      if (existing) {
        // Script tag already in DOM (another component started loading
        // it); attach listener instead of duplicating the request.
        existing.addEventListener("load", onLoaded);
        existing.addEventListener("error", () =>
          reject(new Error("Picker script load failed")),
        );
        if ((existing as any).readyState === "complete") onLoaded();
      } else {
        const script = document.createElement("script");
        script.src = PICKER_SCRIPT_SRC;
        script.async = true;
        script.defer = true;
        script.onload = onLoaded;
        script.onerror = () =>
          reject(new Error("Picker script load failed"));
        document.head.appendChild(script);
      }
    });
    return loadingRef.current;
  }

  async function open() {
    if (!accessToken || !apiKey) return;
    setErr(null);
    setLoading(true);
    try {
      await ensureSdkLoaded();
      const view = new window.google.picker.DocsView(
        window.google.picker.ViewId.FOLDERS,
      )
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true)
        .setMimeTypes("application/vnd.google-apps.folder");
      // Scope the initial view to the project's parent folder when we
      // know it — keeps the user from getting lost in their personal
      // Drive. They can still navigate up/out via the Picker chrome.
      if (parentFolderId) view.setParent(parentFolderId);
      const picker = new window.google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(accessToken)
        .setDeveloperKey(apiKey)
        // Right-to-left UI to match the rest of the hub.
        .setLocale("he")
        .setTitle("בחר תיקייה ב-Drive")
        .setCallback((data: any) => {
          const Action = window.google.picker.Action;
          if (data.action === Action.PICKED) {
            const doc = data.docs?.[0];
            if (doc?.id) {
              onPick({
                id: String(doc.id),
                name: String(doc.name || ""),
                mimeType: doc.mimeType ? String(doc.mimeType) : undefined,
              });
            }
          }
          if (
            data.action === Action.CANCEL ||
            data.action === Action.PICKED
          ) {
            setLoading(false);
          }
        })
        .build();
      picker.setVisible(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }

  const cantUse = !accessToken || !apiKey;
  const hint = !apiKey
    ? "API key חסר — הגדר NEXT_PUBLIC_GOOGLE_PICKER_API_KEY"
    : !accessToken
      ? "צריך להתחבר מחדש (חסר Drive scope)"
      : undefined;

  return (
    <div className="drive-picker-button-row">
      <button
        type="button"
        className="btn-ghost btn-sm drive-picker-button"
        onClick={open}
        disabled={disabled || cantUse || loading}
        title={hint || "פתח Google Drive Picker"}
      >
        {loading ? "טוען Picker…" : "🆕 בחר עם Drive Picker (ניסיוני)"}
      </button>
      {err && (
        <span className="drive-picker-button-err" role="alert">
          שגיאה: {err}
        </span>
      )}
      {hint && !err && (
        <span className="drive-picker-button-hint">{hint}</span>
      )}
    </div>
  );
}
