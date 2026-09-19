/* pixDraw PWA bootstrap (classic script, defer)。SW登録のみ。i18n非依存。 */
(() => {
  "use strict";

  if (!("serviceWorker" in navigator)) return;
  // SWはhttps/localhostのみ。http公開では黙って無効。
  const host = window.location.hostname;
  if (
    window.location.protocol !== "https:" &&
    host !== "localhost" &&
    host !== "127.0.0.1" &&
    host !== "[::1]"
  ) {
    return;
  }
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // 開発サーバ等で /sw.js が無ければ黙って無効 (PWAはdist配信のみ)
    });
  });
})();
