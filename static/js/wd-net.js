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

  // タイル差分同期: 視野のタイルだけ要求し、版が変わった分だけ受け取る。
  // 全量bbox取得はしない (MB級JSONの根絶)。消去の取りこぼしはタイル単位で照合する
  // truncatedは廃止: サーバは読める分だけ返し、残りはpendingで知らせる。促しトーストなし
  const TILE = 128;
  const WATCH_CAP = 512; // サーバのwatch保持上限に合わせる
  const TILE_REQ_CAP = 4096; // サーバのneed解析上限に合わせる
  const CHASE_MAX = 3; // 1パンでの追いかけ再取得の上限
  const tileVers = new Map(); // "tx,ty" -> v
  const tileCells = new Map(); // "tx,ty" -> Set("x,y")
  async function fetchMeta() {
    try {
      const meta = await (await fetch(`${apiBase()}/api/canvas`)).json();
      if (meta.background && meta.background !== background) {
        background = meta.background;
        markStatic();
      }
      if (meta.cooldown) cooldown = meta.cooldown;
      applyZoneData(meta);
    } catch (err) {
      console.error(err);
    }
  }
  let fetchSeq = 0;
  let lastWatchSent = "";
  async function fetchViewport(chase) {
    chase = chase || 0;
    const seq = ++fetchSeq;
    const box = visibleBbox();
    const tx0 = Math.floor(box.minX / TILE), tx1 = Math.floor(box.maxX / TILE);
    const ty0 = Math.floor(box.minY / TILE), ty1 = Math.floor(box.maxY / TILE);
    const need = [];
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) need.push(`${tx},${ty}`);
    }
    // 購読タイルをWSへ通知 (ズームアウト時も止めない。サーバ上限に収める)
    const watchKey = need.join(";");
    if (socket && socketReady && socket.readyState === 1 && watchKey !== lastWatchSent) {
      lastWatchSent = watchKey;
      try { socket.send(JSON.stringify({ t: "watch", tiles: need.slice(0, WATCH_CAP) })); } catch {}
    }
    if (need.length > TILE_REQ_CAP) {
      // 濫用防止の外枠。購読は上で送ったので実況は止まらない
      return;
    }
    const known = [];
    for (const k of need) {
      if (tileVers.has(k)) known.push(`${k}:${tileVers.get(k)}`);
    }
    try {
      const url = `${apiBase()}/api/tiles?need=${encodeURIComponent(need.join(";"))}&known=${encodeURIComponent(known.join(";"))}`;
      const data = await (await fetch(url)).json();
      if (seq !== fetchSeq) return; // 古い応答は破棄
      let progressed = false;
      for (const [tkey, tile] of Object.entries(data.tiles || {})) {
        if (tile.pixels) {
          applyTile(tkey, tile.v, tile.pixels);
          progressed = true;
        } else if (tile.v != null) tileVers.set(tkey, tile.v);
      }
      pruneFar(box);
      zoneDirty = true;
      // 残りがあれば視野が変わらないうちは追いかける (上限付きで自然収束)
      const pending = typeof data.pending === "number" ? data.pending : 0;
      if (pending > 0 && progressed && chase < CHASE_MAX && seq === fetchSeq) {
        fetchViewport(chase + 1);
      }
    } catch (err) {
      console.error(err);
    }
  }
  function applyTile(tkey, v, fresh) {
    const had = tileCells.get(tkey) || new Set();
    const next = new Set();
    for (const [key, val] of Object.entries(fresh)) {
      next.add(key);
      const cur = pixels.get(key);
      const coats = val.coats ?? 1;
      if (!cur || cur.c !== val.c || cur.t !== val.t || (cur.coats ?? 1) !== coats) {
        const [px, py] = key.split(",").map(Number);
        const cell = { c: val.c, t: val.t, by: val.by || null, x: px, y: py, coats, s: 0, sAt: Date.now(), e: 0, eAt: Date.now(), e0: 0 };
        trackPixelWrite(cur, cell);
        pixels.set(key, cell);
        markStatic();
      }
    }
    // タイル内にサーバー側で存在しないキャッシュは消去 (消しゴムの取りこぼし対策)
    for (const key of had) {
      if (!next.has(key)) {
        trackPixelWrite(pixels.get(key), null);
        pixels.delete(key);
        markStatic();
      }
    }
    tileCells.set(tkey, next);
    tileVers.set(tkey, v);
  }

  let fetchTimer = 0;
  function scheduleViewportFetch() {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(fetchViewport, 250);
  }

  function pruneFar(box) {
    if (pixels.size <= maxCache) return;
    const big = fetchMargin * 4 + 512;
    // 値はx/yを持つのでキー文字列の分解はしない (15万件のsplit回避)
    for (const [key, val] of [...pixels.entries()]) {
      const x = val.x, y = val.y;
      if (x < box.minX - big || x > box.maxX + big || y < box.minY - big || y > box.maxY + big) {
        trackPixelWrite(pixels.get(key), null);
        pixels.delete(key);
        const tk = `${Math.floor(x / TILE)},${Math.floor(y / TILE)}`;
        const set = tileCells.get(tk);
        if (set) {
          set.delete(key);
          if (set.size === 0) tileCells.delete(tk);
        }
        markStatic();
        if (pixels.size <= maxCache) break;
      }
    }
    // 遠方タイルの版も捨てる (無制限増殖防止。捨てた分は次回全量取り直し)
    for (const tkey of [...tileVers.keys()]) {
      const [tx, ty] = tkey.split(",").map(Number);
      const cx = (tx + 0.5) * TILE, cy = (ty + 0.5) * TILE;
      if (cx < box.minX - big || cx > box.maxX + big || cy < box.minY - big || cy > box.maxY + big) {
        tileVers.delete(tkey);
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
      await fetchMeta();
      await fetchViewport(); // 視野タイルだけ取得
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
  let wsConnecting = false;
  // 素WS (Socket.IO廃止): ticket + Turnstile必須。ページ表示の度に検証。
  // 失敗時は指数バックオフで最大3回まで (無限ウィジェット防止)。それ以上は手動リロード。
  async function connectSocket() {
    // asyncの隙間での二重起動防止 (二重ticket+二重接続の原因)
    if (socket || wsGiveUp || wsConnecting) return;
    wsConnecting = true;
    try {
      const ts = await getTurnstileToken();
      if (wsGiveUp) return;
      const ticket = await fetchWsTicket();
      const ws = new WebSocket(wsUrl());
      ws.binaryType = "arraybuffer";
      let helloDone = false;
      socket = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ t: "hello", ticket, turnstileToken: ts }));
      };
      ws.onmessage = (ev) => {
        // バイナリ (pixel/cursor/leave) とJSON (helloOk/join) の混在
        if (ev.data instanceof ArrayBuffer) {
          onWsBin(ev.data);
          return;
        }
        let d = null;
        try { d = JSON.parse(ev.data); } catch { return; }
        if (!d || typeof d !== "object") return;
        // サーバは識別子にkindを使う (pixel載荷の"t"=インク種と衝突するため)
        const kind = d.kind || d.t;
        if (kind === "helloOk") {
          if (!d.ok) {
            helloDone = true;
            wsConnecting = false;
            wsFailCount += 1;
            try { ws.close(); } catch {}
            socket = null;
            onWsFailed(d.error);
            return;
          }
          helloDone = true;
          wsConnecting = false;
          wsFailCount = 0;
          socketReady = true;
          if (d.uid) {
            myUid = d.uid;
            myUidEl.textContent = `#${myUid}`;
          }
          fetchViewport();
          return;
        }
        if (kind === "pixel") { onPixel(d); return; }
        if (kind === "cursor") { applyRemote(d); return; }
        if (kind === "join") { applyRemote(d); refreshUserList(); return; }
        if (kind === "leave") {
          if (d.uid) remotes.delete(d.uid);
          refreshUserList();
          markDirty();
          return;
        }
      };
  // ---- WSバイナリ (20B pixel / 15B cursor / 7B leave) ----
  const _td = new TextDecoder();
  const INK_BITS = ["chalk", "ghost", "glow", "rainbow", "shield"];
  function bitsToInk(bits) {
    if (bits & 0x20) return "erase";
    const parts = [];
    for (let i = 0; i < 5; i++) {
      if (bits & (1 << i)) parts.push(INK_BITS[i]);
    }
    return parts.length ? parts.join("+") : "normal";
  }
  function binUid(view, off) {
    let s = "";
    for (let i = 0; i < 6; i++) {
      const c = view.getUint8(off + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  function rgbHex(r, g, b) {
    return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
  }
  function onWsBin(buf) {
    if (!buf || buf.byteLength < 7) return;
    const v = new DataView(buf);
    const kind = v.getUint8(0);
    if (kind === 1 && buf.byteLength >= 20) {
      // pixel
      const x = v.getInt32(1, true), y = v.getInt32(5, true);
      const ink = bitsToInk(v.getUint8(12));
      const coats = v.getUint8(13);
      const uid = binUid(v, 14);
      if (ink === "erase") {
        onPixel({ x, y, c: background, t: "normal", by: null });
      } else {
        onPixel({ x, y, c: rgbHex(v.getUint8(9), v.getUint8(10), v.getUint8(11)), t: ink, by: uid || null, coats });
      }
      return;
    }
    if (kind === 2 && buf.byteLength >= 15) {
      // cursor (uid既知の分だけ反映。join取りこぼしは次回watchスナップショットで復旧)
      const x = v.getInt32(1, true), y = v.getInt32(5, true);
      const uid = binUid(v, 9);
      const cur = remotes.get(uid);
      if (!uid || !cur) return;
      applyRemote({ uid, x, y });
      return;
    }
    if (kind === 3) {
      const uid = binUid(v, 1);
      if (uid) remotes.delete(uid);
      refreshUserList();
      markDirty();
    }
  }
      ws.onclose = () => {
        socket = null;
        socketReady = false;
        wsConnecting = false;
        lastWatchSent = "";
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
      wsConnecting = false;
      onWsFailed("");
    }
  }
  function onWsFailed(reason) {
    wsConnecting = false;
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
      const tkey = `${Math.floor(p.x / TILE)},${Math.floor(p.y / TILE)}`;
      const touchTile = (add) => {
        let set = tileCells.get(tkey);
        if (add) {
          if (!set) { set = new Set(); tileCells.set(tkey, set); }
          set.add(key);
        } else if (set) {
          set.delete(key);
          if (set.size === 0) tileCells.delete(tkey);
        }
      };
      if (p.t === "normal" && String(p.c).toLowerCase() === background.toLowerCase()) {
        trackPixelWrite(prev, null);
        pixels.delete(key);
        touchTile(false);
      } else {
        const next = { c: p.c, t: p.t, by: p.by || null, x: p.x, y: p.y, coats: p.coats ?? 1, s: p.s || 0, sAt: Date.now(), e: p.e || 0, eAt: Date.now(), e0: p.e || 0 };
        trackPixelWrite(prev, next);
        pixels.set(key, next);
        touchTile(true);
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
      // /api/usersはuidのみ返すため、無い項目は既存値を維持 (名前消去防止)
      remotes.set(u.uid, { ...cur, uid: u.uid,
        name: u.name ?? cur.name, color: u.color ?? cur.color,
        level: u.level ?? cur.level ?? 1, country: u.country ?? cur.country,
        x: u.x ?? cur.x, y: u.y ?? cur.y, updatedAt: Date.now() });
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
