// food-log — service worker
// Strategy:
//   - App shell (HTML/CSS/JS/manifest/icons): cache-first, refreshed in background.
//   - Supabase REST GET: network-first → cache → empty array fallback.
//   - Supabase storage GET (uploaded photos): cache-first when cached.
//   - POSTs (uploads + inserts): passthrough. Offline-write queue lives in the
//     app's IndexedDB layer (see app.ts queuePending / drainQueue), not here.
//   - Everything else: passthrough.

const VERSION = 'food-log-v2-4';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './dist/app.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];

const SUPABASE_REST_HINT = '/rest/v1/';
const SUPABASE_STORAGE_HINT = '/storage/v1/object/public/';

// ── Install / activate ──────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] Failed to cache shell asset', url, err);
          })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── Fetch routing ─────────────────────────────────────────────────────────

function isShellRequest(url) {
  if (url.origin !== self.location.origin) return false;
  return url.pathname.startsWith(self.registration.scope.replace(self.location.origin, ''));
}

function isSupabaseRest(url) {
  return url.pathname.includes(SUPABASE_REST_HINT);
}

function isSupabaseStorageGet(url) {
  return url.pathname.includes(SUPABASE_STORAGE_HINT);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method.toUpperCase() !== 'GET') return; // passthrough non-GET
  const url = new URL(request.url);

  if (isSupabaseRest(url)) {
    event.respondWith(handleSupabaseGet(request));
    return;
  }

  if (isSupabaseStorageGet(url)) {
    event.respondWith(handleStorageGet(request));
    return;
  }

  if (isShellRequest(url)) {
    event.respondWith(handleShell(request));
    return;
  }
});

async function handleShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    fetch(request)
      .then((res) => {
        if (res && res.ok) cache.put(request, res.clone());
      })
      .catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    if (request.mode === 'navigate') {
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
    }
    throw err;
  }
}

async function handleSupabaseGet(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handleStorageGet(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    fetch(request)
      .then((res) => {
        if (res && res.ok) cache.put(request, res.clone());
      })
      .catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    throw err;
  }
}
