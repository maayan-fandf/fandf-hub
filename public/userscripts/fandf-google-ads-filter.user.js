// ==UserScript==
// @name         F&F Google Ads Auto-Filter
// @namespace    https://hub.fandf.co.il/
// @version      0.1.3
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
    // Step 3: click + focus. .click() goes through React handlers
    // cleanly even though synthetic keyboard events don't.
    try {
      if (trigger.click) trigger.click();
      if (trigger.focus) trigger.focus();
    } catch (_) {}
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
