/**
 * Centralized date formatting for the hub.
 *
 * Convention (per user request 2026-05-01):
 *   - Absolute dates surface as ISO `yyyy-mm-dd`.
 *   - Absolute datetimes surface as `yyyy-mm-dd HH:MM` (24h).
 *   - Relative-time strings ("לפני שעתיים") stay as-is in their
 *     existing helpers — they're more useful than absolute dates
 *     for chat-like surfaces and aren't replaced.
 *
 * Both helpers accept any of: ISO string, Date object, epoch ms.
 * Returns "" for falsy / unparseable input so callers can skip with
 * a simple boolean check (`if (!s) return null`) instead of try/catch.
 *
 * The output format is locale-independent on purpose. Hebrew DD/MM/YYYY
 * was ambiguous next to English MM/DD/YYYY in mixed-language UI; ISO
 * sorts lexicographically and parses back as a Date constructor input.
 */

export function formatDateIso(input: string | Date | number | null | undefined): string {
  const d = parseAny(input);
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export function formatDateTimeIso(input: string | Date | number | null | undefined): string {
  const d = parseAny(input);
  if (!d) return "";
  const date = formatDateIso(d);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${date} ${hh}:${mm}`;
}

function parseAny(input: string | Date | number | null | undefined): Date | null {
  if (input == null || input === "") return null;
  if (input instanceof Date) {
    return Number.isFinite(input.getTime()) ? input : null;
  }
  const t = typeof input === "number" ? input : Date.parse(String(input));
  if (!Number.isFinite(t)) return null;
  return new Date(t);
}
