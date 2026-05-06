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
  // Current names_to_emails column values. Hebrew labels mirror
  // the Role column verbatim where possible — when the column
  // value is already a recognizable English term we keep it and
  // pair it with a contextual emoji.
  media:           { emoji: "📺", label: "media",        cls: "role-media" },
  manager:         { emoji: "👔", label: "manager",      cls: "role-account" },
  "client manager":{ emoji: "🤝", label: "client manager",cls: "role-account" },
  copywriter:      { emoji: "✍️", label: "copywriter",   cls: "role-creative" },
  art:             { emoji: "🎨", label: "art",          cls: "role-creative" },
  designer:        { emoji: "🖌️", label: "designer",     cls: "role-creative" },
  video:           { emoji: "🎬", label: "video",        cls: "role-creative" },
};

function lookup(role: string) {
  const key = String(role || "").toLowerCase().trim();
  return META[key];
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
