/**
 * Read-only iframe preview of a task's filled-in template, surfaced
 * at the top of /tasks/[id]'s body. Detected heuristically server-
 * side: any Google Doc/Sheet/Slides in the task's Drive folder whose
 * display name ends in "(טיוטה)" — the suffix `materializeDraft`
 * stamps onto template copies at task-creation time.
 *
 * Embed URL uses each editor's `/preview` path, which renders the
 * document content with no edit toolbar (Docs hides the menu bar
 * + sidebar; Sheets shows static cells; Slides shows static frames).
 * It's still authenticated via the user's Google session, so private
 * files only render for users with read access — no leak risk.
 *
 * The iframe is collapsible. Default-open so the preview is visible
 * the moment the page loads; users can collapse it if it gets in the
 * way of reading discussion / files. State is local (per-page-
 * session) so it doesn't need a server pref.
 */

"use client";

import { useState } from "react";

type Props = {
  fileId: string;
  fileName: string;
  /** Drive mime type — picks the right /preview URL path. */
  mimeType: string;
  /** Direct edit URL surfaced as a "פתח לעריכה" link so users can
   *  jump out of the read-only preview when they need to. */
  editUrl: string;
};

const PREVIEW_PATH_BY_MIME: Record<string, string> = {
  "application/vnd.google-apps.document": "document",
  "application/vnd.google-apps.spreadsheet": "spreadsheets",
  "application/vnd.google-apps.presentation": "presentation",
};

export default function TaskTemplatePreview({
  fileId,
  fileName,
  mimeType,
  editUrl,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const previewPath = PREVIEW_PATH_BY_MIME[mimeType];
  if (!previewPath) return null;
  const src = `https://docs.google.com/${previewPath}/d/${fileId}/preview`;
  return (
    <section
      className={`task-template-preview${
        collapsed ? " is-collapsed" : ""
      }`}
      aria-label={`תבנית: ${fileName}`}
    >
      <header className="task-template-preview-head">
        <span className="task-template-preview-chip">
          📄 תבנית — תצוגה מקדימה
        </span>
        <span className="task-template-preview-name" title={fileName}>
          {fileName}
        </span>
        <span className="task-template-preview-spacer" />
        <a
          href={editUrl}
          target="_blank"
          rel="noreferrer"
          className="task-template-preview-edit"
          title="פתח את התבנית לעריכה בכרטיסייה חדשה"
        >
          ↗ פתח לעריכה
        </a>
        <button
          type="button"
          className="task-template-preview-toggle"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          title={collapsed ? "הצג תבנית" : "הסתר תבנית"}
        >
          {collapsed ? "▾ הצג" : "▴ הסתר"}
        </button>
      </header>
      {!collapsed && (
        <iframe
          key={fileId}
          src={src}
          className="task-template-preview-iframe"
          title={fileName}
          loading="lazy"
        />
      )}
    </section>
  );
}
