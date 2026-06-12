import Link from "next/link";
import OnboardingChecklist from "@/components/OnboardingChecklist";
import Shot from "@/components/OnboardingShot";

export const metadata = { title: "מדריך התחלה — F&F Hub" };

/**
 * Internal-team onboarding guide. Rebuilt 2026-06-12 around how people
 * actually learn, instead of a feature inventory:
 *
 *   1. An interactive "first hour" checklist (do > read; persists in
 *      localStorage via OnboardingChecklist).
 *   2. Role-based daily loops — the Hub is heavily role-gated, so a
 *      generic tour wastes half of every reader's attention.
 *   3. Three durable mental models (task lifecycle, internal/shared
 *      discussions, Drive↔briefs) — the slow-rotting core.
 *   4. "Things you won't discover alone" — the documented
 *      discoverability debt (hover-only features, self-hiding nav).
 *   5. Shortcuts + leaning on the ✨ assistant as the living manual.
 *
 * Content grounded in a 2026-06-12 code inventory (nav shell, projects,
 * campaigns suites read by subagents; tasks/stats/billing from the main
 * session). Keep claims durable: prefer mental models over per-feature
 * detail — the surfaces themselves are the documentation for the rest.
 *
 * Screenshots live in public/onboarding/ — recapture when a surface
 * changes materially (they're the fastest-rotting part of this page).
 *
 * Linked from the ⚙️ gear menu and the ⌘K command palette.
 */

// Screenshot figures use components/OnboardingShot — a client component
// that hides itself when its image is missing, so the guide can ship
// text-first and figures light up as captures land in public/onboarding/.

// The task lifecycle — mirrors WorkTaskStatus in lib/appsScript.ts.
const STATUSES: { label: string; he: string; desc: string }[] = [
  { label: "draft", he: "טיוטה", desc: "נכתבה אך עוד לא נשלחה לטיפול" },
  { label: "awaiting_handling", he: "ממתין לטיפול", desc: "מוכנה — מחכה שמישהו ייקח אותה" },
  { label: "in_progress", he: "בעבודה", desc: "מישהו עובד עליה כרגע (השעון רץ)" },
  { label: "awaiting_clarification", he: "ממתין לבירור", desc: "תקועה עד שתתקבל תשובה — הכדור אצל השואל" },
  { label: "awaiting_approval", he: "ממתין לאישור", desc: "הושלמה ומחכה לאישור המאשר" },
  { label: "blocked", he: "חסום", desc: "ממתינה למשימה אחרת שתסתיים קודם" },
  { label: "done", he: "בוצע", desc: "הסתיימה (סופי)" },
  { label: "cancelled", he: "בוטל", desc: "ירדה מהפרק (סופי)" },
];

const SHORTCUTS: { keys: string; desc: string }[] = [
  { keys: "⌘K / Ctrl+K", desc: "לוח הפקודות — קפיצה לפרויקט, פעולה, או חיפוש בתוך כל הדיונים" },
  { keys: "/", desc: "פתיחת לוח הפקודות (כשלא מקלידים בשדה)" },
  { keys: "g ואז p", desc: "מעבר לפרויקטים" },
  { keys: "g ואז i", desc: "מעבר לתיוגים" },
  { keys: "g ואז n", desc: "הערה אישית חדשה" },
  { keys: "Ctrl+Shift+M", desc: "הערה אישית חדשה (עובד גם באמצע הקלדה)" },
  { keys: "⌘/Ctrl+Enter", desc: "שליחה — בכל קומפוזר: הודעה, תגובה, משימה חדשה" },
  { keys: "?", desc: "הצגת כל קיצורי המקלדת" },
  { keys: "Esc", desc: "סגירת כל חלון קופץ" },
];

export default function OnboardingPage() {
  return (
    <main className="container help-open">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>✨</span>
            ברוכים הבאים ל-Hub
          </h1>
          <div className="subtitle">
            המדריך בנוי כך שלא צריך לקרוא את כולו: עוברים על השעה הראשונה,
            קוראים את המסלול של <b>התפקיד שלך</b>, ואת השאר שואלים את
            העוזר ✨ כשצריך.
          </div>
        </div>
      </header>

      {/* ── 1. The first hour — interactive ───────────────────────── */}
      <section className="help-open-card">
        <h2>🚀 השעה הראשונה — עשו, אל תקראו</h2>
        <p className="help-open-alt">
          שבע פעולות אמיתיות. הסימונים נשמרים — אפשר לחזור לכאן מתי שרוצים
          (⚙️ ← ✨ מדריך התחלה).
        </p>
        <OnboardingChecklist
          items={[
            {
              id: "palette",
              label: (
                <>
                  לחצו <kbd dir="ltr">Ctrl+K</kbd> והקלידו שם של פרויקט —
                  זו הדרך המהירה ביותר לכל מקום ב-Hub.
                </>
              ),
            },
            {
              id: "filters",
              label: (
                <>
                  בעמוד <Link href="/">הבית</Link>, שימו לב לשני המסננים
                  למעלה: ברירת המחדל היא <b>רק שלי</b> + <b>רק קמפיינים
                  פעילים</b>. לחצו ״הכל״ בשניהם כדי לראות את כל הפורטפוליו —
                  ואז חזרו לברירת המחדל.
                </>
              ),
            },
            {
              id: "discussion-tab",
              label: (
                <>
                  פתחו פרויקט כלשהו וגללו לדיון. בדקו באיזו כרטיסייה אתם:
                  צוות F&F נוחת תמיד על 🔒 <b>פנימי</b>. ללקוח כותבים רק
                  מכרטיסיית 🤝 <b>משותף</b>.
                </>
              ),
            },
            {
              id: "tasks",
              label: (
                <>
                  פתחו את <Link href="/tasks">📋 משימות</Link>. המספר האדום
                  בתפריט סופר <b>רק</b> מה שמחכה לפעולה שלכם — לא דברים
                  שתקועים אצל אחרים.
                </>
              ),
            },
            {
              id: "push",
              label: (
                <>
                  הפעילו התראות דפדפן: ⚙️ ← <b>התראות דפדפן</b>. ההפעלה היא
                  פעם אחת בכל מחשב, ותקבלו עדכונים גם כשה-Hub סגור.
                </>
              ),
            },
            {
              id: "kbd",
              label: (
                <>
                  לחצו <kbd>?</kbd> — נפתחת רשימת קיצורי המקלדת. שווה לזכור
                  לפחות את <kbd dir="ltr">Ctrl+K</kbd>.
                </>
              ),
            },
            {
              id: "open-locally",
              label: (
                <>
                  (פעם אחת למחשב) הגדירו{" "}
                  <Link href="/help/open-locally">פתיחת תיקיות במחשב</Link>{" "}
                  כדי שכפתור 📁 יפתח תיקיות Drive ישירות ב-Explorer / Finder.
                </>
              ),
            },
          ]}
        />
      </section>

      {/* ── 2. Role-based daily loops ─────────────────────────────── */}
      <section className="help-open-card">
        <h2>🧭 המסלול היומי שלך — לפי תפקיד</h2>
        <p className="help-open-alt">
          ה-Hub מציג לכל תפקיד תפריט אחר — חלקים שלא רלוונטיים אליך פשוט
          לא קיימים אצלך. פתחו את הבלוק של התפקיד שלכם.
        </p>

        <details className="onb-role">
          <summary>📣 מנהל/ת קמפיינים · מדיה</summary>
          <div className="onb-role-body">
            <p>
              הבוקר שלך מתחיל ב-<Link href="/morning">📢 קמפיינים</Link>:
              פיד התראות לפי פרויקט — חריגות קצב, תקציב, פערי מחיר, לידים
              תקועים. לכל התראה ארבע פעולות:
            </p>
            <ul className="onboarding-tools">
              <li>
                <b>✓ טיפלתי</b> — משתיק את ההתראה <b>לכל הצוות</b> (לא רק
                לך!) למשך 1–7 ימים לפי סוג ההתראה. ⋯ פותח משכים מותאמים
                (יום / שבוע / חודש / לצמיתות), ↺ מבטל. התראה שחזרה עם צ׳יפ
                🔁 = הבעיה עדיין חיה.
              </li>
              <li>
                <b>💬 שלח לפנימי</b> — מפרסם את ההתראה בצ׳אט הפנימי של
                הפרויקט, עם אפשרות לתייג חברי צוות. שליחה גם משתיקה את
                ההתראה אוטומטית.
              </li>
              <li>
                <b>📋 צור משימה</b> — טופס משימה חדש עם כל פרטי ההתראה
                ממולאים מראש.
              </li>
              <li>
                <b>📋 העתק ₪ ופתח</b> — מעתיק את הסכום הנדרש ופותח את
                הפלטפורמה (גוגל/פייסבוק) ישירות.
              </li>
            </ul>
            <p>
              משם ל-<Link href="/morning/budgets">💰 תקציבים</Link>: שולחן
              העבודה התקציבי. ⚠️ על שורה = פער של יותר מ-12% בין התקציב
              היומי המוגדר בפלטפורמה לנדרש. התג הצבעוני ₪/יום הוא{" "}
              <b>לחיץ-להעתקה</b>, ו-ⓘ נותן אבחנה מלאה (להעלות / להוריד /
              ״התקציב נכון — בדקו delivery״). טיפלתי כאן משתיק רק עד מחר,
              וחוזר אוטומטית אם הפער עדיין פתוח.
            </p>
            <Shot
              src="morning-alert.png"
              alt="כרטיס התראה בפיד הקמפיינים עם ארבע פעולות"
              caption="התראה בפיד: הטקסט מימין, ארבע הפעולות משמאל. ✓ טיפלתי משתיק לכולם — לא רק לך."
            />
          </div>
        </details>

        <details className="onb-role">
          <summary>🎨 קריאייטיב — סטודיו · קופי · אומנות · וידאו</summary>
          <div className="onb-role-body">
            <p>
              הבית שלך הוא <Link href="/tasks">📋 משימות</Link>. הלולאה:
            </p>
            <ul className="onboarding-tools">
              <li>
                המספר האדום בתפריט = משימות שמחכות <b>לך</b>. לחצו והתחילו
                מ״ממתין לטיפול״.
              </li>
              <li>
                לקחתם משימה? העבירו ל<b>בעבודה</b> — שעון הזמן נדלק לבד.
                יוצאים להפסקה? ⏸ משהה בלי לשנות סטטוס.
              </li>
              <li>
                חסר מידע? <b>ממתין לבירור</b> מעביר את הכדור חזרה לשואל —
                והמשימה יוצאת מהרשימה הפעילה שלכם עד שתגיע תשובה.
              </li>
              <li>
                סיימתם? <b>ממתין לאישור</b>. המאשר יקבל התראה; אם המשימה
                תוחזר, תקבלו אותה עם הערות לסבב נוסף.
              </li>
              <li>
                קבצים מעלים ישירות למשימה — הם נשמרים בתיקיית Drive ייעודית
                שנוצרת אוטומטית בהעלאה הראשונה.
              </li>
            </ul>
            <p className="help-open-alt">
              לא רואים ״קמפיינים״ בתפריט? נכון — זה מסך של מדיה ומנהלים.
              אצלכם הוא מוסתר בכוונה. ולרישום מהיר של תזכורת לעצמכם:{" "}
              <kbd dir="ltr">Ctrl+Shift+M</kbd> מכל מקום.
            </p>
            <Shot
              src="tasks-queue.png"
              alt="תור המשימות מחולק לפי סטטוס"
              caption="תור המשימות: ברירת המחדל מציגה רק את מה ששלך (רק שלי). המספרים ליד כל סטטוס — כמה מחכות שם."
            />
          </div>
        </details>

        <details className="onb-role">
          <summary>🤝 מנהל/ת לקוח</summary>
          <div className="onb-role-body">
            <ul className="onboarding-tools">
              <li>
                הדיונים הם הכלי המרכזי שלך — וההבחנה בין 🔒 פנימי ל-🤝
                משותף קריטית (ראו המודל למטה). גם קבצים שמועלים בטאב
                המשותף נשמרים בתיקייה שהלקוח רואה.
              </li>
              <li>
                הפעילו 📩 <b>מיילים מלקוחות</b> (⚙️ ← מיילים מלקוחות):
                מיילים מלקוחות רשומים מ-3 הימים האחרונים מופיעים בתפריט,
                עם המרה למשימה בלחיצה אחת.
              </li>
              <li>
                כרטיס 📐 <b>פריסה אחרונה</b> בעמוד הפרויקט מציג את הפריסה
                העדכנית עם סטטוס אישור — אפשר לשלוח לאישור הלקוח ישירות
                משם (המיילים של הלקוח מוצעים אוטומטית).
              </li>
              <li>
                מה הלקוח רואה? עמוד פרויקט מצומצם: דשבורד לקריאה בלבד (בלי
                איתותים שליליים), הדיון המשותף בלבד, בלי משימות ובלי
                התראות. מה שאתם רואים ≠ מה שהוא רואה.
              </li>
            </ul>
            <Shot
              src="discussion.png"
              alt="כרטיסיות הדיון פנימי ומשותף"
              caption="הדיון: שימו לב לכרטיסייה לפני כתיבה. פנימי = רק F&F. משותף = גם הלקוח. ברירת המחדל היא פנימי."
            />
          </div>
        </details>

        <details className="onb-role">
          <summary>👑 אדמין</summary>
          <div className="onb-role-body">
            <p>הכל שלמעלה, ובנוסף:</p>
            <ul className="onboarding-tools">
              <li>
                <Link href="/morning/forecast">🔮 תחזית חודש</Link> — תקציב
                מול בפועל + דמי ניהול לכל התיק, מקובץ לפי מנהל/חברה/פרויקט.
                כל הסינון והמיון חיים ב-URL — העתיקו את הכתובת לשיתוף תצוגה
                מדויקת.
              </li>
              <li>
                <Link href="/stats">📊 סטטיסטיקה</Link> — התפלגויות עלות
                לליד/תיאום/ביצוע בכל התיק, השוואת פרויקטים, מגמות
                וקורלציות. כל נקודה לחיצה — קופצים לפרויקט.
              </li>
              <li>
                כלי הניהול גרים בגלגל ⚙️ ← <b>ניהול</b>: חיוב 🧾, מחירון 💰,
                דוח זמן ⏱️, ניהול אנשים 📇 ועוד. כלים חדשים מתווספים לשם,
                לא לסרגל העליון.
              </li>
              <li>
                <b>הצג כ-</b> (בגלגל): צפייה ב-Hub כפי שעובד אחר רואה אותו —
                לבדיקת הרשאות והדרכה. מתאפס ברענון.
              </li>
            </ul>
          </div>
        </details>
      </section>

      {/* ── 3. Three mental models ────────────────────────────────── */}
      <section className="help-open-card">
        <h2>🧠 שלושה מודלים שחובה להבין</h2>

        <h3 className="onb-model-title">1 · מחזור החיים של משימה</h3>
        <p>
          לכל משימה ארבעה תפקידים — <b>כותב</b> (מי שיצר), <b>מאשר</b>,{" "}
          <b>מנהל פרויקט</b> ו<b>עובדים</b> — והיא נעה בין הסטטוסים:
        </p>
        <ul className="onboarding-status-list">
          {STATUSES.map((s) => (
            <li key={s.label}>
              <span className="onboarding-status-he">{s.he}</span>
              <span className="onboarding-status-desc">{s.desc}</span>
            </li>
          ))}
        </ul>
        <p className="help-open-alt">
          כשבוחרים <b>יותר מאדם אחד</b> בטופס משימה חדשה, מופיע בורר אופן
          עבודה: משימה אחת משותפת · 🌂 מטריה (משימה לכל אחד תחת מעטפת
          מסכמת) · 🔗 שרשרת (שלב אחרי שלב — כל שלב חוסם את הבא, וכשהוא
          נסגר הבא משתחרר אוטומטית ל״ממתין לטיפול״).
        </p>

        <h3 className="onb-model-title">2 · פנימי מול משותף</h3>
        <div className="onb-warn">
          <p>
            בכל פרויקט שתי כרטיסיות דיון: 🔒 <b>פנימי</b> — צוות F&F בלבד,
            הלקוח <b>לעולם</b> לא רואה. 🤝 <b>משותף</b> — הלקוח רואה
            וכותב. צוות F&F נוחת תמיד על פנימי — <b>בדקו את הכרטיסייה לפני
            שליחה</b>. הכרטיסייה קובעת גם לאן קבצים נשמרים: פנימי ← תיקיית
            הצוות, משותף ← התיקייה שהלקוח פותח.
          </p>
        </div>
        <p className="help-open-alt">
          תיוג: הקלדת @ פותחת בורר אנשים; הטוקן בגוף ההודעה הוא מה שיוצר את
          ההתראה — מחיקתו מבטלת את התיוג. אפשר גם להפוך כל הודעה למשימה
          (📋 בכרטיס ההודעה).
        </p>

        <h3 className="onb-model-title">3 · Drive ↔ בריפים</h3>
        <p>
          המבנה: <b>חברה ← פרויקט ← בריף ← משימה</b>, ו-Drive הוא מקור
          האמת. רשימת הבריפים בטופס המשימה נקראת ישירות מתיקיות ה-Drive;
          בריף חדש = תיקייה חדשה; שינוי שם בריף מסנכרן את התיקייה ואת כל
          המשימות. תיקיית Drive למשימה עצמה נוצרת רק כשמעלים אליה קובץ
          ראשון — משימות בלי קבצים לא מייצרות תיקיות ריקות.
        </p>
      </section>

      {/* ── 4. Things you won't discover alone ────────────────────── */}
      <section className="help-open-card">
        <h2>🕵️ דברים שלא תגלו לבד</h2>
        <ul className="onboarding-tools onb-secrets">
          <li>
            <b>ריחוף על כל אווטאר</b> (חצי שנייה) פותח כרטיס איש קשר —
            וואטסאפ, מייל, המשימות הפתוחות שלו, והקצאת משימה אליו.
          </li>
          <li>
            <b>שלושה פריטי תפריט מסתתרים כשהם ריקים</b>: 🏷️ תיוגים, 📥
            Google Tasks, 📩 לקוחות. אם לא רואים אותם — אין מה לטפל, לא
            חסרה הרשאה. (📩 דורש גם הפעלה חד-פעמית בגלגל.)
          </li>
          <li>
            <b>הדיון קופץ אוטומטית ל״תיוגים שלי״</b> כשמחכים לכם תיוגים על
            הפרויקט — אם הפיד נראה פתאום קצר, לחצו ״הכל״; שום דבר לא נמחק.
          </li>
          <li>
            <b>חיפוש ⌘K מחפש גם בתוך תוכן הדיונים</b> (משני תווים ומעלה)
            וקופץ לשורה המדויקת בציר הזמן — היא תהבהב כשתגיעו.
          </li>
          <li>
            <b>הדשבורד בעמוד פרויקט נטען 5–30 שניות</b> — זה צפוי, הוא
            נטען מראש בזמן שקוראים את ראש העמוד. הפס שמתחתיו הוא ידית
            גובה (גרירה לשינוי, דאבל-קליק לאיפוס).
          </li>
          <li>
            <b>בכרטיסי המגמה בדשבורד</b>: ריחוף על נקודת חודש פותח פאי של
            פירוק הערך לפי ערוץ מדיה.
          </li>
          <li>
            <b>📅 בורר החודש בעמוד פרויקט</b> מסובב את כל העמוד (דשבורד +
            CRM) לחודש שנבחר, וה-URL נשמר — אפשר לשתף קישור לתצוגה מדויקת.
          </li>
          <li>
            <b>עובד חדש שעוד לא שובץ ברוסטר</b> רואה זמנית את כל הפרויקטים
            גם כש״רק שלי״ דלוק — ברגע שתשובצו, הרשימה תצטמצם פתאום. זה
            פיצ׳ר, לא באג.
          </li>
          <li>
            <b>בפאנל היום (מימין)</b>: 👁 על כל משימה פותח תצוגה מקדימה בלי
            לעזוב את העמוד. הפאנל מתקפל לפס דק וזוכר את הבחירה.
          </li>
          <li>
            <b>השתקת התראות ≠ איבוד התראות</b>: ההשתקה בגלגל רק מעמעמת את
            הסימון האדום; הכל נשאר תחת 🔔.
          </li>
        </ul>
        <details className="onb-role">
          <summary>📸 צילום מסך: לוח הפקודות</summary>
          <div className="onb-role-body">
            <Shot
              src="palette.png"
              alt="לוח הפקודות פתוח עם תוצאות חיפוש"
              caption="לוח הפקודות (Ctrl+K): פעולות, פרויקטים, וחיפוש תוכן בתוך כל הדיונים — הדרך המהירה לכל מקום."
            />
          </div>
        </details>
      </section>

      {/* ── 5. Shortcuts ──────────────────────────────────────────── */}
      <section className="help-open-card">
        <h2>⌨️ קיצורי מקלדת</h2>
        <ul className="onboarding-kbd-list">
          {SHORTCUTS.map((s) => (
            <li key={s.keys}>
              <kbd dir="ltr">{s.keys}</kbd>
              <span>{s.desc}</span>
            </li>
          ))}
        </ul>
        <p className="help-open-alt">
          <kbd>?</kbd> מציג את הרשימה המלאה בכל רגע.
        </p>
      </section>

      {/* ── 6. Help ───────────────────────────────────────────────── */}
      <section className="help-open-card help-open-safety">
        <h2>🙋 כשמשהו לא ברור</h2>
        <p>
          הכפתור ✨ בפינה פותח עוזר AI שמכיר את הנתונים של ה-Hub — והוא
          רואה את העמוד שאתם עומדים עליו, אז שאלו מהמקום הרלוונטי. דוגמאות
          טובות להתחלה:
        </p>
        <ul className="onboarding-tools">
          <li>״מי על הפרויקט הזה?״ (מתוך עמוד פרויקט)</li>
          <li>״מה המייל האחרון מהלקוח של גינדי?״</li>
          <li>״תסכם לי את ההתראות הפתוחות שלי״</li>
        </ul>
        <p>
          ואם עדיין תקועים — מעין (
          <a href="mailto:maayan@fandf.co.il" dir="ltr">
            maayan@fandf.co.il
          </a>
          ). המדריך הזה זמין תמיד מהגלגל ⚙️ ומ-⌘K.
        </p>
      </section>

      <div className="help-open-back">
        <Link href="/">→ חזרה לפרויקטים</Link>
      </div>
    </main>
  );
}
