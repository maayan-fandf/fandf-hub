import { auth, signOut } from "@/auth";

export const dynamic = "force-dynamic";

export default async function UnauthorizedPage() {
  const session = await auth();
  const email = session?.user?.email;

  return (
    <main className="container signin-container">
      <div className="signin-card">
        <h1>אין עדיין גישה</h1>
        <p>
          אתה מחובר כ-<strong dir="ltr">{email ?? "(לא ידוע)"}</strong>, אבל
          המייל הזה לא רשום כאדמין או כחבר באף פרויקט בדשבורד.
        </p>
        <p>
          בקש מאדמין להוסיף אותך לטאב <code>Keys</code> (בעמודה
          &quot;EMAIL Manager&quot; או &quot;Email Client&quot;) או ל-
          <code>CONFIG.ADMIN_EMAILS</code>. לאחר מכן טען מחדש את הדף.
        </p>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/signin" });
          }}
        >
          <button type="submit" className="btn-primary">
            יציאה
          </button>
        </form>
      </div>
    </main>
  );
}
