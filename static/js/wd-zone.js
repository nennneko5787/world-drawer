// wd-zone.js — 配置可能ゾーンの算出・描画データ。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
"use strict";
  // ---------- 配置可能ゾーン (Lv制限中の目安表示。禁止ではなく既知の許可域の強調) ----------
  const zoneIndex = new Map(); // "1024pxブロック" -> [x0,y0,x1,y1,...]
  let zoneDirty = true;
  let zoneBuiltAt = 0;
  // {x1,y1,x2,y2}: セル境界座標での線分 (チェビシェフ距離の正方形の周囲)。世界座標
  let zoneSegments = [];
  function applyZoneData(d) {
    if (!d) return;
    if (d.trustedLevel) trustedLevel = d.trustedLevel;
    if (d.placeRadius) placeRadius = d.placeRadius;
  }
  function rebuildZoneIndex() {
    zoneIndex.clear();
    const S = 1024;
    for (const val of pixels.values()) {
      const x = val.x, y = val.y;
      const bk = `${Math.floor(x / S)},${Math.floor(y / S)}`;
      let arr = zoneIndex.get(bk);
      if (!arr) {
        arr = [];
        zoneIndex.set(bk, arr);
      }
      arr.push(x, y);
    }
    zoneBuiltAt = Date.now();
    zoneDirty = false;
  }
  function zoneAllowed(x, y, shrink) {
    const R = placeRadius - shrink;
    if (R < 0) return true;
    const S = 1024;
    if (R > S * 2) return true;
    const spread = Math.ceil(R / S);
    const bx = Math.floor(x / S), by = Math.floor(y / S);
    let checked = 0;
    for (let ix = bx - spread; ix <= bx + spread; ix++) {
      for (let iy = by - spread; iy <= by + spread; iy++) {
        const arr = zoneIndex.get(`${ix},${iy}`);
        if (!arr) continue;
        for (let i = 0; i < arr.length; i += 2) {
          if (Math.max(Math.abs(arr[i] - x), Math.abs(arr[i + 1] - y)) <= R) return true;
          if (++checked >= 400) return true;
        }
      }
    }
    for (const cur of remotes.values()) {
      if (cur.x == null || cur.y == null) continue;
      if (Math.max(Math.abs(cur.x - x), Math.abs(cur.y - y)) <= R) return true;
    }
    return false;
  }
  function mergeSortedPairs(pairs) {
    // [[a,b],...] (含む端) をソート済みとして重なり・隣接を統合し [a0,b0,a1,b1,...] で返す
    if (pairs.length === 0) return [];
    pairs.sort((p, q) => p[0] - q[0]);
    const out = [];
    let ca = pairs[0][0], cb = pairs[0][1];
    for (let i = 1; i < pairs.length; i++) {
      if (pairs[i][0] <= cb + 1) cb = Math.max(cb, pairs[i][1]);
      else {
        out.push(ca, cb);
        ca = pairs[i][0];
        cb = pairs[i][1];
      }
    }
    out.push(ca, cb);
    return out;
  }
  function subtractIntervals(aFlat, bFlat) {
    // A - B (どちらも統合済み [a0,b0,...] 含む端)。結果も統合済み
    const out = [];
    let j = 0;
    for (let i = 0; i < aFlat.length; i += 2) {
      const s = aFlat[i], e = aFlat[i + 1];
      while (j < bFlat.length && bFlat[j + 1] < s) j += 2;
      let cur = s;
      let k = j;
      while (k < bFlat.length && bFlat[k] <= e) {
        if (bFlat[k] > cur) out.push(cur, bFlat[k] - 1);
        cur = Math.max(cur, bFlat[k + 1] + 1);
        if (cur > e) break;
        k += 2;
      }
      if (cur <= e) out.push(cur, e);
    }
    return out;
  }
  function rebuildZoneSegments(vx0, vx1, vy0, vy1) {
    // 可視行ごとに許可区間 [a..b] をマージし、正方形 (チェビシェフ距離) の周囲を
    // 縦線 + 横線の両方で描く。サーバーの内外判定（含む端）と一致する
    const segs = [];
    const R = placeRadius;
    const S = 1024;
    const cand = [];
    const bx0 = Math.floor((vx0 - R) / S), bx1 = Math.floor((vx1 + R) / S);
    const by0 = Math.floor((vy0 - R) / S), by1 = Math.floor((vy1 + R) / S);
    let capped = false;
    for (let ix = bx0; ix <= bx1 && !capped; ix++) {
      for (let iy = by0; iy <= by1 && !capped; iy++) {
        const arr = zoneIndex.get(`${ix},${iy}`);
        if (!arr) continue;
        for (let i = 0; i < arr.length && !capped; i += 2) {
          cand.push(arr[i], arr[i + 1]);
          if (cand.length >= 8000) capped = true;
        }
      }
    }
    for (const cur of remotes.values()) {
      if (cur.x == null || cur.y == null) continue;
      cand.push(cur.x, cur.y);
    }
    const rows = vy1 - vy0;
    const step = rows > 300 ? Math.ceil(rows / 300) : 1;
    // 指定行の許可区間 (統合済み)。範囲が画面より大きいと可視端での開閉が
    // 画面端に張り付く偽線になるため、上下1段外側も評価して真の開閉だけを描く
    const intervalsAt = (y) => {
      const pairs = [];
      for (let i = 0; i < cand.length; i += 2) {
        if (Math.abs(cand[i + 1] - y) > R) continue;
        const a = cand[i] - R, b = cand[i] + R;
        if (b < vx0 - 1 || a > vx1 + 1) continue;
        pairs.push([a, b]);
      }
      return mergeSortedPairs(pairs);
    };
    // サンプリング行ごとの統合区間 (空行も保持して横線の開閉を検出する)
    const rowList = [];
    for (let y = vy0; y <= vy1; y += step) {
      rowList.push({ y, iv: intervalsAt(y) });
    }
    let prev = intervalsAt(vy0 - step);
    for (const row of rowList) {
      const cur = row.iv;
      // 縦線: 各区間の左右 (step分つなげて途切れさせない)
      for (let i = 0; i < cur.length; i += 2) {
        segs.push({ x1: cur[i], y1: row.y, x2: cur[i], y2: row.y + step });
        segs.push({ x1: cur[i + 1] + 1, y1: row.y, x2: cur[i + 1] + 1, y2: row.y + step });
      }
      // 横線: 前行との差分 (現れた所・消えた所) を行境界 Y に引く
      const added = subtractIntervals(cur, prev);
      const removed = subtractIntervals(prev, cur);
      for (let i = 0; i < added.length; i += 2) {
        segs.push({ x1: added[i], y1: row.y, x2: added[i + 1] + 1, y2: row.y });
      }
      for (let i = 0; i < removed.length; i += 2) {
        segs.push({ x1: removed[i], y1: row.y, x2: removed[i + 1] + 1, y2: row.y });
      }
      prev = cur;
    }
    // 一番下の閉じ線 (画面下に続く部分は引かない)
    if (prev.length > 0 && rowList.length > 0) {
      const bottomY = rowList[rowList.length - 1].y + step;
      const tail = subtractIntervals(prev, intervalsAt(bottomY));
      for (let i = 0; i < tail.length; i += 2) {
        segs.push({ x1: tail[i], y1: bottomY, x2: tail[i + 1] + 1, y2: bottomY });
      }
    }
    zoneSegments = segs;
    zoneDirty = false;
    zoneBuiltAt = Date.now();
  }
