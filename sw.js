// sw.js · Colorado Referees Hub service worker · 2026-11-23
// Strategy, built around the Hub's existing ?v= cache busters:
//   - navigations: network first, cached shell as the offline fallback
//   - same-origin GET with ?v=: cache first (a new release is a new URL)
//   - other same-origin GET (fonts, images, json): stale while revalidate
//   - everything else (Supabase, Apps Script, cross-origin): untouched
// The cache name is strategy-versioned, not release-versioned; releases
// roll through the ?v= keys. activate cleans retired cache names and a
// size trim keeps old ?v= entries from piling up.

var CACHE = 'hub-static-v1';
var TRIM_AT = 140;

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(['./', './index.html']).catch(function () {});
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function trim(c) {
  c.keys().then(function (keys) {
    if (keys.length > TRIM_AT) {
      c.delete(keys[0]).then(function () { trim(c); });
    }
  });
}

function put(req, res) {
  if (!res || !res.ok || res.status !== 200) { return res; }
  var copy = res.clone();
  caches.open(CACHE).then(function (c) { c.put(req, copy); trim(c); });
  return res;
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') { return; }
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) { return; }

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) { return put(req, res); })
        .catch(function () {
          return caches.match(req).then(function (hit) {
            return hit || caches.match('./index.html');
          });
        })
    );
    return;
  }

  if (url.searchParams.has('v')) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) { return put(req, res); });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) { return put(req, res); })
        .catch(function () { return hit; });
      return hit || net;
    })
  );
});
