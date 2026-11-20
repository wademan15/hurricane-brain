/* Hurricane Brain service worker: offline after the first load.
 *
 * Strategy: same-origin GET requests are answered from the cache when present and refreshed in
 * the background (stale-while-revalidate); navigations fall back to the cached app shell when
 * offline. Everything the app loads (scripts, the engine worker and WebAssembly, the audio
 * worklet, styles, icons) is a same-origin file, so it is cached as soon as it is first used.
 * The page asks the worker to cache what it has already loaded (see main.tsx warm-up).
 * Nothing is sent anywhere: no analytics, no third-party requests.
 */
const CACHE = 'hurricane-brain-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(['./', './manifest.webmanifest', './icon.svg', './favicon.svg']).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'cache-urls' && Array.isArray(data.urls)) {
    event.waitUntil(
      caches.open(CACHE).then((c) =>
        Promise.all(
          data.urls
            .filter((u) => typeof u === 'string' && new URL(u, self.location.href).origin === self.location.origin)
            .map((u) => c.add(u).catch(() => undefined)),
        ),
      ),
    );
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = (await cache.match(req)) || (req.mode === 'navigate' ? await cache.match('./') : undefined);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => undefined);
          return res;
        })
        .catch(() => undefined);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      const res = await network;
      if (res) return res;
      if (req.mode === 'navigate') {
        const shell = await cache.match('./');
        if (shell) return shell;
      }
      return new Response('Offline and not cached yet.', { status: 503, statusText: 'Offline' });
    }),
  );
});
