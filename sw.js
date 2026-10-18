// Service worker: makes the app load offline.
// App files are served from the cache and refreshed in the background
// (stale-while-revalidate), so a change shows up on the next launch.
// Bump VERSION when the list of SHELL files changes.

const VERSION = 'v2';
const SHELL_CACHE = `notes-shell-${VERSION}`;
const FONT_CACHE = 'notes-fonts';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './store.js',
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
      .then((cache) => cache.addAll(SHELL))
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

// Answer from the cache when we can, and refresh the cached copy in the background.
// The refresh is handed to event.waitUntil so the browser doesn't cut it short.
function staleWhileRevalidate(event, cacheName, { cacheKey = event.request, ignoreSearch = false } = {}) {
  const cacheP = caches.open(cacheName);
  const fresh = cacheP.then((cache) => fetch(event.request).then((response) => {
    if (response.ok || response.type === 'opaque') return cache.put(cacheKey, response.clone()).then(() => response);
    return response;
  })).catch(() => undefined);
  event.waitUntil(fresh);

  return cacheP
    .then((cache) => cache.match(cacheKey, { ignoreSearch }))
    .then(async (cached) => cached || (await fresh) || Response.error());
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    // Every page navigation gets the app shell.
    const cacheKey = request.mode === 'navigate' ? './index.html' : request;
    event.respondWith(staleWhileRevalidate(event, SHELL_CACHE, { cacheKey, ignoreSearch: true }));
  } else if (FONT_HOSTS.includes(url.hostname)) {
    // Font URLs differ only by query string, so match them exactly.
    event.respondWith(staleWhileRevalidate(event, FONT_CACHE));
  }
});
