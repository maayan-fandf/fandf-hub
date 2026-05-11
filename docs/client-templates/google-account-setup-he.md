# Client template: Google identity setup for media-plan approvals (Hebrew)

Send this to any external client whose email isn't already associated with a Google account, so they can approve פריסות (media plans) directly in the file. Drive Approvals API rejects reviewer emails without a Google identity — this message offers the client two paths to resolve it.

## How to use

**Option 1 — copy from the hub (fastest):** open the project, click **📤 שלח לאישור** on the latest פריסה card, attempt to send to the client. If their email lacks a Google identity, an amber badge appears next to their row plus a **📋 העתק הוראות** button. Click it → the rendered template (with their email pre-filled) is on your clipboard. Just fill in `[שם]` and paste into Gmail/Chat.

**Option 2 — copy from this file:**

1. Copy the message below into your email client or chat tool.
2. Replace the placeholders:
   - `[שם]` → the recipient's first name (e.g. `טניה`)
   - `[כתובת המייל]` → their existing work email (e.g. `tanya_b@shikunbinui.com`)
3. Send.
4. Once they reply (with either their Gmail address, or confirmation that they've completed option B), update Keys col E `Email Client` for the project to their now-valid email. Re-trigger the approval from the hub.

> **Note on syncing**: the runtime version lives in `lib/clientTemplates.ts` (used by the **📋 העתק הוראות** button). If you edit the body below, **also update the `googleAccountSetupHebrew` function** — there's no build-time sync between the two.

## Template

> ⚠ Everything below the `---` line is the message body. The first line is the subject. The two `[שם]` / `[כתובת המייל]` placeholders are the only fields to replace.

---

**נושא:** איך לאשר את הפריסות שלנו ישירות בקובץ — 2 אפשרויות לבחירה

היי [שם],

כדי שתוכלי לאשר את הפריסות שלנו ישירות בתוך הקובץ (במקום פינג-פונג של אישורים במייל), צריך שכתובת המייל שאיתה את מקבלת את הבקשה תהיה מקושרת לחשבון Google. יש לך שתי אפשרויות — כל אחת מהן תעבוד אותו דבר מבחינתנו:

---

### ✨ אפשרות א' — הקלה והמהירה (אם יש לך Gmail פרטי)

אם יש לך כבר חשבון Gmail פרטי (`...@gmail.com`) שאת משתמשת בו, פשוט תני לי אותו ואני אגדיר אותך אצלנו במערכת תחת הכתובת הזו. **לא צריך לעשות שום דבר נוסף**. בקשות אישור יגיעו ל-Gmail הפרטי שלך, את לוחצת על הקישור — ומכיוון שאת כבר מחוברת ל-Gmail — את ישר רואה את הקובץ ויכולה לאשר/לדחות בלחיצה.

החיסרון היחיד: בקשות האישור לא יגיעו לתיבת הדואר של העבודה. אם זה מפריע — אפשרות ב'.

---

### 🔧 אפשרות ב' — שמירה על המייל הקיים שלך (2-3 דקות עבודה חד-פעמית)

אם את מעדיפה לקבל את בקשות האישור בתיבת המייל הרגילה שלך ב-`[כתובת המייל]`, אפשר לשייך לכתובת הזו "זהות Google" חינמית — שום דבר במייל לא משתנה (אותה תיבה, אותו ספק, אותה סיסמה), פשוט מוסיפים לכתובת הזו אפשרות להיכנס איתה ל-Drive.

**הערה לפני שמתחילים:** Google תוביל אותך דרך מספר מסכים. **הקישור החשוב** — `"Use my current email address instead"` — מופיע **במסך השלישי** (מסך בחירת שם משתמש), לא במסך הראשון. אז גם אם נראה לך שאת בדרך ליצור Gmail חדש — את לא, זה התהליך הרגיל, פשוט המשיכי עד לשם.

**שלבי הרשמה:**

1. פתחי דפדפן ועברי לכתובת: **https://accounts.google.com/SignUp**

2. **מסך ראשון — שם:** מלאי שם פרטי ושם משפחה (כפי שתרצי שיופיע בעת אישור פריסות). לחצי **Next**.

3. **מסך שני — פרטים בסיסיים:** תאריך לידה ומגדר. מלאי לפי המקובל. לחצי **Next**.

4. **מסך שלישי — שם משתמש:** כאן Google מציעה לך ליצור כתובת Gmail חדשה (`...@gmail.com`). **אל תיצרי**. מתחת לשדה של שם המשתמש יש קישור קטן בכחול:

   👉 **"Use my current email address instead"** (השתמש בכתובת המייל הקיימת שלי במקום).

   לחצי על הקישור הזה.

5. כעת השדה משתנה: במקום ליצור כתובת חדשה, את מזינה את הכתובת הקיימת שלך — **`[כתובת המייל]`**.

6. **מסך הסיסמה:** בחרי סיסמה חדשה (זו **לא** הסיסמה של המייל שלך; זו סיסמה ייעודית לחשבון Google שאת יוצרת עכשיו — שמרי אותה בצד).

7. Google תשלח **קוד אימות** ב-6 ספרות לכתובת `[כתובת המייל]` (תיבת הדואר הרגילה שלך). פתחי את המייל, העתיקי את הקוד, והדביקי אותו במסך.

8. אישרי את תנאי השימוש — וזהו, סיימת. נוצר חשבון Google לכתובת הקיימת שלך.

**אם לא רואה את הקישור "Use my current email address instead":**
- ודאי שאת באמת על **מסך שם המשתמש** (לא מסך שם פרטי / לא מסך תאריך לידה). המסך אמור לבקש ממך לבחור `username@gmail.com`.
- הקישור קטן ובצבע כחול בהיר — לפעמים מוסתר מתחת לשדה. גללי קצת למטה.
- אם בכל זאת לא רואה — סגרי את הכל ופתחי שוב בחלון פרטי (Incognito).

**מה קורה מעתה:**

- את ממשיכה לקבל מיילים ב-`[כתובת המייל]` כרגיל — שום שינוי בתיבת הדואר שלך.
- כשתקבלי מיילים על פריסות חדשות לאישור, את לוחצת על הקישור → Google תבקש ממך להתחבר → את מקלידה את הכתובת `[כתובת המייל]` והסיסמה שבחרת.
- בתוך הקובץ יופיעו כפתורי **"אשר"** ו**"דחה"** — לחיצה אחת ואנחנו רואים את התשובה אצלנו במערכת.
- ההתחברות נשמרת בדפדפן, אז זה תהליך חד-פעמי. מהפעם הבאה — לחיצה אחת ואת בפנים.

---

**בקיצור:** תגידי לי איזו אפשרות עדיפה לך — Gmail פרטי או שיוך לכתובת העבודה — ואני אסדר את הצד שלנו. אם משהו לא ברור או נתקעת באיזשהו שלב באפשרות ב', תני סימן ואסביר.

תודה!
