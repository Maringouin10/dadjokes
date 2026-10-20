const CACHE = 'dadjokes-v4';
const SHELL = [
  '/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Network first for everything, so the joke and the app stay fresh;
  // fall back to the cache when offline (last known joke included).
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(url.pathname === '/' ? '/index.html' : request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit
        || (request.mode === 'navigate' ? caches.match('/index.html') : Response.error()))),
  );
});
