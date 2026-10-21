// deadman.switch service worker: installs the app, shows check-in reminders,
// and checks you in straight from the notification's "I'm OK" button.
// Switches and bundles are private, so pages are never cached.
const CACHE = 'ds-shell-v1'
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
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')))
    return
  }
  const path = new URL(req.url).pathname
  if (SHELL.includes(path)) event.respondWith(fetch(req).catch(() => caches.match(path)))
})

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'Time to check in', {
      body: data.body || '',
      tag: 'checkin',
      renotify: true,
      requireInteraction: true,
      data: { url: data.url || '/me', checkin: data.checkin || '' },
      actions: data.checkin ? [{ action: 'checkin', title: "I'm OK" }] : [],
      icon: '/icon-192.png',
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  const { url, checkin } = event.notification.data || {}
  event.notification.close()
  if (event.action === 'checkin' && checkin) {
    event.waitUntil(
      fetch(`/c/${encodeURIComponent(checkin)}`, { method: 'POST', headers: { accept: 'application/json', 'x-via': 'push' } })
        .then((r) => r.json())
        .then((r) => self.registration.showNotification(r.ok ? 'Checked in' : 'Already checked in', { body: r.ok ? 'Thanks. See you next time.' : 'You are fine.', tag: 'checkin', icon: '/icon-192.png' }))
        .catch(() => self.clients.openWindow(url)),
    )
    return
  }
  event.waitUntil(self.clients.openWindow(url || '/me'))
})
