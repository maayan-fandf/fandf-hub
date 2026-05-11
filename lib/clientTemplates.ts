/**
 * Runtime versions of the client-facing message templates that live as
 * markdown under `docs/client-templates/`. The .md files are the human-
 * readable docs (for copy-paste into email manually); this module is
 * what the hub uses when a UI surface offers a "copy template" button.
 *
 * IMPORTANT: keep this file in sync with the corresponding .md file. The
 * .md and .ts versions are intentionally duplicated so neither requires
 * a build-time loader for the other; we accept the manual-sync cost
 * because there's only one template today (and likely a handful long-
 * term).
 *
 * Placeholder convention: `[שם]` (the recipient's first name) stays
 * unsubstituted — we don't reliably have a name from Keys col E (which
 * is just emails). The user is expected to type the name into the
 * recipient's message client themselves. `[כתובת המייל]` IS substituted
 * since we always have the email at the point of copy.
 */

export type ClientTemplate = {
  /** Suggested subject line for the email/chat. */
  subject: string;
  /** Message body without the subject. */
  body: string;
  /** Subject + body concatenated with a divider, suitable for a single
   *  clipboard paste. The recipient's mail client will treat the first
   *  line as subject only when pasted into the subject field; for chat
   *  the whole blob lands as one message. */
  full: string;
};

/**
 * Template for asking a client to either share their personal Gmail or
 * link their existing email to a free Google identity so Drive Approvals
 * accepts them as a reviewer.
 *
 * Triggered from the SendForApprovalButton dialog when the lib's
 * pre-validation flags a reviewer's email as not having a Google account.
 * The email param is the rejected reviewer email — gets inlined into the
 * body so the recipient sees their own address in the instructions.
 */
export function googleAccountSetupHebrew(email: string): ClientTemplate {
  const safeEmail = String(email || "").trim();
  const subject = "איך לאשר את הפריסות שלנו ישירות בקובץ — 2 אפשרויות לבחירה";

  // Body kept verbatim with the .md file. If you edit one, edit both.
  // The `[שם]` placeholder is intentionally left in place — the sender
  // fills it before pasting. `[כתובת המייל]` is replaced inline.
  const body = `היי [שם],

כדי שתוכלי לאשר את הפריסות שלנו ישירות בתוך הקובץ (במקום פינג-פונג של אישורים במייל), צריך שכתובת המייל שאיתה את מקבלת את הבקשה תהיה מקושרת לחשבון Google. יש לך שתי אפשרויות — כל אחת מהן תעבוד אותו דבר מבחינתנו:

---

✨ אפשרות א' — הקלה והמהירה (אם יש לך Gmail פרטי)

אם יש לך כבר חשבון Gmail פרטי (...@gmail.com) שאת משתמשת בו, פשוט תני לי אותו ואני אגדיר אותך אצלנו במערכת תחת הכתובת הזו. לא צריך לעשות שום דבר נוסף. בקשות אישור יגיעו ל-Gmail הפרטי שלך, את לוחצת על הקישור — ומכיוון שאת כבר מחוברת ל-Gmail — את ישר רואה את הקובץ ויכולה לאשר/לדחות בלחיצה.

החיסרון היחיד: בקשות האישור לא יגיעו לתיבת הדואר של העבודה. אם זה מפריע — אפשרות ב'.

---

🔧 אפשרות ב' — שמירה על המייל הקיים שלך (2-3 דקות עבודה חד-פעמית)

אם את מעדיפה לקבל את בקשות האישור בתיבת המייל הרגילה שלך ב-${safeEmail}, אפשר לשייך לכתובת הזו "זהות Google" חינמית — שום דבר במייל לא משתנה (אותה תיבה, אותו ספק, אותה סיסמה), פשוט מוסיפים לכתובת הזו אפשרות להיכנס איתה ל-Drive.

הערה לפני שמתחילים: Google תוביל אותך דרך מספר מסכים. הקישור החשוב — "Use my current email address instead" — מופיע במסך השלישי (מסך בחירת שם משתמש), לא במסך הראשון. אז גם אם נראה לך שאת בדרך ליצור Gmail חדש — את לא, זה התהליך הרגיל, פשוט המשיכי עד לשם.

שלבי הרשמה:

1. פתחי דפדפן ועברי לכתובת: https://accounts.google.com/SignUp

2. מסך ראשון — שם: מלאי שם פרטי ושם משפחה (כפי שתרצי שיופיע בעת אישור פריסות). לחצי Next.

3. מסך שני — פרטים בסיסיים: תאריך לידה ומגדר. מלאי לפי המקובל. לחצי Next.

4. מסך שלישי — שם משתמש: כאן Google מציעה לך ליצור כתובת Gmail חדשה (...@gmail.com). אל תיצרי. מתחת לשדה של שם המשתמש יש קישור קטן בכחול:

   👉 "Use my current email address instead" (השתמש בכתובת המייל הקיימת שלי במקום).

   לחצי על הקישור הזה.

5. כעת השדה משתנה: במקום ליצור כתובת חדשה, את מזינה את הכתובת הקיימת שלך — ${safeEmail}.

6. מסך הסיסמה: בחרי סיסמה חדשה (זו לא הסיסמה של המייל שלך; זו סיסמה ייעודית לחשבון Google שאת יוצרת עכשיו — שמרי אותה בצד).

7. Google תשלח קוד אימות ב-6 ספרות לכתובת ${safeEmail} (תיבת הדואר הרגילה שלך). פתחי את המייל, העתיקי את הקוד, והדביקי אותו במסך.

8. אישרי את תנאי השימוש — וזהו, סיימת. נוצר חשבון Google לכתובת הקיימת שלך.

אם לא רואה את הקישור "Use my current email address instead":
- ודאי שאת באמת על מסך שם המשתמש (לא מסך שם פרטי / לא מסך תאריך לידה). המסך אמור לבקש ממך לבחור username@gmail.com.
- הקישור קטן ובצבע כחול בהיר — לפעמים מוסתר מתחת לשדה. גללי קצת למטה.
- אם בכל זאת לא רואה — סגרי את הכל ופתחי שוב בחלון פרטי (Incognito).

מה קורה מעתה:

- את ממשיכה לקבל מיילים ב-${safeEmail} כרגיל — שום שינוי בתיבת הדואר שלך.
- כשתקבלי מיילים על פריסות חדשות לאישור, את לוחצת על הקישור → Google תבקש ממך להתחבר → את מקלידה את הכתובת ${safeEmail} והסיסמה שבחרת.
- בתוך הקובץ יופיעו כפתורי "אשר" ו"דחה" — לחיצה אחת ואנחנו רואים את התשובה אצלנו במערכת.
- ההתחברות נשמרת בדפדפן, אז זה תהליך חד-פעמי. מהפעם הבאה — לחיצה אחת ואת בפנים.

---

בקיצור: תגידי לי איזו אפשרות עדיפה לך — Gmail פרטי או שיוך לכתובת העבודה — ואני אסדר את הצד שלנו. אם משהו לא ברור או נתקעת באיזשהו שלב באפשרות ב', תני סימן ואסביר.

תודה!`;

  const full = `נושא: ${subject}\n\n${body}`;
  return { subject, body, full };
}
