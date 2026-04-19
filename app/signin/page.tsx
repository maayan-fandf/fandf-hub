import { signIn } from "@/auth";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; error?: string }>;
}) {
  const { from, error } = await searchParams;

  return (
    <main className="container signin-container">
      <div className="signin-card">
        <h1>התחברות ל-Hub</h1>
        <p className="subtitle">התחבר באמצעות חשבון Google.</p>

        {error && (
          <div className="error">ההתחברות נכשלה: {error}</div>
        )}

        <form
          action={async () => {
            "use server";
            await signIn("google", {
              redirectTo: from || "/",
            });
          }}
        >
          <button type="submit" className="btn-primary signin-btn">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path
                fill="#EA4335"
                d="M12 10.2v3.9h5.5c-.2 1.4-1.7 4.1-5.5 4.1a6.2 6.2 0 0 1 0-12.4c2 0 3.3.9 4 1.6l2.7-2.6A9.9 9.9 0 1 0 12 22c5.7 0 9.5-4 9.5-9.6 0-.7-.1-1.2-.2-1.7H12z"
              />
            </svg>
            המשך עם Google
          </button>
        </form>

        <p className="signin-note">
          לאחר ההתחברות, Hub בודק אם למייל שלך יש גישה (אדמין או רשום בפרויקט).
          אם לא, תוצג בפניך אפשרות לבקש גישה.
        </p>
      </div>
    </main>
  );
}
