import Link from "next/link";
import { auth } from "@/auth";
import { listNotifications, type NotificationRow } from "@/lib/notifications";
import { tasksPeopleList } from "@/lib/appsScript";
import NotificationsList from "@/components/NotificationsList";

export const dynamic = "force-dynamic";

type Search = { unread?: string };

const KIND_LABELS: Record<string, { emoji: string; label: string }> = {
  task_assigned: { emoji: "📋", label: "משימה חדשה" },
  task_unassigned: { emoji: "📋", label: "הוסרת ממשימה" },
  task_awaiting_approval: { emoji: "📋", label: "ממתינה לאישורך" },
  task_returned: { emoji: "↩️", label: "משימה הוחזרה" },
  task_done: { emoji: "✅", label: "משימה הושלמה" },
  task_cancelled: { emoji: "🚫", label: "משימה בוטלה" },
  comment_reply: { emoji: "💬", label: "תגובה חדשה" },
  mention: { emoji: "🏷️", label: "תויגת" },
};

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const unreadOnly = sp.unread === "1";
  const session = await auth();
  const email = session?.user?.email ?? "";
  let items: NotificationRow[] = [];
  let error = "";
  // People list parallels the items fetch so each notification's
  // actor email can resolve to a Hebrew display name in the list.
  const [, peopleRes] = await Promise.all([
    email
      ? listNotifications(email, { unreadOnly, limit: 100 })
          .then((r) => {
            items = r;
          })
          .catch((e) => {
            error = e instanceof Error ? e.message : String(e);
          })
      : Promise.resolve(),
    tasksPeopleList().catch(() => ({ ok: false, people: [] as never[] })),
  ]);
  const people = peopleRes.ok ? peopleRes.people : [];

  const unreadCount = items.filter((i) => !i.read_at).length;

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>
              🔔
            </span>
            התראות
          </h1>
          <div className="subtitle">
            כל מה שהאב היה שולח לך במייל — גם כאן, במקום אחד.
            כשמשהו דורש את תשומת הלב שלך הוא יופיע כאן וגם בתפריט הנעילה למעלה.
          </div>
        </div>
        <div className="header-actions">
          <Link
            href={unreadOnly ? "/notifications" : "/notifications?unread=1"}
            className="btn-ghost btn-sm"
          >
            {unreadOnly ? "הצג הכל" : "לא נקראו בלבד"}
          </Link>
        </div>
      </header>

      {error && (
        <div className="error">
          <strong>שגיאה בטעינת ההתראות.</strong>
          <br />
          {error}
        </div>
      )}

      {!error && items.length === 0 && (
        <div className="empty">
          <span className="emoji" aria-hidden>
            🌿
          </span>
          {unreadOnly ? "אין התראות חדשות." : "אין עדיין התראות."}
        </div>
      )}

      {items.length > 0 && (
        <NotificationsList
          items={items}
          unreadCount={unreadCount}
          kindLabels={KIND_LABELS}
          people={people}
        />
      )}
    </main>
  );
}
