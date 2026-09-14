// wd-camera.js — カメラ (表示サイズ・ズーム・移動・位置の保存/復元)。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
"use strict";
  // ---------- camera (infinite) ----------
  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 96;
  const cam = { x: 0, y: 0, zoom: 16 };
  // 実表示サイズ (CSS px)。innerWidth/innerHeight だとスマホの URL バー領域分だけ
  // バッキングストアと表示サイズが食い違い、縦方向に引き伸ばされて見えるため、
  // canvas の実表示サイズを基準にする (正方形維持)。
  function viewW() {
    return canvas.clientWidth || window.innerWidth;
  }
  function viewH() {
    return canvas.clientHeight || window.innerHeight;
  }
  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(viewW() * dpr);
    canvas.height = Math.floor(viewH() * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    markDirty();
  }
  window.addEventListener("resize", resize);
  // 後続ファイルの関数のため直接参照せず実行時に解決する
  window.addEventListener("resize", (...args) => scheduleViewportFetch(...args));
  try {
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", resize);
      window.visualViewport.addEventListener("resize", (...args) => scheduleViewportFetch(...args));
    }
  } catch {}
  window.addEventListener("orientationchange", resize);
  resize();

  function centerOn(cx, cy, zoom) {
    if (zoom) cam.zoom = zoom;
    cam.x = viewW() / 2 - cx * cam.zoom;
    cam.y = viewH() / 2 - cy * cam.zoom;
    markDirty();
  }
  centerOn(0, 0, 16);

  // 表示位置の復元 (入り直しても前回の場所に戻る)
  function saveCamera() {
    try {
      localStorage.setItem("wd_cam", JSON.stringify({ x: cam.x, y: cam.y, zoom: cam.zoom }));
    } catch {}
  }
  let camTimer = 0;
  function scheduleSaveCamera() {
    clearTimeout(camTimer);
    camTimer = setTimeout(saveCamera, 500);
  }
  (function restoreCamera() {
    try {
      const saved = JSON.parse(localStorage.getItem("wd_cam") || "null");
      if (!saved || typeof saved !== "object") return;
      const zoom = Number(saved.zoom);
      if (!Number.isFinite(zoom) || zoom < MIN_ZOOM || zoom > MAX_ZOOM) return;
      const x = Number(saved.x), y = Number(saved.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (Math.abs(x) > 1e9 || Math.abs(y) > 1e9) return;
      cam.x = x;
      cam.y = y;
      cam.zoom = zoom;
    } catch {}
  })();
