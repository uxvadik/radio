// Service worker: офлайн-оболочка приложения. Потоки и API никогда не кэшируем.
const CACHE = 'radio-shell-v9';
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/store.js',
  './js/ui.js',
  './js/player.js',
  './js/radio.js',
  './js/m3u.js',
  './js/metadata.js',
  './js/noise.js',
  './sample/1.mp3',
  './sample/2.mp3',
  './sample/3.mp3',
  './sample/4.mp3',
  './manifest.webmanifest',
  './playlists/altrock.m3u',
  './playlists/covera.m3u',
  './playlists/deephouse.m3u',
  './playlists/jazz.m3u',
  './playlists/gta-3.m3u',
  './playlists/gta-vc.m3u',
  './playlists/gta-sa.m3u',
  './playlists/gta-4.m3u',
  './playlists/gta-lcs.m3u',
  './playlists/gta-vcs.m3u',
  './icons/icon-192.png',
  './icons/icon-384.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-16.png',
  './icons/favicon-32.png',
  './icons/favicon-48.png',
  './icons/favicon.ico',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.destination === 'audio' || req.destination === 'video') return;
  if (/\.wav$/i.test(url.pathname)) return; // сэмплы шумов не кэшируем

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
