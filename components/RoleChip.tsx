type Role =
  | "admin"
  | "campaign"
  | "account"
  | "internal"
  | "internal_cf"
  | "client"
  | string;

const META: Record<
  string,
  { emoji: string; label: string; cls: string }
> = {
  admin:       { emoji: "👑", label: "אדמין",       cls: "role-admin" },
  campaign:    { emoji: "🎯", label: "קמפיינים",   cls: "role-campaign" },
  account:     { emoji: "👔", label: "מנהל לקוח",  cls: "role-account" },
  internal:    { emoji: "🎨", label: "קריאייטיב",  cls: "role-creative" },
  internal_cf: { emoji: "🌈", label: "קריאייטיב",  cls: "role-creative-cf" },
  client:      { emoji: "🛍️", label: "לקוח",       cls: "role-client" },
};

/**
 * Small colored chip for a role — emoji + Hebrew label. Used in the
 * assignee picker, mention cards, task cards. Unknown roles fall back to
 * a neutral "chip" so the UI never explodes on new role names.
 */
export default function RoleChip({ role }: { role: Role }) {
  const m = META[role];
  if (!m) return <span className="chip chip-muted">{role}</span>;
  return (
    <span className={`chip chip-role ${m.cls}`} title={m.label}>
      <span aria-hidden>{m.emoji}</span> {m.label}
    </span>
  );
}
