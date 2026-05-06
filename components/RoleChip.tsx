type Role = string;

/**
 * Role → emoji + chip class lookup. Two generations of values
 * coexist:
 *
 *   - LEGACY enum keys (`admin`, `campaign`, `account`, `internal`,
 *     `internal_cf`, `client`) — used by older surfaces (the older
 *     CreateTaskDrawer + InternalChatComposer paths)
 *   - CURRENT names_to_emails values, written by humans in the
 *     `Role` column of names_to_emails: `media`, `manager`,
 *     `client manager`, `copywriter`, `art`, `designer`, `video`
 *
 * Lookup is case-insensitive and trims whitespace, so the column
 * value can drift slightly without breaking the chip rendering.
 * Unknown roles fall back to a neutral muted chip so the UI never
 * explodes on a new role name nobody mapped yet.
 *
 * Reused on every people-picker surface (PersonCombobox /
 * PeopleMultiCombobox / CreateTaskDrawer / InternalChatComposer)
 * so role recognition feels consistent across the hub.
 */
const META: Record<
  string,
  { emoji: string; label: string; cls: string }
> = {
  // Legacy enum keys.
  admin:           { emoji: "👑", label: "אדמין",       cls: "role-admin" },
  campaign:        { emoji: "🎯", label: "קמפיינים",   cls: "role-campaign" },
  account:         { emoji: "👔", label: "מנהל לקוח",  cls: "role-account" },
  internal:        { emoji: "🎨", label: "קריאייטיב",  cls: "role-creative" },
  internal_cf:     { emoji: "🌈", label: "קריאייטיב",  cls: "role-creative-cf" },
  client:          { emoji: "🛍️", label: "לקוח",       cls: "role-client" },
  // Current names_to_emails column values (revised by Maayan
  // 2026-05-06). Hebrew labels mirror the Role column verbatim
  // where possible — when the column value is already a
  // recognizable English term we keep it and pair it with a
  // contextual emoji. Lookup is case-insensitive (lowercased on
  // entry) so the column can be written "Media" or "media" or
  // "MEDIA" with no behavioural change.
  media:           { emoji: "🎯", label: "media",         cls: "role-media" },
  manager:         { emoji: "👔", label: "manager",       cls: "role-account" },
  "client manager":{ emoji: "🤝", label: "client manager",cls: "role-account" },
  copywriter:      { emoji: "✍️", label: "copywriter",    cls: "role-creative" },
  art:             { emoji: "🎨", label: "art",           cls: "role-creative" },
  studio:          { emoji: "🖼️", label: "studio",        cls: "role-creative" },
  designer:        { emoji: "🖌️", label: "designer",      cls: "role-creative" },
  video:           { emoji: "🎬", label: "video",         cls: "role-creative" },
  // Hebrew legacy aliases — older tasks were created when the dept
  // sheet stored Hebrew strings ("מדיה" / "קריאייטיב" / etc.) before
  // the Role column was migrated to English. Mapping just the
  // unambiguous case here so the queue cell shows "🎯 media" instead
  // of bare "מדיה". The fuzzy ones (קריאייטיב, תכנון, אחר) stay
  // unmapped — caller decides how to display them.
  "מדיה":           { emoji: "🎯", label: "media",         cls: "role-media" },
};

function lookup(role: string) {
  const key = String(role || "").toLowerCase().trim();
  return META[key];
}

/** Bare-emoji lookup for surfaces that already have their own chip
 *  chrome (e.g. the dept multi-select on the task form). Returns "" for
 *  unknown / empty roles so callers can render `{emoji} {label}` and
 *  the missing emoji simply collapses without an awkward placeholder. */
export function roleEmoji(role: string): string {
  const m = lookup(role);
  return m ? m.emoji : "";
}

/** Canonical English label for a role string. Returns the META label
 *  when the input matches a known key (case-insensitive); falls back
 *  to the trimmed input when unknown. Used by surfaces that want the
 *  CONSISTENT spelling (e.g. the queue's dept cell) regardless of how
 *  the value drifted in storage. */
export function roleLabel(role: string): string {
  const m = lookup(role);
  return m ? m.label : (role || "").trim();
}

export default function RoleChip({ role }: { role: Role }) {
  const m = lookup(role);
  if (!m) {
    if (!role) return null;
    return <span className="chip chip-muted">{role}</span>;
  }
  return (
    <span className={`chip chip-role ${m.cls}`} title={m.label}>
      <span aria-hidden>{m.emoji}</span> {m.label}
    </span>
  );
}
