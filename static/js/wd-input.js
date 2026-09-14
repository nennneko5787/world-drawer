// wd-input.js — ポインタ・ホイール入力 (描画 vs パン・ピンチ)。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
"use strict";
  // ---------- input (left: paint on click + pan, right/middle: pan only) ----------
  let panning = false, moved = 0, lastPX = 0, lastPY = 0, downPos = null, downButton = 0;
  // タップ確定は押下位置 (down) を使う。離す位置 (up) だと指のぶれ分ずれるため。
  let downCell = null;
  // タッチのホールド中 (移動なし) のプレビューセル。指で隠れても分かるよう強調表示する。
  // 移動してパンになったら null にして配置キャンセル。
  let touchHold = null;
  // 指タップはぶれやすいのでタップ判定の遊びを大きめに (マウスは精密なまま)
  let tapSlop = 6;
  const pointers = new Map();
  let pinchDist = 0;
  let lastPinchMid = null;
  // 設計図ドラッグ描画用 (dot の連続・rect/line/circle のプレビュー)。
  // 左ボタン・タッチ単指が描画、右・中ボタンはパン。タッチの移動は2本指パン
  let lastStrokeCell = null;
  let draftStrokeDropped = false;

  // 右クリックメニューを出さない (右ドラッグ移動のため)
  // Firefoxでは右ドラッグ後にcanvas外でcontextmenuが出る事があるためdocument全体で抑止する。
  // 入力欄 (名前・パスワード等) のメニューは残す
  let suppressContextUntil = 0;
  const isEditableTarget = (t) => !!(t && t.closest && t.closest("input, textarea, select, [contenteditable='true']"));
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("contextmenu", (e) => {
    if (isEditableTarget(e.target)) return;
    e.preventDefault();
  }, true);
  document.addEventListener("contextmenu", (e) => {
    if (!isEditableTarget(e.target) && Date.now() < suppressContextUntil) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  canvas.addEventListener("auxclick", (e) => {
    if (e.button === 1 || e.button === 2) e.preventDefault();
  });
  canvas.addEventListener("mousedown", (e) => {
    if (e.button === 1) e.preventDefault(); // 中クリックの自動スクロール抑止 (Firefox対策)
  });
  canvas.addEventListener("mouseup", (e) => {
    if (e.button === 2) e.preventDefault();
  });
  // 長押しでの選択・ドラッグ・コールアウト抑止 (iOS Safari 対策)
  canvas.addEventListener("selectstart", (e) => e.preventDefault());
  canvas.addEventListener("dragstart", (e) => e.preventDefault());

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button === 1) e.preventDefault(); // 中クリックの自動スクロール抑止
    // タッチの長押し選択・ダブルタップ拡大の抑止
    if (e.pointerType === "touch") {
      try {
        e.preventDefault();
      } catch {}
    }
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {}
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      lastPinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // 2本指に移ったら形状プレビュー・ストロークは確定/破棄してパン・ズームへ
      if (draftStroke && draftStroke.changes.length > 0) {
        pushDraftUndo(draftStroke.changes);
        saveDrafts();
        if (draftStrokeDropped) toast(t("draftLimit", { max: maxDrafts }));
      }
      draftStroke = null;
      draftPreview = null;
      draftDrawing = false;
      lastStrokeCell = null;
      panning = false;
      downCell = null;
      touchHold = null;
      return;
    }
    panning = true;
    moved = 0;
    tapSlop = e.pointerType === "touch" ? 18 : 6;
    downButton = e.button;
    lastPX = e.clientX;
    lastPY = e.clientY;
    downPos = { x: e.clientX, y: e.clientY };
    // タップのみ（移動なし）でも位置を他者に伝える。送信抑制は sendCursor 側で行う
    downCell = screenToCell(e.clientX, e.clientY);
    // タッチは move が来ないタップもあるため、押下時点でプレビュー・座標を更新
    hover = downCell;
    markDirty();
    if (e.pointerType === "touch") touchHold = downCell;
    coordsEl.textContent = formatCoords(downCell);
    sendCursor(downCell.x, downCell.y);
    // 設計図のドラッグ描画開始 (履歴・スポイト中は除く。バケツはタップのみ)
    // 左ボタン・タッチ単指が描画、右・中はパン
    draftDrawing = false;
    if (
      draftMode && !historyMode && !eyedropMode &&
      draftTool !== "bucket" &&
      (e.pointerType === "touch" || e.button === 0)
    ) {
      draftDrawing = true;
      lastStrokeCell = downCell;
      draftStrokeDropped = false;
      if (draftTool === "dot") {
        draftStroke = { changes: [], seen: new Set() };
        if (!paintDraftCellInto(downCell.x, downCell.y, draftStroke.changes, draftStroke.seen)) {
          draftStrokeDropped = true;
        }
        saveDrafts();
        refreshDraftUI();
      } else {
        draftPreview = { tool: draftTool, x0: downCell.x, y0: downCell.y, x1: downCell.x, y1: downCell.y };
      }
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // 2本指パン (設計図ドラッグ中の移動手段)
      if (lastPinchMid) {
        cam.x += mid.x - lastPinchMid.x;
        cam.y += mid.y - lastPinchMid.y;
        markStatic();
      }
      lastPinchMid = mid;
      if (pinchDist > 0) {
        zoomAt(mid.x, mid.y, dist / pinchDist);
      }
      pinchDist = dist;
      touchHold = null;
      return;
    }
    // 設計図ドラッグ描画中 (左・タッチ)。右・中ボタンは下のパンへ
    if (draftDrawing && draftMode && (e.pointerType === "touch" || downButton === 0)) {
      const dx = e.clientX - lastPX, dy = e.clientY - lastPY;
      moved += Math.abs(dx) + Math.abs(dy);
      lastPX = e.clientX;
      lastPY = e.clientY;
      touchHold = null;
      const cell = screenToCell(e.clientX, e.clientY);
      if (!hover || hover.x !== cell.x || hover.y !== cell.y) {
        hover = cell;
        markDirty();
      }
      coordsEl.textContent = formatCoords(cell);
      sendCursor(cell.x, cell.y);
      if (draftTool === "dot" && draftStroke) {
        // 高速移動でも途切れないよう前回セルから線形補間
        const from = lastStrokeCell || cell;
        const seg = draftLineCells(from.x, from.y, cell.x, cell.y) || [[cell.x, cell.y]];
        for (const [px, py] of seg) {
          if (!paintDraftCellInto(px, py, draftStroke.changes, draftStroke.seen)) {
            draftStrokeDropped = true;
          }
        }
        lastStrokeCell = cell;
        saveDrafts();
        refreshDraftUI();
      } else if (draftPreview) {
        if (draftPreview.x1 !== cell.x || draftPreview.y1 !== cell.y) {
          draftPreview.x1 = cell.x;
          draftPreview.y1 = cell.y;
          markDirty();
        }
      }
      return;
    }
    if (panning) {
      const dx = e.clientX - lastPX, dy = e.clientY - lastPY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > tapSlop) {
        cam.x += dx;
        cam.y += dy;
        markStatic();
        // 移動したのでホールド解除。離しても配置しない (パンとして扱う)
        touchHold = null;
        // 右ドラッグ中はFirefoxのcontextmenuが出ないよう抑止期間を延長
        if (downButton === 2) suppressContextUntil = Date.now() + 800;
      }
      lastPX = e.clientX;
      lastPY = e.clientY;
    }
    if (e.pointerType === "touch" && touchHold) {
      // ホールド中は押下セルに固定 (指のぶれでプレビューが暴れない)
      hover = touchHold;
      coordsEl.textContent = formatCoords(touchHold);
      sendCursor(touchHold.x, touchHold.y);
      return;
    }
    const cell = screenToCell(e.clientX, e.clientY);
    if (!hover || hover.x !== cell.x || hover.y !== cell.y) {
      hover = cell;
      markDirty();
    }
    coordsEl.textContent = formatCoords(cell);
    sendCursor(cell.x, cell.y);
  });
  canvas.addEventListener("pointerup", (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) {
      pinchDist = 0;
      lastPinchMid = null;
    }
    // 右ボタンで移動していたら離した後のcontextmenu (Firefox) を捨てる
    if (e.button === 2 && moved > tapSlop) suppressContextUntil = Date.now() + 1000;
    // 設計図ドラッグ描画の確定 (全指が離れたら)
    if (draftDrawing && pointers.size === 0) {
      if (draftStroke) {
        if (draftStroke.changes.length > 0) {
          pushDraftUndo(draftStroke.changes);
          saveDrafts();
        }
        if (draftStrokeDropped) toast(t("draftLimit", { max: maxDrafts }));
        draftStroke = null;
      }
      if (draftPreview) {
        const pv = draftPreview;
        draftPreview = null;
        const cells = draftShapeCells(pv.tool, pv.x0, pv.y0, pv.x1, pv.y1);
        applyDraftCellList(cells);
      }
      draftDrawing = false;
      lastStrokeCell = null;
      draftStrokeDropped = false;
      refreshDraftUI();
    }
    if (panning && pointers.size === 0) {
      const rightTap = downButton === 2 && rightErase;
      const middleTap = downButton === 1 && middleEyedrop;
      if (moved <= tapSlop && downPos && downCell && (downButton === 0 || rightTap || middleTap)) {
        // 押下位置で確定 (指のぶれ・離す位置のずれを無視)
        const cell = downCell;
        hover = cell;
        coordsEl.textContent = formatCoords(cell);
        if (rightTap) {
          // 右消去は履歴・スポイトより優先 (ドラッグは移動のまま)
          if (draftMode) draftEraseOne(cell.x, cell.y);
          else place(cell.x, cell.y, "eraser");
        } else if (middleTap) {
          // 中スポイト (設計図と併用可。履歴モード中は履歴を優先)
          if (historyMode) showHistory(cell.x, cell.y);
          else pickColor(cell.x, cell.y);
        } else if (historyMode) showHistory(cell.x, cell.y);
        else if (eyedropMode) pickColor(cell.x, cell.y);
        else if (draftMode && draftTool === "bucket") draftBucketFill(cell.x, cell.y);
        else if (draftMode && draftTool !== "bucket") { /* 描画済み */ }
        else place(cell.x, cell.y);
      }
      panning = false;
    }
    downCell = null;
    touchHold = null;
    // タッチは指を離したらプレビューを消す (残像防止)
    if (e.pointerType === "touch" && hover !== null) {
      hover = null;
      markDirty();
    }
    if (pointers.size === 0) {
      scheduleViewportFetch(); // パン・ピンチ確定後に視野を再取得
      scheduleSaveCamera();
    }
  });
  canvas.addEventListener("pointercancel", (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) {
      pinchDist = 0;
      lastPinchMid = null;
    }
    // キャンセル時はプレビュー破棄・ストロークは適用分だけ確定
    if (draftStroke && pointers.size === 0) {
      if (draftStroke.changes.length > 0) {
        pushDraftUndo(draftStroke.changes);
        saveDrafts();
      }
      if (draftStrokeDropped) toast(t("draftLimit", { max: maxDrafts }));
    }
    if (pointers.size === 0) {
      if (draftPreview !== null) markDirty();
      draftStroke = null;
      draftPreview = null;
      draftDrawing = false;
      lastStrokeCell = null;
      draftStrokeDropped = false;
    }
    panning = false;
    downCell = null;
    touchHold = null;
    if (e.pointerType === "touch") hover = null;
  });
  canvas.addEventListener("pointerleave", () => {
    if (hover !== null) {
      hover = null;
      markDirty();
    }
  });

  function zoomAt(cx, cy, factor) {
    const old = cam.zoom;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, old * factor));
    if (next === old) return;
    cam.x = cx - ((cx - cam.x) / old) * next;
    cam.y = cy - ((cy - cam.y) / old) * next;
    cam.zoom = next;
    markStatic();
  }
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    scheduleViewportFetch();
    scheduleSaveCamera();
  }, { passive: false });
