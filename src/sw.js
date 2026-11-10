// Service worker template. vite.config.ts fills in the two placeholders at build time and
// writes the result to dist/sw.js, so every build gets a new cache and a complete offline file list.
const VERSION = '__SW_VERSION__';
const PRECACHE = __SW_PRECACHE__;
const CACHE = `horse-${VERSION}`;

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the HTTP cache so a new build never precaches stale files.
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('horse-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  // Page loads: network first, so a fresh deploy shows up on the next launch; cached page when offline.
  // cache: 'no-cache' makes the browser revalidate with the server; without it the host's
  // 10-minute HTTP cache can hand back the previous build.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req.url, { cache: 'no-cache' }).catch(() => caches.match('./index.html').then((hit) => hit || Response.error())));
    return;
  }

  // Everything else (hashed bundles, icons, later GLB/KTX2 assets): cache first, then network.
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
    )
  );
});
