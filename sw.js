/* Fiches du labo : fonctionnement hors connexion. Changer VERSION à chaque mise à jour du code. */
const VERSION = 'fdl-v29';
const PHOTOS = 'fdl-photos';
const FONTS = 'fdl-fonts';
const SHELL = ['./', './index.html', './style.css', './app.js', './ingredients.js', './config.js', './manifest.webmanifest',
  './vendor/supabase.js', './vendor/jszip.min.js', './vendor/jspdf.umd.min.js', './icons/logo.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  // cache: 'reload' : on ignore le cache du navigateur pour prendre la version tout juste publiée.
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== PHOTOS && k !== FONTS).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Photos (adresses signées Supabase) : on garde une copie, indexée sans le jeton.
  if (url.pathname.includes('/storage/v1/object/sign/photos/')) { e.respondWith(photo(req, url)); return; }
  if (url.origin === location.origin) { e.respondWith(fresh(req)); return; }
  if (url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') { e.respondWith(cached(req, FONTS)); }
});
// Fichiers de l'appli : réseau d'abord (mises à jour), copie si hors connexion.
async function fresh(req) {
  const cache = await caches.open(VERSION);
  try {
    // no-cache : le navigateur revérifie auprès du serveur à chaque ouverture (rapide si rien n'a changé).
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok) cache.put(req.mode === 'navigate' ? './index.html' : req, res.clone());
    return res;
  } catch (_) {
    return (await cache.match(req.mode === 'navigate' ? './index.html' : req, { ignoreSearch: true })) || Response.error();
  }
}
async function cached(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}
async function photo(req, url) {
  const cache = await caches.open(PHOTOS);
  const key = url.origin + url.pathname;
  const hit = await cache.match(key);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === 'opaque') cache.put(key, res.clone());
    return res;
  } catch (_) { return Response.error(); }
}
