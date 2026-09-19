// pixDraw Service Worker (template)。
// frontend/build.py が __WD_SW_VERSION__ を ?v= 版に置換し、dist/sw.js
// (scope=/) として配信する。dist/static/ には置かない。
//
// 方針: 版付き /static/* のみ cache-first (immutable)。HTML・API・WS・
// OGP画像・クロスオリジンCDNは素通し (ネットワークのみ)。
// シェルを先読みキャッシュしないため、新旧フロントの取り違え
// (deploy.md の WS 1006 問題) を起こさない。オフライン起動の偽装もしない。
"use strict";

const WD_SW_VERSION = "__WD_SW_VERSION__";
const WD_CACHE = "pixdraw-static-" + WD_SW_VERSION;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("pixdraw-static-") && k !== WD_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

function cacheableStatic(url) {
  return (
    url.origin === self.location.origin &&
    url.pathname.startsWith("/static/") &&
    url.searchParams.has("v")
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  if (req.mode === "navigate") return;
  let url = null;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (!cacheableStatic(url)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(WD_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && res.ok) {
        try {
          await cache.put(req, res.clone());
        } catch (e) {
          // 保存失敗は次回missするだけ (無害)
        }
      }
      return res;
    })(),
  );
});
