"use client";

import { useState } from "react";
import PrisotDataTable from "./PrisotDataTable";
import PrisotThumb from "./PrisotThumb";
import type { PrisotData } from "@/lib/driveFolders";

/**
 * "📐 פריסה מאושרת" — lazily fetches the project's latest approved פריסה
 * (Drive spread) and shows it in a modal so a manager can validate the
 * live budget distribution against the approved media plan without
 * leaving the budget desk. Fetch happens on first open (Drive lookup is
 * ~0.5–2s), then cached in component state.
 */

type Prisa = {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string;
  folderUrl?: string;
  modifiedTime?: string;
  approvalState?: string;
  source?: string;
  isImage: boolean;
  isSheet: boolean;
  data: PrisotData | null;
};

export default function PrisaButton({
  company,
  project,
}: {
  company: string;
  project: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [prisa, setPrisa] = useState<Prisa | null>(null);
  const [loaded, setLoaded] = useState(false);

  async function openModal() {
    setOpen(true);
    if (loaded || loading) return;
    setLoading(true);
    setError("");
    try {
      const r = await fetch(
        `/api/campaigns/prisa?company=${encodeURIComponent(company)}&project=${encodeURIComponent(project)}`,
        { cache: "no-store" },
      );
      const d = (await r.json()) as { ok?: boolean; error?: string; prisa?: Prisa | null };
      if (!r.ok || !d.ok) {
        setError(d.error || "טעינה נכשלה");
      } else {
        setPrisa(d.prisa ?? null);
        setLoaded(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "טעינה נכשלה");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button type="button" className="budget-action-btn" onClick={openModal}>
        📐 פריסה מאושרת
      </button>
      {open && (
        <div
          className="prisa-overlay"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            className="prisa-modal"
            onClick={(e) => e.stopPropagation()}
            dir="rtl"
            role="dialog"
            aria-label={`פריסה מאושרת — ${project}`}
          >
            <div className="prisa-modal-head">
              <span className="prisa-modal-title">📐 פריסה מאושרת — {project}</span>
              <div className="prisa-modal-actions">
                {prisa?.folderUrl && (
                  <a
                    href={prisa.folderUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="budget-action-btn"
                  >
                    📁 תיקייה
                  </a>
                )}
                {prisa?.webViewLink && (
                  <a
                    href={prisa.webViewLink}
                    target="_blank"
                    rel="noreferrer"
                    className="budget-action-btn"
                  >
                    פתח בכרטיסייה ↗
                  </a>
                )}
                <button
                  type="button"
                  className="budget-action-btn"
                  onClick={() => setOpen(false)}
                  aria-label="סגור"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="prisa-modal-body">
              {loading && <div className="prisa-state">טוען פריסה…</div>}
              {error && <div className="prisa-state prisa-error">{error}</div>}
              {loaded && !loading && !prisa && (
                <div className="prisa-state">לא נמצאה פריסה לפרויקט זה.</div>
              )}
              {prisa && (
                <>
                  <div className="prisa-filemeta">
                    <span className="prisa-filename">{prisa.name}</span>
                    {prisa.approvalState === "approved" && (
                      <span className="prisot-approved-badge">✓ מאושר</span>
                    )}
                    {prisa.approvalState === "pending" && (
                      <span className="prisot-unapproved-badge">⏳ נשלח לאישור</span>
                    )}
                    {prisa.approvalState === "declined" && (
                      <span className="prisot-declined-badge">❌ נדחה</span>
                    )}
                    {prisa.source === "general" && (
                      <span className="prisot-source-badge">מתוך כללי</span>
                    )}
                  </div>
                  {prisa.isImage ? (
                    <div className="prisa-thumb-wrap">
                      <PrisotThumb
                        src={`/api/drive/image/${encodeURIComponent(prisa.id)}`}
                        alt={prisa.name}
                      />
                    </div>
                  ) : prisa.data ? (
                    <PrisotDataTable data={prisa.data} />
                  ) : (
                    <div className="prisa-thumb-wrap">
                      <PrisotThumb
                        src={`/api/drive/thumb/${encodeURIComponent(prisa.id)}`}
                        alt={prisa.name}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
