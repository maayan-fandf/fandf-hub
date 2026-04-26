import Link from "next/link";
import {
  getMyProjects,
  tasksPeopleList,
  currentUserEmail,
} from "@/lib/appsScript";
import TaskCreateForm from "@/components/TaskCreateForm";
import { getCommentByIdDirect } from "@/lib/commentsDirect";

export const dynamic = "force-dynamic";

type Search = {
  project?: string;
  company?: string;
  /** When set, /tasks/new pre-fills the form from the source comment's
   *  body / mentions / project. Used by the "המר למשימה" button on
   *  comment cards across the app — converts a legacy תגובה into a
   *  full work task without losing the original context. */
  from_comment?: string;
};

export default async function NewTaskPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  // Four independent fetches, all server-side so the form renders with
  // everything pre-populated (no loading spinners). The comment fetch
  // is skipped when `from_comment` isn't set — the common path.
  const [projectsRes, peopleRes, me, commentSeed] = await Promise.all([
    getMyProjects().catch(() => null),
    tasksPeopleList().catch(() => ({ ok: false, people: [] })),
    currentUserEmail().catch(() => ""),
    sp.from_comment
      ? (async () => {
          const email = await currentUserEmail().catch(() => "");
          if (!email) return null;
          return getCommentByIdDirect(email, sp.from_comment!).catch(() => null);
        })()
      : Promise.resolve(null),
  ]);

  // Build a lean project list with the roster field we actually auto-fill
  // (account manager = Keys col D "EMAIL Manager", stored as a Hebrew full
  // name like "Itay Stein"). The form resolves the name → email against
  // the `people` list client-side.
  const projects = (projectsRes?.projects ?? []).map((p) => ({
    name: p.name,
    company: p.company,
    projectManagerFull: p.roster?.projectManagerFull || "",
  }));

  // Pre-fill seed (from comment OR explicit search params). Comment
  // wins when both are present so the conversion flow is deterministic.
  const seedProject = commentSeed?.project || sp.project || "";
  const seedDescription = commentSeed?.body || "";
  const seedAssignees = commentSeed ? commentSeed.mentions.join(", ") : "";
  // Title gets a "Re: <first 40 chars of body>" hint when converting —
  // gives the user a starting point they can edit before submitting.
  const seedTitle = commentSeed
    ? commentSeed.body.split("\n")[0].slice(0, 60).trim()
    : "";

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>
              ➕
            </span>
            {commentSeed ? "המרת תגובה למשימה" : "משימה חדשה"}
          </h1>
          <div className="subtitle">
            {commentSeed ? (
              <>
                ממיר/ה תגובה של <b>{commentSeed.author_name || commentSeed.author_email}</b>
                {" "}בפרויקט <b>{commentSeed.project}</b>. השדות ממולאים מתוך
                התגובה — ערוך את הכותרת והשלם את שאר הפרטים. בעת יצירה,
                כל שרשור הדיון (התגובה המקורית + כל ההתייחסויות אליה)
                יועבר תחת המשימה החדשה.
              </>
            ) : (
              <>
                ברירת המחדל — &quot;ממתין לטיפול&quot;. בעת יצירה: תיקייה ב־Drive
                לפי הבחירה (קיימת או חדשה), מייל למבצעים, ומשימה ב־Google Tasks
                לכל מבצע (מסומנת כהושלמה כשהמשימה עוברת ל-&quot;בוצע&quot;).
              </>
            )}
          </div>
        </div>
        <div className="header-actions">
          <Link href="/tasks" className="btn-ghost btn-sm">
            ← חזרה לרשימה
          </Link>
        </div>
      </header>

      <TaskCreateForm
        projects={projects}
        defaultProject={seedProject}
        defaultDescription={seedDescription}
        defaultAssignees={seedAssignees}
        defaultTitle={seedTitle}
        fromComment={commentSeed?.id || ""}
        people={peopleRes?.people ?? []}
        currentUserEmail={me}
      />
    </main>
  );
}
