'use strict';

const CACHE_NAME = 'ai-invoice-po-detector-v5-2';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/playground.html',
  '/styles.css',
  '/workspaceStore.js',
  '/disputeGenerator.js',
  '/accountingExporter.js',
  '/localAiClient.js',
  '/cryptoVault.js',
  '/app.js',
  '/playground.js',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const reqUrl = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    reqUrl.origin !== self.location.origin ||
    reqUrl.pathname.startsWith('/api/') ||
    reqUrl.pathname === '/__dev_reload'
  ) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((networkResp) => {
          if (networkResp && networkResp.status === 200) {
            const copy = networkResp.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, copy));
          }
          return networkResp;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
