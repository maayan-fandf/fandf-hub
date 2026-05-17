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

const WIN_UNINSTALL = String.raw`Remove-Item -Recurse -Force 'HKCU:\Software\Classes\fandfopen' -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\FandFOpen" -ErrorAction SilentlyContinue`;

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
          <span aria-hidden>🪟</span> Windows — מומלץ (הדבקה)
        </h2>
        <p>
          השיטה הכי אמינה (עובדת גם כשמדיניות החברה חוסמת הרצת קבצים):
          פתח <b>PowerShell</b> (תפריט התחלה → הקלד <code>PowerShell</code>{" "}
          → Enter), הדבק את <b>כל</b> הבלוק הבא בבת אחת ולחץ Enter:
        </p>
        <pre dir="ltr">{WIN_SNIPPET}</pre>
        <p className="help-open-alt">
          השורה האחרונה תדפיס את הפקודה שנרשמה — סימן שההתקנה הצליחה.
          אפשר להריץ שוב בכל עת (כולל אחרי הסרה) — זה idempotent.
        </p>
        <details className="help-open-fallback">
          <summary>מעדיף/ה חבילת קבצים?</summary>
          <p>
            הורד{" "}
            <a
              className="btn-primary btn-sm"
              href="/desktop-open/fandf-open-helper.zip"
              download
              dir="ltr"
            >
              ⬇ fandf-open-helper.zip
            </a>{" "}
            (מכילה install / uninstall / README ל־Windows ול־macOS),
            פתח אותה, ובתיקיית <code dir="ltr">windows</code> לחיצה
            כפולה על <code dir="ltr">install.cmd</code>. אם גם זה חסום —
            שיטת ההדבקה למעלה תמיד עובדת (אותה תוצאה בדיוק).
          </p>
        </details>
      </section>

      <section className="help-open-card">
        <h2>הסרה (Windows)</h2>
        <p>הדבק ב־PowerShell (בטוח גם אם משהו לא קיים):</p>
        <pre dir="ltr">{WIN_UNINSTALL}</pre>
      </section>

      <section className="help-open-card">
        <h2>
          <span aria-hidden></span> macOS
        </h2>
        <ol className="help-open-steps">
          <li>
            הורד את החבילה:{" "}
            <a
              className="btn-primary btn-sm"
              href="/desktop-open/fandf-open-helper.zip"
              download
              dir="ltr"
            >
              ⬇ fandf-open-helper.zip
            </a>{" "}
            ופתח אותה (לחיצה כפולה).
          </li>
          <li>
            בתיקיית <code dir="ltr">macos</code>: לחיצה ימנית על{" "}
            <code dir="ltr">install.command</code> → <b>Open</b> → ושוב{" "}
            <b>Open</b> (פעם ראשונה, לעקוף את Gatekeeper).
            <br />
            <span className="help-open-alt">
              אם לחיצה כפולה לא עובדת:{" "}
              <code dir="ltr">bash ./install.command</code> ב־Terminal
              מתוך תיקיית <code dir="ltr">macos</code>. הסרה:{" "}
              <code dir="ltr">uninstall.command</code> באותו אופן.
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
          <a
            href="/desktop-open/bundle/README.txt"
            target="_blank"
            rel="noreferrer"
          >
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
