// wd-net.js — サーバー同期 (セッション・視野取得・socket・配置・取り消し)。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
"use strict";
  async function ensureToken() {
    if (token) return;
    const ts = await getTurnstileToken();
    const res = await fetch(`${apiBase()}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnstile_token: ts, lang: window.wdI18n.lang }),
    });
    const data = await res.json();
    if (!data.ok || !data.token) throw new Error("session failed");
    token = data.token;
    localStorage.setItem("wd_token", token);
    applyLevelData(data);
    if (data.uid) {
      myUid = data.uid;
      myUidEl.textContent = `#${myUid}`;
    }
    if (data.profile) {
      myName = data.profile.name || myName;
      profileName.value = myName;
      setProfileColor(data.profile.color || myColor);
    }
    if (data.inventory) inventory = { ...inventory, ...data.inventory };
    myCountry = data.country ?? null;
    myShowCountry = data.showCountry ?? true;
    countryChk.checked = myShowCountry;
  }
  // ---------- viewport fetching (視野+余白だけ取得) ----------
  function visibleBbox() {
    const clamp = (v) => Math.max(-coordLimit, Math.min(coordLimit, v));
    return {
      minX: clamp(Math.floor(-cam.x / cam.zoom) - fetchMargin),
      minY: clamp(Math.floor(-cam.y / cam.zoom) - fetchMargin),
      maxX: clamp(Math.ceil((viewW() - cam.x) / cam.zoom) + fetchMargin),
      maxY: clamp(Math.ceil((viewH() - cam.y) / cam.zoom) + fetchMargin),
    };
  }

  let fetchSeq = 0;
  async function fetchViewport() {
    const seq = ++fetchSeq;
    const box = visibleBbox();
    try {
      const url = `${apiBase()}/api/canvas?minX=${box.minX}&minY=${box.minY}&maxX=${box.maxX}&maxY=${box.maxY}`;
      const canvasData = await (await fetch(url)).json();
      if (seq !== fetchSeq) return; // 古い応答は破棄
      if (canvasData.background && canvasData.background !== background) {
        background = canvasData.background;
        markStatic();
      }
      if (canvasData.cooldown) cooldown = canvasData.cooldown;
      applyZoneData(canvasData);
      const fresh = canvasData.pixels || {};
      if (!canvasData.truncated) {
        // 取得範囲内にサーバー側で存在しないキャッシュは消去 (消しゴムの取りこぼし対策)
        for (const key of [...pixels.keys()]) {
          const [x, y] = key.split(",").map(Number);
          if (x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY && !(key in fresh)) {
            trackPixelWrite(pixels.get(key), null);
            pixels.delete(key);
            markStatic();
          }
        }
      } else {
        toast(t("zoomOutToast"));
      }
      for (const [key, val] of Object.entries(fresh)) {
        const cur = pixels.get(key);
        const coats = val.coats ?? 1;
        if (!cur || cur.c !== val.c || cur.t !== val.t || (cur.coats ?? 1) !== coats || (cur.s || 0) !== (val.s || 0) || (cur.e || 0) !== (val.e || 0)) {
          const [px, py] = key.split(",").map(Number);
          // e0 は初見残り秒として引き継ぐ (置き換わり時は更新)。フェード基準用
          const same = cur && cur.c === val.c && cur.t === val.t && cur.by === (val.by || null);
          const e0 = (same && cur.e0) || val.e || 0;
          const next = { c: val.c, t: val.t, by: val.by || null, x: px, y: py, coats, s: val.s || 0, sAt: Date.now(), e: val.e || 0, eAt: Date.now(), e0 };
          trackPixelWrite(cur, next);
          pixels.set(key, next);
          markStatic();
        }
      }
      pruneFar(box);
      zoneDirty = true;
    } catch (err) {
      console.error(err);
    }
  }

  let fetchTimer = 0;
  function scheduleViewportFetch() {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(fetchViewport, 250);
  }

  function pruneFar(box) {
    if (pixels.size <= maxCache) return;
    const big = fetchMargin * 4 + 512;
    for (const key of [...pixels.keys()]) {
      const [x, y] = key.split(",").map(Number);
      if (x < box.minX - big || x > box.maxX + big || y < box.minY - big || y > box.maxY + big) {
        trackPixelWrite(pixels.get(key), null);
        pixels.delete(key);
        markStatic();
        if (pixels.size <= maxCache) break;
      }
    }
  }

  function goOrigin() {
    centerOn(0, 0);
    fetchViewport();
    scheduleSaveCamera();
  }

  async function goToArt() {
    // 近くの他プレイヤー優先、なければ全体の絵の中心へ
    const cx = (-cam.x + viewW() / 2) / cam.zoom;
    const cy = (-cam.y + viewH() / 2) / cam.zoom;
    let best = null, bestD = Infinity;
    for (const cur of remotes.values()) {
      if (cur.x == null || cur.y == null) continue;
      const d = Math.max(Math.abs(cur.x - cx), Math.abs(cur.y - cy));
      if (d < bestD) {
        bestD = d;
        best = cur;
      }
    }
    if (best) {
      centerOn(best.x, best.y);
    } else {
      try {
        const b = await (await fetch(`${apiBase()}/api/bounds`)).json();
        if (b.count > 0 && b.minX != null) centerOn((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
        else {
          toast(t("noArtToast"));
          return;
        }
      } catch {
        toast(t("moveFailedToast"));
        return;
      }
    }
    fetchViewport();
    scheduleSaveCamera();
  }

  function screenToCell(sx, sy) {
    return { x: Math.floor((sx - cam.x) / cam.zoom), y: Math.floor((sy - cam.y) / cam.zoom) };
  }
  function cellToScreen(x, y) {
    return { x: cam.x + x * cam.zoom, y: cam.y + y * cam.zoom };
  }
  // ズームが小さい (MIN_ZOOM付近) と sx+1/sy+1, zoom-2 では幅が負になるため、
  // 小ズーム時はセル全体をそのまま描く
  function strokeCellRect(sx, sy) {
    const z = cam.zoom;
    if (z >= 4) ctx.strokeRect(sx + 1, sy + 1, z - 2, z - 2);
    else ctx.strokeRect(sx, sy, Math.max(z, 0.5), Math.max(z, 0.5));
  }
  function fillCellRect(sx, sy) {
    const z = cam.zoom;
    if (z >= 4) ctx.fillRect(sx + 1, sy + 1, z - 2, z - 2);
    else ctx.fillRect(sx, sy, Math.max(z, 0.5), Math.max(z, 0.5));
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // ---------- server sync (viewport only) ----------
  async function loadInitial() {
    try {
      await ensureToken();
      await fetchViewport(); // 視野+余白だけ取得
      const me = await (await fetch(`${apiBase()}/api/me`, { headers: authHeaders() })).json();
      inventory = { ...inventory, ...me.inventory };
      cooldownUntil = me.cooldownUntil ? me.cooldownUntil * 1000 : 0;
      myCountry = me.country ?? null;
      myShowCountry = me.showCountry ?? true;
      countryChk.checked = myShowCountry;
      if (me.uid) {
        myUid = me.uid;
        myUidEl.textContent = `#${myUid}`;
      }
      applyLevelData(me);
      if (me.profile) {
        // サーバー正 (保存・統合結果) に合わせる。端末別の古い名での上書きを防ぐ
        if (me.profile.name) {
          myName = me.profile.name;
          profileName.value = myName;
          try {
            localStorage.setItem("wd_name", myName);
          } catch {}
        }
        if (me.profile.color) {
          setProfileColor(me.profile.color);
          try {
            localStorage.setItem("wd_userColor", myColor);
          } catch {}
        }
      }
      refreshInkUI();
      refreshColorUI();
      refreshUserList();
      try {
        if (sessionStorage.getItem("wd_merged")) {
          sessionStorage.removeItem("wd_merged");
          toast(t("mergedToast"));
        }
      } catch {}
      try {
        if (showZone && myLevel < trustedLevel && !sessionStorage.getItem("wd_zoneToast")) {
          sessionStorage.setItem("wd_zoneToast", "1");
          toast(t("zoneToast", { level: trustedLevel }));
        }
      } catch {}
    } catch (err) {
      console.error(err);
      toast(t("serverError"));
    }
  }

  let socket = null;
  let socketReady = false;
  let wsFailCount = 0;
  let wsGiveUp = false;
  // 素WS (Socket.IO廃止): ticket + Turnstile必須。ページ表示の度に検証。
  // 失敗時は指数バックオフで最大3回まで (無限ウィジェット防止)。それ以上は手動リロード。
  async function connectSocket() {
    if (socket || wsGiveUp) return;
    try {
      const ts = await getTurnstileToken();
      if (wsGiveUp) return;
      const ticket = await fetchWsTicket();
      const ws = new WebSocket(wsUrl());
      let helloDone = false;
      socket = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ t: "hello", ticket, turnstileToken: ts }));
      };
      ws.onmessage = (ev) => {
        let d = null;
        try { d = JSON.parse(ev.data); } catch { return; }
        if (!d || typeof d.t !== "string") return;
        if (d.t === "helloOk") {
          if (!d.ok) {
            helloDone = true;
            wsFailCount += 1;
            try { ws.close(); } catch {}
            socket = null;
            onWsFailed(d.error);
            return;
          }
          helloDone = true;
          wsFailCount = 0;
          socketReady = true;
          if (d.uid) {
            myUid = d.uid;
            myUidEl.textContent = `#${myUid}`;
          }
          fetchViewport();
          return;
        }
        if (d.t === "pixel") { onPixel(d); return; }
        if (d.t === "cursor") { applyRemote(d); return; }
        if (d.t === "join") { applyRemote(d); refreshUserList(); return; }
        if (d.t === "leave") {
          if (d.uid) remotes.delete(d.uid);
          refreshUserList();
          markDirty();
          return;
        }
      };
      ws.onclose = () => {
        socket = null;
        socketReady = false;
        if (wsGiveUp) return;
        if (!helloDone) {
          // hello前の切断も失敗扱い
          wsFailCount += 1;
          onWsFailed("");
          return;
        }
        // hello済みの切断はネットワーク瞬断扱いで1回だけ自動再接続
        if (wsFailCount < 3) {
          wsFailCount += 1;
          setTimeout(connectSocket, 3000 * wsFailCount);
        } else {
          onWsFailed("");
        }
      };
      ws.onerror = () => {
        try { ws.close(); } catch {}
      };
    } catch {
      onWsFailed("");
    }
  }
  function onWsFailed(reason) {
    if (wsFailCount >= 3) {
      wsGiveUp = true;
      socket = null;
      toast(t("turnstileFailed"), "", { label: t("reloadBtn"), fn: () => location.reload() });
      // ポーリングに切替 (閲覧だけはできる)
      setInterval(() => {
        fetchViewport();
        refreshOnlineUsers();
      }, 5000);
      return;
    }
    setTimeout(connectSocket, 3000 * Math.max(1, wsFailCount));
  }
  function onPixel(p) {
      const key = `${p.x},${p.y}`;
      const prev = pixels.get(key) || null;
      if (p.t === "normal" && String(p.c).toLowerCase() === background.toLowerCase()) {
        trackPixelWrite(prev, null);
        pixels.delete(key);
      } else {
        const next = { c: p.c, t: p.t, by: p.by || null, x: p.x, y: p.y, coats: p.coats ?? 1, s: p.s || 0, sAt: Date.now(), e: p.e || 0, eAt: Date.now(), e0: p.e || 0 };
        trackPixelWrite(prev, next);
        pixels.set(key, next);
      }
      zoneDirty = true;
      markStatic();
      if (pendingUndo && `${pendingUndo.x},${pendingUndo.y}` === key && p.by !== myUid) cancelUndo();
      if (historyMode && historyKey === key) showHistory(p.x, p.y);
  }

  // カーソルは10秒で画面から消える。その分の再描画を予約 (連打防止の単発)
  let cursorExpireTimer = 0;
  function scheduleCursorExpire() {
    if (cursorExpireTimer) return;
    cursorExpireTimer = setTimeout(() => {
      cursorExpireTimer = 0;
      markDirty();
    }, 10500);
  }

  function applyRemote(u) {
    // 相関IDは公開前提の uid (token は線に流さない)。自分は myUid で除外する
    if (!u || !u.uid || u.uid === myUid) return;
    const cur = remotes.get(u.uid) || {};
    remotes.set(u.uid, {
      uid: u.uid,
      name: u.name ?? cur.name ?? t("anon"),
      color: u.color ?? cur.color ?? "#22aa66",
      level: u.level ?? cur.level ?? 1,
      country: u.country ?? cur.country,
      x: u.x ?? cur.x,
      y: u.y ?? cur.y,
      updatedAt: Date.now(),
    });
    refreshOnlineUI();
    markDirty();
    scheduleCursorExpire();
  }

  // RESTフォールバック時は打ち切り分の総数を別途受け取る (socket時は完全一覧)
  let onlineTotal = null;
  function applyPresenceList(list, total) {
    const seen = new Set();
    (list || []).forEach((u) => {
      if (!u || !u.uid || u.uid === myUid) return; // 自分は除外
      seen.add(u.uid);
      const cur = remotes.get(u.uid) || {};
      remotes.set(u.uid, { ...cur, uid: u.uid, name: u.name, color: u.color, level: u.level ?? cur.level ?? 1, country: u.country ?? cur.country, x: u.x ?? cur.x, y: u.y ?? cur.y, updatedAt: Date.now() });
    });
    for (const uid of [...remotes.keys()]) {
      // myUid 確定前に紛れた自分自身もここで掃除する
      if (uid === myUid || !seen.has(uid)) remotes.delete(uid);
    }
    onlineTotal = typeof total === "number" && Number.isFinite(total) ? total : null;
    refreshUserList();
    markDirty();
    scheduleCursorExpire();
  }

  let lastCursorSent = 0;
  let lastCursorCell = "";
  function sendCursor(x, y, force) {
    if (!socket || !socketReady || socket.readyState !== 1) return;
    const key = `${x},${y}`;
    const nowMs = Date.now();
    if (!force) {
      if (key === lastCursorCell && nowMs - lastCursorSent < 800) return;
      if (nowMs - lastCursorSent < cursorMinMs) return;
    }
    lastCursorSent = nowMs;
    lastCursorCell = key;
    try { socket.send(JSON.stringify({ t: "cursor", x, y })); } catch {}
  }

  async function refreshOnlineUsers() {
    try {
      const data = await (await fetch(`${apiBase()}/api/users`)).json();
      applyPresenceList(data.online || [], data.count);
    } catch {}
  }

  async function place(x, y, forceTool) {
    if (Math.abs(x) > coordLimit || Math.abs(y) > coordLimit) {
      toast(t("outOfBounds"));
      return;
    }
    if (cooldownUntil > Date.now()) {
      toast(t("cooldownToast", { s: ((cooldownUntil - Date.now()) / 1000).toFixed(1) }));
      return;
    }
    const key = `${x},${y}`;
    const prevPix = pixels.get(key) || null;
    const effTool = forceTool || tool;
    const inkToUse = effTool === "eraser" ? "erase" : inkKey();
    if (inkToUse !== "normal" && inkToUse !== "erase") {
      const lacking = inkToUse.split("+").some((p) => (inventory[p] || 0) <= 0);
      if (lacking) {
        toast(t("noInkToast"));
        refreshInkUI();
        return;
      }
    }
    try {
      const res = await fetch(`${apiBase()}/api/place`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ x, y, color: paintColor, ink: inkToUse }),
      });
      const data = await res.json();
      if (!data.ok) {
        if (data.error === "cooldown") {
          cooldownUntil = data.cooldownUntil * 1000;
          applyLevelData(data);
          toast(t("cooldownToast", { s: data.remaining }));
        } else if (data.error === "noInk") {
          toast(t("noInkToast"));
          inventory = data.inventory;
          refreshInkUI();
        } else if (data.error === "tooFar") {
          toast(
            t("tooFarToast", { radius: data.radius || placeRadius }),
            "",
            { label: t("goToArtBtn"), fn: goToArt }
          );
        } else if (data.error === "ipBusy") {
          toast(t("ipBusyToast"));
        } else if (data.error === "noSocket") {
          toast(t("socketRequiredToast"));
        } else if (data.error === "cursorMismatch") {
          toast(t("cursorMismatchToast"));
        } else if (data.error === "shielded") {
          toast(t("shieldToast", { s: data.remaining ?? 0 }));
        } else {
          toast(t("placeFailedToast", { error: data.error }));
        }
        return;
      }
      const prevForUndo = prevPix ? { c: prevPix.c, t: prevPix.t, coats: prevPix.coats ?? 1 } : null;
      if (inkToUse === "erase") {
        trackPixelWrite(prevPix, null);
        pixels.delete(key);
      } else {
        const next = { c: data.pixel.c, t: data.pixel.t, by: data.by || myUid || null, x, y, coats: data.pixel.coats ?? 1, s: data.pixel.s || 0, sAt: Date.now(), e: data.pixel.e || 0, eAt: Date.now(), e0: data.pixel.e || 0 };
        trackPixelWrite(prevPix, next);
        pixels.set(key, next);
      }
      cooldownUntil = data.cooldownUntil * 1000;
      inventory = data.inventory;
      applyLevelData(data);
      refreshInkUI();
      zoneDirty = true;
      markStatic();
      armUndo(x, y, prevForUndo);
      if (data.leveledUp) toast(t("levelUpToast", { level: data.level, cooldown: data.cooldown.toFixed(1) }), "reward");
      if (data.reward) toast(t("rewardToast", { ink: inkName(data.reward.ink), amount: data.reward.amount }), "reward");
    } catch {
      toast(t("commError"));
    }
  }

  // ---------- undo (3秒以内の取り消し) ----------
  let pendingUndo = null;
  let undoTimer = 0;
  let undoTick = 0;
  function cancelUndo() {
    pendingUndo = null;
    clearTimeout(undoTimer);
    clearInterval(undoTick);
    undoBtn.classList.add("hidden");
  }
  function armUndo(x, y, prev) {
    cancelUndo();
    pendingUndo = { x, y, prev };
    undoBtn.classList.remove("hidden");
    const deadline = Date.now() + 3000;
    const update = () => {
      const left = Math.max(0, (deadline - Date.now()) / 1000);
      undoBtn.textContent = t("undoFmt", { s: left.toFixed(1) });
      if (left <= 0) cancelUndo();
    };
    update();
    undoTick = setInterval(update, 100);
    undoTimer = setTimeout(cancelUndo, 3000);
  }
  async function doUndo() {
    if (!pendingUndo) return;
    const target = pendingUndo;
    cancelUndo();
    try {
      const body = { x: target.x, y: target.y, prevEmpty: target.prev == null };
      if (target.prev) {
        body.prevC = target.prev.c;
        body.prevT = target.prev.t;
        body.prevCoats = target.prev.coats ?? 1;
      }
      const res = await fetch(`${apiBase()}/api/undo`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) {
        if (data.error === "tooLate") toast(t("undoLate"));
        else if (data.error === "changed") toast(t("undoChanged"));
        else toast(t("undoFailed"));
        return;
      }
      const key = `${target.x},${target.y}`;
      const prevUndoPix = pixels.get(key) || null;
      if (data.pixel.erased) {
        trackPixelWrite(prevUndoPix, null);
        pixels.delete(key);
      } else {
        const next = { c: data.pixel.c, t: data.pixel.t, by: data.by || myUid || null, x: target.x, y: target.y, coats: data.pixel.coats ?? 1, s: data.pixel.s || 0, sAt: Date.now(), e: data.pixel.e || 0, eAt: Date.now(), e0: 0 };
        trackPixelWrite(prevUndoPix, next);
        pixels.set(key, next);
      }
      inventory = data.inventory;
      refreshInkUI();
      applyLevelData(data);
      zoneDirty = true;
      markStatic();
      toast(t("undoneToast"));
    } catch {
      toast(t("commError"));
    }
  }
