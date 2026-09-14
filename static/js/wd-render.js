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
  // 小数ズームでセル間に隙間 (背景の覗き) が出ないよう、セルを全方向に膨らませて描く
  const PIXEL_BLEED = 0.5;
  const pixelBatchMap = new Map();
  const specialDrawList = [];
  const draftBatchMap = new Map();
  // 静的レイヤー (背景・設計図・通常ピクセル等を焼き付け、毎フレームは転送のみ)。
  // 変化がなければ再描画しないため、虹アニメ・カーソル移動時も安い
  const staticCanvas = document.createElement("canvas");
  const staticCtx = staticCanvas.getContext("2d");
  const animCache = []; // 毎フレーム動かす虹ピクセル (静的再構築時に更新)
  // 特殊インク1マス描画 (静的・動的共通。t は描画先)。
  // save/restoreとshadowBlur乱用を避け、必要分だけ設定・復元する
  function paintSpecialTo(t, val, sx, sy, s, time, animateRainbow, glowFx) {
    const vt = val.t || "normal";
    const hasRainbow = vt.includes("rainbow");
    const hasGlow = vt.includes("glow");
    const hasGhost = vt.includes("ghost");
    const x = val.x, y = val.y;
    const B = PIXEL_BLEED;
    let base = val.c;
    if (hasRainbow && animateRainbow) base = `hsl(${(x * 7 + y * 13 + time * 90) % 360},100%,55%)`;
    let alpha = 1;
    if (hasGhost) {
      // 重ね塗りで濃くなる (coats<=0 は混色済み=不透明)。初回は半透明
      const coats = val.coats ?? 1;
      alpha = coats <= 0 ? 1 : 1 - 0.5 / Math.min(Math.max(1, coats), 5);
    }
    if (hasGlow && glowFx) {
      // 発光 (ダークモードでは強く輝く)
      t.globalAlpha = alpha;
      t.shadowColor = base;
      t.shadowBlur = isDark ? s * 1.2 + 12 : Math.max(6, s * 0.8);
      t.fillStyle = base;
      t.fillRect(sx - B, sy - B, s + B * 2, s + B * 2);
      if (isDark) t.fillRect(sx - B, sy - B, s + B * 2, s + B * 2);
      t.shadowBlur = 0;
      if (alpha !== 1) t.globalAlpha = 1;
    } else {
      if (alpha !== 1) t.globalAlpha = alpha;
      t.fillStyle = base;
      t.fillRect(sx - B, sy - B, s + B * 2, s + B * 2);
      if (alpha !== 1) t.globalAlpha = 1;
    }
  }
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
    // 最高画質は常にフル詳細 (従来描画)。それ以外は簡易表示設定に従う
    const dl = qualityMode === "ultra" ? 0 : detailLevel();
    const ultra = qualityMode === "ultra";
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

    const x0 = Math.floor(-cam.x / cam.zoom) - 1;
    const x1 = Math.ceil((vw - cam.x) / cam.zoom) + 1;
    const y0 = Math.floor(-cam.y / cam.zoom) - 1;
    const y1 = Math.ceil((vh - cam.y) / cam.zoom) + 1;

    // ゾーンデータの更新 (静的レイヤーに焼く前に済ませる)
    if (showZone && dl < 2 && myLevel < trustedLevel && pixels.size > 0) {
      if (zoneDirty && !panning && Date.now() - zoneBuiltAt > 800) {
        rebuildZoneIndex();
        rebuildZoneSegments(x0, x1, y0, y1);
        staticDirty = true;
      }
    }

    if (ultra) {
      // 最高画質: 毎フレーム全量を直接描画 (従来方式)
      paintStaticTo(ctx, vw, vh, x0, x1, y0, y1, time, dl, true);
    } else {
      // 静的レイヤー方式: 変化時のみ焼き直し、毎フレームは転送＋動く物だけ描く
      if (staticDirty) {
        const dpr = Math.min(dprCap(), window.devicePixelRatio || 1);
        const sw = Math.max(1, Math.floor(vw * dpr));
        const sh = Math.max(1, Math.floor(vh * dpr));
        if (staticCanvas.width !== sw || staticCanvas.height !== sh) {
          staticCanvas.width = sw;
          staticCanvas.height = sh;
        }
        staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        paintStaticTo(staticCtx, vw, vh, x0, x1, y0, y1, time, dl, false);
        staticDirty = false;
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      ctx.fillStyle = isDark ? "#15151b" : background;
      ctx.fillRect(0, 0, vw, vh);
      ctx.drawImage(staticCanvas, 0, 0, vw, vh);
    }
    paintDynamicTo(vw, vh, time, dl);

    updateCooldownUI();
    requestAnimationFrame(render);
  }
  // 静的レイヤー描画 (背景・設計図・ピクセル・ゾーン・軸・グリッド)。
  // t が静的offscreenなら焼き付け、最高画質では直接描画する
  function paintStaticTo(t, vw, vh, x0, x1, y0, y1, time, dl, useLegacy) {
    t.fillStyle = isDark ? "#15151b" : background;
    t.fillRect(0, 0, vw, vh);

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
        t.save();
        t.globalAlpha = isDark ? 0.38 : 0.22;
        for (const [color, arr] of draftBatchMap) {
          t.fillStyle = color;
          t.beginPath();
          for (let i = 0; i < arr.length; i += 2) t.rect(arr[i] - PIXEL_BLEED, arr[i + 1] - PIXEL_BLEED, dz + PIXEL_BLEED * 2, dz + PIXEL_BLEED * 2);
          t.fill();
        }
        t.restore();
      }
    }

    // ピクセル (座標は格納時に解決済みで毎フレームparseしない)
    // t は単体 ("glow") または重ねがけ ("ghost+glow")。効果は合成して描く
    if (useLegacy) {
      // 最高画質: 従来の1マスずつ描画 (発光の影つき・虹アニメ常時)。重いが忠実
      for (const val of pixels.values()) {
        const x = val.x, y = val.y;
        if (x == null || y == null) continue;
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        if (val.by && blocked.has(val.by)) continue; // 非表示ID
        const sx = cam.x + x * cam.zoom - PIXEL_BLEED;
        const sy = cam.y + y * cam.zoom - PIXEL_BLEED;
        const s = cam.zoom + PIXEL_BLEED * 2;
        const vt = String(val.t || "normal");
        if (vt === "normal") {
          t.fillStyle = val.c;
          t.fillRect(sx, sy, s, s);
          continue;
        }
        const parts = new Set(vt.split("+"));
        const hasRainbow = parts.has("rainbow");
        const hasGlow = parts.has("glow");
        const hasGhost = parts.has("ghost");
        let base = val.c;
        if (hasRainbow) base = `hsl(${(x * 7 + y * 13 + time * 90) % 360},100%,55%)`;
        t.save();
        if (hasGhost) {
          // 重ね塗りで濃くなる (coats<=0 は混色済み=不透明)。初回は半透明
          const coats = val.coats ?? 1;
          t.globalAlpha = coats <= 0 ? 1 : 1 - 0.5 / Math.min(Math.max(1, coats), 5);
        }
        if (hasGlow) {
          // 発光 (ダークモードでは強く輝く)
          t.shadowColor = base;
          t.shadowBlur = isDark ? s * 1.2 + 12 : Math.max(6, s * 0.8);
        }
        t.fillStyle = base;
        t.fillRect(sx, sy, s, s);
        if (hasGlow && isDark) t.fillRect(sx, sy, s, s);
        t.restore();
      }
    } else {
      // 色バッチ高速描画。動く虹は動的パスに回し、ここでは焼き付けない
      pixelBatchMap.clear();
      specialDrawList.length = 0;
      animCache.length = 0;
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
        } else if (dl < 2 && vt.includes("rainbow")) {
          animCache.push(val);
        } else {
          specialDrawList.push(val);
        }
      }
      if (pixelBatchMap.size > 0) {
        for (const [color, arr] of pixelBatchMap) {
          t.fillStyle = color;
          t.beginPath();
          for (let i = 0; i < arr.length; i += 2) t.rect(arr[i] - PIXEL_BLEED, arr[i + 1] - PIXEL_BLEED, zx + PIXEL_BLEED * 2, zx + PIXEL_BLEED * 2);
          t.fill();
        }
      }
      if (specialDrawList.length > 0) {
        // 発光の shadowBlur は激重のため、発光が多い・縮小表示・特殊が多い時は簡易描画
        const glowFx = dl === 0 && glowCount <= 250 && zx >= 4 && specialDrawList.length < 800;
        for (let si = 0; si < specialDrawList.length; si++) {
          const val = specialDrawList[si];
          paintSpecialTo(t, val, cx + val.x * zx, cy + val.y * zx, zx, time, dl < 2, glowFx);
        }
        t.globalAlpha = 1;
        t.shadowBlur = 0;
      }
    }

    // 配置可能ゾーンの境界線 (Lv制限中のみ。簡易Lv2以上では非表示)
    // データ更新は render 側の事前パスで済ませ、ここでは描くだけ
    if (showZone && dl < 2 && myLevel < trustedLevel && pixels.size > 0) {
      t.save();
      t.strokeStyle = isDark ? "rgba(255, 213, 74, .85)" : "rgba(200, 150, 0, .85)";
      t.lineWidth = 2;
      t.setLineDash([9, 6]);
      t.beginPath();
      for (const s of zoneSegments) {
        const loX = Math.min(s.x1, s.x2), hiX = Math.max(s.x1, s.x2);
        const loY = Math.min(s.y1, s.y2), hiY = Math.max(s.y1, s.y2);
        if (hiX < x0 - 1 || loX > x1 + 1 || hiY < y0 - 1 || loY > y1 + 1) continue;
        t.moveTo(cam.x + s.x1 * cam.zoom, cam.y + s.y1 * cam.zoom);
        t.lineTo(cam.x + s.x2 * cam.zoom, cam.y + s.y2 * cam.zoom);
      }
      t.stroke();
      t.restore();
    }

    // 原点軸
    if (showAxes) {
      const origin = cellToScreen(0, 0);
      t.strokeStyle = "rgba(200,0,0,.35)";
      t.lineWidth = 1.5;
      t.beginPath();
      if (origin.x >= 0 && origin.x <= vw) {
        t.moveTo(origin.x, 0);
        t.lineTo(origin.x, vh);
      }
      if (origin.y >= 0 && origin.y <= vh) {
        t.moveTo(0, origin.y);
        t.lineTo(vw, origin.y);
      }
      t.stroke();
    }

    // グリッド (無限)
    if (showGrid && cam.zoom >= 6) {
      t.strokeStyle = isDark ? "rgba(255,255,255,.14)" : "rgba(0,0,0,.18)";
      t.lineWidth = 1;
      t.beginPath();
      for (let x = x0; x <= x1; x++) {
        const px = Math.round(cam.x + x * cam.zoom) + 0.5;
        t.moveTo(px, Math.max(0, cam.y + y0 * cam.zoom));
        t.lineTo(px, Math.min(vh, cam.y + (y1 + 1) * cam.zoom));
      }
      for (let y = y0; y <= y1; y++) {
        const py = Math.round(cam.y + y * cam.zoom) + 0.5;
        t.moveTo(Math.max(0, cam.x + x0 * cam.zoom), py);
        t.lineTo(Math.min(vw, cam.x + (x1 + 1) * cam.zoom), py);
      }
      t.stroke();
    }

    t.globalAlpha = 1;
    t.shadowBlur = 0;
  }
  // 動的オーバーレイ (プレビュー・虹アニメ・カーソル・ホバー・ホールド)。毎フレーム描く
  function paintDynamicTo(vw, vh, time, dl) {
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

    // 虹アニメ (静的レイヤーに焼けない分だけ毎フレーム描く)
    if (animCache.length > 0) {
      const zx = cam.zoom, cx = cam.x, cy = cam.y;
      const glowFx = dl === 0 && glowCount <= 250 && zx >= 4 && animCache.length < 800;
      for (let ai = 0; ai < animCache.length; ai++) {
        const val = animCache[ai];
        paintSpecialTo(ctx, val, cx + val.x * zx, cy + val.y * zx, zx, time, true, glowFx);
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }

    // 他ユーザーのカーソル (枠だけ + 名前、非表示IDは除外)
    if (showCursors) {
      const nowMs = Date.now();
      const x0 = Math.floor(-cam.x / cam.zoom) - 1;
      const x1 = Math.ceil((vw - cam.x) / cam.zoom) + 1;
      const y0 = Math.floor(-cam.y / cam.zoom) - 1;
      const y1 = Math.ceil((vh - cam.y) / cam.zoom) + 1;
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
  }

  let cooldownShown = "";
