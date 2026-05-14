// ==UserScript==
// @name         F&F Google Ads Auto-Filter
// @namespace    https://hub.fandf.co.il/
// @version      0.1.1
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

  /** Dispatch a Shift+W keydown to document — Google Ads' built-in
   *  "show the campaign view filter" shortcut. The listener is on
   *  the document level, so this works as long as no <input>
   *  currently has focus. */
  function pressShiftW() {
    // Defocus any currently-focused input — Google Ads' shortcuts
    // are suppressed while typing in a form field.
    try {
      if (document.activeElement && document.activeElement.blur) {
        document.activeElement.blur();
      }
    } catch (_) {}
    const opts = {
      key: 'W',
      code: 'KeyW',
      keyCode: 87,
      which: 87,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    };
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  /** Best-effort locator for the filter input that mounts inside the
   *  filter panel. Selectors ordered from most-stable to most-generic. */
  function findFilterInput() {
    const candidates = [
      'input[aria-label*="filter" i]',
      'input[aria-label*="search" i]',
      'input[placeholder*="filter" i]',
      'input[placeholder*="search" i]',
      // The Material-style nested input that the new Ads UI uses.
      'material-input input[type="text"]:not([readonly])',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
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
    // Step 1: open the panel.
    pressShiftW();
    // Step 2: wait for the panel's filter input to mount.
    let input = null;
    try {
      input = await pollUntil(findFilterInput, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);
    } catch (e) {
      // Panel may have opened but selectors didn't catch the input.
      showToast(
        'פאנל הסינון פתוח — הדבק (Ctrl+V) כדי לסנן ל-"' + filterValue + '"',
        false,
      );
      return;
    }
    try {
      input.focus();
      setInputValue(input, filterValue);
      // Give the framework a beat to render typeahead results, then
      // press Enter to apply.
      setTimeout(function () {
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
        }));
      }, 500);
      showToast('סינון "' + filterValue + '" הוחל אוטומטית ✓', true);
    } catch (e) {
      showToast(
        'נמצא שדה סינון אך מילוי אוטומטי נכשל — הדבק ידנית: ' + filterValue,
        false,
      );
    }
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
