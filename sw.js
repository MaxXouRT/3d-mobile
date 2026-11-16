// Hors-ligne : réseau d'abord (pour recevoir les mises à jour), cache en secours.
const CACHE = 'celluloid-v3';
const FILES = ['./', 'index.html', 'css/style.css', 'manifest.webmanifest', 'icons/icon.svg',
  'js/main.js', 'js/ui.js', 'js/store.js', 'js/state.js', 'js/project.js', 'js/render.js', 'js/effects.js', 'js/lineart.js',
  'js/tools.js', 'js/viewport.js', 'js/editor.js', 'js/panels.js', 'js/io.js', 'js/editor3d.js', 'js/import3d.js', 'vendor/three/three.module.min.js', 'vendor/three/three.core.min.js', 'vendor/mp4-muxer.mjs', 'vendor/gifenc.mjs'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
