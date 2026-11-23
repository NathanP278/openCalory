// openCalory Vanilla PWA Service Worker (Zero-dependency, Next.js 16 Turbopack compatible)
const CACHE_NAME = 'opencalory-v3';

const PRECACHE_ASSETS = [
  '/',
  '/log',
  '/trends',
  '/recipes',
  '/settings',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/data/catalog-manifest.json',
  '/data/food-catalog.db.gz',
];

const CACHE_FIRST_DATA_PATHS = new Set([
  '/data/catalog-manifest.json',
  '/data/food-catalog.db.gz',
]);

// Install: precache app shell and static staples dataset, immediately activate
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.allSettled(
          PRECACHE_ASSETS.map((url) => cache.add(url).catch(() => undefined))
        )
      )
      .then(() => self.skipWaiting())
  );
});

// Activate: clean up obsolete caches, claim active clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Fetch: strategy routing
self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) {
    return;
  }

  // 1. /api/*: Network-only (never cached)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 2. Offline food catalog (/data/catalog-manifest.json & /data/food-catalog.db.gz): Cache-first
  if (CACHE_FIRST_DATA_PATHS.has(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  // 3. Static assets and pages: Stale-While-Revalidate
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.match(event.request).then((cachedResponse) => {
        const fetchPromise = fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              cache.put(event.request, networkResponse.clone());
            }
            return networkResponse;
          })
          .catch(() => {
            // Offline fallback: if navigation fails and page not cached, fallback to root
            if (event.request.mode === 'navigate' && !cachedResponse) {
              return cache.match('/');
            }
            return cachedResponse;
          });

        if (cachedResponse) {
          event.waitUntil(fetchPromise);
          return cachedResponse;
        }

        return fetchPromise;
      });
    })
  );
});
