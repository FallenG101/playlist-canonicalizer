const CACHE_NAME = 'canonicalizer-shell-v2';
const APP_SHELL = [
  './',
  './index.html',
  './privacy.html',
  './styles.css',
  './manifest.webmanifest',
  './assets/canonicalizer-icon-180.png',
  './assets/canonicalizer-icon-192.png',
  './assets/canonicalizer-icon-512.png',
  './assets/canonicalizer-icon.svg',
  './assets/spotify-full-logo-white.svg',
  './js/app.js',
  './js/apply.js',
  './js/auth.js',
  './js/canonicalizer.js',
  './js/review.js',
  './js/scan-cache.js',
  './js/spotify.js',
];
const CACHEABLE_PATHS = new Set(APP_SHELL.map((path) => new URL(path, self.registration.scope).pathname));

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('canonicalizer-shell-') && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.search || !CACHEABLE_PATHS.has(url.pathname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME).catch(() => null);
    try {
      const response = await fetch(request, { cache: 'no-store' });
      if (cache && response.ok && response.type === 'basic') {
        await cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    } catch (error) {
      const cached = await cache?.match(request).catch(() => null);
      if (cached) return cached;
      throw error;
    }
  })());
});
