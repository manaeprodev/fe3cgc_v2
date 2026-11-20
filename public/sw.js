// Service worker : réseau d'abord, cache en secours (pour ouvrir l'app hors ligne).
// L'API (/api/) n'est jamais mise en cache.
const CACHE = 'conquete-v10';
const SHELL = ['./', 'css/style.css', 'js/app.js', 'config/game.json', 'config/map.json', 'assets/map/fodlan.jpg', 'i18n/fr.json', 'i18n/en.json', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./')))
  );
});

// Notifications push : le serveur envoie un message chiffré { title, body, url, tag } ; un toucher ouvre ou ramène le jeu.
self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = {}; }
  e.waitUntil(self.registration.showNotification(m.title || 'Fire Emblem Three Crowns', {
    body: m.body || '',
    icon: 'assets/icons/icon-192.png',
    badge: 'assets/icons/icon-192.png',
    tag: m.tag || 'conquete',
    data: { url: m.url || './' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || './', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const open = wins.find((w) => w.url.startsWith(self.location.origin));
    return open ? open.focus() : self.clients.openWindow(target);
  }));
});
