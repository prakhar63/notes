// Service worker: makes the app load offline, and updates it as one piece.
//
// Each deploy is a new VERSION (tools/deploy.mjs stamps it from the site's
// contents). The browser sees a changed sw.js, installs this worker, and the
// worker downloads the whole app fresh into a new cache before taking over.
// So every file the page loads always comes from the same version — a new
// index.html can never be paired with an old app.js.
//
// On localhost the app is served network-first, so edits show up on reload.

const VERSION = 'aaa661a08c'; // replaced at deploy time; leave as-is in the source
const SHELL_CACHE = `notes-shell-${VERSION}`;
const FONT_CACHE = 'notes-fonts';
const DEV = ['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname);

const SHELL = [
  './index.html',
  './styles.css',
  './app.js',
  './store.js',
  './lists.js',
  './blocks.js',
  './images.js',
  './sync.js',
  './vendor/peerjs.min.js',
  './vendor/qrcode.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // cache: 'reload' skips the browser's HTTP cache, so nothing stale sneaks in.
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('notes-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

// App files: from this version's cache; the network only for anything not in it.
async function fromShell(request) {
  const cacheKey = request.mode === 'navigate' ? './index.html' : request;
  const cached = await caches.match(cacheKey, { cacheName: SHELL_CACHE, ignoreSearch: true });
  return cached || fetch(request);
}

// Local development: always the latest file, with the cache as an offline fallback.
async function networkFirst(request) {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(request.mode === 'navigate' ? './index.html' : request, response.clone());
    }
    return response;
  } catch {
    const cacheKey = request.mode === 'navigate' ? './index.html' : request;
    return (await caches.match(cacheKey, { cacheName: SHELL_CACHE, ignoreSearch: true })) || Response.error();
  }
}

// Fonts never change at a given URL: serve the cached copy, refresh it in the background.
function fontStaleWhileRevalidate(event) {
  const cacheP = caches.open(FONT_CACHE);
  const fresh = cacheP.then((cache) => fetch(event.request).then((response) => {
    if (response.ok || response.type === 'opaque') return cache.put(event.request, response.clone()).then(() => response);
    return response;
  })).catch(() => undefined);
  event.waitUntil(fresh);
  return cacheP
    .then((cache) => cache.match(event.request))
    .then(async (cached) => cached || (await fresh) || Response.error());
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    event.respondWith(DEV ? networkFirst(request) : fromShell(request));
  } else if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(fontStaleWhileRevalidate(event));
  }
});
