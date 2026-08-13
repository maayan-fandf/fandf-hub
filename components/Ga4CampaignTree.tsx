"use client";

import { useState } from "react";
import PlatformIcon from "@/components/PlatformIcon";
import type { Ga4TreeNode } from "@/lib/ga4Report";

/**
 * channel → campaign → ad group / ad, expandable.
 *
 * Replaces the flat campaign table. The whole tree ships with the page
 * and expands client-side: it is ~60-150 rows on a real property, which
 * is far cheaper than a fetch per level and makes expansion instant.
 *
 * Channels start collapsed. A media buyer opens the one channel they are
 * asking about, and auto-expanding would put a hundred rows on screen to
 * answer a question nobody asked.
 *
 * The third level is named per branch, not globally: Google gives real
 * ad-group names while Meta leaves that dimension unset and puts the AD
 * in utm_content, so the same depth means different things and the tree
 * says which via each node's `childLabel`.
 */
export default function Ga4CampaignTree({
  nodes,
  showConv,
}: {
  nodes: Ga4TreeNode[];
  showConv: boolean;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const total = nodes.reduce((n, x) => n + x.sessions, 0);

  const rows: React.ReactNode[] = [];
  const walk = (node: Ga4TreeNode, depth: number, visible: boolean) => {
    if (!visible) return;
    const hasKids = node.children.length > 0;
    const isOpen = open.has(node.key);
    rows.push(
      <tr
        key={node.key}
        className={
          `ga4w-tree-row is-d${depth}` +
          (hasKids ? " is-parent" : "") +
          (isOpen ? " is-open" : "")
        }
        onClick={hasKids ? () => toggle(node.key) : undefined}
      >
        <td className="ga4w-tree-name">
          <span style={{ paddingInlineStart: `${depth * 1.1}rem` }} />
          {hasKids ? (
            <span className="ga4w-tree-caret" aria-hidden>
              {isOpen ? "▾" : "▸"}
            </span>
          ) : (
            <span className="ga4w-tree-caret is-leaf" aria-hidden />
          )}
          {depth === 0 && <PlatformIcon platform={node.platform} size="1.05em" />}
          <span className={depth === 0 ? "ga4w-tree-lbl is-chan" : "ga4w-tree-lbl"}>
            {node.label}
          </span>
          {hasKids && (
            <span className="ga4w-tree-count">
              {node.children.length} {childWord(node.children.length, node.childLabel)}
            </span>
          )}
        </td>
        <td>{fmtInt(node.sessions)}</td>
        <td>{total > 0 ? fmtPct(node.sessions / total) : "—"}</td>
        {showConv && <td>{fmtInt(node.keyEvents)}</td>}
        {showConv && <td>{fmtPct(node.convRate)}</td>}
      </tr>,
    );
    for (const kid of node.children) walk(kid, depth + 1, isOpen);
  };
  for (const n of nodes) walk(n, 0, true);

  if (rows.length === 0) return null;

  return (
    <div className="ga4w-block">
      <h3 className="ga4w-h3">פילוח לפי ערוץ וקמפיין</h3>
      <div className="ga4w-table-wrap">
        <table className="ga4w-table ga4w-tree">
          <thead>
            <tr>
              <th>ערוץ / קמפיין</th>
              <th>כניסות</th>
              <th>חלק</th>
              {showConv && <th>אירועי מפתח</th>}
              {showConv && <th>שיעור המרה</th>}
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
      <div className="ga4w-note">
        לחיצה על ערוץ פותחת את הקמפיינים שלו, ולחיצה על קמפיין את קבוצות
        המודעות (בגוגל) או המודעות (במטא). ״חלק״ מחושב מסך הכניסות מקמפיינים
        בתקופה.
      </div>
    </div>
  );
}

/** Hebrew reads "1 קמפיינים" as broken. Singular forms for a count
 *  of one; the plural label the node already carries otherwise. */
function childWord(n: number, plural?: string): string {
  if (n !== 1) return plural ?? "";
  if (plural === "קמפיינים") return "קמפיין";
  if (plural === "קבוצות מודעות") return "קבוצת מודעות";
  if (plural === "מודעות") return "מודעה";
  return plural ?? "";
}

function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}
function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;
}
