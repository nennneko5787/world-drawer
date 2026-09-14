// wd-render.js — キャンバス描画ループ。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
"use strict";
  // ダークモード用の設計図表示色。暗い色は白寄りに持ち上げないと
  // 暗背景に埋もれるため、輝度不足分だけ混合する (結果はキャッシュ)
  const draftDarkColorCache = new Map();
  function draftDisplayColor(hex) {
    if (!isDark) return hex;
    const cached = draftDarkColorCache.get(hex);
    if (cached !== undefined) return cached;
    let out = hex;
    const m = /^#([0-9a-fA-F]{6})$/.exec(hex || "");
    if (m) {
      const n = parseInt(m[1], 16);
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      if (lum < 0.35) {
        const k = 0.55;
        const mix = (c) => Math.round(c + (255 - c) * k);
        const hx = (c) => mix(c).toString(16).padStart(2, "0");
        out = `#${hx(r)}${hx(g)}${hx(b)}`;
      }
    }
    if (draftDarkColorCache.size > 1024) draftDarkColorCache.clear();
    draftDarkColorCache.set(hex, out);
    return out;
  }
  // カーソル名札の文字色。背景色が明るい色では黒文字にして可読性を保つ
  function labelTextColor(hex) {
    const m = /^#([0-9a-fA-F]{6})$/.exec(hex || "");
    if (!m) return "#fff";
    const n = parseInt(m[1], 16);
    const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    return lum > 0.6 ? "#111" : "#fff";
  }
  // ズーム連動の描画詳細度 (簡易表示)。0=フル 〜 3=最小。
  // 1: 発光の影を省略 / 2: +虹アニメ停止・ゾーン境界非表示 / 3: +カーソル名札非表示
  function detailLevel() {
    if (simplifyMode === "off") return 0;
    const z = cam.zoom;
    if (z >= 4) return 0;
    if (z >= 1.5) return 1;
    if (z >= 0.5) return 2;
    return 3;
  }
  // フレーム毎の確保を避ける再利用バッファ (色→平坦座標配列、特殊リスト)
  // 11k超のピクセル表示でも fillStyle切替・fill呼出・GCを抑えるため
  const pixelBatchMap = new Map();
  const specialDrawList = [];
  const draftBatchMap = new Map();
  // ---------- render (infinite: visible only) ----------
  function render(now) {
    const time = now / 1000;
    // FPS計測 (EMA。設定パネルに500ms毎表示)
    if (fpsLastT > 0) {
      const dt = now - fpsLastT;
      if (dt > 0 && dt < 1000) {
        const fps = 1000 / dt;
        fpsEma = fpsEma === 0 ? fps : fpsEma * 0.9 + fps * 0.1;
      }
    }
    fpsLastT = now;
    const dl = detailLevel();
    if (now - fpsShownAt > 500) {
      fpsShownAt = now;
      if (fpsVal) fpsVal.textContent = String(Math.round(fpsEma));
      if (cacheVal) cacheVal.textContent = String(pixels.size);
      if (drawDetailVal) {
        drawDetailVal.textContent = dl >= 3 ? t("qdL3") : dl === 2 ? t("qdL2") : dl === 1 ? t("qdL1") : t("qdFull");
      }
    }
    isDark = document.documentElement.dataset.theme === "dark";
    const vw = viewW(), vh = viewH();
    // 変化なし・虹色アニメなしなら描画スキップ (DOM表示の更新だけ継続)
    // vsync駆動 (rAF) で毎フレーム描画。アニメ抑制はしない
    const hoverRainbow = !!hover && tool === "pen" && inkSet.has("rainbow");
    // 簡易Lv2以上では虹を固定色にするためアニメ用の再描画は不要
    const needAnim = dl < 2 && (rainbowCount > 0 || hoverRainbow);
    if (!renderDirty && !needAnim) {
      updateCooldownUI();
      requestAnimationFrame(render);
      return;
    }
    renderDirty = false;
    ctx.fillStyle = isDark ? "#15151b" : background;
    ctx.fillRect(0, 0, vw, vh);

    const x0 = Math.floor(-cam.x / cam.zoom) - 1;
    const x1 = Math.ceil((vw - cam.x) / cam.zoom) + 1;
    const y0 = Math.floor(-cam.y / cam.zoom) - 1;
    const y1 = Math.ceil((vh - cam.y) / cam.zoom) + 1;

    // 設計図 (自分専用・薄く表示。毎フレームparseしないよう一覧キャッシュを使う)
    // ダークモードは濃度を上げ＋暗色を持ち上げないと見えない
    // 色ごとにバッチ化して fillStyle切替・fill回数を削減
    if (showDrafts && draftList.length > 0) {
      draftBatchMap.clear();
      const dz = cam.zoom, dcx = cam.x, dcy = cam.y;
      for (let di = 0; di < draftList.length; di++) {
        const d = draftList[di];
        if (d.x < x0 || d.x > x1 || d.y < y0 || d.y > y1) continue;
        const dc = draftDisplayColor(d.c);
        let arr = draftBatchMap.get(dc);
        if (!arr) {
          arr = [];
          draftBatchMap.set(dc, arr);
        }
        arr.push(dcx + d.x * dz, dcy + d.y * dz);
      }
      if (draftBatchMap.size > 0) {
        ctx.save();
        ctx.globalAlpha = isDark ? 0.38 : 0.22;
        for (const [color, arr] of draftBatchMap) {
          ctx.fillStyle = color;
          ctx.beginPath();
          for (let i = 0; i < arr.length; i += 2) ctx.rect(arr[i], arr[i + 1], dz, dz);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    // 設計図の範囲プレビュー (矩形・直線・円のドラッグ中。消しゴム時は赤)
    if (draftMode && draftPreview) {
      const pv = draftPreview;
      const erasePv = tool === "eraser";
      const pvColor = erasePv ? "#e33" : draftDisplayColor(paintColor);
      const xa = Math.min(pv.x0, pv.x1), xb = Math.max(pv.x0, pv.x1);
      const ya = Math.min(pv.y0, pv.y1), yb = Math.max(pv.y0, pv.y1);
      ctx.save();
      ctx.setLineDash([8, 5]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = pvColor;
      if (pv.tool === "rect") {
        const sx = cam.x + xa * cam.zoom, sy = cam.y + ya * cam.zoom;
        const w = (xb - xa + 1) * cam.zoom, h = (yb - ya + 1) * cam.zoom;
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = pvColor;
        ctx.fillRect(sx, sy, w, h);
        ctx.globalAlpha = 1;
        ctx.strokeRect(sx, sy, w, h);
      } else if (pv.tool === "line") {
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.moveTo(cam.x + (pv.x0 + 0.5) * cam.zoom, cam.y + (pv.y0 + 0.5) * cam.zoom);
        ctx.lineTo(cam.x + (pv.x1 + 0.5) * cam.zoom, cam.y + (pv.y1 + 0.5) * cam.zoom);
        ctx.lineWidth = Math.max(2, cam.zoom * 0.9);
        ctx.setLineDash([]);
        ctx.stroke();
      } else if (pv.tool === "circle") {
        const sx = cam.x + xa * cam.zoom, sy = cam.y + ya * cam.zoom;
        const w = (xb - xa + 1) * cam.zoom, h = (yb - ya + 1) * cam.zoom;
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = pvColor;
        ctx.beginPath();
        ctx.ellipse(sx + w / 2, sy + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.stroke();
      }
      ctx.restore();
    }

    // ピクセル (座標は格納時に解決済みで毎フレームparseしない)
    // t は単体 ("glow") または重ねがけ ("ghost+glow")。効果は合成して描く
    // 高速化: 通常ピクセルは色ごとにバッチ (fillStyle切替とfillを削減)、
    // 特殊は少数前提で後段描画。Set確保・save/restore・shadowBlur乱用を避ける
    pixelBatchMap.clear();
    specialDrawList.length = 0;
    {
      const hasBlocked = blocked.size > 0;
      const zx = cam.zoom, cx = cam.x, cy = cam.y;
      for (const val of pixels.values()) {
        const x = val.x, y = val.y;
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        if (hasBlocked && val.by && blocked.has(val.by)) continue; // 非表示ID
        const vt = val.t || "normal";
        if (vt === "normal") {
          let arr = pixelBatchMap.get(val.c);
          if (!arr) {
            arr = [];
            pixelBatchMap.set(val.c, arr);
          }
          arr.push(cx + x * zx, cy + y * zx);
        } else {
          specialDrawList.push(val);
        }
      }
      if (pixelBatchMap.size > 0) {
        for (const [color, arr] of pixelBatchMap) {
          ctx.fillStyle = color;
          ctx.beginPath();
          for (let i = 0; i < arr.length; i += 2) ctx.rect(arr[i], arr[i + 1], zx, zx);
          ctx.fill();
        }
      }
    }
    if (specialDrawList.length > 0) {
      // 発光の shadowBlur は激重のため、発光が多い・縮小表示・特殊が多い時は簡易描画
      const zx = cam.zoom, cx = cam.x, cy = cam.y;
      const glowFx = dl === 0 && glowCount <= 250 && zx >= 4 && specialDrawList.length < 800;
      for (let si = 0; si < specialDrawList.length; si++) {
        const val = specialDrawList[si];
        const x = val.x, y = val.y;
        const vt = val.t || "normal";
        // トークン名は互いに部分文字列にならないため includes で判定 (Set確保なし)
        const hasRainbow = vt.includes("rainbow");
        const hasGlow = vt.includes("glow");
        const hasGhost = vt.includes("ghost");
        let base = val.c;
        if (hasRainbow && dl < 2) base = `hsl(${(x * 7 + y * 13 + time * 90) % 360},100%,55%)`;
        const sx = cx + x * zx, sy = cy + y * zx;
        let alpha = 1;
        if (hasGhost) {
          // 重ね塗りで濃くなる (coats<=0 は混色済み=不透明)。初回は半透明
          const coats = val.coats ?? 1;
          alpha = coats <= 0 ? 1 : 1 - 0.5 / Math.min(Math.max(1, coats), 5);
        }
        if (hasGlow && glowFx) {
          // 発光 (ダークモードでは強く輝く)。save/restoreなしで必要分だけ設定・復元
          ctx.globalAlpha = alpha;
          ctx.shadowColor = base;
          ctx.shadowBlur = isDark ? zx * 1.2 + 12 : Math.max(6, zx * 0.8);
          ctx.fillStyle = base;
          ctx.fillRect(sx, sy, zx, zx);
          if (isDark) ctx.fillRect(sx, sy, zx, zx);
          ctx.shadowBlur = 0;
          if (alpha !== 1) ctx.globalAlpha = 1;
        } else {
          if (alpha !== 1) ctx.globalAlpha = alpha;
          ctx.fillStyle = base;
          ctx.fillRect(sx, sy, zx, zx);
          if (alpha !== 1) ctx.globalAlpha = 1;
        }
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }

    // 配置可能ゾーンの境界線 (Lv制限中のみ。簡易Lv2以上では非表示)
    if (showZone && dl < 2 && myLevel < trustedLevel && pixels.size > 0) {
      if (zoneDirty && !panning && Date.now() - zoneBuiltAt > 800) {
        rebuildZoneIndex();
        rebuildZoneSegments(x0, x1, y0, y1);
      }
      ctx.save();
      ctx.strokeStyle = isDark ? "rgba(255, 213, 74, .85)" : "rgba(200, 150, 0, .85)";
      ctx.lineWidth = 2;
      ctx.setLineDash([9, 6]);
      ctx.beginPath();
      for (const s of zoneSegments) {
        const loX = Math.min(s.x1, s.x2), hiX = Math.max(s.x1, s.x2);
        const loY = Math.min(s.y1, s.y2), hiY = Math.max(s.y1, s.y2);
        if (hiX < x0 - 1 || loX > x1 + 1 || hiY < y0 - 1 || loY > y1 + 1) continue;
        ctx.moveTo(cam.x + s.x1 * cam.zoom, cam.y + s.y1 * cam.zoom);
        ctx.lineTo(cam.x + s.x2 * cam.zoom, cam.y + s.y2 * cam.zoom);
      }
      ctx.stroke();
      ctx.restore();
    }

    // 原点軸
    if (showAxes) {
      const origin = cellToScreen(0, 0);
      ctx.strokeStyle = "rgba(200,0,0,.35)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (origin.x >= 0 && origin.x <= vw) {
        ctx.moveTo(origin.x, 0);
        ctx.lineTo(origin.x, vh);
      }
      if (origin.y >= 0 && origin.y <= vh) {
        ctx.moveTo(0, origin.y);
        ctx.lineTo(vw, origin.y);
      }
      ctx.stroke();
    }

    // グリッド (無限)
    if (showGrid && cam.zoom >= 6) {
      ctx.strokeStyle = isDark ? "rgba(255,255,255,.14)" : "rgba(0,0,0,.18)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = x0; x <= x1; x++) {
        const px = Math.round(cam.x + x * cam.zoom) + 0.5;
        ctx.moveTo(px, Math.max(0, cam.y + y0 * cam.zoom));
        ctx.lineTo(px, Math.min(vh, cam.y + (y1 + 1) * cam.zoom));
      }
      for (let y = y0; y <= y1; y++) {
        const py = Math.round(cam.y + y * cam.zoom) + 0.5;
        ctx.moveTo(Math.max(0, cam.x + x0 * cam.zoom), py);
        ctx.lineTo(Math.min(vw, cam.x + (x1 + 1) * cam.zoom), py);
      }
      ctx.stroke();
    }

    // 他ユーザーのカーソル (枠だけ + 名前、非表示IDは除外)
    if (showCursors) {
      const nowMs = Date.now();
      for (const cur of remotes.values()) {
        if (cur.uid === myUid) continue;
        if (cur.uid && blocked.has(cur.uid)) continue;
        if (nowMs - cur.updatedAt > 10000) continue;
        if (cur.x == null || cur.y == null) continue;
        if (cur.x < x0 || cur.x > x1 || cur.y < y0 || cur.y > y1) continue;
        const sx = cam.x + cur.x * cam.zoom, sy = cam.y + cur.y * cam.zoom;
        ctx.strokeStyle = cur.color || "#22aa66";
        ctx.lineWidth = 2.5;
        strokeCellRect(sx, sy);
        // 簡易Lv3では名札を省略 (枠のみ。小さすぎて読めないため)
        if (dl >= 3) continue;
        const label = cur.name || t("anon");
        ctx.font = "12px system-ui, sans-serif";
        const w = ctx.measureText(label).width + 12;
        const lx = Math.min(Math.max(4, sx), vw - w - 4);
        const ly = Math.max(30, sy - 24);
        const tagBg = cur.color || "#22aa66";
        ctx.fillStyle = tagBg;
        ctx.fillRect(lx, ly, w, 18);
        ctx.fillStyle = labelTextColor(tagBg);
        ctx.fillText(label, lx + 6, ly + 13);
      }
    }

    // 自分のホバー (枠だけプレビュー)
    if (hover) {
      const sx = cam.x + hover.x * cam.zoom, sy = cam.y + hover.y * cam.zoom;
      ctx.strokeStyle = tool === "pen" ? (isDark ? "#fff" : "#111") : "#d00";
      ctx.lineWidth = 2;
      strokeCellRect(sx, sy);
      if (tool === "pen") {
        ctx.globalAlpha = 0.55;
        // 簡易Lv2以上では虹プレビューも固定色 (アニメ用の再描画を抑える)
        ctx.fillStyle = inkSet.has("rainbow")
          ? (dl < 2 ? `hsl(${(Date.now() / 10) % 360},100%,55%)` : `hsl(${(hover.x * 7 + hover.y * 13) % 360},100%,55%)`)
          : draftDisplayColor(paintColor);
        fillCellRect(sx, sy);
        ctx.globalAlpha = 1;
      }
      if (showZone && myLevel < trustedLevel && !zoneAllowed(hover.x, hover.y, 0)) {
        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = "#e33";
        ctx.lineWidth = 2.5;
        strokeCellRect(sx, sy);
        ctx.restore();
      }
    }

    // タッチのホールド中は指で隠れても分かるよう外枠と座標ラベルで強調
    if (touchHold) {
      const hx = cam.x + touchHold.x * cam.zoom, hy = cam.y + touchHold.y * cam.zoom;
      ctx.save();
      ctx.strokeStyle = "#0aa0ff";
      ctx.lineWidth = 3;
      ctx.strokeRect(hx - 5, hy - 5, cam.zoom + 10, cam.zoom + 10);
      ctx.restore();
      const holdLabel = formatCoords(touchHold);
      ctx.font = "13px system-ui, sans-serif";
      const tw = ctx.measureText(holdLabel).width + 16;
      const tx = Math.min(Math.max(4, hx + cam.zoom / 2 - tw / 2), vw - tw - 4);
      const ty = Math.max(30, hy - 36);
      ctx.fillStyle = "rgba(10, 160, 255, .95)";
      ctx.fillRect(tx, ty, tw, 22);
      ctx.fillStyle = "#fff";
      ctx.fillText(holdLabel, tx + 8, ty + 15);
    }

    updateCooldownUI();
    requestAnimationFrame(render);
  }

  let cooldownShown = "";