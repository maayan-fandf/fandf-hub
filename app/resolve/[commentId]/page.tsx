import Link from "next/link";
import { auth } from "@/auth";
import { resolveCommentDirect } from "@/lib/commentsWriteDirect";

export const dynamic = "force-dynamic";

type Params = { commentId: string };
type Search = { project?: string };

export default async function ResolvePage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { commentId: raw } = await params;
  const { project: rawProject } = await searchParams;
  const commentId = decodeURIComponent(raw);
  const project = rawProject ? decodeURIComponent(rawProject) : "";

  // Auto-resolve on page load. resolveCommentDirect is idempotent —
  // re-clicking the Chat card link just re-sets resolved=true, which is
  // a no-op on an already-resolved row. The hub doesn't prefetch this
  // route from anywhere, so there's no risk of an accidental prefetch
  // triggering the action.
  let ok = true;
  let errMsg = "";
  const session = await auth();
  if (!session?.user?.email) {
    ok = false;
    errMsg = "לא מחובר/ת";
  } else {
    try {
      await resolveCommentDirect(session.user.email, commentId, true);
    } catch (e) {
      ok = false;
      errMsg = e instanceof Error ? e.message : String(e);
    }
  }

  return (
    <main className="container resolve-container">
      <div className="resolve-card">
        {ok ? (
          <>
            <div className="resolve-icon" aria-hidden>✅</div>
            <h1>פתור</h1>
            <p className="subtitle">
              סימנת את המשימה כהושלמה. אפשר לסגור את הלשונית הזו ולחזור לצ׳אט.
            </p>
            {project && (
              <div className="resolve-actions">
                <Link
                  href={`/projects/${encodeURIComponent(project)}`}
                  className="btn-primary"
                >
                  עבור לדף הפרויקט ←
                </Link>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="resolve-icon" aria-hidden>⚠️</div>
            <h1>לא הצלחנו לפתור</h1>
            <p className="subtitle error-detail">{errMsg}</p>
            <p className="subtitle">
              אפשר שאין לך הרשאה, שהפריט כבר פתור, או שהוא נמחק.
            </p>
            <div className="resolve-actions">
              {project ? (
                <Link
                  href={`/projects/${encodeURIComponent(project)}`}
                  className="btn-primary"
                >
                  פתח את הפרויקט
                </Link>
              ) : (
                <Link href="/" className="btn-primary">
                  חזרה להאב
                </Link>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
