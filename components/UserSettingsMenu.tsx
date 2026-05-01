"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatDateTimeIso } from "@/lib/dateFormat";

type Prefs = {
  email_notifications: boolean;
  gtasks_sync: boolean;
  view_as_email: string;
  notifications_snooze_until: string;
  hide_archived: boolean;
  archive_after_days: string;
  gmail_customer_poll: boolean;
};

type Person = { email: string; name: string; role: string };

const DEFAULT_PREFS: Prefs = {
  email_notifications: true,
  gtasks_sync: true,
  view_as_email: "",
  notifications_snooze_until: "",
  hide_archived: true,
  archive_after_days: "14",
  gmail_customer_poll: false,
};

/** Snooze options offered in the gear menu. Stored as an absolute ISO
 *  timestamp on the user's prefs row so refreshes / new sessions
 *  honor the same window. Empty value = no snooze. */
const SNOOZE_OPTIONS: { val: string; label: string; ms: number }[] = [
  { val: "", label: "אל תשתיק", ms: 0 },
  { val: "1h", label: "שעה", ms: 60 * 60 * 1000 },
  { val: "today", label: "עד סוף היום", ms: 0 /* computed at click */ },
  { val: "7d", label: "7 ימים", ms: 7 * 24 * 60 * 60 * 1000 },
];

/** Resolve a snooze button label ("1h" / "today" / "7d" / "") to the
 *  ISO timestamp we should persist. Empty input clears the snooze. */
function computeSnoozeUntil(val: string): string {
  if (!val) return "";
  if (val === "today") {
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    return end.toISOString();
  }
  const opt = SNOOZE_OPTIONS.find((o) => o.val === val);
  if (!opt || !opt.ms) return "";
  return new Date(Date.now() + opt.ms).toISOString();
}

/** True when the persisted ISO matches the bucket the user is hovering.
 *  We treat any non-empty future ISO as the "active" state for ALL
 *  non-empty options together — the precise bucket isn't preserved on
 *  the row, so highlight collapses to "snoozed" vs "not snoozed". */
function isSnoozeActive(persistedIso: string, optionVal: string): boolean {
  const isCurrentlySnoozed =
    !!persistedIso && new Date(persistedIso).getTime() > Date.now();
  if (optionVal === "") return !isCurrentlySnoozed;
  return isCurrentlySnoozed;
}

/**
 * Topnav gear menu — per-user settings:
 *
 *   - email_notifications: toggle outbound emails for this user.
 *   - gtasks_sync: toggle whether the hub creates/updates this user's
 *     personal Google Tasks.
 *   - view_as_email: act as another user for default-filter purposes
 *     (managers reviewing employees, peers covering for someone on a
 *     holiday). Data access is unaffected.
 *
 * Loads prefs + people list lazily on first open. Saves on each toggle
 * with optimistic UI; reverts the toggle if the server rejects.
 */
/** Read the `hub_view_as` cookie. Empty string when not set or when
 *  document is not available (SSR shouldn't happen for this client
 *  component, but the guard is cheap). */
function readViewAsCookie(): string {
  if (typeof document === "undefined") return "";
  const m = document.cookie.match(/(?:^|;\s*)hub_view_as=([^;]+)/);
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]).toLowerCase().trim();
  } catch {
    return "";
  }
}

/** Set or clear the `hub_view_as` cookie. Empty value clears it. */
function writeViewAsCookie(value: string): void {
  if (typeof document === "undefined") return;
  const v = (value || "").toLowerCase().trim();
  if (!v) {
    document.cookie = `hub_view_as=; path=/; max-age=0; SameSite=Lax`;
    return;
  }
  document.cookie = `hub_view_as=${encodeURIComponent(v)}; path=/; SameSite=Lax`;
}

/** Admin section entries shown inline at the bottom of the gear menu
 *  for admins. Each links to its dedicated page; the page is the
 *  bidirectional editor (sheet ↔ UI) for that area. New admin tools
 *  are added here, not as separate top-nav entries. */
const ADMIN_LINKS: { href: string; label: string; emoji: string }[] = [
  { href: "/admin/names-to-emails", label: "שמות ואימיילים", emoji: "📇" },
  { href: "/admin/chat-spaces", label: "Chat Spaces", emoji: "💬" },
  { href: "/admin/user-prefs", label: "העדפות משתמשים", emoji: "👥" },
  { href: "/admin/task-form-schema", label: "סכמת טופס משימה", emoji: "📐" },
  { href: "/admin/keys", label: "Keys", emoji: "🔑" },
];

export default function UserSettingsMenu({
  myEmail,
  isAdmin,
}: {
  myEmail: string;
  /** When true, the menu renders an "Admin" section linking to the
   *  /admin/* pages. Replaces the old standalone NavAdminLink in the
   *  top nav. Server-computed in layout.tsx so the section can render
   *  on first paint without a /api/me round-trip. */
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Controlled draft for the view_as input — separate from `prefs`
  // so we can autosave with a debounce as the user types without
  // refetching prefs on every keystroke.
  const [viewAsDraft, setViewAsDraft] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);
  const viewAsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open || loadedRef.current) return;
    loadedRef.current = true;
    void loadAll();
  }, [open]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function loadAll() {
    setError(null);
    try {
      const [prefsRes, peopleRes] = await Promise.all([
        fetch("/api/me/prefs"),
        fetch("/api/people"),
      ]);
      const prefsData = (await prefsRes.json()) as
        | { ok: true; prefs: Prefs }
        | { ok: false; error: string };
      const peopleData = (await peopleRes.json()) as
        | { ok: true; people: Person[] }
        | { ok: false; error: string };
      if (!prefsRes.ok || !prefsData.ok) {
        throw new Error(("error" in prefsData && prefsData.error) || "prefs fetch failed");
      }
      setPrefs(prefsData.prefs);
      // View-as is now a session cookie (cleared on refresh / tab close).
      // Read it directly here instead of trusting the sheet's
      // view_as_email — the sheet pref is admin-only "default" plumbing
      // surfaced via /admin/user-prefs. Cookie always wins.
      setViewAsDraft(readViewAsCookie());
      if (peopleRes.ok && "ok" in peopleData && peopleData.ok) {
        setPeople(peopleData.people);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPrefs(DEFAULT_PREFS);
    }
  }

  // Apply a view-as cookie change. router.refresh() re-runs server
  // components (which read the cookie via getEffectiveViewAs) without
  // unloading the page. Crucially, it does NOT trigger beforeunload
  // — so the ViewAsBanner's beforeunload-clear handler doesn't wipe
  // the cookie we just set. (window.location.reload() *does* fire
  // beforeunload, which used to nuke the cookie before the new page
  // could read it — see the bug fix dated 2026-04-30.)
  const commitViewAs = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      const current = readViewAsCookie();
      if (trimmed === current) return;
      if (trimmed !== "" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
        // Ignore partial typing — only commit a full email or explicit
        // clear. Mirrors the old debounced save.
        return;
      }
      writeViewAsCookie(trimmed);
      router.refresh();
    },
    [router],
  );

  // Schedule a debounced commit so typing the email pauses ~600ms
  // before reloading.
  const scheduleViewAsSave = useCallback(
    (value: string) => {
      if (viewAsTimerRef.current) clearTimeout(viewAsTimerRef.current);
      viewAsTimerRef.current = setTimeout(() => {
        commitViewAs(value);
      }, 600);
    },
    [commitViewAs],
  );

  async function save(partial: Partial<Prefs>) {
    if (!prefs) return;
    setError(null);
    setBusy(Object.keys(partial).join(","));
    // Optimistic update — UI flips before the round-trip. If the
    // server rejects we re-load and restore the truth below.
    const optimistic = { ...prefs, ...partial };
    setPrefs(optimistic);
    try {
      // `keepalive: true` keeps the request in flight even if the user
      // navigates immediately after toggling — common for view_as,
      // where the user types an email then clicks a nav link before
      // the input's onBlur completes. Without keepalive, the fetch
      // would be aborted and the pref never reaches the sheet.
      const res = await fetch("/api/me/prefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(partial),
        keepalive: true,
      });
      const data = (await res.json()) as
        | { ok: true; prefs: Prefs }
        | { ok: false; error: string };
      if (!res.ok || !data.ok) {
        throw new Error(("error" in data && data.error) || "save failed");
      }
      setPrefs(data.prefs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Revert optimistic update by re-fetching.
      void loadAll();
    } finally {
      setBusy(null);
    }
  }

  // "Active view-as" is keyed off the cookie now (transient). The
  // viewAsDraft state mirrors the cookie via loadAll, so checking it
  // here keeps the trigger dot in sync without a fresh document.cookie
  // read on every render.
  const isViewingAs =
    !!viewAsDraft && viewAsDraft.toLowerCase() !== myEmail.toLowerCase();

  return (
    <div ref={wrapRef} className="settings-menu-wrap">
      <button
        type="button"
        className={`settings-menu-trigger${isViewingAs ? " is-viewing-as" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-label="הגדרות משתמש"
        aria-expanded={open}
        title={isViewingAs ? `מציג כ-${viewAsDraft}` : "הגדרות"}
      >
        ⚙️
        {isViewingAs && <span className="settings-menu-dot" aria-hidden />}
      </button>
      {open && (
        <div className="settings-menu themed-scrollbar" role="menu">
          {!prefs ? (
            <div className="settings-menu-loading">טוען…</div>
          ) : (
            <>
              <div className="settings-menu-section">
                <label className="settings-menu-toggle">
                  <input
                    type="checkbox"
                    checked={prefs.email_notifications}
                    disabled={busy === "email_notifications"}
                    onChange={(e) =>
                      save({ email_notifications: e.target.checked })
                    }
                  />
                  <span className="settings-menu-toggle-label">
                    התראות במייל
                    <small>הצמדות במשימות + ממתין לאישור + סיכום יומי</small>
                  </span>
                </label>
                <label className="settings-menu-toggle">
                  <input
                    type="checkbox"
                    checked={prefs.gtasks_sync}
                    disabled={busy === "gtasks_sync"}
                    onChange={(e) => save({ gtasks_sync: e.target.checked })}
                  />
                  <span className="settings-menu-toggle-label">
                    סנכרון Google Tasks
                    <small>הוספה ועדכון של משימות ברשימת ה-Tasks האישית</small>
                  </span>
                </label>
                <label className="settings-menu-toggle">
                  <input
                    type="checkbox"
                    checked={prefs.gmail_customer_poll}
                    disabled={busy === "gmail_customer_poll"}
                    onChange={(e) =>
                      save({ gmail_customer_poll: e.target.checked })
                    }
                  />
                  <span className="settings-menu-toggle-label">
                    מיילים מלקוחות
                    <small>
                      הצגת מיילים מלקוחות רשומים (Keys col E) מ-3 הימים
                      האחרונים, להמרה למשימה או להעברה לחלל הצ׳אט
                    </small>
                  </span>
                </label>
                {prefs.gmail_customer_poll && (
                  <Link
                    href="/customer-emails"
                    className="settings-menu-link"
                    onClick={() => setOpen(false)}
                  >
                    📩 פתח מיילים מלקוחות →
                  </Link>
                )}
              </div>

              <div className="settings-menu-section">
                <label className="settings-menu-toggle">
                  <input
                    type="checkbox"
                    checked={prefs.hide_archived}
                    disabled={busy === "hide_archived"}
                    onChange={(e) =>
                      save({ hide_archived: e.target.checked })
                    }
                  />
                  <span className="settings-menu-toggle-label">
                    הסתר משימות שבוצעו / בוטלו
                    <small>
                      ב‑/tasks הארכיון נכנס תחת תפריט נפתח. ניתן להציגו
                      בלחיצה על 📦 ארכיון או על ידי סינון לפי סטטוס.
                    </small>
                  </span>
                </label>
                <label className="settings-menu-input-row">
                  <span className="settings-menu-input-label">
                    ימים עד ארכיון
                    <small>
                      משימות שבוצעו / בוטלו לפני יותר מהמספר הזה נחשבות
                      ארכיון
                    </small>
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={365}
                    step={1}
                    className="settings-menu-input settings-menu-input-narrow"
                    value={prefs.archive_after_days}
                    disabled={busy === "archive_after_days"}
                    onChange={(e) =>
                      // Track the typed value as-is so the input stays
                      // controlled; only persist a valid clamped value.
                      void save({
                        archive_after_days: e.target.value,
                      })
                    }
                  />
                </label>
              </div>

              <div className="settings-menu-section">
                <div className="settings-menu-label">
                  השתק התראות בהאב
                  <small>
                    ההתראות עדיין נשמרות תחת 🔔 — רק הסימון האדום יושתק
                  </small>
                </div>
                <div
                  className="settings-menu-snooze-row"
                  role="radiogroup"
                  aria-label="השתק התראות"
                >
                  {SNOOZE_OPTIONS.map((opt) => {
                    const active = isSnoozeActive(
                      prefs.notifications_snooze_until,
                      opt.val,
                    );
                    return (
                      <button
                        key={opt.val}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={`settings-menu-snooze-btn${active ? " is-active" : ""}`}
                        onClick={() => {
                          const until = computeSnoozeUntil(opt.val);
                          void save({ notifications_snooze_until: until });
                        }}
                        disabled={busy === "notifications_snooze_until"}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                {prefs.notifications_snooze_until &&
                  new Date(prefs.notifications_snooze_until).getTime() >
                    Date.now() && (
                    <div className="settings-menu-hint">
                      🔕 מושתק עד{" "}
                      <span dir="ltr">
                        {formatDateTimeIso(prefs.notifications_snooze_until)}
                      </span>
                    </div>
                  )}
              </div>

              <div className="settings-menu-section">
                <div className="settings-menu-label">
                  הצג כ
                  <small>
                    סינון ברירת המחדל יחושב לפי המשתמש שתבחר. התיוג
                    מתאפס אוטומטית בריענון הדף או פתיחת חלון חדש.
                  </small>
                </div>
                <input
                  type="text"
                  list="settings-menu-people"
                  className="settings-menu-input"
                  placeholder="email או השאר ריק כדי להציג את עצמך"
                  value={viewAsDraft}
                  dir="ltr"
                  onChange={(e) => {
                    const v = e.target.value;
                    setViewAsDraft(v);
                    scheduleViewAsSave(v);
                  }}
                  onBlur={(e) => {
                    // Cancel any pending debounce and commit immediately
                    // — onBlur fires when the user clicks away or moves
                    // focus, so they expect their value to be saved now.
                    if (viewAsTimerRef.current) clearTimeout(viewAsTimerRef.current);
                    commitViewAs(e.currentTarget.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                />
                <datalist id="settings-menu-people">
                  {people.map((p) => (
                    <option key={p.email} value={p.email}>
                      {p.name} · {p.role}
                    </option>
                  ))}
                </datalist>
                {isViewingAs && (
                  <button
                    type="button"
                    className="settings-menu-link"
                    onClick={() => {
                      if (viewAsTimerRef.current) clearTimeout(viewAsTimerRef.current);
                      setViewAsDraft("");
                      commitViewAs("");
                    }}
                  >
                    חזור להציג את עצמי ({myEmail})
                  </button>
                )}
              </div>

              {isAdmin && (
                <div className="settings-menu-section settings-menu-admin">
                  <div className="settings-menu-label">
                    ⚙️ ניהול
                    <small>אזור אדמין — עריכת תצורה של המערכת</small>
                  </div>
                  <ul className="settings-menu-admin-list">
                    {ADMIN_LINKS.map((a) => (
                      <li key={a.href}>
                        <Link
                          href={a.href}
                          className="settings-menu-admin-link"
                          role="menuitem"
                          onClick={() => setOpen(false)}
                        >
                          <span aria-hidden>{a.emoji}</span>
                          {a.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {error && <div className="settings-menu-error">{error}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
