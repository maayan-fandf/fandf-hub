# Brief for Nadav — `sehel_meetings` is missing whole projects

**Date:** 2026-07-13
**Table:** `sehel_meetings` (Supabase `zkuzyxrkqjtramucjhid`)
**Impact:** blocks several Sehel projects from using the warehouse CRM funnel in the Hub.

## What we found

We turned on the Sehel warehouse funnel in the Hub (`SUPABASE_SEHEL_WAREHOUSE=1`).
Cross-checking June 2026, the **leads** are healthy across the whole portfolio,
but **`sehel_meetings` only covers ~46% of Sehel lead volume**. More than half
the active projects have leads in `sehel_leads_daily` but **zero rows** in
`sehel_meetings`:

| Project (base account) | June leads | warehouse meetings |
|---|---|---|
| כוכב הצפון אשדוד | 256 | **0** |
| קיימא (all salespeople) | ~96 | **0** |
| תדהר בין השדרות | 86 | **0** |
| רייסדור כרמי גת | 82 | **0** |
| רייסדור בני עי״ש | 21 | **0** |

For contrast, the projects that **are** synced look correct:

| Project | June leads | scheduled | held | rate |
|---|---|---|---|---|
| אפרידר דיור מוגן | 204 | 59 | 52 | 25.5% |
| CAZAR | 119 | 35 | 32 | 26.9% |
| אפרידר גינות רחובות | 66 | 33 | 33 | 50.0% |
| HaGada בני דן | 42 | 11 | 4 | 9.5% |
| ברוריה 10-12 | 24 | 3 | 3 | 12.5% |

## Likely cause (please check)

One strong suspect is a **`project_name` mismatch between the two tables**:

- `sehel_leads_daily.project_name` carries a salesperson suffix, e.g.
  `אפרידר גינות רחובות נדב כהן`.
- `sehel_meetings.project_name` is the **base account only**, e.g.
  `אפרידר גינות רחובות`.

For the projects above there is **no matching base row in `sehel_meetings` at
all** — so either their meetings aren't being synced, or they're landing under a
different `project_name` spelling than the leads use (e.g. `כוכב הצפון` vs
`כוכב הצפון אשדוד`). Worth confirming both the sync coverage and the exact
`project_name` strings on the meetings side.

## What the Hub does in the meantime (no action needed there)

The Hub is **safe** regardless: the routing guard (`lib/crmData.ts`) only lets
the warehouse funnel supersede the Sheet when the warehouse actually carries
meetings for that project. The projects above **stay on the existing Sheet
funnel** — no regression, no zeroed-out meetings.

## When it's fixed

Once `sehel_meetings` has rows for these projects (correctly keyed by base
`project_name`), they'll **switch to the warehouse funnel automatically** — no
Hub change or redeploy needed. Ping us to re-run the cross-check and confirm.
