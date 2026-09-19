// wd-stats.js — 統計オーバーレイ (表示専用・操作を塞がない)。
// FPS・フレーム時間グラフ・キャッシュ・描画詳細・WS送受信量を500ms毎に更新する。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
"use strict";
  let wsPrev = { up: 0, down: 0, t: 0 };

  function fmtBytes(n) {
    n = Math.max(0, Math.round(Number(n) || 0));
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  function applyStatsOverlay() {
    try {
      if (typeof statsOverlay === "undefined" || !statsOverlay) return;
      statsOverlay.classList.toggle("hidden", !showStats);
    } catch {}
  }

  function drawStatsGraph() {
    try {
      if (typeof stGraph === "undefined" || !stGraph) return;
      const g = stGraph.getContext("2d");
      const W = stGraph.width, H = stGraph.height;
      g.clearRect(0, 0, W, H);
      // 16.7ms (60fps) の目安線
      const guideY = H - Math.min(1, 16.7 / 50) * (H - 4) - 2;
      g.strokeStyle = "rgba(128,128,128,.6)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, guideY);
      g.lineTo(W, guideY);
      g.stroke();
      if (typeof frameMsHist === "undefined" || frameMsHist.length < 2) return;
      let accent = "#1a73e8";
      try {
        const v = getComputedStyle(document.documentElement).getPropertyValue("--focus").trim();
        if (v) accent = v;
      } catch {}
      g.strokeStyle = accent;
      g.lineWidth = 2;
      g.beginPath();
      const n = frameMsHist.length;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * (W - 2) + 1;
        const y = H - Math.min(1, frameMsHist[i] / 50) * (H - 4) - 2;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    } catch (e) {
      console.error(e);
    }
  }

  function refreshStats() {
    try {
      if (!showStats) return;
      if (typeof statsOverlay === "undefined" || !statsOverlay) return;
      if (typeof stFps !== "undefined" && stFps) {
        stFps.textContent = String(Math.round(typeof fpsEma === "number" ? fpsEma : 0));
      }
      if (typeof stMs !== "undefined" && stMs) {
        let avg = 0;
        try {
          if (typeof frameMsHist !== "undefined" && frameMsHist.length > 0) {
            avg = frameMsHist.reduce((a, b) => a + b, 0) / frameMsHist.length;
          }
        } catch {}
        stMs.textContent = `${avg.toFixed(1)} ms`;
      }
      if (typeof stCache !== "undefined" && stCache) {
        try {
          stCache.textContent = String(typeof pixels !== "undefined" ? pixels.size : 0);
        } catch {
          stCache.textContent = "-";
        }
      }
      if (typeof stDraw !== "undefined" && stDraw) {
        const dl = typeof renderDl === "number" ? renderDl : 0;
        stDraw.textContent = dl >= 3 ? t("qdL3") : dl === 2 ? t("qdL2") : dl === 1 ? t("qdL1") : t("qdFull");
      }
      // WS送受信量 (前回差分から現在レートを算出)
      try {
        const now = Date.now();
        const cur = (typeof wsTraffic !== "undefined")
          ? wsTraffic
          : { upBytes: 0, downBytes: 0 };
        let upRate = 0, downRate = 0;
        if (wsPrev.t > 0 && now > wsPrev.t) {
          const dt = (now - wsPrev.t) / 1000;
          upRate = Math.max(0, (cur.upBytes - wsPrev.up) / dt);
          downRate = Math.max(0, (cur.downBytes - wsPrev.down) / dt);
        }
        wsPrev = { up: cur.upBytes, down: cur.downBytes, t: now };
        if (typeof stUp !== "undefined" && stUp) {
          stUp.textContent = `${fmtBytes(upRate)}/s (${fmtBytes(cur.upBytes)})`;
        }
        if (typeof stDown !== "undefined" && stDown) {
          stDown.textContent = `${fmtBytes(downRate)}/s (${fmtBytes(cur.downBytes)})`;
        }
      } catch {}
      drawStatsGraph();
    } catch (e) {
      console.error(e);
    }
  }

  function initStats() {
    try {
      applyStatsOverlay();
      refreshStats();
      setInterval(refreshStats, 500);
    } catch (e) {
      console.error(e);
    }
  }
