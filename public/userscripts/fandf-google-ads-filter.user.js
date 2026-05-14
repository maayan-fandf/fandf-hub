// ==UserScript==
// @name         F&F Google Ads Auto-Filter
// @namespace    https://hub.fandf.co.il/
// @version      0.1.2
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
 *
 * 2. This userscript runs on every ads.google.com page load, reads
 *    the hash, and:
 *      a) Dispatches Shift+W on document — Google Ads' built-in
 *         "Show the campaign view filter" shortcut. Filter panel
 *         slides out.
 *      b) Polls the DOM for the filter input that mounts after
 *         the panel opens.
 *      c) Sets the input's value to the slug (via the React-
 *         compatible native setter so onChange fires).
 *      d) Dispatches Enter to apply.
 *
 * 3. The hash is stripped after read so subsequent in-app
 *    navigations don't re-trigger.
 *
 * Graceful degradation
 * ────────────────────────────────────────────────────────────────
 * Each step is best-effort:
 *   - If Shift+W is no-op'd (page not focused) → user sees no panel
 *     open. Fallback toast tells them to paste manually (the slug
 *     is already in the clipboard from the dashboard click).
 *   - If the filter input selector breaks (Google's DOM drifts ~once
 *     a quarter) → the panel still opens via Shift+W, user pastes.
 *   - Toast at the bottom of the page confirms outcome either way.
 *
 * Maintenance
 * ────────────────────────────────────────────────────────────────
 * The DOM selectors in `findFilterInput` are the most fragile part.
 * If Google Ads renames the filter input's aria-label or placeholder,
 * update the selector list. Inspect the filter input in DevTools
 * after Shift+W and look for stable attributes (aria-label,
 * role, placeholder text — avoid auto-generated class names).
 */

(function () {
  'use strict';

  const HASH_PREFIX = '#fandf-filter=';
  const POLL_INTERVAL_MS = 250;
  const POLL_TIMEOUT_MS = 15000;
  const INITIAL_DELAY_MS = 1500; // wait for the campaigns view to settle

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

  async function applyFilter(filterValue) {
    // Step 1: find Google Ads' "Add filter" trigger. The synthetic
    // Shift+W keyboard event approach (v0.1.0-0.1.1) didn't work — the
    // Material UI filters out untrusted KeyboardEvents — so we click
    // the actual DOM element instead.
    let trigger;
    try {
      trigger = await pollUntil(findAddFilterTrigger, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    } catch (e) {
      showToast(
        'לא נמצא כפתור "Add filter" — אולי דף לא צפוי. הדבק ידנית: ' + filterValue,
        false,
      );
      return;
    }
    // Step 2: click + focus. Click via .click() (synthetic, but element-
    // level clicks usually go through React handlers cleanly even when
    // synthetic keyboard events don't). If the trigger is already an
    // open combobox, clicking just focuses it.
    try {
      if (trigger.click) trigger.click();
      if (trigger.focus) trigger.focus();
    } catch (_) {}
    // Step 3: a short beat for Google Ads to render the now-active input,
    // then try to pre-fill the slug. The active input might be a
    // different element than what we clicked (e.g. clicking the button
    // mounts a popup with its own input that takes focus).
    await new Promise(function (r) { setTimeout(r, 400); });
    const input = findActiveTextInput() || (trigger.tagName === 'INPUT' ? trigger : null);
    if (input) {
      try {
        input.focus();
        setInputValue(input, filterValue);
        // Toast: filter is half-applied. User presses Enter to confirm
        // or picks an autocomplete suggestion.
        showToast(
          '📋 "' + filterValue + '" הוזן בסינון — לחץ Enter או בחר מהאוטוקומפליט',
          true,
        );
        return;
      } catch (_) {
        // Fall through to "panel-open, user pastes" fallback.
      }
    }
    // Fallback: input not auto-fillable. The filter UI IS open from
    // step 2 — user pastes from clipboard (slug already there from the
    // dashboard click) + Enter.
    showToast(
      '📋 הסינון פתוח — הדבק (Ctrl+V) כדי לסנן ל-"' + filterValue + '"',
      false,
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
