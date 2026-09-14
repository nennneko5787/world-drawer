// wd-drafts.js — 設計図エンジン (点・矩形・直線・円・バケツ・undo・全消し・プレビュー)。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
"use strict";
  // ---------- 設計図エンジン (形状・バケツ・undo・全消し) ----------
  const DRAFT_UNDO_MAX = 50;
  const DRAFT_SHAPE_CELLS_CAP = 40000; // 1操作の走査上限 (応答性のため)
  const DRAFT_BUCKET_VISIT_CAP = 30000;
  const DRAFT_BUCKET_RADIUS = 500;
  const draftUndoStack = []; // [{changes: [[key, prev|null]]}]
  let draftPreview = null; // {tool, x0, y0, x1, y1} (rect/line/circle のドラッグ中)
  let draftStroke = null; // {changes, seen} (dot のドラッグ中)
  let draftDrawing = false;
  // 描画用キャッシュ ([{x,y,c}]。毎フレームの key parse を避ける)。
  // 単発更新は draftListSet で追従、置換系 (バケツ・undo・全消し・初期読込) は再構築
  let draftList = [];
  const draftListIdx = new Map(); // key -> draftList の添字
  function draftListSet(x, y, colorOrNull) {
    const key = `${x},${y}`;
    const i = draftListIdx.get(key);
    if (colorOrNull === null) {
      if (i === undefined) return;
      const last = draftList.length - 1;
      if (i !== last) {
        const movedItem = draftList[last];
        draftList[i] = movedItem;
        draftListIdx.set(`${movedItem.x},${movedItem.y}`, i);
      }
      draftList.pop();
      draftListIdx.delete(key);
      return;
    }
    if (i !== undefined) draftList[i].c = colorOrNull;
    else {
      draftListIdx.set(key, draftList.length);
      draftList.push({ x, y, c: colorOrNull });
    }
  }
  function rebuildDraftList() {
    draftList = [];
    draftListIdx.clear();
    for (const [key, color] of drafts) {
      const sep = key.indexOf(",");
      draftListSet(+key.slice(0, sep), +key.slice(sep + 1), color);
    }
  }
  function pushDraftUndo(changes) {
    if (!changes || changes.length === 0) return;
    draftUndoStack.push({ changes });
    while (draftUndoStack.length > DRAFT_UNDO_MAX) draftUndoStack.shift();
    refreshDraftUI();
  }
  // 1マスを現在の筆・消しゴム・色で changes/seen に記録しつつ適用。
  // 戻り値 false は上限で捨てた (呼び出し側でトースト)
  function paintDraftCellInto(x, y, changes, seen) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
    if (Math.abs(x) > coordLimit || Math.abs(y) > coordLimit) return true;
    const key = `${x},${y}`;
    if (seen.has(key)) return true;
    const cur = drafts.has(key) ? drafts.get(key) : null;
    const want = tool === "eraser" ? null : paintColor;
    if (cur === want) {
      seen.add(key);
      return true;
    }
    if (want !== null && !drafts.has(key) && drafts.size >= maxDrafts) return false;
    changes.push([key, cur]);
    seen.add(key);
    if (want === null) drafts.delete(key);
    else drafts.set(key, want);
    draftListSet(x, y, want);
    return true;
  }
  function draftRectCells(x0, y0, x1, y1) {
    const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
    const ya = Math.min(y0, y1), yb = Math.max(y0, y1);
    if ((xb - xa + 1) * (yb - ya + 1) > DRAFT_SHAPE_CELLS_CAP) return null;
    const out = [];
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) out.push([x, y]);
    }
    return out;
  }
  function draftLineCells(x0, y0, x1, y1) {
    // Bresenham (両端含む)
    const out = [];
    let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let x = x0, y = y0, err = dx + dy, guard = 0;
    while (true) {
      out.push([x, y]);
      if (x === x1 && y === y1) break;
      if (++guard > DRAFT_SHAPE_CELLS_CAP) return null;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
    return out;
  }
  function draftCircleCells(x0, y0, x1, y1) {
    // 外接矩形に内接する塗りつぶし楕円
    const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
    const ya = Math.min(y0, y1), yb = Math.max(y0, y1);
    if ((xb - xa + 1) * (yb - ya + 1) > DRAFT_SHAPE_CELLS_CAP) return null;
    const cx = (xa + xb) / 2, cy = (ya + yb) / 2;
    const rx = (xb - xa) / 2 + 0.5, ry = (yb - ya) / 2 + 0.5;
    const out = [];
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const nx = (x - cx) / rx, ny = (y - cy) / ry;
        if (nx * nx + ny * ny <= 1) out.push([x, y]);
      }
    }
    return out;
  }
  function draftShapeCells(toolName, x0, y0, x1, y1) {
    if (toolName === "rect") return draftRectCells(x0, y0, x1, y1);
    if (toolName === "line") return draftLineCells(x0, y0, x1, y1);
    if (toolName === "circle") return draftCircleCells(x0, y0, x1, y1);
    return [[x1, y1]];
  }
  function applyDraftCellList(cells) {
    // cells: [[x,y],...] を現在の筆・色で適用し undo に積む。null は上限超過
    if (!cells) {
      toast(t("draftLimit", { max: maxDrafts }));
      return false;
    }
    const changes = [];
    const seen = new Set();
    let dropped = 0;
    for (const [x, y] of cells) {
      if (!paintDraftCellInto(x, y, changes, seen)) dropped++;
    }
    if (changes.length > 0) {
      pushDraftUndo(changes);
      saveDrafts();
    }
    if (dropped > 0) toast(t("draftLimit", { max: maxDrafts }));
    refreshDraftUI();
    return true;
  }
  function draftBucketFill(sx, sy) {
    if (Math.abs(sx) > coordLimit || Math.abs(sy) > coordLimit) return;
    const startKey = `${sx},${sy}`;
    const startVal = drafts.has(startKey) ? drafts.get(startKey) : null;
    const want = tool === "eraser" ? null : paintColor;
    if (startVal === want) return;
    if (want !== null && startVal === null && drafts.size >= maxDrafts) {
      toast(t("draftLimit", { max: maxDrafts }));
      return;
    }
    const changes = [];
    const seen = new Set([startKey]);
    const queue = [[sx, sy]];
    let head = 0;
    let truncated = false;
    while (head < queue.length) {
      if (head >= DRAFT_BUCKET_VISIT_CAP) {
        truncated = true;
        break;
      }
      const [x, y] = queue[head++];
      if (Math.abs(x - sx) > DRAFT_BUCKET_RADIUS || Math.abs(y - sy) > DRAFT_BUCKET_RADIUS) continue;
      if (Math.abs(x) > coordLimit || Math.abs(y) > coordLimit) continue;
      const key = `${x},${y}`;
      const cur = drafts.has(key) ? drafts.get(key) : null;
      if (cur !== startVal) continue;
      if (want !== null && !drafts.has(key) && drafts.size >= maxDrafts) {
        truncated = true;
        continue;
      }
      changes.push([key, cur]);
      if (want === null) drafts.delete(key);
      else drafts.set(key, want);
      const nexts = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
      for (const [nx, ny] of nexts) {
        const nk = `${nx},${ny}`;
        if (seen.has(nk)) continue;
        if (Math.abs(nx - sx) > DRAFT_BUCKET_RADIUS || Math.abs(ny - sy) > DRAFT_BUCKET_RADIUS) continue;
        seen.add(nk);
        queue.push([nx, ny]);
      }
    }
    if (changes.length > 0) {
      pushDraftUndo(changes);
      rebuildDraftList();
      saveDrafts();
    }
    if (truncated) toast(t("draftLimit", { max: maxDrafts }));
    refreshDraftUI();
  }
  function draftEraseOne(x, y) {
    // 右クリック消去用の単発消し (現在の draftTool によらず1マス)。undo可
    const changes = [];
    const seen = new Set();
    const savedTool = tool;
    tool = "eraser";
    let ok = true;
    try {
      ok = paintDraftCellInto(x, y, changes, seen);
    } finally {
      tool = savedTool;
    }
    if (!ok) toast(t("draftLimit", { max: maxDrafts }));
    if (changes.length > 0) {
      pushDraftUndo(changes);
      saveDrafts();
    }
    refreshDraftUI();
  }
  function undoDraft() {
    const op = draftUndoStack.pop();
    if (!op) {
      toast(t("draftUndoNone"));
      return;
    }
    for (const [key, prev] of op.changes) {
      if (prev == null) drafts.delete(key);
      else drafts.set(key, prev);
    }
    rebuildDraftList();
    saveDrafts();
    refreshDraftUI();
  }
  function clearDrafts() {
    if (drafts.size === 0) {
      toast(t("draftUndoNone"));
      return;
    }
    pushDraftUndo([...drafts.entries()].map(([k, v]) => [k, v]));
    drafts.clear();
    rebuildDraftList();
    draftPreview = null;
    draftStroke = null;
    draftDrawing = false;
    saveDrafts();
    refreshDraftUI();
    toast(t("draftCleared"));
  }
  function refreshDraftUI() {
    if (draftBar) draftBar.classList.toggle("hidden", !draftMode);
    document.querySelectorAll("[data-drafttool]").forEach((el) => {
      el.classList.toggle("active", el.dataset.drafttool === draftTool);
    });
    if (draftUndoBtn) draftUndoBtn.disabled = draftUndoStack.length === 0;
    if (draftClearBtn) draftClearBtn.disabled = drafts.size === 0;
  }
  rebuildDraftList(); // 端末保存からの初期読込分を反映