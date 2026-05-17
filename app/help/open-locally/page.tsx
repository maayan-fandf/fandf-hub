import Link from "next/link";

export const metadata = { title: "פתיחת תיקיות במחשב — F&F Hub" };

// Copy-paste fallback for when "Run with PowerShell" is blocked (org
// policy / double-click opens an editor). String.raw so backslashes
// render verbatim; the snippet has no backticks and no ${ } so it's
// safe in a raw template. Mirrors public/desktop-open/install-windows.ps1.
const WIN_SNIPPET = String.raw`$dir = "$env:LOCALAPPDATA\FandFOpen"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$h = @(
 'param([string]$u)',
 'try {',
 '  $p = [uri]::UnescapeDataString(($u -replace "^fandfopen:","")).Replace("/","\")',
 '  $c = $p',
 '  while ($c -and -not (Test-Path -LiteralPath $c)) { $c = Split-Path -Parent $c }',
 '  if ($c) { Start-Process explorer.exe -ArgumentList ([char]34 + $c + [char]34) }',
 '} catch {}'
)
Set-Content -LiteralPath "$dir\open.ps1" -Value $h -Encoding UTF8
New-Item -Path 'HKCU:\Software\Classes\fandfopen\shell\open\command' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Classes\fandfopen' -Name '(default)' -Value 'URL:FandF Open'
Set-ItemProperty -Path 'HKCU:\Software\Classes\fandfopen' -Name 'URL Protocol' -Value ''
$run = 'powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $dir + '\open.ps1" "%1"'
Set-ItemProperty -Path 'HKCU:\Software\Classes\fandfopen\shell\open\command' -Name '(default)' -Value $run
reg query "HKCU\Software\Classes\fandfopen\shell\open\command"`;

/**
 * One-time setup guide for the `fandfopen:` helper. Linked from the
 * ⚙️ gear menu (everyone) and the 📁 folder button's hint popover.
 * Static, no data — just the per-OS steps + download buttons. See
 * public/desktop-open/ for the installers + lib/inProgressTime note
 * in CopyLocalPathButton for why a per-machine helper is required.
 */
export default function OpenLocallyHelpPage() {
  return (
    <main className="container help-open">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>💻</span>
            פתיחת תיקיות במחשב — התקנה חד-פעמית
          </h1>
          <div className="subtitle">
            הופך את כפתור התיקייה{" "}
            <span aria-hidden>📁</span> בעמודי הפרויקטים והמשימות לפתיחה
            ישירה של התיקייה ב־File Explorer / Finder דרך Google Drive
            for Desktop — בלחיצה אחת, בלי להעתיק ולהדביק נתיב.
          </div>
        </div>
      </header>

      <section className="help-open-card">
        <h2>למה צריך התקנה?</h2>
        <p>
          דפדפנים חוסמים פתיחה של תיקייה מקומית מתוך אתר (מטעמי אבטחה).
          הדרך היחידה לפתיחה אמיתית בלחיצה היא רישום חד-פעמי של קיצור
          מותאם במחשב. ההתקנה היא <b>לכל משתמש בלבד</b> (ללא הרשאת
          מנהל) וצריך לבצע אותה <b>פעם אחת בכל מחשב</b>. בלי ההתקנה
          הכפתור עדיין מעתיק את הנתיב ומראה איך להדביק אותו — פשוט בלי
          הפתיחה האוטומטית.
        </p>
        <p className="help-open-req">
          <b>דרישה מוקדמת:</b> מותקן ומחובר Google Drive for Desktop,
          והכונן המשותף ממופה (<code dir="ltr">G:\</code> בווינדוס,{" "}
          <code dir="ltr">~/Library/CloudStorage/…</code> במק).
        </p>
      </section>

      <section className="help-open-card">
        <h2>
          <span aria-hidden>🪟</span> Windows
        </h2>
        <ol className="help-open-steps">
          <li>
            הורד את קובץ ההתקנה:{" "}
            <a
              className="btn-primary btn-sm"
              href="/desktop-open/install-windows.ps1"
              download
              dir="ltr"
            >
              ⬇ install-windows.ps1
            </a>
          </li>
          <li>
            לחיצה ימנית על הקובץ שהורד →{" "}
            <b>“Run with PowerShell”</b>. (אם יש אזהרת SmartScreen — זה
            צפוי לקובץ התקנה; אפשר לאשר.)
          </li>
          <li>נפתח חלון קצר ומאשר שההתקנה בוצעה — אפשר לסגור.</li>
        </ol>
        <details className="help-open-fallback">
          <summary>
            לא עבד / “Run with PowerShell” חסום? פתרון בהדבקה
          </summary>
          <p>
            פתח <b>PowerShell</b> (תפריט התחלה → הקלד PowerShell) והדבק
            את כל הבלוק הבא בבת אחת, Enter:
          </p>
          <pre dir="ltr">{WIN_SNIPPET}</pre>
          <p className="help-open-alt">
            השורה האחרונה אמורה להדפיס את הפקודה שנרשמה — סימן
            שההתקנה הצליחה.
          </p>
        </details>
      </section>

      <section className="help-open-card">
        <h2>
          <span aria-hidden></span> macOS
        </h2>
        <ol className="help-open-steps">
          <li>
            הורד את קובץ ההתקנה:{" "}
            <a
              className="btn-primary btn-sm"
              href="/desktop-open/install-macos.command"
              download
              dir="ltr"
            >
              ⬇ install-macos.command
            </a>
          </li>
          <li>
            לחיצה ימנית על הקובץ שהורד → <b>Open</b> → ושוב{" "}
            <b>Open</b> (פעם ראשונה, כדי לעקוף את Gatekeeper).
            <br />
            <span className="help-open-alt">
              לחלופין ב־Terminal:{" "}
              <code dir="ltr">bash ~/Downloads/install-macos.command</code>
            </span>
          </li>
          <li>מופיע אישור שההתקנה בוצעה — אפשר לסגור.</li>
        </ol>
      </section>

      <section className="help-open-card">
        <h2>אחרי ההתקנה</h2>
        <p>
          חזור לכפתור התיקייה <span aria-hidden>📁</span> בעמוד הפרויקט
          / המשימה ולחץ עליו שוב. בפעם הראשונה הדפדפן ישאל אם לפתוח את
          הקישור <code dir="ltr">fandfopen</code> — אשר/י (ורצוי לסמן
          “זכור / תמיד”). מכאן והלאה הכפתור פותח את התיקייה ישירות.
        </p>
      </section>

      <section className="help-open-card help-open-safety">
        <h2>בטיחות והסרה</h2>
        <p>
          העוזר <b>אף פעם לא מריץ פקודות</b> — הוא רק מעביר את הנתיב
          המפוענח ל־Explorer / Finder, כך שקישור זדוני יכול לכל היותר
          לפתוח חלון של תיקייה. פרטים מלאים, הסבר טכני והוראות הסרה
          בקובץ{" "}
          <a href="/desktop-open/README.txt" target="_blank" rel="noreferrer">
            README.txt
          </a>
          .
        </p>
      </section>

      <div className="help-open-back">
        <Link href="/">← חזרה</Link>
      </div>
    </main>
  );
}
