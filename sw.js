// Ladeplan: Service Worker. Zeigt Push-Nachrichten an und hält die App-Dateien für den Offline-Start bereit.
// Bei jeder Änderung an den App-Dateien VERSION hochzählen, damit Handys die neue Version laden.
const VERSION = 'ladeplan-v1';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'dtg-logo.png', 'manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Eigene Dateien: erst Netz, bei fehlender Verbindung aus dem Speicher. Daten von Supabase nie zwischenspeichern.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))),
  );
});

self.addEventListener('push', e => {
  let data = { title: 'Ladeplan', body: '' };
  try { data = { ...data, ...e.data.json() }; } catch { data.body = e.data ? e.data.text() : ''; }
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    lang: 'de',
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.startsWith(self.registration.scope));
    return open ? open.focus() : self.clients.openWindow('./');
  }));
});
