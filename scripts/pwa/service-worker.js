// Offline app shell for the browser build. Built into the site only when
// EDITKIN_PWA=1 (see scripts/vite-plugin-pwa.ts); desktop builds never ship it.
//
// The build replaces the two placeholders below. User media is never cached:
// it only exists as local blob URLs, which are not same-origin network fetches.
const VERSION = "__EDITKIN_VERSION__";
const PRECACHE = "__EDITKIN_PRECACHE__";

const SHELL_CACHE = `editkin-shell-${VERSION}`;
// Fonts are large (up to ~17 MB each), so they are cached only after the app
// actually requests them. The set is bounded by build-web-public.mjs.
const FONT_CACHE = "editkin-fonts-v1";
const INDEX_URL = new URL("./index.html", self.registration.scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("editkin-shell-") && name !== SHELL_CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

// A new worker waits so it never swaps assets under an open editing session.
// The page asks to activate it right after a fresh load, and only when no other
// tab still runs the previous version.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "SKIP_WAITING_IF_ALONE") return;
  event.waitUntil(self.clients.matchAll().then((clients) => { if (clients.length <= 1) return self.skipWaiting(); }));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        // Keep the offline fallback on the newest deployed shell.
        if (response.ok) {
          const cache = await caches.open(SHELL_CACHE);
          await cache.put(INDEX_URL, response.clone());
        }
        return response;
      } catch (error) {
        const cached = await caches.match(INDEX_URL);
        if (cached) return cached;
        throw error;
      }
    })());
    return;
  }

  if (url.pathname.includes("/fonts/")) {
    event.respondWith((async () => {
      const cache = await caches.open(FONT_CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.status === 200) await cache.put(request, response.clone());
      return response;
    })());
    return;
  }

  event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
});
