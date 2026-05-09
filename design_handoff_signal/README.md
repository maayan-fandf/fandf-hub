# Handoff: F&F Hub — Direction B "Signal"

## Overview
This is a visual + IX redesign of the F&F Hub (`hub.fandf.co.il`) — an internal work-management tool for a digital marketing agency. The target codebase is the existing Next.js 15 / App Router app in `hub-next/` (the source codebase this design was built against). The design covers two screens: **Projects Home** (`/`) and **Morning / Alert feed** (`/morning`).

## About the Design Files
The files in `prototypes/` are **design references written in HTML + React/JSX for previewing in a browser** — they are not production code to copy directly. Your job is to **recreate the visuals and interactions in the real codebase** (`hub-next/` — Next.js 15 + Server Components + `next-auth` + Apps Script backend) using its existing patterns, data fetching, and file structure. Data in the prototype is hard-coded placeholder; the real screens already have typed server actions (`getMyProjects`, `getMyCounts`, `getMorningFeed`) that return the same shape.

Open `preview.html` to see the two screens rendered at 1280×820.

## Fidelity
**High-fidelity.** All colors, typography, spacing, and layout values below are the intended final values. Recreate pixel-accurately.

## Target Codebase Notes
- **Framework**: Next.js 15 App Router, React Server Components, TypeScript
- **Styling**: plain CSS in `app/globals.css` with CSS custom properties (light + `[data-theme="dark"]`). This redesign is **dark-first** — add the new tokens to the dark theme and let light-mode remain as-is for now, OR rebuild `globals.css` around these tokens (the second is preferred — the current CSS is fighting itself with too many hues).
- **Language**: Hebrew, `<html lang="he" dir="rtl">` — already set in `app/layout.tsx`.
- **Icons**: the prototype uses Unicode glyphs (`○ ▦ ◐ ◇ ✓ ⚙ ↗ ⌕`). Replace with a real icon set — **Lucide** (`lucide-react`) is recommended; monochrome, stroke-based, matches the aesthetic.
- **Remove emoji** from nav + headers. They're part of the current design's clutter — this direction relies on typography + color for hierarchy.

---

## Design Tokens

Add these to `app/globals.css` under `[data-theme="dark"]` (and derive light equivalents if needed).

```css
/* Signal palette */
--bg:          #0b0c10;  /* page background */
--surface:     #15171f;  /* cards, table, sidenav */
--surface-hi:  #1c1f2a;  /* hover, active row, search */
--rule:        #272a36;  /* borders */
--rule-soft:   #1f2230;  /* subtle dividers */
--ink:         #eef0f6;  /* primary text */
--ink-soft:    #8a90a4;  /* secondary text */
--ink-muted:   #5a6077;  /* labels, monospace meta */

/* Accent — "signal mint" — used for brand, active nav, primary buttons, positive data */
--accent:      #7cf5b3;
--accent-ink:  #063a23;  /* text on --accent */

/* Semantic */
--warn:        #f4c96b;
--crit:        #f77b7b;
--ok:          #7cf5b3;  /* same as accent */

/* Radii */
--r-sm: 4px;
--r-md: 5px;
--r-lg: 6px;
--r-xl: 8px;
```

### Typography
- **UI sans**: `Heebo` (Google Fonts, weights 400/500/600/700). Hebrew-native, works great for both he and en.
- **Monospace**: `IBM Plex Mono` (Google Fonts, weight 400/500). Used for kickers, micro-labels, numerics, kbd hints.
- **No serif.** No brand italic. No emoji.

Type scale (px):
| Use | Font | Size | Weight | Tracking |
|---|---|---|---|---|
| Page title (`h1`) | Heebo | 20 | 700 | 0 |
| KPI number | Heebo | 30 | 700 | -0.5 |
| KPI label | Heebo | 11 | 500 | 0.08em, uppercase |
| Section/kicker | Plex Mono | 10.5 | 500 | 0.1em |
| Body | Heebo | 13 | 500 | 0 |
| Micro / meta | Heebo | 11.5 | 500 | 0 |
| Table header | Plex Mono | 10 | 500 | 0.1em |
| Numerics | Heebo, `font-feature-settings: "tnum"` |

---

## Layout Shell (shared by both screens)

Every signed-in page is a 2-column grid:
- **Left side nav**: 220px fixed, `background: --surface`, `border-inline-start: 1px solid --rule` (RTL — the "left" rail sits on the right in RTL).
- **Main**: fluid.

### SideNav contents (top → bottom)
1. **Brand row** — 22×22 rounded-5 `--accent` tile with bold "F" (`--accent-ink`) + "Hub" wordmark (700, 14px) + small mono `v3` pushed to edge.
2. **Search chip** (`--surface-hi`, 1px `--rule`, `--r-lg`, 8×10px padding) with magnifier + "חיפוש" + `⌘K` mono glyph pushed to edge. Opens the existing CommandPalette.
3. **Primary nav** — 5 items, each a row:
   - היום · projects · בוקר (badge `3`) · תיוגים (badge `6`) · משימות שלי
   - Icon (14px, `--ink-muted`; `--accent` when active), label (13 / 500; 600 when active), badge (right side, `--accent` bg, `--accent-ink` text, 10px / 700, 99px radius, 1×6px pad)
   - Active row: `background: --surface-hi`, plus a 2×(row-height-minus-margins) px bar at `inset-inline-end: -14px` in `--accent`, `border-radius: 2px`
4. **MORE** mono label (9px, `--ink-muted`, `0.1em` tracking)
5. Secondary nav rows — admin, external dashboard. Same shape as primary, no badge, no icon highlight.
6. Spacer pushes the user tile to the bottom.
7. **User tile** — 28×28 radius-8 avatar (gradient `linear-gradient(135deg, #a78bfa, #7cf5b3)`, dark initials), name (12/600) + email (10.5, `--ink-muted`, `dir="ltr"`), separated from nav by `border-top: 1px solid --rule`, `padding-top: 14px`.

### Main header
- Padding `18px 28px`, `border-bottom: 1px solid --rule`, sticky at top with `z-index: 2`.
- Left: 2-line block — kicker mono `WORKSPACE / FANDF` (10.5 / `--ink-muted` / uppercase-ish) + page title (`h1`, 20/700).
- Spacer.
- Right-side controls: segmented view picker (see Home), primary action button.

---

## Screen 1 — Projects Home (`/`)

Replaces `app/page.tsx`. Keep its data loading (parallel `getMyProjects` + `getMyCounts`) exactly as-is; only the render changes.

### Header right side
- **View segmented control**: `background: --surface`, `1px --rule`, `--r-lg`, `2px` inner padding. Three items: `רשימה / לוח / ציר זמן`. Active item has `--surface-hi` background, `--r-sm`, 5×12 padding, 12/500. Inactive items: transparent, `--ink-soft`.
- **Primary button**: `+ פרויקט` — `--accent` bg, `--accent-ink` text, 7×14 padding, `--r-lg`, 12/700.

### Body — 24px padding
**KPI strip** — 4-up grid, `gap: 12px`, `margin-bottom: 22px`. Each tile:
- `--surface` bg, `1px --rule`, `--r-xl`, padding `14px 16px`, flex column, `gap: 8px`.
- Row 1: label (11/500, uppercase-ish, 0.08em tracking, `--ink-soft`).
- Row 2: big value (30/700, -0.5 tracking, `tnum` numerals) + small colored delta (11.5/600). Delta color: `--crit` / `--warn` / `--accent`.
- Row 3: sparkline — inline `<svg>` 100% × 22, `preserveAspectRatio="none"`. `<polyline>` stroke 1.5 in accent color, `<polygon>` same points + baseline, `fill` same color at `opacity: 0.12`.

KPI content for the prototype (use real values from `MyCounts` + `MorningFeed`):
1. `משימות פתוחות` — value = `counts.total.openTasks`, sub = `${overdue} באיחור`, tone `crit`
2. `תיוגים חדשים` — value = `counts.total.openMentions`, sub = `+N היום`, tone `ok`
3. `פרויקטים פעילים` — value = `data.projects.length`, sub = `N חברות` (distinct companies), no tone
4. `תקציב מוקצה` — sum of `MorningProject.budget`, sub = `% נוצל`, tone `warn` if ≥90%

**Projects table**
- Container: `--surface` bg, `1px --rule`, `--r-xl`, overflow hidden.
- Header row: grid `1.6fr 1fr 60px 60px 1fr 90px`, `gap: 14px`, `padding: 10px 16px`, `background: --surface-hi`, `border-bottom: 1px --rule`. Mono 10/500 0.1em tracking, `--ink-muted`. Columns: `פרויקט · לקוח · משימות (center) · תיוגים (center) · קצב · סטטוס (end)`.
- Data row: same grid, `padding: 12px 16px`, `border-bottom: 1px --rule-soft`, 13 / 500.
  - Project cell: 6×6 rounded-2 square in `statusColor` + bold project name (truncate). Click → `/projects/[name]`.
  - Company cell: `--ink-soft`, 12px.
  - Tasks cell: mono 11.5, center-aligned; `--ink` when > 0 else `--ink-muted`.
  - Mentions cell: mono 11.5 center; `--accent` when > 0 else `--ink-muted`.
  - Progress cell: flex row — 4px high bar in `--rule-soft` (2px radius, overflow hidden) with inner fill `width: {progress}%` in `--accent` (or `--crit` if > 95); then mono 10.5 / `--ink-soft` / min-width 26 / text "N%".
  - Status cell: 10.5 / 600 / textAlign: left (= RTL-end). Text + color from status map.
- Status map: `ontrack` → `--accent` / "במסלול"; `risk` → `--warn` / "סיכון"; `blocked` → `--crit` / "חסום"; `idle` → `--ink-muted` / "רגוע".
  - Derive `status` from MorningProject.maxSeverity + progress: 3 → `blocked`, 2 → `risk`, 0 and progress == 0 → `idle`, else `ontrack`.
- Table footer (outside container): mono 10.5 `--ink-muted`, `padding: 10px 16px 0`, flex with gap 18px — `${count} פרויקטים · ${companies} חברות` on the start, `עודכן לפני N שניות` on the end (use `new Date().toISOString()` or a short relative).

---

## Screen 2 — Morning / Alert feed (`/morning`)

Replaces `app/morning/page.tsx`. Data: `getMorningFeed({ scope })`. Same parallel load semantics.

### Header
- Kicker mono `/ ALERT FEED`.
- Title `h1` row: "בוקר" + a 7×7 pulsing dot (`--crit` bg, `box-shadow: 0 0 0 3px rgba(247,123,123,0.2)`, optional subtle pulse animation at 1.6s).
- Right side: 12/`--ink-soft` hint — "טיפלת? סמן ✓ והן ישוקטו עד מחר".

### KPI strip — 4-up, same component as Home
1. `התראות קריטיות` / `counts.severe` / tone `crit` / sub "דורשות פעולה היום"
2. `אזהרות` / `counts.warn` / tone `warn` / sub "ניתן לדחות"
3. `תקציב בסיכון` / sum of budgets on crit projects / tone `crit` / sub `N פרויקטים`
4. `שקט` / `counts.clear` / tone `ok` / sub "על המסלול"

### Severity filter strip
Row, `gap: 8px`, `margin-bottom: 14px`. Four chips — first is active (הכל · 12), rest colored dots: קריטי · 3 (`--crit`), אזהרה · 5 (`--warn`), שקט · 4 (`--ok`).
- Chip: `padding: 6px 12px`, `border-radius: 99px`, `font-size: 11.5 / 600`. Active: `--surface-hi` bg, `1px --ink` border, `--ink` text. Inactive: transparent bg, `1px --rule` border, color = dot color (or `--ink-soft` for "הכל"). 6×6 round dot prefix for colored chips.
- After filters, pushed to end: mono 10.5 `--ink-muted` — `SCOPE · שלי` (or `SCOPE · כולם` in admin scope).

### Alert rows
Grid row per `MorningProject` with signals, `1fr 180px 180px 130px` / `gap: 16px` / `padding: 16px 18px` / `margin-bottom: 10px`.
- Container: tinted background by severity:
  - `crit` → `rgba(247,123,123,0.08)`
  - `warn` → `rgba(244,201,107,0.06)`
  - `ok`   → `rgba(124,245,179,0.05)`
- `1px --rule`, `--r-xl`.

**Cell 1 — content**
- Row: severity chip (mono 9.5 / 700 / 0.15em tracking / `1px border` of severity color / `padding 1×6 --r-sm` / same color text, uppercase label: CRITICAL / WARNING / CLEAR) + project name (14/700) + company name (11.5 `--ink-soft`).
- Headline (13, `--ink`, margin-bottom 4).
- Detail (11.5, `--ink-soft`).
- Signal chips row (`margin-top: 8px`, `gap: 6px`, flex wrap): each chip — mono 10, `--surface-hi` bg, `1px --rule`, `--ink-soft`, `padding: 2px 7px`, `--radius 99px`. Populate from `MorningProject.signals`.

**Cells 2 + 3 — bars** (budget + time)
- Header row: 10.5 / `--ink-soft` label + mono % value. Value color: `--crit` if over 100, else `--ink`.
- Track: 6px tall, `--rule-soft` bg, 3px radius. Fill: `min(100%, pct%)`, `--accent` (or `--crit` if over). If over 100: 3px wide `--crit` bar at the track's inside-end with `box-shadow: 0 0 8px --crit` glow.

**Cell 4 — actions**
- Two small buttons, justified to end, `gap: 6px`.
- Secondary: `פתח` — `--surface` bg, `1px --rule`, `--ink` text, 5×10, 11/600, `--r-md`. Links to `/projects/[name]`.
- Primary: `✓ טופל` — `--accent` bg, `--accent-ink` text, 5×10, 11/700, `--r-md`. POSTs to the existing `/api/morning/dismiss` route.

---

## Interactions & Behavior

- **Nav active state**: derive from `usePathname()`; `/` → projects, `/morning`, `/inbox`, `/admin`.
- **Command palette**: `⌘K` / `Ctrl+K` opens the existing `<CommandPalette>` component (already mounted in `layout.tsx`).
- **Sparklines**: prototype uses fake points. Wire to real data later; initial pass can compute from `MorningProject` history if available, otherwise show last 8 `byProject` snapshots if persisted, otherwise omit.
- **Row → project**: clicking any project row or alert's `פתח` button navigates to `/projects/${encodeURIComponent(project.name)}`.
- **Mark handled**: `✓ טופל` button calls the existing dismiss endpoint; optimistically remove the card with a 200ms ease-out fade + height collapse.
- **Severity filter**: updates URL `?severity=...`; server re-fetches and re-renders (same pattern as the current `morning/page.tsx`).
- **Scope toggle**: admin users see a "SCOPE · שלי / כולם" toggle — click cycles. Same query-string pattern as today.
- **Hover states**:
  - Nav rows: background → `--surface-hi` at 60% opacity.
  - Table rows: background → `rgba(255,255,255,0.02)`.
  - Buttons: `filter: brightness(1.05)` on accent; `background: --surface-hi` on secondary.
- **Loading**: skeleton rows in table (6 rows, same grid, each cell a 1.5em tall `--surface-hi` block at 60% width).

## Responsive
- **≤ 1024px**: side nav collapses to icons only (44px wide). Labels hide. Badges still show.
- **≤ 768px**: side nav becomes a bottom tab bar (5 icons). KPI strip goes 2×2. Table collapses to stacked cards — same info, vertical stack.
- **≤ 480px**: alert row grid goes 1-col; bars and actions stack under the content cell.

## State Management
None beyond what the App Router already does — Server Components fetch data, Server Actions handle mutations. No client-side store needed. The only client components are:
- `<ThemeToggle>` (existing)
- `<CommandPalette>` (existing)
- `<NavMentionBadge>` / `<NavMorningLink>` (existing) — keep the badge-count polling.

## Files in the Prototype
- `prototypes/B_signal.jsx` — all components for the two screens, as runnable JSX.
- `prototypes/design-canvas.jsx` — the multi-frame canvas wrapper (ignore; just for previewing side-by-side).
- `preview.html` — open this to see the two screens rendered at full 1280×820.

## Assets
No custom assets. Everything is type, layout, CSS custom properties, and a handful of inline SVG sparklines. The avatar gradient in the user tile is pure CSS. Icons should be swapped to `lucide-react` — suggested mapping:
- `○` → `<Circle>`
- `▦` → `<LayoutGrid>`
- `◐` → `<Sunrise>` or `<AlertCircle>`
- `◇` → `<AtSign>` or `<Bell>`
- `✓` → `<Check>` / `<CheckSquare>`
- `⚙` → `<Settings>`
- `↗` → `<ArrowUpRight>` / `<ExternalLink>`
- `⌕` → `<Search>`
