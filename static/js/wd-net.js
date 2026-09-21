// wd-net.js — サーバー同期 (セッション・視野取得・socket・配置・取り消し)。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
"use strict";
  async function ensureToken() {
    if (token) return;
    // サーバが要求した時だけ検証する (不要時は空トークンで通る)
    const sessionT0 = Date.now();
    const data = await postWithTurnstile(
      "/api/session",
      { "Content-Type": "application/json" },
      (ts) => ({ turnstile_token: ts, lang: window.wdI18n.lang }),
    );
    if (!data.ok || !data.token) throw new Error("session failed");
    token = data.token;
    localStorage.setItem("wd_token", token);
    applyLevelData(data, sessionT0);
    if (data.uid) {
      setMyUidEl(data.uid);
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
  // ---------- viewport fetching (視野だけ取得。余白の先読みはしない) ----------
  function visibleBbox() {
    const clamp = (v) => Math.max(-coordLimit, Math.min(coordLimit, v));
    return {
      minX: clamp(Math.floor(-cam.x / cam.zoom)),
      minY: clamp(Math.floor(-cam.y / cam.zoom)),
      maxX: clamp(Math.ceil((viewW() - cam.x) / cam.zoom)),
      maxY: clamp(Math.ceil((viewH() - cam.y) / cam.zoom)),
    };
  }

  // タイル差分同期: 視野のタイルだけ要求し、版が変わった分だけ受け取る。
  // 全量bbox取得はしない (MB級JSONの根絶)。消去の取りこぼしはタイル単位で照合する
  // truncatedは廃止: サーバは読める分だけ返し、残りはpendingで知らせる。促しトーストなし
  const TILE = 128;
  const TILE_REQ_CAP = 4096; // サーバのneed解析上限 (視野がこれを超えたらRESTは送らない)
  const CHASE_MAX = 8; // 1パンでの追いかけ再取得の上限
  const CHASE_CELLS = 20000; // これ以上のセル数を返した回は追いかけない (弱い鯖を叩き続けない)
  const CHASE_DELAY_MS = 80; // 追いかけの間隔 (バースト防止・描画を挟む)
  const tileVers = new Map(); // "tx,ty" -> v
  const tileCells = new Map(); // "tx,ty" -> Set(pixel) 参照集合 (描画のタイル単位走査用)
  // tileCells の追従 (全書き込み経路で呼ぶこと。参照で持つため Map.get が要らない)
  function tileTouch(tkey, ref, add) {
    if (ref == null) return;
    let set = tileCells.get(tkey);
    if (add) {
      if (!set) { set = new Set(); tileCells.set(tkey, set); }
      set.add(ref);
    } else if (set) {
      set.delete(ref);
      if (set.size === 0) tileCells.delete(tkey);
    }
  }
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
    // 見えているタイルだけ送る。優先付けはしない (順序は単なる行順)
    const need = [];
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) need.push(`${tx},${ty}`);
    }
    // 購読タイルをWSへ通知 (ズームアウト時も止めない。サーバ上限はwatchBin側で切る)
    const watchKey = need.join(";");
    if (socket && socketReady && socket.readyState === 1 && watchKey !== lastWatchSent) {
      let wbuf = null;
      try {
        wbuf = watchBin(need);
      } catch (err) {
        console.error(err);
      }
      if (wbuf) {
        lastWatchSent = watchKey;
        // closeレースの送信失敗だけ無視。エンコード失敗は上で記録済み
        try { socket.send(wbuf); } catch {}
      }
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
      let cells = 0;
      for (const [tkey, tile] of Object.entries(data.tiles || {})) {
        if (tile.pixels) {
          cells += Object.keys(tile.pixels).length;
          applyTile(tkey, tile.v, tile.pixels);
          progressed = true;
        } else if (tile.v != null) tileVers.set(tkey, tile.v);
      }
      pruneFar(box);
      zoneDirty = true;
      // 残りがあれば視野が変わらないうちは同じ視野で追いかける (上限付きで自然収束。
      // 巨大応答の直後は叩き続けない)
      const pending = typeof data.pending === "number" ? data.pending : 0;
      if (pending > 0 && progressed && cells < CHASE_CELLS && chase < CHASE_MAX && seq === fetchSeq) {
        setTimeout(() => { if (seq === fetchSeq) fetchViewport(chase + 1); }, CHASE_DELAY_MS);
      }
    } catch (err) {
      console.error(err);
    }
  }
  function applyTile(tkey, v, fresh) {
    const had = tileCells.get(tkey) || new Set();
    const next = new Set();
    for (const [key, val] of Object.entries(fresh)) {
      const cur = pixels.get(key);
      const coats = val.coats ?? 1;
      const ve = val.e || 0, vs = val.s || 0;
      let ref = cur || null;
      if (!cur || cur.c !== val.c || cur.t !== val.t || (cur.coats ?? 1) !== coats
        || (cur.e || 0) !== ve || (cur.s || 0) !== vs) {
        // キー分解はsplitより手割り (巨大取得時の主スレッド停止を短縮)
        const ci = key.indexOf(",");
        const px = +key.slice(0, ci), py = +key.slice(ci + 1);
        ref = { c: val.c, t: val.t, by: val.by || null, x: px, y: py, coats, s: vs, sAt: Date.now(), e: ve, eAt: Date.now(), e0: val.e0 || ve };
        trackPixelWrite(cur, ref);
        pixels.set(key, ref);
        markStatic();
      }
      if (ref) next.add(ref);
    }
    // タイル内にサーバー側で存在しないキャッシュは消去 (消しゴムの取りこぼし対策)
    for (const ref of had) {
      if (!next.has(ref)) {
        trackPixelWrite(ref, null);
        pixels.delete(ref.x + "," + ref.y);
        markStatic();
      }
    }
    if (next.size > 0) tileCells.set(tkey, next);
    else tileCells.delete(tkey);
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
        trackPixelWrite(val, null);
        pixels.delete(key);
        tileTouch(`${Math.floor(x / TILE)},${Math.floor(y / TILE)}`, val, false);
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
      // ハンドオフ帰還時は断片を先に消費 (トークン発行より前)。リロード後は通常起動
      if ((await consumeHandoffPayload()) === "reloaded") return;
      // 旧経由の到達時は一度だけ自動往復 (使用中なら何もしない)
      if (await maybeAutoHandoff()) return;
      await maybeImportPrevOrigin();
      await ensureToken();
      await fetchMeta();
      await fetchViewport(); // 視野タイルだけ取得
      const meT0 = Date.now();
      const me = await (await fetch(`${apiBase()}/api/me`, { headers: authHeaders() })).json();
      inventory = { ...inventory, ...me.inventory };
      cooldownUntil = me.cooldownUntil ? me.cooldownUntil * 1000 : 0;
      myCountry = me.country ?? null;
      myShowCountry = me.showCountry ?? true;
      countryChk.checked = myShowCountry;
      if (me.uid) {
        setMyUidEl(me.uid);
      }
      applyLevelData(me, meT0);
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
        if (sessionStorage.getItem("wd_mig_done")) {
          sessionStorage.removeItem("wd_mig_done");
          if (sessionStorage.getItem("wd_mig_partial")) {
            sessionStorage.removeItem("wd_mig_partial");
            let skipped = [];
            try {
              skipped = JSON.parse(sessionStorage.getItem("wd_mig_skipped") || "[]") || [];
            } catch {}
            sessionStorage.removeItem("wd_mig_skipped");
            const names = (typeof migSkippedNames === "function" ? migSkippedNames(skipped) : []).filter((s) => !!s);
            toast(names.length ? t("migratedPartialToast", { items: names.join(", ") }) : t("migratedToast"));
          } else {
            toast(t("migratedToast"));
          }
        }
      } catch {}
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

  // ---- WSバイナリ (完全。pixel 20B / cursor 15B / leave 7B / hello,watch可変 / helloOk 9B / join可変) ----
  // トップレベルに置くこと。connectSocket() の内側だと fetchViewport/sendCursor から見えない
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
  // ---- WS送信エンコーダ (完全バイナリ。受信レイアウトと対称) ----
  const _te = new TextEncoder();
  function helloBin(ticket, ts) {
    const tb = _te.encode(ticket), sb = _te.encode(ts || "");
    const buf = new ArrayBuffer(5 + tb.length + sb.length);
    const v = new DataView(buf);
    const u8 = new Uint8Array(buf);
    v.setUint8(0, 4);
    v.setUint16(1, tb.length, true);
    u8.set(tb, 3);
    v.setUint16(3 + tb.length, sb.length, true);
    u8.set(sb, 3 + tb.length + 2);
    return buf;
  }
  function watchBin(tiles) {
    const n = Math.min(tiles.length, 512);
    const v = new DataView(new ArrayBuffer(3 + n * 8));
    v.setUint8(0, 5);
    v.setUint16(1, n, true);
    for (let i = 0; i < n; i++) {
      const [tx, ty] = tiles[i].split(",").map(Number);
      v.setInt32(3 + i * 8, tx, true);
      v.setInt32(7 + i * 8, ty, true);
    }
    return v.buffer;
  }
  function cursorBin(x, y) {
    const v = new DataView(new ArrayBuffer(15));
    v.setUint8(0, 2);
    v.setInt32(1, x, true);
    v.setInt32(5, y, true);
    const uid = myUid || "";
    for (let i = 0; i < 6; i++) {
      v.setUint8(9 + i, i < uid.length ? uid.charCodeAt(i) & 0xff : 0);
    }
    return v.buffer;
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
      // onlineTotal は自分込み総数。一覧にいた本人のleaveだけ1減らす
      if (uid && remotes.delete(uid) && typeof onlineTotal === "number") {
        onlineTotal = Math.max(0, onlineTotal - 1);
      }
      refreshUserList();
      markDirty();
      return;
    }
    if (kind === 8) {
      // chat (wd-chat.jsの受信入口。未読バッジ・ドック追記はそちら)。
      // wd-chat.jsより先に読まれるためwindow経由で呼ぶ
      try {
        if (typeof window.wdChatOnMsg === "function") window.wdChatOnMsg(buf);
        else if (typeof onChatBinMsg === "function") onChatBinMsg(buf);
      } catch (e) {
        console.error(e);
      }
      return;
    }
    if (kind === 10) {
      // chat返信 (引用付き。旧クライアントは未知kindとして無視する)
      try {
        if (typeof window.wdChatOnReplyMsg === "function") window.wdChatOnReplyMsg(buf);
        else if (typeof onChatReplyBinMsg === "function") onChatReplyBinMsg(buf);
      } catch (e) {
        console.error(e);
      }
      return;
    }
    if (kind === 9 && buf.byteLength >= 9) {
      // server time (接続直後＋1分毎)。仮想サーバ時計を補正する
      try {
        if (typeof serverClockSync === "function") serverClockSync(v.getFloat64(1, true));
      } catch (e) {
        console.error(e);
      }
      return;
    }
  }

  let socket = null;
  let socketReady = false;
  let wsFailCount = 0;
  let wsGiveUp = false;
  let wsConnecting = false;
  // WS送受信量 (統計オーバーレイ用。累積バイト+件数)
  const wsTraffic = { upBytes: 0, downBytes: 0, upMsgs: 0, downMsgs: 0 };
  function wsCountUp(d) {
    try {
      const n = d && typeof d.byteLength === "number" ? d.byteLength : String(d ?? "").length;
      wsTraffic.upBytes += n;
      wsTraffic.upMsgs++;
    } catch {}
  }
  function wsCountDown(n) {
    try {
      wsTraffic.downBytes += Number(n) || 0;
      wsTraffic.downMsgs++;
    } catch {}
  }
  // 素WS (Socket.IO廃止): ticket + Turnstile必須。ページ表示の度に検証。
  // 失敗時は指数バックオフで最大3回まで (無限ウィジェット防止)。それ以上は手動リロード。
  async function connectSocket() {
    // asyncの隙間での二重起動防止 (二重ticket+二重接続の原因)
    if (socket || wsGiveUp || wsConnecting) return;
    if (!token) {
      // セッション未確立 (新規時) は待つ。空Bearerでticketを叩くとmissingTokenになる
      setTimeout(connectSocket, 2000);
      return;
    }
    wsConnecting = true;
    try {
      if (wsFailCount === 0) toast(t("connectingToast"));
      const { ticket, turnstileRequired } = await fetchWsTicket();
      if (wsGiveUp) return;
      // サーバが要求する時だけ検証ウィジェットを実行する
      const ts = turnstileRequired ? await getTurnstileToken() : "";
      if (wsGiveUp) return;
      const ws = new WebSocket(wsUrl());
      ws.binaryType = "arraybuffer";
      let helloDone = false;
      socket = ws;
      try {
        const _origSend = ws.send.bind(ws);
        ws.send = (d) => { wsCountUp(d); return _origSend(d); };
      } catch {}
      ws.onopen = () => {
        ws.send(helloBin(ticket, ts));
      };
      ws.onmessage = (ev) => {
        try { wsCountDown(ev.data && ev.data.byteLength ? ev.data.byteLength : 0); } catch {}
        // 完全バイナリ。Textフレームは送受信ともに使わない
        if (!(ev.data instanceof ArrayBuffer)) return;
        const buf = ev.data;
        if (!buf || buf.byteLength < 1) return;
        const kind = new DataView(buf).getUint8(0);
        if (kind === 6 && buf.byteLength >= 9) {
          // helloOk
          const v = new DataView(buf);
          const ok = v.getUint8(1) !== 0, err = v.getUint8(2);
          const uid = binUid(v, 3);
          if (!ok) {
            helloDone = true;
            wsConnecting = false;
            wsFailCount += 1;
            try { ws.close(); } catch {}
            socket = null;
            onWsFailed(err === 1 ? "badTicket" : err === 2 ? "turnstileRequired" : err === 3 ? "noUser" : err === 4 ? "sockLimit" : "");
            return;
          }
          helloDone = true;
          wsConnecting = false;
          wsFailCount = 0;
          socketReady = true;
          toast(t("connectedToast"));
          if (uid) {
            setMyUidEl(uid);
          }
          fetchViewport();
          // 既存オンラインユーザーの名前はjoinでは届かないためRESTで初回取得する
          refreshOnlineUsers();
          return;
        }
        if (kind === 7 && buf.byteLength >= 13) {
          // join (最小13B: 空名の理論値。実務上は名前入り)
          // join
          const v = new DataView(buf);
          const uid = binUid(v, 1);
          const nl = v.getUint8(7);
          if (buf.byteLength < 8 + nl + 5) return;
          const name = _td.decode(new Uint8Array(buf, 8, nl));
          const o = 8 + nl;
          const color = rgbHex(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2));
          const level = v.getUint16(o + 3, true);
          // onlineTotal は自分込み総数。新規到着だけ1増やす (再送の二重計上防止)
          const isNew = !!uid && uid !== myUid && !remotes.has(uid);
          applyRemote({ uid, name, color, level });
          if (isNew && typeof onlineTotal === "number") onlineTotal++;
          refreshUserList();
          return;
        }
        onWsBin(buf);
      };
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
      // 視野外のWS差分も変数上は更新する (不整合防止)。重い静的レイヤー再構築だけ省く。
      // 視点変化の全経路がmarkStaticするので描画漏れは起きない
      const m = fetchMargin + 512;
      const far = p.x < -cam.x / cam.zoom - m || p.x > (viewW() - cam.x) / cam.zoom + m
        || p.y < -cam.y / cam.zoom - m || p.y > (viewH() - cam.y) / cam.zoom + m;
      const key = `${p.x},${p.y}`;
      const prev = pixels.get(key) || null;
      const tkey = `${Math.floor(p.x / TILE)},${Math.floor(p.y / TILE)}`;
      if (p.t === "normal" && String(p.c).toLowerCase() === background.toLowerCase()) {
        trackPixelWrite(prev, null);
        pixels.delete(key);
        tileTouch(tkey, prev, false);
      } else {
        const next = { c: p.c, t: p.t, by: p.by || null, x: p.x, y: p.y, coats: p.coats ?? 1, s: p.s || 0, sAt: Date.now(), e: p.e || 0, eAt: Date.now(), e0: p.e || 0 };
        trackPixelWrite(prev, next);
        pixels.set(key, next);
        tileTouch(tkey, prev, false);
        tileTouch(tkey, next, true);
      }
      zoneDirty = true;
      if (pendingUndo && `${pendingUndo.x},${pendingUndo.y}` === key && p.by !== myUid) cancelUndo();
      if (historyMode && historyKey === key) showHistory(p.x, p.y);
      if (far) return;
      markStatic();
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
  }

  // サーバの count は自分込みの総数。表示側は足さずにそのまま使う
  // (refreshOnlineUI)。WSのjoin/leaveで増減追従する
  let onlineTotal = null;
  function applyPresenceList(list, total) {
    const seen = new Set();
    (list || []).forEach((u) => {
      if (!u || !u.uid || u.uid === myUid) return; // 自分は除外
      seen.add(u.uid);
      const cur = remotes.get(u.uid) || {};
      // /api/usersは名前入りで返す。無い項目は既存値を維持 (名前消去防止)
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
    let cbuf = null;
    try {
      cbuf = cursorBin(x, y);
    } catch (err) {
      console.error(err);
      return;
    }
    lastCursorSent = nowMs;
    lastCursorCell = key;
    // closeレースの送信失敗だけ無視。エンコード失敗は上で記録済み
    try { socket.send(cbuf); } catch {}
  }

  async function refreshOnlineUsers() {
    try {
      const data = await (await fetch(`${apiBase()}/api/users`)).json();
      applyPresenceList(data.online || [], data.count);
    } catch {}
  }

  // シールド残り秒を見やすい単位に整形 (60秒→分、60分→時間、24時間→日)
  function fmtDur(sec) {
    const s = Math.max(0, Math.ceil(Number(sec) || 0));
    if (s < 60) return t("durSec", { n: s });
    if (s < 3600) return t("durMin", { n: Math.floor(s / 60) });
    if (s < 86400) return t("durHour", { n: Math.floor(s / 3600) });
    return t("durDay", { n: Math.floor(s / 86400) });
  }

  let placing = false; // 配置の送信中ガード (応答前の連打で二重送信しない)
  async function place(x, y, forceTool) {
    if (Math.abs(x) > coordLimit || Math.abs(y) > coordLimit) {
      toast(t("outOfBounds"));
      return;
    }
    // 表示と同じ残り秒でゲートする (「準備OKなのに弾かれる」をなくす)
    const gateRemain = (typeof cooldownRemainSec === "function") ? cooldownRemainSec() : 0;
    if (gateRemain > 0) {
      const s = (typeof fmtRemain === "function")
        ? fmtRemain(gateRemain)
        : gateRemain.toFixed(1);
      toast(t("cooldownToast", { s: s || "0.01" }));
      return;
    }
    if (placing) return;
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
      placing = true;
      const placeT0 = Date.now();
      const res = await fetch(`${apiBase()}/api/place`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ x, y, color: paintColor, ink: inkToUse }),
      });
      const data = await res.json();
      if (!data.ok) {
        if (data.error === "cooldown") {
          cooldownUntil = data.cooldownUntil * 1000;
          applyLevelData(data, placeT0);
          try { updateCooldownUI(); } catch {}
          toast(t("cooldownToast", { s: fmtRemain(data.remaining) || "0.0" }));
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
          const retry = data.retryAfter ?? res.headers.get("Retry-After");
          const s = retry != null && retry !== "" ? Number(retry) : null;
          if (s != null && Number.isFinite(s)) {
            toast(t("ipBusyRetryToast", { s }));
          } else {
            toast(t("ipBusyToast"));
          }
        } else if (data.error === "noSocket") {
          toast(t("socketRequiredToast"));
        } else if (data.error === "cursorMismatch") {
          toast(t("cursorMismatchToast"));
        } else if (data.error === "shielded") {
          toast(t("shieldToast", { dur: fmtDur(data.remaining ?? 0) }));
        } else {
          toast(t("placeFailedToast", { error: data.error }));
        }
        return;
      }
      const prevForUndo = prevPix ? { c: prevPix.c, t: prevPix.t, coats: prevPix.coats ?? 1 } : null;
      const placeTkey = `${Math.floor(x / TILE)},${Math.floor(y / TILE)}`;
      if (inkToUse === "erase") {
        trackPixelWrite(prevPix, null);
        pixels.delete(key);
        tileTouch(placeTkey, prevPix, false);
      } else {
        const next = { c: data.pixel.c, t: data.pixel.t, by: data.by || myUid || null, x, y, coats: data.pixel.coats ?? 1, s: data.pixel.s || 0, sAt: Date.now(), e: data.pixel.e || 0, eAt: Date.now(), e0: data.pixel.e0 || data.pixel.e || 0 };
        trackPixelWrite(prevPix, next);
        pixels.set(key, next);
        tileTouch(placeTkey, prevPix, false);
        tileTouch(placeTkey, next, true);
      }
      cooldownUntil = data.cooldownUntil * 1000;
      inventory = data.inventory;
      applyLevelData(data, placeT0);
      try { updateCooldownUI(); } catch {}
      refreshInkUI();
      zoneDirty = true;
      markStatic();
      armUndo(x, y, prevForUndo);
      if (data.leveledUp) toast(t("levelUpToast", { level: data.level, cooldown: data.cooldown.toFixed(1) }), "reward");
      if (data.reward) toast(t("rewardToast", { ink: inkName(data.reward.ink), amount: data.reward.amount }), "reward");
    } catch {
      toast(t("commError"));
    } finally {
      placing = false;
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
    const deadline = (typeof serverNowMs === "function" ? serverNowMs() : Date.now()) + 3000;
    const update = () => {
      const nowMs = (typeof serverNowMs === "function" ? serverNowMs() : Date.now());
      const left = Math.max(0, (deadline - nowMs) / 1000);
      const s = (typeof fmtRemain === "function") ? fmtRemain(left) : left.toFixed(1);
      undoBtn.textContent = t("undoFmt", { s: s || "0.0" });
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
      const undoTkey = `${Math.floor(target.x / TILE)},${Math.floor(target.y / TILE)}`;
      if (data.pixel.erased) {
        trackPixelWrite(prevUndoPix, null);
        pixels.delete(key);
        tileTouch(undoTkey, prevUndoPix, false);
      } else {
        const next = { c: data.pixel.c, t: data.pixel.t, by: data.by || myUid || null, x: target.x, y: target.y, coats: data.pixel.coats ?? 1, s: data.pixel.s || 0, sAt: Date.now(), e: data.pixel.e || 0, eAt: Date.now(), e0: data.pixel.e0 || data.pixel.e || 0 };
        trackPixelWrite(prevUndoPix, next);
        pixels.set(key, next);
        tileTouch(undoTkey, prevUndoPix, false);
        tileTouch(undoTkey, next, true);
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
