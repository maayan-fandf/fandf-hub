import { sessionOfAnyAccount, signOut } from "@/auth";

export const metadata = { title: "אין הרשאה" };
export const dynamic = "force-dynamic";

export default async function UnauthorizedPage() {
  // sessionOfAnyAccount, not auth(): the reader of this page is exactly the
  // account auth() hides, and the page has to tell them which address they
  // signed in with.
  const session = await sessionOfAnyAccount();
  const email = session?.user?.email;

  return (
    <main className="container signin-container">
      <div className="signin-card">
        <h1>אין עדיין גישה</h1>
        <p>
          את/ה מחובר/ת כ-<strong dir="ltr">{email ?? "(לא ידוע)"}</strong>, אבל
          הכתובת הזו אינה רשומה באף פרויקט.
        </p>
        <p>
          אם התחברת בחשבון Google הלא נכון — צאו והתחברו בחשבון שאליו נשלחה
          ההזמנה. אחרת, פנו למנהל/ת הלקוח שלכם ב-F&amp;F כדי שיוסיפו את
          הכתובת; הגישה נפתחת תוך כמה דקות מההוספה.
        </p>
        {/* The way back. A listed client can land here on a load where the
            roster could not be read (the door fails closed); reloading THIS
            page would never leave it, so offer the home page, which lets
            them in as soon as the roster reads. */}
        <p>
          <a href="/">נסו שוב</a>
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
