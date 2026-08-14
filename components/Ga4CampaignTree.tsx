"use client";

import { useState } from "react";
import PlatformIcon from "@/components/PlatformIcon";
import { StandardHead, StandardCells } from "@/components/Ga4Columns";
// `import type` ONLY. lib/ga4Report imports lib/sa → googleapis, which
// needs node's `net`/`worker_threads`; importing any runtime VALUE from
// it here drags that whole chain into the client bundle and 500s the
// entire project page, not just this section. Types are erased at
// compile time and are safe — a value import is not.
import type { Ga4TreeNode, Ga4TreeView } from "@/lib/ga4Report";

/** The view labels live here rather than in ga4Report for the reason
 *  above: they are UI strings, and this is the only consumer. */
const GA4_TREE_VIEWS: { id: Ga4TreeView; label: string }[] = [
  { id: "adset", label: "קבוצות מודעות" },
  { id: "placement", label: "מיקומים" },
  { id: "ad", label: "מודעות" },
];

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
  trees,
  showConv,
}: {
  trees: Record<Ga4TreeView, Ga4TreeNode[]>;
  showConv: boolean;
}) {
  const [view, setView] = useState<Ga4TreeView>("adset");
  const [open, setOpen] = useState<Set<string>>(new Set());
  // Expanded keys are per view: a campaign's key is stable across views
  // but its children are not, so carrying the open set over would leave
  // rows expanded that no longer exist.
  const nodes = trees[view] ?? [];
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
        {/* Share is always of the CHANNEL total, at every depth — a
            campaign's 12% is 12% of the section's traffic, not of its
            own channel, so the numbers stay comparable down the tree. */}
        <StandardCells
          sessions={node.sessions}
          total={total}
          engagementRate={node.engagementRate}
          avgSeconds={node.avgSeconds}
          keyEvents={node.keyEvents}
          convRate={node.convRate}
          showConv={showConv}
        />
      </tr>,
    );
    for (const kid of node.children) walk(kid, depth + 1, isOpen);
  };
  for (const n of nodes) walk(n, 0, true);

  if (rows.length === 0) return null;

  return (
    <div className="ga4w-block">
      <div className="ga4w-tree-head">
        <h3 className="ga4w-h3">מאיפה הגיעה התנועה</h3>
        {/* Switches only the THIRD level. Channel and campaign rows are
            identical across views, so their numbers stay put while the
            breakdown underneath changes — which is what makes comparing
            the three worth doing. */}
        <div className="ga4w-viewsw" role="group" aria-label="רמת פילוח">
          {GA4_TREE_VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              className={"ga4w-viewsw-btn" + (v.id === view ? " is-active" : "")}
              aria-pressed={v.id === view}
              onClick={() => {
                setView(v.id);
                setOpen(new Set());
              }}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <div className="ga4w-table-wrap">
        <table className="ga4w-table ga4w-table-std ga4w-tree">
          <StandardHead first="ערוץ / קמפיין" showConv={showConv} />
          <tbody>{rows}</tbody>
        </table>
      </div>
      <div className="ga4w-note">
        לחיצה על ערוץ פותחת את הקמפיינים שלו, ולחיצה על קמפיין את הרמה
        שנבחרה למעלה.{" "}
        {view === "adset" &&
          "קבוצת מודעות נלקחת מ-ad group בגוגל ומ-utm_term במטא."}
        {view === "placement" &&
          "מיקום נלקח מ-utm_medium — במטא זהו מיקום המודעה (פיד, סטוריז, טור ימני)."}
        {view === "ad" && "מודעה נלקחת מ-utm_content."}
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
  if (plural === "מיקומים") return "מיקום";
  return plural ?? "";
}

