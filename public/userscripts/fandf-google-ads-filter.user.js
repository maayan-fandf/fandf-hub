// ==UserScript==
// @name         F&F Google Ads Auto-Filter
// @namespace    https://hub.fandf.co.il/
// @version      0.1.4
// @description  Auto-applies the campaign filter when Google Ads opens with a #fandf-filter=<slug> hash in the URL. Triggered by clicking the קצב יומי cell in the F&F dashboard.
// @author       F&F Brandvertising
// @match        https://ads.google.com/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://hub.fandf.co.il/userscripts/fandf-google-ads-filter.user.js
// @downloadURL  https://hub.fandf.co.il/userscripts/fandf-google-ads-filter.user.js
// ==/UserScript==

/*
 * How it works
 * ────────────────────────────────────────────────────────────────
 * 1. Dashboard cell click navigates the user to
 *      https://ads.google.com/aw/campaigns?__c=…#fandf-filter=<slug>
 *    `<slug>` is the project's Keys.campaign-ID (e.g. "felix-q3-2026").
 *    The dashboard also writes the slug + daily budget into the
 *    clipboard so the next paste resolves to either of them.
 *
 * 2. This userscript runs on every ads.google.com page load, reads
 *    the hash, strips it (so in-app SPA nav doesn't re-trigger), and:
 *      a) Removes any stale "Campaign name <op> <value>" chip left
 *         from a previous session — chips AND together, so leaving
 *         one in place would intersect with ours to nothing.
 *      b) Polls for Google Ads' "Add filter" combobox.
 *      c) Retries a full mouse-event sequence (pointerdown +
 *         mousedown + mouseup + click + focus) on the combobox until
 *         the filter-type listbox actually mounts. See "Why retry?"
 *         on clickUntilPopupOpens for the SPA-timing rationale.
 *
 * 3. The combobox is a filter-TYPE picker, not a campaign-name input
 *    (v0.1.2 mistake — see project memory note). The user finishes
 *    the flow with one paste (Ctrl+V) and one click on the surfaced
 *    "Campaign name contains <slug>" autocomplete suggestion.
 *
 * Graceful degradation
 * ────────────────────────────────────────────────────────────────
 *   - If the combobox never mounts within POLL_TIMEOUT_MS → fallback
 *     toast tells the user to paste manually (slug already in clipboard).
 *   - If MAX_CLICK_ATTEMPTS clicks fail to open the popup → fallback
 *     toast asks the user to click "Add filter" themselves, then paste.
 *   - Toast at the bottom of the page confirms outcome either way.
 *
 * Maintenance
 * ────────────────────────────────────────────────────────────────
 * The DOM selectors in `findAddFilterTrigger` + `isPopupOpen` are the
 * most fragile part. If Google Ads renames the trigger's aria-label
 * or moves away from `role="listbox" / role="option"` for the popup,
 * update them. Inspect in DevTools right after the popup opens for
 * stable attributes (aria-label, role) — avoid auto-generated class
 * names. NB: Google Ads has 0 native `<button>` elements; everything
 * is `[role="button"]` on Material Web Components.
 */

(function () {
  'use strict';

  const HASH_PREFIX = '#fandf-filter=';
  const POLL_INTERVAL_MS = 250;
  const POLL_TIMEOUT_MS = 15000;
  const INITIAL_DELAY_MS = 1500; // wait for the campaigns view to settle
  // Retry-click parameters — see "Why retry?" comment on clickUntilPopupOpens
  // for the rationale (Google Ads' SPA isn't fully interactive at idle+1500ms,
  // so the first click can silently no-op).
  const POPUP_WAIT_MS = 700;
  const CLICK_RETRY_GAP_MS = 600;
  const MAX_CLICK_ATTEMPTS = 10;

  function readFilterFromHash() {
    const h = window.location.hash || '';
    if (!h.startsWith(HASH_PREFIX)) return null;
    try {
      return decodeURIComponent(h.slice(HASH_PREFIX.length));
    } catch (_) {
      return null;
    }
  }

  function clearHash() {
    try {
      // Strip our hash so the filter doesn't re-apply on later in-app
      // navigations. history.replaceState avoids a page reload.
      history.replaceState(null, '', location.pathname + location.search);
    } catch (_) {}
  }

  /** Best-effort locator for Google Ads' "Add filter" trigger — either
   *  the collapsed button (when no filters are open) or the
   *  always-present combobox in the filters bar (campaigns view).
   *  Both surfaces carry an aria-label / placeholder of "Add filter".
   *  Falls back to scanning button/input text content for "add filter"
   *  if attribute matches fail. */
  function findAddFilterTrigger() {
    const selectors = [
      'input[aria-label*="Add filter" i]',
      'button[aria-label*="Add filter" i]',
      'input[placeholder*="Add filter" i]',
      '[role="combobox"][aria-label*="filter" i]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }
    // Text-content fallback — scan buttons + inputs for visible "Add filter".
    const nodes = document.querySelectorAll('button, input, [role="button"], [role="combobox"]');
    for (const el of nodes) {
      const txt = (
        (el.textContent || '') +
        ' ' +
        (el.value || '') +
        ' ' +
        (el.getAttribute('aria-label') || '') +
        ' ' +
        (el.getAttribute('placeholder') || '')
      ).toLowerCase();
      if (txt.includes('add filter') && isVisible(el)) return el;
    }
    return null;
  }

  /** After clicking the "Add filter" trigger, an input element gains
   *  focus (Google Ads' combobox auto-focuses its sub-input). Find
   *  whichever input is currently focused or, failing that, the
   *  first visible text input on the page that wasn't already a
   *  permanent header search. */
  function findActiveTextInput() {
    const ae = document.activeElement;
    if (ae && /^(input|textarea)$/i.test(ae.tagName) && isVisible(ae)) {
      return ae;
    }
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /** Set the input value via the prototype's native setter so React
   *  / the Google Ads framework's onChange handler fires. Plain
   *  `input.value = '...'` doesn't trigger framework re-renders. */
  function setInputValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function pollUntil(predicate, timeoutMs, intervalMs) {
    return new Promise(function (resolve, reject) {
      const started = Date.now();
      function tick() {
        const v = predicate();
        if (v) return resolve(v);
        if (Date.now() - started > timeoutMs) {
          return reject(new Error('timeout'));
        }
        setTimeout(tick, intervalMs);
      }
      tick();
    });
  }

  /** Dispatch a real-mouse-style click sequence on `el`. Google Ads'
   *  Material Web Components frequently listen on `pointerdown` /
   *  `mousedown` rather than `click`; calling `.click()` on its own can
   *  silently no-op for popup triggers. The full pointer+mouse+click
   *  sequence mimics what a trusted user gesture looks like (apart from
   *  the `isTrusted` flag, which can't be forged). */
  function dispatchFullClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const base = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      buttons: 1,
    };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerType: 'mouse', isPrimary: true }, base)));
    } catch (_) {}
    try { el.dispatchEvent(new MouseEvent('mousedown', base)); } catch (_) {}
    try {
      el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerType: 'mouse', isPrimary: true, buttons: 0 }, base)));
    } catch (_) {}
    try { el.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, base, { buttons: 0 }))); } catch (_) {}
    try { el.dispatchEvent(new MouseEvent('click', Object.assign({}, base, { buttons: 0 }))); } catch (_) {}
    try { if (typeof el.click === 'function') el.click(); } catch (_) {}
    try { if (typeof el.focus === 'function') el.focus(); } catch (_) {}
  }

  /** True when Google Ads' filter-type dropdown is mounted+visible. The
   *  combobox opens a listbox containing options like "Campaign name",
   *  "Status", "Type", etc. We accept either a visible listbox OR a
   *  visible option as proof the popup opened — Google's DOM varies
   *  between Material versions in which element gets `role="listbox"`. */
  function isPopupOpen() {
    const lb = document.querySelector('[role="listbox"]');
    if (lb && isVisible(lb)) return true;
    const opt = document.querySelector('[role="option"]');
    if (opt && isVisible(opt)) return true;
    return false;
  }

  /** Why retry? Tampermonkey fires the userscript at `document-idle +
   *  INITIAL_DELAY_MS`, but Google Ads' SPA hydrates lazily — the
   *  combobox is visible in the DOM well before its click handler is
   *  actually wired up. A single `.click()` at that window often
   *  silently no-ops (or opens-and-immediately-closes the popup before
   *  the user can see it). Empirically the same click via DevTools 30s
   *  later works flawlessly. So we retry the full mouse-event sequence
   *  with a short wait between attempts until the popup actually
   *  mounts. */
  async function clickUntilPopupOpens(trigger, maxAttempts) {
    for (let i = 0; i < maxAttempts; i++) {
      dispatchFullClick(trigger);
      try {
        await pollUntil(isPopupOpen, POPUP_WAIT_MS, 100);
        return true;
      } catch (_) {
        // popup didn't appear within POPUP_WAIT_MS — wait, then retry.
        await new Promise(function (r) { setTimeout(r, CLICK_RETRY_GAP_MS); });
        // Re-resolve the trigger in case Google Ads remounted it.
        const fresh = findAddFilterTrigger();
        if (fresh && fresh !== trigger) trigger = fresh;
      }
    }
    return false;
  }

  /** Toast at the bottom-center of the page. Mirrors the F&F
   *  dashboard's dark navy palette so it reads as "same product"
   *  when the user sees both in the same flow. */
  function showToast(msg, ok) {
    const id = '__fandf_filter_toast__';
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.style.cssText = [
        'position:fixed',
        'bottom:24px',
        'left:50%',
        'transform:translateX(-50%)',
        'background:#1a2234',
        'color:#e2e8f0',
        'padding:10px 18px',
        'border-radius:10px',
        'font:14px Rubik,system-ui,-apple-system,sans-serif',
        'z-index:2147483647', // top of the world
        'box-shadow:0 8px 24px rgba(0,0,0,.4)',
        'pointer-events:none',
        'transition:opacity .3s',
        'direction:rtl',
        'text-align:right',
        'max-width:480px',
      ].join(';');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.borderInlineStart = '4px solid ' + (ok ? '#10b981' : '#f59e0b');
    el.style.opacity = '1';
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(function () {
      el.style.opacity = '0';
    }, 4500);
  }

  /** Remove any existing "Campaign name *" filter chip before adding
   *  ours. Google Ads chips AND together — if the user's previous
   *  session left a "Campaign name contains <old-project>" chip, adding
   *  ours on top would intersect (match nothing) instead of replacing.
   *  Other filter types ("Campaign status: Enabled, Paused", "Ad group
   *  status: ...") are intentional defaults — leave them alone. */
  function removeStaleCampaignNameChips() {
    // Filter chips are rendered as buttons / divs with role=button.
    // The visible text on a chip starts with the filter-type label,
    // e.g. "Campaign name contains felix-tower" / "Campaign name equals
    // X". The X (delete) button sits inside the same chip container.
    const nodes = document.querySelectorAll('[role="button"], button');
    const removed = [];
    for (const el of nodes) {
      const txt = (el.textContent || '').trim();
      // Match "Campaign name <operator> <value>" — that's the chip's
      // own text. Skip the bare "Add filter" / "Campaign name" picker
      // entries (no operator, short text).
      if (/^Campaign name\s+(contains|equals|starts with|ends with|does not)/i.test(txt)) {
        // Find the X button inside this chip.
        const remove = el.querySelector('[aria-label*="emove" i], [aria-label*="elete" i], [aria-label*="clear" i], button:last-child');
        if (remove && isVisible(remove)) {
          try { remove.click(); removed.push(txt.slice(0, 50)); } catch (_) {}
        }
      }
    }
    return removed;
  }

  async function applyFilter(filterValue) {
    // Step 1: clear any stale Campaign-name filter chip from a
    // previous session — see removeStaleCampaignNameChips() above.
    removeStaleCampaignNameChips();
    // Step 2: find Google Ads' "Add filter" combobox. We DELIBERATELY
    // do NOT try to set its value programmatically — earlier versions
    // (v0.1.2) showed that the combobox is a filter-TYPE picker
    // (Campaign name / Status / Type / …), so typing a campaign-name
    // string into it just shows "No results". The right Google Ads
    // flow is: open combobox → user pastes slug → typeahead surfaces
    // "Campaign name contains <slug>" as a suggestion → user clicks
    // it. We automate steps 1 + 2; the user does the last paste +
    // click.
    let trigger;
    try {
      trigger = await pollUntil(findAddFilterTrigger, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    } catch (e) {
      showToast(
        'לא נמצא כפתור "Add filter" — הדבק ידנית: ' + filterValue,
        false,
      );
      return;
    }
    // Step 3: open the popup. v0.1.3 fired one `.click()` here and that
    // silently no-op'd on cold SPA renders — see the "Why retry?" comment
    // on clickUntilPopupOpens. v0.1.4 retries the full mouse-event
    // sequence until the listbox actually mounts (or we give up).
    const opened = await clickUntilPopupOpens(trigger, MAX_CLICK_ATTEMPTS);
    if (!opened) {
      showToast(
        'הסינון לא נפתח אוטומטית — לחץ "Add filter" והדבק (Ctrl+V) ידנית: ' + filterValue,
        false,
      );
      return;
    }
    // Step 4: toast guides the next 2 user actions.
    showToast(
      '📋 הסינון פתוח לסלאג "' + filterValue + '" — הדבק (Ctrl+V) ובחר מהצעת האוטוקומפליט',
      true,
    );
  }

  function run() {
    const filter = readFilterFromHash();
    if (!filter) return;
    // Skip when we're not yet on a campaigns-area route. The
    // /nav/selectaccount account picker preserves the hash across its
    // redirect, so as long as we DON'T strip it here, the userscript
    // will fire fresh on the destination (/aw/campaigns?...) once the
    // user picks an account. Stripping the hash here would lose the
    // filter before we ever reach the page that can use it.
    if (!/^\/aw\//.test(location.pathname)) {
      return;
    }
    clearHash();
    // The dashboard URL lands at /aw/campaigns?... — Google Ads' SPA
    // takes ~1s to render the campaigns view. Delay before we start
    // dispatching keyboard events.
    setTimeout(function () {
      applyFilter(filter).catch(function () {});
    }, INITIAL_DELAY_MS);
  }

  // Initial load.
  run();
  // Google Ads is an SPA — re-check on hashchange in case the user
  // navigates around and ends up back at a #fandf-filter URL.
  window.addEventListener('hashchange', run);
})();
