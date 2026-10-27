// Kerf service worker: precaches the app shell for offline use, keeps it fresh with
// stale-while-revalidate, caches web fonts, and receives files shared to the app.
// The deploy workflow replaces __BUILD__ with the commit hash so each release installs cleanly.
const VERSION = 'kerf-__BUILD__';
const SHELL_CACHE = `${VERSION}-shell`;
const FONT_CACHE = 'kerf-fonts';

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'js/main.js',
  'js/app.js',
  'js/commands.js',
  'js/core/audio-data.js',
  'js/core/events.js',
  'js/core/format.js',
  'js/core/history.js',
  'js/core/settings.js',
  'js/core/store.js',
  'js/audio/engine.js',
  'js/audio/recorder.js',
  'js/worklets/recorder-worklet.js',
  'js/dsp/analysis.js',
  'js/dsp/biquad.js',
  'js/dsp/dynamics.js',
  'js/dsp/effects.js',
  'js/dsp/fft.js',
  'js/dsp/generators.js',
  'js/dsp/loudness.js',
  'js/dsp/modulation.js',
  'js/dsp/restoration.js',
  'js/dsp/stretch.js',
  'js/io/importer.js',
  'js/io/labels.js',
  'js/io/mp3.js',
  'js/io/mp3-worker.js',
  'js/io/project.js',
  'js/io/wav.js',
  'js/io/zip.js',
  'js/vendor/lame.min.js',
  'js/ui/batch.js',
  'js/ui/dialog.js',
  'js/ui/dialogs.js',
  'js/ui/dom.js',
  'js/ui/export.js',
  'js/ui/icons.js',
  'js/ui/menu.js',
  'js/ui/meters.js',
  'js/ui/palette.js',
  'js/ui/sidepanel.js',
  'js/ui/timeline.js',
  'js/ui/toast.js',
  'js/ui/vfd.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.endsWith('-shell') && k !== SHELL_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

async function staleWhileRevalidate(request, cacheName, fallbackKey) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(fallbackKey || request, { ignoreSearch: !!fallbackKey });
  const network = fetch(request).then(res => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(fallbackKey || request, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await network) || new Response('Offline and not cached yet.', { status: 503, headers: { 'content-type': 'text/plain' } });
}

async function receiveShare(request) {
  const form = await request.formData();
  const files = form.getAll('audio').filter(f => f && typeof f !== 'string');
  const cache = await caches.open('kerf-share');
  await Promise.all(files.map((f, i) => cache.put(`shared/${Date.now()}-${i}`, new Response(f, {
    headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || `shared-${i}`) },
  }))));
  return Response.redirect('./?share-target=1', 303);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET') return;
  if (url.origin === location.origin) {
    if (req.mode === 'navigate') {
      const scopePath = new URL(self.registration.scope).pathname;
      event.respondWith(staleWhileRevalidate(req, SHELL_CACHE, `${scopePath}index.html`));
      return;
    }
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(req, FONT_CACHE));
  }
});
