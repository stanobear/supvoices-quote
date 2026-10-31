// Keeps the quote builder working offline (e.g. at a client site with poor signal).
const CACHE = "svq-v3";
const FILES = ["./", "index.html", "manifest.webmanifest", "icon.svg", "icon-192.png",
  "vendor/jspdf.umd.min.js", "vendor/jspdf.plugin.autotable.min.js"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
// Network first so updates arrive as soon as you're online; cache when offline.
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok && new URL(e.request.url).origin === location.origin) { const cl = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cl)); }
    return r;
  }).catch(() => caches.match(e.request, {ignoreSearch: true})));
});
