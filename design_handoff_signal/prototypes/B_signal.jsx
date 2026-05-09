// Direction B — "Signal"
// Modern SaaS, data-dense. Left rail nav, confident sans, one electric
// accent, charts-first. Feels productive and current.

const B = {
  bg: '#0b0c10',
  surface: '#15171f',
  surfaceHi: '#1c1f2a',
  rule: '#272a36',
  ruleSoft: '#1f2230',
  ink: '#eef0f6',
  inkSoft: '#8a90a4',
  inkMuted: '#5a6077',
  accent: '#7cf5b3',     // signal mint
  accentInk: '#063a23',
  warn: '#f4c96b',
  crit: '#f77b7b',
  ok: '#7cf5b3',
  sans: '"Heebo", system-ui, sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, monospace',
};

const bBase = {
  width: '100%', height: '100%',
  background: B.bg, color: B.ink,
  fontFamily: B.sans, direction: 'rtl', fontSize: 13,
  display: 'grid', gridTemplateColumns: '220px 1fr', overflow: 'hidden',
};

function BSideNav({ active = 'projects' }) {
  const items = [
    { k: 'today', label: 'היום', icon: '○' },
    { k: 'projects', label: 'פרויקטים', icon: '▦' },
    { k: 'morning', label: 'בוקר', icon: '◐', badge: 3 },
    { k: 'inbox', label: 'תיוגים', icon: '◇', badge: 6 },
    { k: 'tasks', label: 'משימות שלי', icon: '✓' },
  ];
  const low = [
    { k: 'admin', label: 'ניהול', icon: '⚙' },
    { k: 'metrics', label: 'דשבורד', icon: '↗' },
  ];
  return (
    <div style={{
      background: B.surface, borderInlineStart: `1px solid ${B.rule}`,
      padding: '20px 14px', display: 'flex', flexDirection: 'column', gap: 20,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 8px' }}>
        <span style={{
          width: 22, height: 22, borderRadius: 5,
          background: B.accent, display: 'grid', placeItems: 'center',
          fontWeight: 800, fontSize: 11, color: B.accentInk,
        }}>F</span>
        <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: 0.2 }}>Hub</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: B.mono, fontSize: 9, color: B.inkMuted }}>v3</span>
      </div>

      <div style={{
        background: B.surfaceHi, border: `1px solid ${B.rule}`,
        borderRadius: 6, padding: '8px 10px',
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 12, color: B.inkSoft,
      }}>
        <span>⌕</span>
        <span>חיפוש</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: B.mono, fontSize: 10, color: B.inkMuted }}>⌘K</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {items.map(it => (
          <div key={it.k} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '7px 10px', borderRadius: 5,
            background: active === it.k ? B.surfaceHi : 'transparent',
            color: active === it.k ? B.ink : B.inkSoft,
            fontSize: 13, fontWeight: active === it.k ? 600 : 500,
            position: 'relative',
          }}>
            <span style={{ color: active === it.k ? B.accent : B.inkMuted, fontSize: 11, width: 14 }}>{it.icon}</span>
            <span>{it.label}</span>
            <span style={{ flex: 1 }} />
            {it.badge && (
              <span style={{
                background: B.accent, color: B.accentInk,
                fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 99,
                fontVariantNumeric: 'tabular-nums',
              }}>{it.badge}</span>
            )}
            {active === it.k && (
              <span style={{
                position: 'absolute', insetInlineEnd: -14, top: 6, bottom: 6,
                width: 2, background: B.accent, borderRadius: 2,
              }} />
            )}
          </div>
        ))}
      </div>

      <div style={{ fontFamily: B.mono, fontSize: 9, color: B.inkMuted, padding: '0 10px', letterSpacing: 0.1 }}>
        MORE
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: -16 }}>
        {low.map(it => (
          <div key={it.k} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '7px 10px', borderRadius: 5, color: B.inkSoft, fontSize: 13,
          }}>
            <span style={{ color: B.inkMuted, width: 14, fontSize: 11 }}>{it.icon}</span>
            <span>{it.label}</span>
          </div>
        ))}
      </div>

      <span style={{ flex: 1 }} />

      <div style={{
        borderTop: `1px solid ${B.rule}`, paddingTop: 14,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <span style={{
          width: 28, height: 28, borderRadius: 8,
          background: 'linear-gradient(135deg,#a78bfa,#7cf5b3)',
          display: 'grid', placeItems: 'center', fontWeight: 700, color: '#000', fontSize: 12,
        }}>יל</span>
        <div style={{ lineHeight: 1.2 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>יעל לוי</div>
          <div style={{ fontSize: 10.5, color: B.inkMuted }} dir="ltr">yael@fandf.co.il</div>
        </div>
      </div>
    </div>
  );
}

function BKpi({ label, value, sub, spark, tone }) {
  const c = tone === 'crit' ? B.crit : tone === 'warn' ? B.warn : B.accent;
  return (
    <div style={{
      background: B.surface, border: `1px solid ${B.rule}`, borderRadius: 8,
      padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ fontSize: 11, color: B.inkSoft, letterSpacing: 0.08, textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 30, fontWeight: 700, letterSpacing: -0.5, fontFeatureSettings: '"tnum"' }}>
          {value}
        </span>
        {sub && <span style={{ fontSize: 11.5, color: c, fontWeight: 600 }}>{sub}</span>}
      </div>
      {spark && (
        <svg width="100%" height="22" viewBox="0 0 140 22" preserveAspectRatio="none" style={{ display: 'block' }}>
          <polyline fill="none" stroke={c} strokeWidth="1.5" points={spark} />
          <polygon fill={c} opacity="0.12" points={spark + ' 140,22 0,22'} />
        </svg>
      )}
    </div>
  );
}

function BRow({ name, company, tasks, mentions, progress, status }) {
  const statusColor = {
    ontrack: B.accent, risk: B.warn, blocked: B.crit, idle: B.inkMuted,
  }[status];
  const statusLabel = {
    ontrack: 'במסלול', risk: 'סיכון', blocked: 'חסום', idle: 'רגוע',
  }[status];
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1.6fr 1fr 60px 60px 1fr 90px',
      alignItems: 'center', gap: 14,
      padding: '12px 16px', borderBottom: `1px solid ${B.ruleSoft}`,
      fontSize: 13,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <span style={{ width: 6, height: 6, borderRadius: 2, background: statusColor }} />
        <span style={{ fontWeight: 600, color: B.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {name}
        </span>
      </div>
      <span style={{ color: B.inkSoft, fontSize: 12 }}>{company}</span>
      <span style={{ fontFamily: B.mono, fontSize: 11.5, color: tasks > 0 ? B.ink : B.inkMuted, textAlign: 'center' }}>
        {tasks}
      </span>
      <span style={{ fontFamily: B.mono, fontSize: 11.5, color: mentions > 0 ? B.accent : B.inkMuted, textAlign: 'center' }}>
        {mentions}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, height: 4, background: B.ruleSoft, borderRadius: 2, overflow: 'hidden' }}>
          <span style={{
            display: 'block', height: '100%', width: `${progress}%`,
            background: progress > 95 ? B.crit : B.accent,
          }} />
        </span>
        <span style={{ fontFamily: B.mono, fontSize: 10.5, color: B.inkSoft, minWidth: 26 }}>{progress}%</span>
      </div>
      <span style={{ fontSize: 10.5, color: statusColor, fontWeight: 600, textAlign: 'left' }}>
        {statusLabel}
      </span>
    </div>
  );
}

function BHome() {
  return (
    <div style={bBase}>
      <BSideNav active="projects" />
      <div style={{ overflow: 'auto' }}>
        {/* header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 16,
          padding: '18px 28px', borderBottom: `1px solid ${B.rule}`,
          background: B.bg, position: 'sticky', top: 0, zIndex: 2,
        }}>
          <div>
            <div style={{ fontFamily: B.mono, fontSize: 10.5, color: B.inkMuted, letterSpacing: 0.1 }}>
              WORKSPACE / FANDF
            </div>
            <h1 style={{ margin: '2px 0 0', fontSize: 20, fontWeight: 700 }}>פרויקטים</h1>
          </div>
          <span style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 0, background: B.surface, border: `1px solid ${B.rule}`, borderRadius: 6, padding: 2 }}>
            {['רשימה', 'לוח', 'ציר זמן'].map((t, i) => (
              <span key={t} style={{
                padding: '5px 12px', borderRadius: 4, fontSize: 12, fontWeight: 500,
                background: i === 0 ? B.surfaceHi : 'transparent',
                color: i === 0 ? B.ink : B.inkSoft,
              }}>{t}</span>
            ))}
          </div>
          <div style={{
            background: B.accent, color: B.accentInk,
            padding: '7px 14px', borderRadius: 6, fontSize: 12, fontWeight: 700,
          }}>+ פרויקט</div>
        </div>

        <div style={{ padding: 24 }}>
          {/* KPI row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 22 }}>
            <BKpi label="משימות פתוחות" value="14" sub="3 באיחור" tone="crit"
              spark="0,12 15,14 30,10 45,13 60,11 75,8 90,9 105,6 120,5 140,4" />
            <BKpi label="תיוגים חדשים" value="06" sub="+2 היום" tone="ok"
              spark="0,18 20,15 40,12 60,14 80,9 100,11 120,7 140,3" />
            <BKpi label="פרויקטים פעילים" value="12" sub="4 חברות"
              spark="0,10 20,11 40,9 60,8 80,10 100,6 120,7 140,5" />
            <BKpi label="תקציב מוקצה" value="₪1.8M" sub="94% נוצל" tone="warn"
              spark="0,20 20,18 40,14 60,12 80,9 100,7 120,5 140,4" />
          </div>

          {/* table */}
          <div style={{
            background: B.surface, border: `1px solid ${B.rule}`, borderRadius: 8, overflow: 'hidden',
          }}>
            <div style={{
              display: 'grid', gridTemplateColumns: '1.6fr 1fr 60px 60px 1fr 90px',
              gap: 14, padding: '10px 16px',
              fontFamily: B.mono, fontSize: 10, color: B.inkMuted, letterSpacing: 0.1,
              borderBottom: `1px solid ${B.rule}`, background: B.surfaceHi,
            }}>
              <span>פרויקט</span>
              <span>לקוח</span>
              <span style={{ textAlign: 'center' }}>משימות</span>
              <span style={{ textAlign: 'center' }}>תיוגים</span>
              <span>קצב</span>
              <span style={{ textAlign: 'left' }}>סטטוס</span>
            </div>
            <BRow name="קמפיין אקטיביה Q2" company="דנון ישראל" tasks={3} mentions={2} progress={62} status="ontrack" />
            <BRow name="השקת יוגורט חדש" company="דנון ישראל" tasks={5} mentions={0} progress={41} status="risk" />
            <BRow name="קריאייטיב באנרים" company="טבע תעשיות" tasks={4} mentions={2} progress={112} status="blocked" />
            <BRow name="ברנד אוורנס 2026" company="טבע תעשיות" tasks={2} mentions={1} progress={88} status="risk" />
            <BRow name="מילקי קמפיין קיץ" company="שטראוס" tasks={1} mentions={0} progress={22} status="ontrack" />
            <BRow name="אוסם פסטה — וידאו" company="שטראוס" tasks={0} mentions={0} progress={0} status="idle" />
            <BRow name="רימרקטינג מותג" company="דנון ישראל" tasks={0} mentions={1} progress={48} status="ontrack" />
            <BRow name="Lookalike test" company="דנון ישראל" tasks={1} mentions={0} progress={75} status="ontrack" />
            <BRow name="שיתוף פעולה נובה" company="טבע תעשיות" tasks={0} mentions={0} progress={18} status="idle" />
          </div>

          <div style={{
            fontFamily: B.mono, fontSize: 10.5, color: B.inkMuted,
            padding: '10px 16px 0', display: 'flex', gap: 18,
          }}>
            <span>12 פרויקטים</span>
            <span>· 4 חברות</span>
            <span style={{ flex: 1 }} />
            <span>עודכן לפני 12 שניות</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function BAlertRow({ project, company, severity, headline, detail, budgetPct, timePct, signals }) {
  const sev = {
    crit: { color: B.crit, label: 'CRITICAL', bg: 'rgba(247,123,123,0.08)' },
    warn: { color: B.warn, label: 'WARNING', bg: 'rgba(244,201,107,0.06)' },
    ok:   { color: B.ok, label: 'CLEAR', bg: 'rgba(124,245,179,0.05)' },
  }[severity];
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr 180px 180px 130px',
      gap: 16, padding: '16px 18px',
      background: sev.bg, border: `1px solid ${B.rule}`, borderRadius: 8,
      marginBottom: 10, alignItems: 'center',
    }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{
            fontFamily: B.mono, fontSize: 9.5, letterSpacing: 0.15,
            color: sev.color, fontWeight: 700,
            border: `1px solid ${sev.color}`, padding: '1px 6px', borderRadius: 3,
          }}>{sev.label}</span>
          <span style={{ fontWeight: 700, fontSize: 14 }}>{project}</span>
          <span style={{ fontSize: 11.5, color: B.inkSoft }}>{company}</span>
        </div>
        <div style={{ fontSize: 13, color: B.ink, marginBottom: 4 }}>{headline}</div>
        <div style={{ fontSize: 11.5, color: B.inkSoft }}>{detail}</div>
        <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {signals.map((s, i) => (
            <span key={i} style={{
              fontFamily: B.mono, fontSize: 10,
              background: B.surfaceHi, border: `1px solid ${B.rule}`,
              color: B.inkSoft, padding: '2px 7px', borderRadius: 99,
            }}>{s}</span>
          ))}
        </div>
      </div>
      <BAlertBar label="תקציב" pct={budgetPct} />
      <BAlertBar label="זמן" pct={timePct} />
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <span style={{ padding: '5px 10px', fontSize: 11, fontWeight: 600,
          border: `1px solid ${B.rule}`, background: B.surface, color: B.ink, borderRadius: 5 }}>פתח</span>
        <span style={{ padding: '5px 10px', fontSize: 11, fontWeight: 700,
          background: B.accent, color: B.accentInk, borderRadius: 5 }}>✓ טופל</span>
      </div>
    </div>
  );
}

function BAlertBar({ label, pct }) {
  const over = pct > 100;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: B.inkSoft, marginBottom: 5 }}>
        <span>{label}</span>
        <span style={{ fontFamily: B.mono, color: over ? B.crit : B.ink }}>{pct}%</span>
      </div>
      <div style={{ height: 6, background: B.ruleSoft, borderRadius: 3, overflow: 'hidden', position: 'relative' }}>
        <div style={{
          position: 'absolute', insetInlineStart: 0, top: 0, bottom: 0,
          width: `${Math.min(100, pct)}%`,
          background: over ? B.crit : B.accent,
        }} />
        {over && (
          <div style={{
            position: 'absolute', insetInlineEnd: 0, top: 0, bottom: 0, width: 3,
            background: B.crit, boxShadow: `0 0 8px ${B.crit}`,
          }} />
        )}
      </div>
    </div>
  );
}

function BMorning() {
  return (
    <div style={bBase}>
      <BSideNav active="morning" />
      <div style={{ overflow: 'auto' }}>
        <div style={{
          padding: '18px 28px', borderBottom: `1px solid ${B.rule}`,
          display: 'flex', alignItems: 'center', gap: 16,
        }}>
          <div>
            <div style={{ fontFamily: B.mono, fontSize: 10.5, color: B.inkMuted, letterSpacing: 0.1 }}>
              / ALERT FEED
            </div>
            <h1 style={{ margin: '2px 0 0', fontSize: 20, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10 }}>
              בוקר
              <span style={{
                width: 7, height: 7, borderRadius: 99, background: B.crit,
                boxShadow: `0 0 0 3px rgba(247,123,123,0.2)`,
              }} />
            </h1>
          </div>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: B.inkSoft }}>טיפלת? סמן ✓ והן ישוקטו עד מחר</span>
        </div>

        <div style={{ padding: 24 }}>
          {/* summary KPIs */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
            <BKpi label="התראות קריטיות" value="03" tone="crit" sub="דורשות פעולה היום"
              spark="0,6 20,7 40,8 60,12 80,14 100,16 120,18 140,19" />
            <BKpi label="אזהרות" value="05" tone="warn" sub="ניתן לדחות"
              spark="0,10 20,12 40,11 60,14 80,13 100,12 120,10 140,9" />
            <BKpi label="תקציב בסיכון" value="₪142K" tone="crit" sub="2 פרויקטים"
              spark="0,20 20,17 40,14 60,11 80,9 100,7 120,5 140,3" />
            <BKpi label="שקט" value="04" sub="על המסלול" tone="ok"
              spark="0,8 20,6 40,4 60,3 80,3 100,2 120,2 140,1" />
          </div>

          {/* severity filters */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center' }}>
            {[
              { label: 'הכל · 12', active: true },
              { label: 'קריטי · 3', color: B.crit },
              { label: 'אזהרה · 5', color: B.warn },
              { label: 'שקט · 4', color: B.ok },
            ].map((t, i) => (
              <span key={i} style={{
                padding: '6px 12px', borderRadius: 99, fontSize: 11.5, fontWeight: 600,
                background: t.active ? B.surfaceHi : 'transparent',
                border: `1px solid ${t.active ? B.ink : B.rule}`,
                color: t.active ? B.ink : (t.color || B.inkSoft),
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}>
                {t.color && <span style={{ width: 6, height: 6, borderRadius: 99, background: t.color }} />}
                {t.label}
              </span>
            ))}
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: B.mono, fontSize: 10.5, color: B.inkMuted }}>SCOPE · שלי</span>
          </div>

          <BAlertRow
            severity="crit" project="קריאייטיב באנרים" company="טבע תעשיות"
            headline="תקציב נוצל ב-112%"
            detail="חריגה של ₪4,800 · חשבון Meta עוקף את הקמפיין ב-Google"
            budgetPct={112} timePct={78}
            signals={['Meta', 'Over-pace', 'Daily cap breached']}
          />
          <BAlertRow
            severity="crit" project="קמפיין אקטיביה Q2" company="דנון ישראל"
            headline="תקציב עצור מזה 48 שעות"
            detail="Meta & Google לא פעילים מאז שני 20:00 — אין sessions"
            budgetPct={34} timePct={62}
            signals={['Meta · paused', 'Google · paused', '0 sessions/day']}
          />
          <BAlertRow
            severity="warn" project="השקת יוגורט חדש" company="דנון ישראל"
            headline="קצב ההוצאה נמוך ב-15 נקודות אחוז"
            detail="הוצאת 41% בזמן 56% — נדרשת האצה של ₪8,200/יום"
            budgetPct={41} timePct={56}
            signals={['Under-pace', '+₪8.2K/day needed']}
          />
          <BAlertRow
            severity="warn" project="ברנד אוורנס 2026" company="טבע תעשיות"
            headline="דדליין בעוד 3 ימים · 2 משימות באיחור"
            detail="קריאייטיב סופי לא אושר · נדרש אישור לקוח"
            budgetPct={88} timePct={94}
            signals={['Deadline 3d', '2 tasks overdue']}
          />
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { BHome, BMorning });
