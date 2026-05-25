/* F&F Hub service worker — background Web Push notifications only.
 * Intentionally minimal: no offline caching / no fetch handler, so it
 * can't interfere with the app shell. Shows a notification on push and
 * focuses/opens the relevant page on click. */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = data.title || "F&F Hub";
  const options = {
    body: data.body || "",
    // Same tag the foreground poller uses (the notification id) so a
    // push and a foreground toast for the same item collapse into one.
    tag: data.tag || undefined,
    data: { url: data.url || "/notifications" },
    dir: "rtl",
    lang: "he",
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url =
    (event.notification.data && event.notification.data.url) ||
    "/notifications";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Focus an existing Hub tab and navigate it; else open a new one.
      for (const client of all) {
        if ("focus" in client) {
          try {
            await client.focus();
            if ("navigate" in client) await client.navigate(url);
            return;
          } catch (e) {
            /* fall through to openWindow */
          }
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })(),
  );
});
