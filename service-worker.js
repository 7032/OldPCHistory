/*!
 * 国産パソコン年表ビューア - Service Worker
 *
 * ファイルを更新したら CACHE_VERSION を必ず上げること。
 * 上げないと利用者の端末に古いキャッシュが残り続ける。
 *
 * GitHub Pages のプロジェクトサイト（サブディレクトリ配信）でも動くよう、
 * プリキャッシュ対象はすべて相対パスで列挙し、
 * new URL(path, self.registration.scope) で絶対URLへ解決している。
 */
'use strict';

var CACHE_VERSION = 'v10';
var CACHE_NAME = 'oldpc-timeline-' + CACHE_VERSION;

/** プリキャッシュ対象（すべて相対パス） */
var PRECACHE_PATHS = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './timeline.md',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

/** ネットワーク優先で扱うパス（データの更新を反映しやすくする） */
var NETWORK_FIRST_PATHS = ['./timeline.md'];

/** 相対パスを配信スコープ基準の絶対URLへ解決する */
function resolve(path) {
  return new URL(path, self.registration.scope).toString();
}

function resolveAll(paths) {
  return paths.map(resolve);
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // 1つでも失敗すると addAll 全体が失敗するため、個別に追加して耐性を持たせる。
      return Promise.all(resolveAll(PRECACHE_PATHS).map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' }))['catch'](function (err) {
          console.warn('[SW] プリキャッシュに失敗しました:', url, err && err.message ? err.message : err);
        });
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        if (name !== CACHE_NAME && name.indexOf('oldpc-timeline-') === 0) {
          return caches['delete'](name);
        }
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function putInCache(request, response) {
  if (!response || !response.ok || response.type === 'opaque') return response;
  var copy = response.clone();
  caches.open(CACHE_NAME).then(function (cache) {
    cache.put(request, copy);
  })['catch'](function () { /* 保存できなくても表示は継続する */ });
  return response;
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return;   // 外部リソースは扱わない

  var scopeUrl = new URL(self.registration.scope);
  if (url.pathname.indexOf(scopeUrl.pathname) !== 0) return;  // スコープ外は素通し

  // ナビゲーション: ネットワーク優先、失敗時は ./index.html を返す
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        return putInCache(req, res);
      })['catch'](function () {
        return caches.match(resolve('./index.html')).then(function (hit) {
          if (hit) return hit;
          return caches.match(resolve('./'));
        }).then(function (hit) {
          return hit || Response.error();
        });
      })
    );
    return;
  }

  // timeline.md はネットワーク優先（オフライン時のみキャッシュ）
  var isNetworkFirst = resolveAll(NETWORK_FIRST_PATHS).some(function (u) {
    return u === url.origin + url.pathname;
  });

  if (isNetworkFirst) {
    event.respondWith(
      fetch(req).then(function (res) {
        return putInCache(req, res);
      })['catch'](function () {
        return caches.match(req).then(function (hit) {
          return hit || Response.error();
        });
      })
    );
    return;
  }

  // それ以外の静的資産はキャッシュ優先
  event.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        return putInCache(req, res);
      });
    })
  );
});
