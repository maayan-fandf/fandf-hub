import Link from "next/link";

export const metadata = { title: "מדריך התחלה — F&F Hub" };

/**
 * Internal-team onboarding guide. A static, no-data walkthrough of the
 * Hub for new staff — the nav surfaces, the task model, keyboard
 * shortcuts, and the one-time setup. Linked from the ⚙️ gear menu and
 * the ⌘K command palette. Reuses the .help-open-card shell from
 * /help/open-locally plus the .onboarding-* additions in globals.css.
 */

type Feature = {
  emoji: string;
  title: string;
  href?: string;
  body: string;
};

// Top-nav surfaces, in the right-to-left order a new hire meets them.
// Some entries self-hide until they have something to show (תיוגים,
// Google Tasks, לקוחות) — the guide explains that so an empty nav
// doesn't read as "missing".
const FEATURES: Feature[] = [
  {
    emoji: "📂",
    title: "פרויקטים",
    href: "/",
    body: "העמוד הראשי. כל הפרויקטים שלך, מקובצים לפי חברה. כל פרויקט מציג כמה משימות פתוחות יש לך בו, תיוגים שמחכים, והתקדמות תקציב וזמן. הכפתורים בראש הרשימה מסננים: ״רק שלי״ מציג רק פרויקטים שאתה חבר בהם, ואפשר להסתיר פרויקטים שהסתיימו או ללא תקציב פעיל.",
  },
  {
    emoji: "📋",
    title: "משימות",
    href: "/tasks",
    body: "כל המשימות שאתה מעורב בהן — ככותב, מאשר, מנהל פרויקט או עובד. הסימון האדום ליד ״משימות״ סופר רק משימות שמחכות לפעולה ממך. בתוך הדף המשימות מחולקות לפי סטטוס, ואפשר לסנן לפי פרויקט, סטטוס ותפקיד.",
  },
  {
    emoji: "📢",
    title: "קמפיינים",
    href: "/morning",
    body: "סקירת בוקר של כל הקמפיינים — אילו פרויקטים צריכים תשומת לב לפי התראות חכמות (חריגת תקציב, קצב, סיום מתקרב). מוצג לאדמינים, מנהלים ותפקידי מדיה.",
  },
  {
    emoji: "🔔",
    title: "התראות",
    href: "/notifications",
    body: "מרכז ההתראות שלך — תיוגים, תגובות, ועדכוני סטטוס במשימות שאתה מעורב בהן. אפשר להשתיק את הסימון האדום זמנית מגלגל ההגדרות ⚙️ בלי לאבד את ההתראות עצמן.",
  },
  {
    emoji: "🏷️",
    title: "תיוגים",
    href: "/inbox",
    body: "כל המקומות שבהם תויגת (@) בדיונים, מכל הפרויקטים במקום אחד. הקישור בתפריט מופיע רק כשיש משהו לטפל בו — אם אתה לא רואה אותו, אין תיוגים פתוחים.",
  },
  {
    emoji: "📩",
    title: "מיילים מלקוחות",
    href: "/customer-emails",
    body: "מציג מיילים מלקוחות רשומים מ-3 הימים האחרונים, ישירות בתפריט — להמרה מהירה למשימה או להעברה לצ׳אט הפרויקט. כבוי כברירת מחדל; מפעילים אותו בגלגל ההגדרות ⚙️.",
  },
  {
    emoji: "📥",
    title: "Google Tasks",
    body: "שיקוף חי של משימות שיצרת ב-Gmail דרך ״Add to tasks״. בלחיצה אחת ממירים אותן למשימת Hub עם פרטי המייל ממולאים. מופיע בתפריט רק כשיש משימות כאלה.",
  },
  {
    emoji: "🔗",
    title: "דשבורד",
    body: "קישור לדשבורד הלקוחות (Apps Script) — הדוחות, נתוני הפרסום והקצב לכל פרויקט. נפתח בלשונית חדשה בחשבון Google הנכון אוטומטית.",
  },
];

const SHORTCUTS: { keys: string; desc: string }[] = [
  { keys: "⌘K / Ctrl+K", desc: "פתח את לוח הפקודות — קפיצה מהירה לפרויקט, פעולה או חיפוש תוכן" },
  { keys: "/", desc: "פתח חיפוש" },
  { keys: "g ואז p", desc: "מעבר לפרויקטים" },
  { keys: "g ואז i", desc: "מעבר לתיוגים" },
  { keys: "g ואז n", desc: "פתיחת הערה אישית חדשה" },
  { keys: "?", desc: "הצגת כל קיצורי המקלדת" },
  { keys: "Esc", desc: "סגירת חלון קופץ" },
];

// The task lifecycle, in roughly the order a task moves through it.
// Mirrors WorkTaskStatus in lib/appsScript.ts.
const STATUSES: { label: string; he: string; desc: string }[] = [
  { label: "draft", he: "טיוטה", desc: "נכתבה אך עוד לא נשלחה לטיפול" },
  { label: "awaiting_handling", he: "ממתין לטיפול", desc: "מוכנה — מחכה שמישהו ייקח אותה" },
  { label: "in_progress", he: "בעבודה", desc: "מישהו עובד עליה כרגע" },
  { label: "awaiting_clarification", he: "ממתין לבירור", desc: "תקועה עד שתתקבל תשובה" },
  { label: "awaiting_approval", he: "ממתין לאישור", desc: "הושלמה ומחכה לאישור מאשר" },
  { label: "blocked", he: "חסום", desc: "ממתינה למשימה אחרת שתסתיים קודם" },
  { label: "done", he: "בוצע", desc: "הסתיימה (סופי)" },
  { label: "cancelled", he: "בוטל", desc: "ירדה מהפרק (סופי)" },
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
            מדריך התחלה קצר לצוות. עוברים עליו פעם אחת — ומכאן הכל במקום
            אחד: פרויקטים, משימות, התראות ודוחות הלקוחות.
          </div>
        </div>
      </header>

      <section className="help-open-card">
        <h2>🚀 חמש דקות להתחלה</h2>
        <ol className="onboarding-steps">
          <li>
            <b>התחברת — אתה כבר בפנים.</b> ההתחברות היא עם חשבון ה-Google
            של F&F. אם אתה רואה את העמוד הזה, הכל תקין.
          </li>
          <li>
            <b>הכר את העמוד הראשי.</b> לחיצה על{" "}
            <Link href="/">📂 פרויקטים</Link> או על הלוגו מציגה את כל
            הפרויקטים שלך, מקובצים לפי חברה.
          </li>
          <li>
            <b>בדוק מה מחכה לך.</b> הסימון האדום ליד{" "}
            <Link href="/tasks">📋 משימות</Link> סופר רק מה שדורש פעולה
            ממך — תתחיל משם.
          </li>
          <li>
            <b>כוונן התראות.</b> בגלגל ⚙️ שבפינה אפשר להחליט אילו התראות
            יגיעו למייל ולהשתיק רעש זמנית.
          </li>
          <li>
            <b>(פעם אחת לכל מחשב)</b> הגדר{" "}
            <Link href="/help/open-locally">פתיחת תיקיות במחשב</Link> כדי
            שכפתור התיקייה 📁 יפתח את התיקייה ישירות ב-Explorer / Finder.
          </li>
        </ol>
      </section>

      <section className="help-open-card">
        <h2>🧭 הסרגל העליון — מה כל כפתור עושה</h2>
        <p className="help-open-alt">
          חלק מהכפתורים מופיעים רק כשיש בהם תוכן (תיוגים, Google Tasks,
          מיילים מלקוחות) — אז סרגל ״חלק״ זה תקין, לא חוסר.
        </p>
        <div className="onboarding-grid">
          {FEATURES.map((f) => (
            <div key={f.title} className="onboarding-feature">
              <h3>
                <span aria-hidden>{f.emoji}</span>
                {f.href ? <Link href={f.href}>{f.title}</Link> : f.title}
              </h3>
              <p>{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="help-open-card">
        <h2>📋 איך עובדות משימות</h2>
        <p>
          כל משימה עוברת בין סטטוסים, ולכל אדם תפקיד בה: <b>כותב</b>{" "}
          (מי שיצר), <b>מאשר</b> (מי שמאשר בסיום), <b>מנהל פרויקט</b>,
          ו<b>עובדים</b> (מי שמבצע). הסטטוסים:
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
          כשמשימה נסגרת, משימות שהיו חסומות בגללה משתחררות אוטומטית
          ל״ממתין לטיפול״.
        </p>
      </section>

      <section className="help-open-card">
        <h2>🧩 משימות מעטפת ושרשראות</h2>
        <p>
          כשעבודה מורכבת מכמה שלבים או מעורבים בה כמה אנשים, יש שתי דרכים
          לארגן אותה:
        </p>
        <ul className="onboarding-tools">
          <li>
            <b>משימת מעטפת:</b> ״קופסה״ שמאגדת תחתיה כמה תתי-משימות
            ומציגה את התמונה הכוללת (כמה הושלמו מתוך כמה). לא עובדים בה
            ישירות — הסטטוס שלה מתעדכן אוטומטית לפי תתי-המשימות. מעטפות
            מוסתרות כברירת מחדל ברשימת המשימות, ואפשר להציג אותן בלחיצה
            על המסנן המתאים.
          </li>
          <li>
            <b>שרשרת:</b> סדרה של שלבים שבהם כל שלב <b>חוסם</b> את הבא.
            השלב הראשון פתוח לעבודה, והשאר מסומנים ״חסום״ עד שהקודם
            מסתיים. ברגע ששלב נסגר, המערכת משחררת אוטומטית את הבא
            ל״ממתין לטיפול״.
          </li>
          <li>
            <b>תבניות שרשרת:</b> אפשר להקים שרשרת שלמה בבת אחת מתבנית
            מוכנה (למשל מדיה ← סטודיו ← אמנות ← קופי) — כל השלבים נוצרים
            מקושרים מראש, בדרך כלל תחת מעטפת אחת שמאגדת אותם.
          </li>
        </ul>
        <p>
          <b>איך מפעילים?</b> בטופס{" "}
          <Link href="/tasks/new">משימה חדשה</Link>, ברגע שבוחרים יותר
          מאדם אחד מופיע בורר אופן העבודה:
        </p>
        <ul className="onboarding-tools">
          <li><b>משימה אחת משותפת</b> — כולם אחראים על אותה משימה (ברירת המחדל).</li>
          <li><b>🌂 מטריה עם משימות מקבילות</b> — משימה נפרדת לכל אדם, תחת מעטפת אחת שמרכזת את ההתקדמות.</li>
          <li><b>🔗 שרשרת משימות</b> — שלב לכל אדם בזה אחר זה; אפשר לשנות את הסדר.</li>
        </ul>
        <p className="help-open-alt">
          בקצרה: <b>מעטפת</b> = ארגון ותצוגה כוללת · <b>שרשרת</b> = תלות
          וסדר ביצוע. השתיים משלימות זו את זו.
        </p>
      </section>

      <section className="help-open-card">
        <h2>⏱️ מעקב זמן</h2>
        <p>
          ה-Hub מודד כמה זמן משימה נמצאה בסטטוס <b>בעבודה</b>:
        </p>
        <ul className="onboarding-tools">
          <li>
            <b>אוטומטי:</b> השעון מתחיל כשמעבירים משימה ל״בעבודה״ ונעצר
            כשהיא יוצאת מהסטטוס — בלי צורך בהפעלה ידנית.
          </li>
          <li>
            <b>השהיה / חידוש:</b> באמצע עבודה אפשר להשהות את השעון
            (הפסקה, מעבר זמני למשימה אחרת) בלי לשנות סטטוס, ולחדש אחר כך.
          </li>
          <li>
            <b>תיקון ידני:</b> אם משימה נשארה ב״בעבודה״ בטעות (סוף שבוע /
            חופשה), אפשר לקבוע את הזמן ידנית או לאפס חזרה לחישוב האוטומטי.
          </li>
          <li>
            <b>יומן זמן:</b> בנוסף אפשר לרשום ידנית כמה זמן הושקע —
            תיעוד נפרד מהשעון האוטומטי. לאדמינים יש{" "}
            <Link href="/admin/time">דוח זמן מרוכז</Link> לפי
            חברה / חודש עם ייצוא ל-CSV.
          </li>
        </ul>
        <p className="help-open-alt">
          מעקב הזמן הוא לתיעוד וניהול בלבד — הוא <b>אינו</b> משפיע על
          החיוב, שנקבע בנפרד לפי המחירון.
        </p>
      </section>

      <section className="help-open-card">
        <h2>💬 דיונים: פנימי מול משותף</h2>
        <p>
          בכל פרויקט יש דיון עם שתי כרטיסיות, וההבחנה ביניהן קריטית:
        </p>
        <ul className="onboarding-tools">
          <li>
            <b>🔒 פנימי</b> — לצוות F&F בלבד. הלקוח <b>לעולם לא רואה</b>{" "}
            את ההודעות האלה.
          </li>
          <li>
            <b>🤝 משותף</b> — נצפה גם על ידי הלקוח.
          </li>
        </ul>
        <p>
          המערכת קובעת מי רואה מה לפי כתובת המייל: רק כתובות{" "}
          <span dir="ltr">@fandf.co.il</span> רואות את הפנימי; לקוחות
          רואים אך ורק את המשותף (אצלם זו הכרטיסייה היחידה). כל הודעה
          נשמרת לפי הכרטיסייה שבה נכתבה — <b>שים לב באיזו כרטיסייה אתה
          לפני שליחה</b>, כדי לא לשלוח ללקוח משהו שנועד לצוות.
        </p>
        <p className="help-open-alt">
          תיוג (@) שולח התראה לאדם שתויג; בתשובה בשרשור גם מי שתויג קודם
          מקבל התראה. כל התיוגים שלך מרוכזים תחת 🏷️ תיוגים. אפשר גם להפוך
          הודעה למשימה ישירות מהדיון.
        </p>
      </section>

      <section className="help-open-card">
        <h2>📁 גוגל דרייב, בריפים וסנכרון דו-כיווני</h2>
        <p>
          כל פרויקט מחובר לתיקייה ב-Google Drive (כונן משותף), במבנה
          היררכי: <b>חברה ← פרויקט ← בריף ← משימה</b>.
        </p>
        <ul className="onboarding-tools">
          <li>
            <b>בריף</b> הוא רמת הארגון השלישית. כל בריף הוא תיקייה
            ב-Drive.
          </li>
          <li>
            <b>סנכרון דו-כיווני:</b> רשימת הבריפים בטופס נקראת ישירות
            מתיקיות ה-Drive (Drive הוא מקור האמת). יצירת בריף חדש ב-Hub
            יוצרת לו תיקייה ב-Drive; שימוש בשם בריף שאין לו תיקייה יוצר
            אותה אוטומטית בשמירה; ושינוי שם בריף מעדכן גם את תיקיית
            ה-Drive וגם את כל המשימות שמשתמשות בו.
          </li>
          <li>
            <b>כפתור התיקייה 📁</b> בעמודי הפרויקט והמשימה מעתיק את
            הנתיב המקומי, ועם{" "}
            <Link href="/help/open-locally">ההתקנה החד-פעמית</Link> פותח
            את התיקייה ישירות ב-Explorer / Finder דרך Google Drive for
            Desktop.
          </li>
          <li>
            קבצים שמעלים למשימה נשמרים בתיקיית ה-Drive שלה.
          </li>
        </ul>
      </section>

      <section className="help-open-card">
        <h2>⚡ כלים שיחסכו לך זמן</h2>
        <ul className="onboarding-tools">
          <li>
            <b>לוח הפקודות (⌘K):</b> הדרך הכי מהירה לקפוץ לכל פרויקט,
            פעולה, או לחפש תוכן בכל הדיונים.
          </li>
          <li>
            <b>הערה אישית מהירה:</b> כפתור ה-➕ הצף בפינה, או הקיצור{" "}
            <kbd dir="ltr">Ctrl+Shift+M</kbd> / <kbd dir="ltr">g</kbd> ואז{" "}
            <kbd dir="ltr">n</kbd> — רושמים לעצמם תזכורת מכל עמוד, והיא
            נשמרת כמשימה ברשימה שלך.
          </li>
          <li>
            <b><Link href="/tasks/new">משימה חדשה</Link>:</b> מעמוד
            המשימות, או המרה בלחיצה ממייל לקוח / מ-Google Tasks.
          </li>
          <li>
            <b>עוזר ה-AI (✨):</b> הכפתור הצף פותח צ׳אט עוזר שמכיר את
            הנתונים של ה-Hub ויכול לענות על שאלות.
          </li>
          <li>
            <b>פאנל היום:</b> הסרגל בצד מרכז את מה שחשוב היום — תזכורות,
            התראות פעילות ופגישות.
          </li>
          <li>
            <b>מצב כהה / בהיר:</b> כפתור הנושא 🌓 בסרגל מחליף ערכת צבעים.
          </li>
        </ul>
      </section>

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
          בכל רגע אפשר ללחוץ <kbd>?</kbd> כדי לראות את הרשימה המלאה.
        </p>
      </section>

      <section className="help-open-card help-open-safety">
        <h2>🙋 צריך עזרה?</h2>
        <p>
          משהו לא ברור או לא עובד כמו שצריך — פנה למעין (
          <a href="mailto:maayan@fandf.co.il" dir="ltr">
            maayan@fandf.co.il
          </a>
          ). אפשר גם לשאול את עוזר ה-AI ✨ ישירות מכל עמוד.
        </p>
      </section>

      <div className="help-open-back">
        <Link href="/">→ חזרה לפרויקטים</Link>
      </div>
    </main>
  );
}
