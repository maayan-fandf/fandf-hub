import type { PrisotCellFormat, PrisotData } from "@/lib/driveFolders";

/**
 * Renders parsed פריסה sheet data as an HTML table that approximates the
 * Google Sheets view (per-cell colors, bold/italic/underline, alignment,
 * merged cells, column widths, frozen-row header band). Shared by the
 * project page's LatestPrisotCard and the budget desk's פריסה-מאושרת
 * modal. Pure render — works in both server and client trees (the type
 * imports are erased at build).
 */
export default function PrisotDataTable({ data }: { data: PrisotData }) {
  const occupied = new Set<string>();
  const spanByAnchor = new Map<string, { rowSpan: number; colSpan: number }>();
  for (const m of data.merges) {
    spanByAnchor.set(`${m.r1},${m.c1}`, {
      rowSpan: m.r2 - m.r1,
      colSpan: m.c2 - m.c1,
    });
    for (let r = m.r1; r < m.r2; r++) {
      for (let c = m.c1; c < m.c2; c++) {
        if (r === m.r1 && c === m.c1) continue;
        occupied.add(`${r},${c}`);
      }
    }
  }

  const colCount = data.rows[0]?.length ?? 0;

  return (
    <div className="prisot-data" dir="rtl">
      <table className="prisot-data-table">
        {data.colWidths.length > 0 && (
          <colgroup>
            {data.colWidths.slice(0, colCount).map((w, i) => (
              <col key={i} style={{ width: `${Math.max(40, w)}px` }} />
            ))}
          </colgroup>
        )}
        <tbody>
          {data.rows.map((row, ri) => {
            const isFrozen = ri < data.frozenRows;
            return (
              <tr key={ri} className={isFrozen ? "prisot-data-header" : undefined}>
                {row.map((cell, ci) => {
                  if (occupied.has(`${ri},${ci}`)) return null;
                  const span = spanByAnchor.get(`${ri},${ci}`);
                  const fmt = data.formats[ri]?.[ci] ?? null;
                  return (
                    <td
                      key={ci}
                      rowSpan={span?.rowSpan}
                      colSpan={span?.colSpan}
                      style={cellStyle(fmt)}
                    >
                      {cell}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function cellStyle(
  fmt: PrisotCellFormat | null,
): React.CSSProperties | undefined {
  if (!fmt) return undefined;
  const s: React.CSSProperties = {};
  if (fmt.bg) s.backgroundColor = fmt.bg;
  if (fmt.fg) s.color = fmt.fg;
  if (fmt.bold) s.fontWeight = 700;
  if (fmt.italic) s.fontStyle = "italic";
  if (fmt.underline) s.textDecoration = "underline";
  if (fmt.fontSize) s.fontSize = `${fmt.fontSize}pt`;
  if (fmt.align) s.textAlign = fmt.align;
  if (fmt.wrap) {
    s.whiteSpace = "normal";
    s.wordBreak = "break-word";
  }
  return Object.keys(s).length === 0 ? undefined : s;
}
