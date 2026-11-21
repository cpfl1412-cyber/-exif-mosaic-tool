/* 사진 안전 정리 — 오프라인 캐시
 * 사진은 절대 네트워크로 나가지 않는다. 여기서는 앱 파일만 다룬다.
 * 업데이트가 바로 반영되도록 같은 출처 파일은 네트워크 우선,
 * 오프라인일 때만 캐시로 응답한다.
 */
const CACHE = 'exif-mosaic-v2';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(ASSETS.map(function (url) {
        return fetch(url, { cache: 'no-store' })
          .then(function (res) { if (res && res.ok) return cache.put(url, res); })
          .catch(function () { /* 오프라인 설치 등은 무시 */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE) return caches.delete(key);
        return null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  // 같은 출처의 앱 파일만 다룬다(그 외 요청은 브라우저 기본 동작).
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async function () {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(request, { cache: 'no-store' });
        if (fresh && fresh.ok && fresh.type === 'basic') {
          cache.put(request, fresh.clone()).catch(function () {});
        }
        return fresh;
      } catch (err) {
        const hit = await cache.match(request, { ignoreSearch: true });
        if (hit) return hit;
        if (request.mode === 'navigate') {
          const shell = await cache.match('./index.html');
          if (shell) return shell;
        }
        return Response.error();
      }
    })()
  );
});
