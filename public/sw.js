// family.ancestry service worker: caches the app shell so it installs and opens offline.
// Tree data is private and changes, so it is never cached: offline you get a page saying so.
const CACHE = 'fa-shell-v1'
const SHELL = ['/offline.html', '/style.css', '/app.js', '/favicon.svg', '/icon-192.png', '/manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return
  const path = new URL(req.url).pathname
  if (req.mode === 'navigate') {
    // threatcrush-disable-next-line js-ssrf-outbound-request same-origin navigation only, checked above
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')))
    return
  }
  if (SHELL.includes(path)) {
    // threatcrush-disable-next-line js-ssrf-outbound-request same-origin shell asset, checked above
    event.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(path, copy)); return res }).catch(() => caches.match(path)))
  }
})
