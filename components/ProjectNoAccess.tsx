import Link from "next/link";

/**
 * What a signed-in viewer sees on a project page they may not open
 * (lib/projectAccess canOpenProject said no).
 *
 * Not /unauthorized: that page says the address is on NO project, which is
 * untrue for a client who is on one project and followed a link to another.
 * And not a 404: the commonest real cause is a client whose access could not
 * be checked on this load (the gate fails closed), and "try again" is the
 * useful thing to tell them.
 *
 * It echoes the name from the URL and nothing else, so it confirms nothing
 * about whether such a project exists.
 */
export default function ProjectNoAccess({
  projectName,
  email,
}: {
  projectName: string;
  email: string;
}) {
  return (
    <main className="container signin-container">
      <div className="signin-card">
        <h1>אין גישה לפרויקט הזה</h1>
        <p>
          את/ה מחובר/ת כ-<strong dir="ltr">{email || "(לא ידוע)"}</strong>, והכתובת
          הזו אינה משויכת לפרויקט «{projectName}».
        </p>
        <p>
          אם זה הפרויקט שלך — רעננו את הדף. אם ההודעה חוזרת, פנו למנהל/ת הלקוח
          שלכם ב-F&amp;F כדי שיוסיפו אתכם לפרויקט.
        </p>
        <Link href="/" className="btn-primary">
          לכל הפרויקטים
        </Link>
      </div>
    </main>
  );
}
