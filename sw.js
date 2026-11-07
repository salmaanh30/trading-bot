// Offline shell for Autopilot. Network first, so you always get the latest version when online.
// Market data and Alpaca calls are never cached (they're cross-origin and skipped below).
const CACHE = "autopilot-v16";
const ASSETS = ["./", "./index.html", "./style.css", "./script.js", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: "reload" })))));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("autopilot-") && k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const scopePath = new URL("./", self.location).pathname;
  const inScope = url.origin === self.location.origin && url.pathname.startsWith(scopePath);
  const isFont = /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!inScope && !isFont) return;

  // Always revalidate with the server (GitHub Pages says max-age=600, which kept old versions on phones).
  const fresh = isFont ? fetch(req) : req.mode === "navigate" ? fetch(req.url, { cache: "no-cache", credentials: "same-origin" }) : fetch(req, { cache: "no-cache" });
  e.respondWith(
    fresh
      .then((res) => {
        if (res.ok || res.type === "opaque") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === "navigate" ? caches.match("./index.html") : Response.error())))
  );
});

// Tapping a trial alert notification opens the app on the Trial tab.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const c = list[0];
    if (c) { c.focus(); return c.navigate ? c.navigate(new URL("./#trial", self.location).href).catch(() => {}) : null; }
    return self.clients.openWindow("./#trial");
  }));
});