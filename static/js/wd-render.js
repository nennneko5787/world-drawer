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
  // 発光のぼかし量 (設定で変更・全テーマ統一)。中=従来のライト、強=従来のダーク相当
  function glowBlur(s) {
    if (glowMode === "off") return 0;
    if (glowMode === "weak") return Math.max(4, s * 0.4);
    if (glowMode === "excessive") return s * 2 + 24;
    if (glowMode === "strong") return s * 1.2 + 12;
    return Math.max(6, s * 0.8);
  }
  // フレーム毎の確保を避ける再利用バッファ (色→平坦座標配列、特殊リスト)
  // 11k超のピクセル表示でも fillStyle切替・fill呼出・GCを抑えるため
  // 小数ズームの隙間対策: セル矩形をデバイスピクセル境界にスナップする。
  // 右下端は隣セルの左上端と同一式で求めるため、隣接セルが境界ピクセルを
  // 共有し背景の覗きが出ない。膨張しないので見た目のサイズは不変。最小1デバイスpx
  function snapCellInto(out, cx, cy, x, y, z) {
    const d = viewDpr > 0 ? viewDpr : 1;
    const rx = Math.round((cx + x * z) * d) / d;
    const ry = Math.round((cy + y * z) * d) / d;
    out.push(
      rx, ry,
      Math.max(1 / d, Math.round((cx + (x + 1) * z) * d) / d - rx),
      Math.max(1 / d, Math.round((cy + (y + 1) * z) * d) / d - ry),
    );
  }
  const snapTmp = [0, 0, 0, 0];
  function snapCell(cx, cy, x, y, z) {
    snapTmp.length = 0;
    snapCellInto(snapTmp, cx, cy, x, y, z);
    return snapTmp;
  }
  const pixelBatchMap = new Map();
  const specialDrawList = [];
  const draftBatchMap = new Map();
  // 静的レイヤー (背景・設計図・通常ピクセル等を焼き付け、毎フレームは転送のみ)。
  // 変化がなければ再描画しないため、虹アニメ・カーソル移動時も安い
  const staticCanvas = document.createElement("canvas");
  const staticCtx = staticCanvas.getContext("2d");
  const animCache = []; // 毎フレーム動かす虹ピクセル (静的再構築時に更新)
  const shieldCache = []; // 保護中のシールド印 (期限切れ判定のため毎フレーム見る)
  let lastChalkSweepT = 0; // 期限切れ掃除は1秒に1回まで
  const chalkCache = []; // チョーク (減衰・消滅のため毎フレーム見る)
  // チョークの減衰 (置いた瞬間から全期間でフェード)。非チョークは1。焼き付け時も呼ぶ。
  // e0 は初見残り秒 (全体長の目安)。同一内容の再取得では引き継ぎ、置き換わりでは更新する
  function chalkFade(val, nowMs) {
    const e = val.e || 0;
    if (e <= 0) return 1;
    const total = (val.e0 || e) * 1000;
    if (total <= 0) return 1;
    const remain = (val.eAt || 0) + e * 1000 - nowMs;
    if (remain <= 0) return 0;
    return Math.min(1, remain / total);
  }
  // シールド有効判定 (残り秒と受信時刻から。時計ずれには猶予なしでサーバーが正)
  function shieldActive(val) {
    const s = val.s || 0;
    if (s <= 0) return false;
    return (val.sAt || 0) + s * 1000 > Date.now();
  }
  // シールドの青オーバーレイ (保護中の目印。設定でON/OFF)
  function paintShieldOverlay(t, sx, sy, sw, sh, zoom) {
    t.fillStyle = "rgba(90,170,255,.35)";
    t.fillRect(sx, sy, sw, sh);
    if (zoom >= 8) {
      t.strokeStyle = "rgba(170,215,255,.9)";
      t.lineWidth = 1;
      t.strokeRect(sx + 0.5, sy + 0.5, Math.max(1, sw - 1), Math.max(1, sh - 1));
    }
  }
  let lastEphemeralDrawT = 0; // シールド・チョークのみの再描画の間引き用 (500ms精度で十分)
  let lastShieldDrawT = 0; // 同上 (リネーム残滓の未宣言参照だったため定義。無いと描画ループが死ぬ)
  // 特殊インク1マス描画 (静的・動的共通。t は描画先)。
  // save/restoreとshadowBlur乱用を避け、必要分だけ設定・復元する
  function paintSpecialTo(t, val, cx, cy, z, time, animateRainbow, glowFx) {
    const vt = val.t || "normal";
    const hasRainbow = vt.includes("rainbow");
    const hasGlow = vt.includes("glow");
    const hasGhost = vt.includes("ghost");
    const x = val.x, y = val.y;
    const q = snapCell(cx, cy, x, y, z);
    const sx = q[0], sy = q[1], sw = q[2], sh = q[3];
    let base = val.c;
    if (hasRainbow && animateRainbow) base = `hsl(${(x * 7 + y * 13 + time * 90) % 360},100%,55%)`;
    let alpha = 1;
    if (hasGhost) {
      // 重ね塗りで濃くなる (coats<=0 は混色済み=不透明)。初回は半透明
      const coats = val.coats ?? 1;
      alpha = coats <= 0 ? 1 : 1 - 0.5 / Math.min(Math.max(1, coats), 5);
    }
    alpha *= chalkFade(val, Date.now());
    if (hasGlow && glowFx && glowMode !== "off") {
      // 発光 (強さは設定・全テーマ統一)
      t.globalAlpha = alpha;
      t.shadowColor = base;
      t.shadowBlur = glowBlur(z);
      t.fillStyle = base;
      t.fillRect(sx, sy, sw, sh);
      if (isDark) t.fillRect(sx, sy, sw, sh);
      t.shadowBlur = 0;
      if (alpha !== 1) t.globalAlpha = 1;
    } else {
      if (alpha !== 1) t.globalAlpha = alpha;
      t.fillStyle = base;
      t.fillRect(sx, sy, sw, sh);
      if (alpha !== 1) t.globalAlpha = 1;
    }
  }
  // ---------- render (infinite: visible only) ----------
  function render(now) {
    const time = now / 1000;
    // FPS計測 (EMA)。統計オーバーレイの表示・グラフ用に履歴も残す
    if (fpsLastT > 0) {
      const dt = now - fpsLastT;
      if (dt > 0 && dt < 1000) {
        const fps = 1000 / dt;
        fpsEma = fpsEma === 0 ? fps : fpsEma * 0.9 + fps * 0.1;
        frameMsHist.push(dt);
        if (frameMsHist.length > 120) frameMsHist.shift();
      }
    }
    fpsLastT = now;
    // 最高画質は常にフル詳細 (従来描画)。最低はズームに関わらず簡易Lv2以上に固定。
    // それ以外は簡易表示設定に従う
    const dl = qualityMode === "ultra" ? 0 : qualityMode === "minimal" ? Math.max(2, detailLevel()) : detailLevel();
    renderDl = dl;
    const ultra = qualityMode === "ultra";
    isDark = document.documentElement.dataset.theme === "dark";
    const vw = viewW(), vh = viewH();
    // 変化なし・虹色アニメなしなら描画スキップ (DOM表示の更新だけ継続)
    // vsync駆動 (rAF) で毎フレーム描画。アニメ抑制はしない
    const hoverRainbow = !!hover && tool === "pen" && inkSet.has("rainbow");
    // 簡易Lv2以上では虹を固定色にするためアニメ用の再描画は不要
    const needAnim = dl < 2 && (rainbowCount > 0 || hoverRainbow);
    // シールド印・チョークの期限切れを消すため、ある間は再描画する (転送主体で安い)。
    // それだけなら500msに間引く
    const needShield = showShield && shieldCache.length > 0;
    const needChalk = chalkCache.length > 0;
    const needEphemeral = needShield || needChalk;
    // チョーク期限切れの掃除 (1秒に1回まで。chalkKeysだけ見る。全走査しない)
    if (now - lastChalkSweepT > 1000) {
      lastChalkSweepT = now;
      let dropped = 0;
      if (chalkKeys.size > 0) {
        for (const key of [...chalkKeys]) {
          const val = pixels.get(key);
          const e = val ? (val.e || 0) : 0;
          if (!val || e <= 0 || (val.eAt || 0) + e * 1000 <= now) {
            if (val) {
              trackPixelWrite(val, null);
              pixels.delete(key);
              // tileCells も追従 (描画のタイル単位走査の土台。死に参照を残さない)
              tileTouch(`${Math.floor(val.x / TILE)},${Math.floor(val.y / TILE)}`, val, false);
              dropped++;
            }
            chalkKeys.delete(key);
          }
        }
      }
      if (dropped > 0) {
        staticDirty = true;
        renderDirty = true;
      }
    }
    if (!renderDirty && !needAnim && !needEphemeral) {
      updateCooldownUI();
      requestAnimationFrame(render);
      return;
    }
    if (!renderDirty && !needAnim && now - lastShieldDrawT < 500) {
      updateCooldownUI();
      requestAnimationFrame(render);
      return;
    }
    if (needEphemeral) lastShieldDrawT = now;
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
      // 最高画質: 毎フレーム全量を直接描画 (従来方式)。
      // 動的キャッシュは使わないため無効化する (古い参照の二重描画防止)
      animCache.length = 0;
      shieldCache.length = 0;
      chalkCache.length = 0;
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
  // 視野内のタイル集合だけ列挙 (tileCells 経由。全件走査しない)。
  // tileCells は全書き込み経路で追従している前提。コールバックはタイル単位なので
  // 呼び出し回数は視野タイル数程度 (都度生成クロージャの多態化は無視できる)
  function forVisibleTileSets(x0, x1, y0, y1, cb) {
    const tx0 = Math.floor(x0 / TILE), tx1 = Math.floor(x1 / TILE);
    const ty0 = Math.floor(y0 / TILE), ty1 = Math.floor(y1 / TILE);
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const set = tileCells.get(`${tx},${ty}`);
        if (!set || set.size === 0) continue;
        cb(set);
      }
    }
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
        snapCellInto(arr, dcx, dcy, d.x, d.y, dz);
      }
      if (draftBatchMap.size > 0) {
        t.save();
        t.globalAlpha = isDark ? 0.38 : 0.22;
        for (const [color, arr] of draftBatchMap) {
          t.fillStyle = color;
          t.beginPath();
          for (let i = 0; i < arr.length; i += 4) t.rect(arr[i], arr[i + 1], arr[i + 2], arr[i + 3]);
          t.fill();
        }
        t.restore();
      }
    }

    // ピクセル (座標は格納時に解決済みで毎フレームparseしない)
    // t は単体 ("glow") または重ねがけ ("ghost+glow")。効果は合成して描く
    if (useLegacy) {
      // 最高画質: 従来の1マスずつ描画 (発光の影つき・虹アニメ常時)。重いが忠実
      forVisibleTileSets(x0, x1, y0, y1, (set) => {
      for (const val of set) {
        const x = val.x, y = val.y;
        if (x == null || y == null) continue;
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        if (val.by && blocked.has(val.by)) continue; // 非表示ID
        const q = snapCell(cam.x, cam.y, x, y, cam.zoom);
        const sx = q[0], sy = q[1], sw = q[2], sh = q[3];
        const s = cam.zoom;
        const vt = String(val.t || "normal");
        if (vt === "normal") {
          t.fillStyle = val.c;
          t.fillRect(sx, sy, sw, sh);
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
        // チョーク減衰 (残り60秒でフェード)
        t.globalAlpha = t.globalAlpha * chalkFade(val, Date.now());
        if (hasGlow && glowMode !== "off") {
          // 発光 (強さは設定・全テーマ統一)
          t.shadowColor = base;
          t.shadowBlur = glowBlur(s);
        }
        t.fillStyle = base;
        t.fillRect(sx, sy, sw, sh);
        if (hasGlow && isDark && glowMode !== "off") t.fillRect(sx, sy, sw, sh);
        if (parts.has("shield") && showShield && shieldActive(val)) {
          paintShieldOverlay(t, sx, sy, sw, sh, cam.zoom);
        }
        t.restore();
      }
      });
    } else {
      // 色バッチ高速描画。動く虹・チョークは動的パスに回し、ここでは焼き付けない
      pixelBatchMap.clear();
      specialDrawList.length = 0;
      animCache.length = 0;
      shieldCache.length = 0;
      chalkCache.length = 0;
      const hasBlocked = blocked.size > 0;
      const zx = cam.zoom, cx = cam.x, cy = cam.y;
      forVisibleTileSets(x0, x1, y0, y1, (set) => {
      for (const val of set) {
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
          snapCellInto(arr, cx, cy, x, y, zx);
        } else if (dl < 2 && vt.includes("rainbow")) {
          animCache.push(val);
        } else {
          specialDrawList.push(val);
        }
        if ((val.s || 0) > 0) shieldCache.push(val);
        if ((val.e || 0) > 0) chalkCache.push(val);
      }
      });
      if (pixelBatchMap.size > 0) {
        for (const [color, arr] of pixelBatchMap) {
          t.fillStyle = color;
          t.beginPath();
          for (let i = 0; i < arr.length; i += 4) t.rect(arr[i], arr[i + 1], arr[i + 2], arr[i + 3]);
          t.fill();
        }
      }
      if (specialDrawList.length > 0) {
        // 発光の shadowBlur は激重のため、発光が多い・縮小表示・特殊が多い時は簡易描画
        const glowFx = dl === 0 && glowCount <= 250 && zx >= 4 && specialDrawList.length < 800;
        for (let si = 0; si < specialDrawList.length; si++) {
          const val = specialDrawList[si];
          paintSpecialTo(t, val, cx, cy, zx, time, dl < 2, glowFx);
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
        paintSpecialTo(ctx, val, cx, cy, zx, time, true, glowFx);
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }

    // シールドの青オーバーレイ (期限切れは自然に消える。焼き付けず毎フレーム判定)
    if (showShield && shieldCache.length > 0) {
      const zx = cam.zoom, cx = cam.x, cy = cam.y;
      for (let qi = 0; qi < shieldCache.length; qi++) {
        const val = shieldCache[qi];
        if (!shieldActive(val)) continue;
        const q = snapCell(cx, cy, val.x, val.y, zx);
        paintShieldOverlay(ctx, q[0], q[1], q[2], q[3], zx);
      }
    }

    // チョーク (減衰つきで上描き。減衰前は焼き付けと同一のため省略。
    // 虹持ちはアニメ側で描画済みのため重ねない)
    if (chalkCache.length > 0) {
      const zx = cam.zoom, cx = cam.x, cy = cam.y;
      const nowMs = Date.now();
      const glowFx = dl === 0 && glowCount <= 250 && zx >= 4 && chalkCache.length < 800;
      for (let ci = 0; ci < chalkCache.length; ci++) {
        const val = chalkCache[ci];
        if (chalkFade(val, nowMs) >= 1) continue;
        if (dl < 2 && String(val.t || "").includes("rainbow")) continue;
        paintSpecialTo(ctx, val, cx, cy, zx, time, dl < 2, glowFx);
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }

    // 他ユーザーのカーソル (枠だけ + 名前、非表示IDは除外。無操作で消さない)
    if (showCursors) {
      const x0 = Math.floor(-cam.x / cam.zoom) - 1;
      const x1 = Math.ceil((vw - cam.x) / cam.zoom) + 1;
      const y0 = Math.floor(-cam.y / cam.zoom) - 1;
      const y1 = Math.ceil((vh - cam.y) / cam.zoom) + 1;
      for (const cur of remotes.values()) {
        if (cur.uid === myUid) continue;
        if (cur.uid && blocked.has(cur.uid)) continue;
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
