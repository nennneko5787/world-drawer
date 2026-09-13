(() => {
  "use strict";

  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
  const coordsEl = document.getElementById("coords");
  const cooldownEl = document.getElementById("cooldown");
  const levelEl = document.getElementById("level");
  const onlineEl = document.getElementById("online");
  const onlineCount = document.getElementById("onlineCount");
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsPanel = document.getElementById("settingsPanel");
  const gridToggle = document.getElementById("gridToggle");
  const cursorToggle = document.getElementById("cursorToggle");
  const draftToggle = document.getElementById("draftToggle");
  const axisToggle = document.getElementById("axisToggle");
  const zoneToggle = document.getElementById("zoneToggle");
  const cursorRateSel = document.getElementById("cursorRateSel");
  const themeSel = document.getElementById("themeSel");
  const colorBtn = document.getElementById("colorBtn");
  const colorChip = document.getElementById("colorChip");
  const swatchesEl = document.getElementById("swatches");
  const toolPen = document.getElementById("toolPen");
  const toolEraser = document.getElementById("toolEraser");
  const toolHistory = document.getElementById("toolHistory");
  const toolDraft = document.getElementById("toolDraft");
  const toolEyedropper = document.getElementById("toolEyedropper");
  const toastWrap = document.getElementById("toast-wrap");
  const profileName = document.getElementById("profileName");
  const profileColorBtn = document.getElementById("profileColorBtn");
  const profileColorChip = document.getElementById("profileColorChip");
  const profileSave = document.getElementById("profileSave");
  const myUidEl = document.getElementById("myUid");
  const userPanel = document.getElementById("userPanel");
  const userList = document.getElementById("userList");
  const historyPanel = document.getElementById("historyPanel");
  const historyTitle = document.getElementById("historyTitle");
  const historyList = document.getElementById("historyList");
  const historyClose = document.getElementById("historyClose");
  const undoBtn = document.getElementById("undoBtn");
  const colorPanel = document.getElementById("colorPanel");
  const colorClose = document.getElementById("colorClose");
  const cpSv = document.getElementById("cpSv");
  const cpHue = document.getElementById("cpHue");
  const cpHex = document.getElementById("cpHex");
  const cpR = document.getElementById("cpR");
  const cpG = document.getElementById("cpG");
  const cpB = document.getElementById("cpB");
  const cpHsvH = document.getElementById("cpHsvH");
  const cpHsvS = document.getElementById("cpHsvS");
  const cpHsvV = document.getElementById("cpHsvV");
  const cpHslH = document.getElementById("cpHslH");
  const cpHslS = document.getElementById("cpHslS");
  const cpHslL = document.getElementById("cpHslL");
  const cpPreview = document.getElementById("cpPreview");
  const cpOk = document.getElementById("cpOk");
  const accountBtn = document.getElementById("accountBtn");
  const accountPanel = document.getElementById("accountPanel");
  const accountClose = document.getElementById("accountClose");
  const issuePassword = document.getElementById("issuePassword");
  const issueBtn = document.getElementById("issueBtn");
  const issueResult = document.getElementById("issueResult");
  const loginCode = document.getElementById("loginCode");
  const loginPassword = document.getElementById("loginPassword");
  const loginBtn = document.getElementById("loginBtn");
  const countryChk = document.getElementById("countryChk");
  const toolbarEl = document.getElementById("toolbar");
  const chromeToggle = document.getElementById("chromeToggle");
  const fpsVal = document.getElementById("fpsVal");
  const cacheVal = document.getElementById("cacheVal");
  const t = (key, params) => window.wdI18n.t(key, params);
  const inkName = (k) => t("inkL_" + k);

  const coordLimit = 1000000;
  const fetchMargin = 256; // 視野の外側に余分に取得するセル数
  const maxCache = 150000; // 手元に保持するピクセル数の上限
  const maxDrafts = 20000; // 設計図の保持上限

  // ---------- state (camelCase) ----------
  let background = "#ffffff";
  let cooldown = 10;
  let myLevel = 1, myXp = 0, xpNeeded = 3;
  const pixels = new Map(); // "x,y" -> {c, t, by}
  const remotes = new Map(); // token -> {uid, name, color, x, y, updatedAt}
  let inventory = { glow: 0, rainbow: 0, ghost: 0 };
  let cooldownUntil = 0;
  let tool = "pen";
  let ink = "normal";
  let showGrid = true;
  let showCursors = true;
  let showAxes = true;
  let showZone = true;
  try {
    if (localStorage.getItem("wd_showAxes") === "0") showAxes = false;
    if (localStorage.getItem("wd_showZone") === "0") showZone = false;
  } catch {}
  let trustedLevel = 5;
  let placeRadius = 1000;
  let hover = null;
  let fpsEma = 0, fpsLastT = 0, fpsShownAt = 0;
  let historyMode = false;
  let eyedropMode = false;
  let historyKey = null;
  let draftMode = false;
  let showDrafts = localStorage.getItem("wd_showDraft") !== "0";
  const drafts = new Map(); // "x,y" -> "#rrggbb" (自分専用・サーバー送信なし)
  try {
    const saved = JSON.parse(localStorage.getItem("wd_draft") || "{}");
    if (saved && typeof saved === "object") {
      for (const [key, color] of Object.entries(saved)) {
        if (drafts.size >= maxDrafts) break;
        if (/^-?\d+,-?\d+$/.test(key) && /^#[0-9a-fA-F]{6}$/.test(color)) drafts.set(key, color);
      }
    }
  } catch {}
  function saveDrafts() {
    try {
      localStorage.setItem("wd_draft", JSON.stringify(Object.fromEntries(drafts)));
    } catch {}
  }
  function paintDraft(x, y) {
    if (Math.abs(x) > coordLimit || Math.abs(y) > coordLimit) return;
    const key = `${x},${y}`;
    if (tool === "eraser") {
      drafts.delete(key);
    } else {
      if (!drafts.has(key) && drafts.size >= maxDrafts) {
        toast(t("draftLimit", { max: maxDrafts }));
        return;
      }
      drafts.set(key, paintColor);
    }
    saveDrafts();
  }
  let myUid = "";
  let isDark = false;

  let blocked = new Set();
  try {
    blocked = new Set(JSON.parse(localStorage.getItem("wd_blocked") || "[]"));
  } catch {}
  function saveBlocked() {
    localStorage.setItem("wd_blocked", JSON.stringify([...blocked]));
  }
  function toggleBlock(uid) {
    if (!uid || uid === myUid) return;
    if (blocked.has(uid)) {
      blocked.delete(uid);
      toast(t("unblockToast", { uid }));
    } else {
      blocked.add(uid);
      toast(t("blockToast", { uid }));
    }
    saveBlocked();
    refreshUserList();
  }

  // トークンはサーバー発行 (secrets使用) のみ。クライアント側生成はしない。
  let token = localStorage.getItem("wd_token") || "";
  async function ensureToken() {
    if (token) return;
    const res = await fetch(`/api/session?lang=${encodeURIComponent(window.wdI18n.lang)}`, { method: "POST" });
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
  let myName = localStorage.getItem("wd_name") || t("anon");
  let myCountry = null;
  let myShowCountry = true;
  let myColor = localStorage.getItem("wd_userColor") || "#22aa66";
  profileName.value = myName;
  let paintColor = "#ff0000";
  function setPaintColor(color) {
    if (!/^#[0-9a-fA-F]{6}$/.test(color || "")) return;
    paintColor = String(color).toLowerCase();
    colorChip.style.background = paintColor;
    document.querySelectorAll(".sw").forEach((el) => {
      el.classList.toggle("sel", el.dataset.color === paintColor);
    });
  }
  function setProfileColor(color) {
    if (!/^#[0-9a-fA-F]{6}$/.test(color || "")) return;
    myColor = String(color).toLowerCase();
    profileColorChip.style.background = myColor;
  }
  setProfileColor(myColor);
  setPaintColor(paintColor);

  const defaultPalette = ["#000000", "#ffffff", "#ff0000", "#ff8000", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#8000ff", "#ff00ff", "#8b4513", "#808080", "#ffd700", "#ff69b4"];
  let palette = [...defaultPalette];
  try {
    const saved = JSON.parse(localStorage.getItem("wd_palette") || "[]");
    if (Array.isArray(saved) && saved.length > 0 && saved.every((c) => /^#[0-9a-fA-F]{6}$/.test(c))) {
      palette = saved;
    }
  } catch {}
  function savePalette() {
    localStorage.setItem("wd_palette", JSON.stringify(palette));
  }
  function renderSwatches() {
    swatchesEl.innerHTML = "";
    palette.forEach((c, i) => {
      const btn = document.createElement("button");
      btn.className = "sw" + (c.toLowerCase() === paintColor ? " sel" : "");
      btn.style.background = c;
      btn.dataset.color = c.toLowerCase();
      btn.title = t("swatchTitle", { c });
      btn.onclick = () => {
        if (btn.classList.contains("sel")) openColorPanel({ kind: "swatch", index: i });
        else setPaintColor(c);
      };
      btn.ondblclick = (e) => {
        e.preventDefault();
        openColorPanel({ kind: "swatch", index: i });
      };
      swatchesEl.appendChild(btn);
    });
  }
  renderSwatches();

  // ---------- theme (light / dark / auto。実体は theme.js で一元管理) ----------
  themeSel.value = window.wdTheme ? window.wdTheme.get() : "auto";
  function applyTheme() {
    if (window.wdTheme) window.wdTheme.paint();
    isDark = document.documentElement.dataset.theme === "dark";
  }
  themeSel.onchange = () => {
    if (window.wdTheme) window.wdTheme.set(themeSel.value);
    applyTheme();
  };
  applyTheme();

  // ---------- camera (infinite) ----------
  const cam = { x: 0, y: 0, zoom: 16 };
  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(innerWidth * dpr);
    canvas.height = Math.floor(innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", resize);
  window.addEventListener("resize", scheduleViewportFetch);
  resize();

  function centerOn(cx, cy, zoom) {
    if (zoom) cam.zoom = zoom;
    cam.x = innerWidth / 2 - cx * cam.zoom;
    cam.y = innerHeight / 2 - cy * cam.zoom;
  }
  centerOn(0, 0, 16);

  // 表示位置の復元 (入り直しても前回の場所に戻る)
  function saveCamera() {
    try {
      localStorage.setItem("wd_cam", JSON.stringify({ x: cam.x, y: cam.y, zoom: cam.zoom }));
    } catch {}
  }
  let camTimer = 0;
  function scheduleSaveCamera() {
    clearTimeout(camTimer);
    camTimer = setTimeout(saveCamera, 500);
  }
  (function restoreCamera() {
    try {
      const saved = JSON.parse(localStorage.getItem("wd_cam") || "null");
      if (!saved || typeof saved !== "object") return;
      const zoom = Number(saved.zoom);
      if (!Number.isFinite(zoom) || zoom < 1 || zoom > 96) return;
      const x = Number(saved.x), y = Number(saved.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (Math.abs(x) > 1e9 || Math.abs(y) > 1e9) return;
      cam.x = x;
      cam.y = y;
      cam.zoom = zoom;
    } catch {}
  })();

  // ---------- viewport fetching (視野+余白だけ取得) ----------
  function visibleBbox() {
    const clamp = (v) => Math.max(-coordLimit, Math.min(coordLimit, v));
    return {
      minX: clamp(Math.floor(-cam.x / cam.zoom) - fetchMargin),
      minY: clamp(Math.floor(-cam.y / cam.zoom) - fetchMargin),
      maxX: clamp(Math.ceil((innerWidth - cam.x) / cam.zoom) + fetchMargin),
      maxY: clamp(Math.ceil((innerHeight - cam.y) / cam.zoom) + fetchMargin),
    };
  }

  let fetchSeq = 0;
  async function fetchViewport() {
    const seq = ++fetchSeq;
    const box = visibleBbox();
    try {
      const url = `/api/canvas?minX=${box.minX}&minY=${box.minY}&maxX=${box.maxX}&maxY=${box.maxY}`;
      const canvasData = await (await fetch(url)).json();
      if (seq !== fetchSeq) return; // 古い応答は破棄
      if (canvasData.background) background = canvasData.background;
      if (canvasData.cooldown) cooldown = canvasData.cooldown;
      applyZoneData(canvasData);
      const fresh = canvasData.pixels || {};
      if (!canvasData.truncated) {
        // 取得範囲内にサーバー側で存在しないキャッシュは消去 (消しゴムの取りこぼし対策)
        for (const key of [...pixels.keys()]) {
          const [x, y] = key.split(",").map(Number);
          if (x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY && !(key in fresh)) {
            pixels.delete(key);
          }
        }
      } else {
        toast(t("zoomOutToast"));
      }
      for (const [key, val] of Object.entries(fresh)) {
        const cur = pixels.get(key);
        if (!cur || cur.c !== val.c || cur.t !== val.t) {
          const [px, py] = key.split(",").map(Number);
          pixels.set(key, { c: val.c, t: val.t, by: val.by || null, x: px, y: py });
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
        pixels.delete(key);
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
    const cx = (-cam.x + innerWidth / 2) / cam.zoom;
    const cy = (-cam.y + innerHeight / 2) / cam.zoom;
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
        const b = await (await fetch("/api/bounds")).json();
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

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // ---------- 配置可能ゾーン (Lv制限中の目安表示。禁止ではなく既知の許可域の強調) ----------
  const zoneIndex = new Map(); // "1024pxブロック" -> [x0,y0,x1,y1,...]
  let zoneDirty = true;
  let zoneBuiltAt = 0;
  let zoneSegments = []; // {x, y}: 境界の縦ティック (x, y)-(x, y+1)。世界座標
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
  function rebuildZoneSegments(vx0, vx1, vy0, vy1) {
    // 可視行ごとに許可区間 [a..b] を正確にマージし、両端に縦ティックを置く。
    // サーバーの内外判定（含む端・チェビシェフ距離）と一致する
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
    for (let y = vy0; y <= vy1; y += step) {
      const pairs = [];
      for (let i = 0; i < cand.length; i += 2) {
        if (Math.abs(cand[i + 1] - y) > R) continue;
        const a = cand[i] - R, b = cand[i] + R;
        if (b < vx0 - 1 || a > vx1 + 1) continue;
        pairs.push([a, b]);
      }
      if (pairs.length === 0) continue;
      pairs.sort((p, q) => p[0] - q[0]);
      let ca = pairs[0][0], cb = pairs[0][1];
      const done = [];
      for (let i = 1; i < pairs.length; i++) {
        if (pairs[i][0] <= cb + 1) cb = Math.max(cb, pairs[i][1]);
        else {
          done.push(ca, cb);
          ca = pairs[i][0];
          cb = pairs[i][1];
        }
      }
      done.push(ca, cb);
      for (let i = 0; i < done.length; i += 2) {
        segs.push({ x: done[i], y }, { x: done[i + 1] + 1, y });
      }
    }
    zoneSegments = segs;
    zoneDirty = false;
    zoneBuiltAt = Date.now();
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
    if (now - fpsShownAt > 500) {
      fpsShownAt = now;
      if (fpsVal) fpsVal.textContent = String(Math.round(fpsEma));
      if (cacheVal) cacheVal.textContent = String(pixels.size);
    }
    isDark = document.documentElement.dataset.theme === "dark";
    ctx.fillStyle = isDark ? "#15151b" : background;
    ctx.fillRect(0, 0, innerWidth, innerHeight);

    const x0 = Math.floor(-cam.x / cam.zoom) - 1;
    const x1 = Math.ceil((innerWidth - cam.x) / cam.zoom) + 1;
    const y0 = Math.floor(-cam.y / cam.zoom) - 1;
    const y1 = Math.ceil((innerHeight - cam.y) / cam.zoom) + 1;

    // 設計図 (自分専用・薄く表示)
    if (showDrafts && drafts.size > 0) {
      ctx.save();
      ctx.globalAlpha = 0.22;
      for (const [key, color] of drafts) {
        const [x, y] = key.split(",").map(Number);
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        ctx.fillStyle = color;
        ctx.fillRect(cam.x + x * cam.zoom, cam.y + y * cam.zoom, cam.zoom, cam.zoom);
      }
      ctx.restore();
    }

    // ピクセル (単一パス。座標は格納時に解決済みで毎フレームparseしない)
    for (const val of pixels.values()) {
      const x = val.x, y = val.y;
      if (x == null || y == null) continue;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (val.by && blocked.has(val.by)) continue; // 非表示ID
      const sx = cam.x + x * cam.zoom, sy = cam.y + y * cam.zoom, s = cam.zoom;
      if (val.t === "normal") {
        ctx.fillStyle = val.c;
        ctx.fillRect(sx, sy, s, s);
      } else if (val.t === "rainbow") {
        ctx.fillStyle = `hsl(${(x * 7 + y * 13 + time * 90) % 360},100%,55%)`;
        ctx.fillRect(sx, sy, s, s);
      } else if (val.t === "glow") {
        // 発光のみ (ダークモードでは強く輝く)
        ctx.save();
        ctx.shadowColor = val.c;
        ctx.shadowBlur = isDark ? s * 1.2 + 12 : Math.max(6, s * 0.8);
        ctx.fillStyle = val.c;
        ctx.fillRect(sx, sy, s, s);
        if (isDark) ctx.fillRect(sx, sy, s, s);
        ctx.restore();
      } else if (val.t === "ghost") {
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = val.c || "#888888";
        ctx.fillRect(sx, sy, s, s);
        ctx.restore();
      }
    }

    // 配置可能ゾーンの境界線 (Lv制限中のみ。サーバー判定と一致する正確な線)
    if (showZone && myLevel < trustedLevel && pixels.size > 0) {
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
        if (s.x < x0 - 1 || s.x > x1 + 1 || s.y < y0 - 1 || s.y > y1 + 1) continue;
        const ex = cam.x + s.x * cam.zoom, ey = cam.y + s.y * cam.zoom;
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex, ey + cam.zoom);
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
      if (origin.x >= 0 && origin.x <= innerWidth) {
        ctx.moveTo(origin.x, 0);
        ctx.lineTo(origin.x, innerHeight);
      }
      if (origin.y >= 0 && origin.y <= innerHeight) {
        ctx.moveTo(0, origin.y);
        ctx.lineTo(innerWidth, origin.y);
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
        ctx.lineTo(px, Math.min(innerHeight, cam.y + (y1 + 1) * cam.zoom));
      }
      for (let y = y0; y <= y1; y++) {
        const py = Math.round(cam.y + y * cam.zoom) + 0.5;
        ctx.moveTo(Math.max(0, cam.x + x0 * cam.zoom), py);
        ctx.lineTo(Math.min(innerWidth, cam.x + (x1 + 1) * cam.zoom), py);
      }
      ctx.stroke();
    }

    // 他ユーザーのカーソル (枠だけ + 名前、非表示IDは除外)
    if (showCursors) {
      const nowMs = Date.now();
      for (const [tok, cur] of remotes) {
        if (tok === token) continue;
        if (cur.uid && blocked.has(cur.uid)) continue;
        if (nowMs - cur.updatedAt > 10000) continue;
        if (cur.x == null || cur.y == null) continue;
        if (cur.x < x0 || cur.x > x1 || cur.y < y0 || cur.y > y1) continue;
        const sx = cam.x + cur.x * cam.zoom, sy = cam.y + cur.y * cam.zoom;
        ctx.strokeStyle = cur.color || "#22aa66";
        ctx.lineWidth = 2.5;
        ctx.strokeRect(sx + 1, sy + 1, cam.zoom - 2, cam.zoom - 2);
        const label = cur.name || t("anon");
        ctx.font = "12px system-ui, sans-serif";
        const w = ctx.measureText(label).width + 12;
        const lx = Math.min(Math.max(4, sx), innerWidth - w - 4);
        const ly = Math.max(30, sy - 24);
        ctx.fillStyle = cur.color || "#22aa66";
        ctx.fillRect(lx, ly, w, 18);
        ctx.fillStyle = "#fff";
        ctx.fillText(label, lx + 6, ly + 13);
      }
    }

    // 自分のホバー (枠だけプレビュー)
    if (hover) {
      const sx = cam.x + hover.x * cam.zoom, sy = cam.y + hover.y * cam.zoom;
      ctx.strokeStyle = tool === "pen" ? (isDark ? "#fff" : "#111") : "#d00";
      ctx.lineWidth = 2;
      ctx.strokeRect(sx + 1, sy + 1, cam.zoom - 2, cam.zoom - 2);
      if (tool === "pen") {
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = ink === "rainbow" ? `hsl(${(Date.now() / 10) % 360},100%,55%)` : paintColor;
        ctx.fillRect(sx + 1, sy + 1, cam.zoom - 2, cam.zoom - 2);
        ctx.globalAlpha = 1;
      }
      if (showZone && myLevel < trustedLevel && !zoneAllowed(hover.x, hover.y, 0)) {
        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = "#e33";
        ctx.lineWidth = 2.5;
        ctx.strokeRect(sx + 1, sy + 1, cam.zoom - 2, cam.zoom - 2);
        ctx.restore();
      }
    }

    updateCooldownUI();
    requestAnimationFrame(render);
  }

  let cooldownShown = "";
  function updateCooldownUI() {
    const remain = Math.max(0, (cooldownUntil - Date.now()) / 1000);
    const text = remain > 0 ? t("cooldownToast", { s: remain.toFixed(1) }) : t("ready");
    if (text === cooldownShown) return; // 毎フレームのDOM更新を抑制
    cooldownShown = text;
    cooldownEl.textContent = text;
    cooldownEl.classList.toggle("cool", remain > 0);
  }

  function toast(msg, cls = "", action) {
    const el = document.createElement("div");
    el.className = "toast " + cls;
    el.textContent = msg;
    if (action) {
      const btn = document.createElement("button");
      btn.className = "toastBtn";
      btn.textContent = action.label;
      btn.onclick = () => {
        try {
          action.fn();
        } finally {
          el.remove();
        }
      };
      el.appendChild(btn);
    }
    toastWrap.appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .4s"; }, 2600);
    setTimeout(() => el.remove(), 3200);
    while (toastWrap.children.length > 3) toastWrap.firstChild.remove();
  }

  function refreshInkUI() {
    document.getElementById("c-glow").textContent = inventory.glow || 0;
    document.getElementById("c-rainbow").textContent = inventory.rainbow || 0;
    document.getElementById("c-ghost").textContent = inventory.ghost || 0;
    document.querySelectorAll(".ink").forEach((btn) => {
      const key = btn.dataset.ink;
      if (key === "normal") return;
      btn.disabled = (inventory[key] || 0) <= 0 && ink !== key;
    });
  }

  function refreshColorUI() {
    // 虹インクは色指定なしのためカラー選択を無効化 (設計図モードを除く)
    const disabled = tool === "pen" && ink === "rainbow" && !draftMode;
    colorBtn.disabled = disabled;
    swatchesEl.classList.toggle("disabled", disabled);
  }

  function refreshLevelUI() {
    levelEl.textContent = t("levelFmt", { level: myLevel, xp: myXp, need: xpNeeded });
    levelEl.title = t("levelTitleFmt", {
      level: myLevel,
      cooldown: cooldown.toFixed(1),
      remain: Math.max(0, xpNeeded - myXp),
    });
  }

  function applyLevelData(data) {
    if (!data) return;
    if (data.level) myLevel = data.level;
    if (data.xp != null) myXp = data.xp;
    if (data.xpNeeded) xpNeeded = data.xpNeeded;
    if (data.cooldown) cooldown = data.cooldown;
    refreshLevelUI();
  }

  function refreshOnlineUI() {
    onlineCount.textContent = String(remotes.size + 1);
  }

  function refreshUserList() {
    // 色と名前の一覧 (座標は出さない)
    const items = [{ uid: myUid, name: myName, color: myColor, country: myCountry, self: true }];
    for (const cur of remotes.values()) {
      items.push({ uid: cur.uid || "?", name: cur.name || t("anon"), color: cur.color || "#22aa66", country: cur.country });
    }
    items.sort((a, b) => (a.self ? -1 : b.self ? 1 : String(a.name).localeCompare(String(b.name), window.wdI18n.locale)));
    userList.innerHTML = "";
    for (const u of items) {
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = u.color;
      li.appendChild(dot);
      const label = document.createElement("span");
      label.className = "uname";
      label.textContent = `${flagEmoji(u.country)}${flagEmoji(u.country) ? " " : ""}${u.name} #${u.uid || "?"}`;
      li.appendChild(label);
      if (u.self) {
        const me = document.createElement("span");
        me.className = "selfTag";
        me.textContent = t("selfTag");
        li.appendChild(me);
      } else {
        const btn = document.createElement("button");
        btn.className = "blockBtn";
        const isBlocked = blocked.has(u.uid);
        btn.textContent = isBlocked ? t("unblockBtn") : t("blockBtn");
        btn.title = isBlocked ? t("blockTitle") : t("unblockTitle");
        btn.onclick = () => toggleBlock(u.uid);
        li.appendChild(btn);
      }
      userList.appendChild(li);
    }
    refreshOnlineUI();
  }

  function formatCoords(cell) {
    return `(${cell.x}, ${cell.y})`;
  }

  // ---------- server sync (viewport only) ----------
  async function loadInitial() {
    try {
      await ensureToken();
      await fetchViewport(); // 視野+余白だけ取得
      const me = await (await fetch(`/api/me?token=${encodeURIComponent(token)}&lang=${encodeURIComponent(window.wdI18n.lang)}`)).json();
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
        // サーバー側に保存済みがあればそちらを優先
        if (me.profile.name && localStorage.getItem("wd_name") == null) {
          myName = me.profile.name;
          profileName.value = myName;
        } else if (me.profile.name) {
          myName = profileName.value || me.profile.name;
        }
        if (me.profile.color && localStorage.getItem("wd_userColor") == null) {
          setProfileColor(me.profile.color);
        }
      }
      refreshInkUI();
      refreshColorUI();
      refreshUserList();
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
  function connectSocket() {
    if (socket) return;
    if (typeof io === "undefined") {
      setInterval(() => {
        fetchViewport();
        refreshOnlineUsers();
      }, 5000);
      return;
    }
    socket = io();
    socket.on("connect", () => {
      socketReady = true;
      socket.emit("hello", { token, name: myName, color: myColor, lang: window.wdI18n.lang });
    });
    socket.on("init", (d) => {
      background = d.background || background;
      if (d.cooldown) cooldown = d.cooldown;
      applyZoneData(d);
      refreshLevelUI();
      (d.online || []).forEach(applyRemote);
      refreshUserList();
      fetchViewport(); // 全量は送られてこないので視野を取得
    });
    socket.on("helloOk", (d) => {
      if (d.token && d.token !== token) {
        token = d.token;
        localStorage.setItem("wd_token", token);
      }
      inventory = { ...inventory, ...d.inventory };
      myCountry = d.country ?? null;
      myShowCountry = d.showCountry ?? true;
      countryChk.checked = myShowCountry;
      cooldownUntil = d.cooldownUntil ? d.cooldownUntil * 1000 : cooldownUntil;
      if (d.uid) {
        myUid = d.uid;
        myUidEl.textContent = `#${myUid}`;
      }
      applyLevelData(d);
      refreshInkUI();
      refreshUserList();
    });
    socket.on("pixel", (p) => {
      const key = `${p.x},${p.y}`;
      if (p.t === "normal" && String(p.c).toLowerCase() === background.toLowerCase()) pixels.delete(key);
      else pixels.set(key, { c: p.c, t: p.t, by: p.by || null, x: p.x, y: p.y });
      zoneDirty = true;
      if (pendingUndo && `${pendingUndo.x},${pendingUndo.y}` === key && p.by !== myUid) cancelUndo();
      if (historyMode && historyKey === key) showHistory(p.x, p.y);
    });
    socket.on("placeResult", (r) => {
      if (!r.ok && r.error === "cooldown") {
        cooldownUntil = r.cooldownUntil * 1000;
        toast(t("cooldownToast", { s: r.remaining }));
      }
    });
    socket.on("cursor", applyRemote);
    socket.on("presence", applyPresenceList);
    socket.on("leave", (d) => {
      if (d && d.token) remotes.delete(d.token);
      refreshUserList();
    });
  }

  function applyRemote(u) {
    if (!u || !u.token || u.token === token) return;
    const cur = remotes.get(u.token) || {};
    remotes.set(u.token, {
      uid: u.uid ?? cur.uid,
      name: u.name ?? cur.name ?? t("anon"),
      color: u.color ?? cur.color ?? "#22aa66",
      country: u.country ?? cur.country,
      x: u.x ?? cur.x,
      y: u.y ?? cur.y,
      updatedAt: Date.now(),
    });
    refreshOnlineUI();
  }

  function applyPresenceList(list) {
    const seen = new Set();
    (list || []).forEach((u) => {
      if (!u || !u.token || u.token === token) return; // 自分は除外
      seen.add(u.token);
      const cur = remotes.get(u.token) || {};
      remotes.set(u.token, { ...cur, uid: u.uid ?? cur.uid, name: u.name, color: u.color, country: u.country ?? cur.country, x: u.x ?? cur.x, y: u.y ?? cur.y, updatedAt: Date.now() });
    });
    for (const tok of [...remotes.keys()]) {
      if (tok !== token && !seen.has(tok)) remotes.delete(tok);
    }
    refreshUserList();
  }

  let lastCursorSent = 0;
  let lastCursorCell = "";
  function sendCursor(x, y) {
    if (!socket || !socketReady) return;
    const key = `${x},${y}`;
    const nowMs = Date.now();
    if (key === lastCursorCell && nowMs - lastCursorSent < 800) return;
    if (nowMs - lastCursorSent < cursorMinMs) return;
    lastCursorSent = nowMs;
    lastCursorCell = key;
    socket.emit("cursor", { token, x, y });
  }

  async function refreshOnlineUsers() {
    try {
      const data = await (await fetch("/api/users")).json();
      applyPresenceList(data.online || []);
    } catch {}
  }

  async function saveProfile() {
    myName = (profileName.value || "").trim().slice(0, 20) || t("anon");
    if (!/^#[0-9a-fA-F]{6}$/.test(myColor)) myColor = "#22aa66";
    localStorage.setItem("wd_name", myName);
    localStorage.setItem("wd_userColor", myColor);
    profileName.value = myName;
    try {
      await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name: myName, color: myColor, showCountry: myShowCountry }),
      });
      if (socket && socketReady) socket.emit("hello", { token, name: myName, color: myColor });
      toast(t("profileSaved", { name: myName }));
      refreshUserList();
    } catch {
      toast(t("profileFailed"));
    }
  }

  function formatTime(at) {
    try {
      return new Date(at * 1000).toLocaleString(window.wdI18n.locale);
    } catch {
      return "";
    }
  }

  function appendHistoryItems(x, y, items) {
    for (const item of items) {
      const li = document.createElement("li");
      const chip = document.createElement("span");
      chip.className = "chip";
      if (item.t === "erase") {
        chip.innerHTML = '<i class="bi bi-eraser"></i>';
      } else {
        chip.style.background = item.c;
      }
      li.appendChild(chip);
      const main = document.createElement("span");
      main.className = "hmain";
      const inkEl = document.createElement("b");
      inkEl.textContent = inkName(item.t);
      main.appendChild(inkEl);
      const who = document.createElement("span");
      who.className = "hwho";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = item.userColor || "#22aa66";
      who.appendChild(dot);
      who.appendChild(document.createTextNode(`${flagEmoji(item.country)}${flagEmoji(item.country) ? " " : ""}${item.name} #${item.uid || "?"}`));
      main.appendChild(who);
      const time = document.createElement("span");
      time.className = "htime";
      time.textContent = formatTime(item.at);
      main.appendChild(time);
      li.appendChild(main);
      if (item.uid && item.uid !== myUid) {
        const btn = document.createElement("button");
        btn.className = "blockBtn";
        btn.textContent = blocked.has(item.uid) ? t("unblockBtn") : t("blockBtn");
        btn.title = t("blockTitleBoth");
        btn.onclick = () => {
          toggleBlock(item.uid);
          showHistory(x, y);
        };
        li.appendChild(btn);
      }
      historyList.appendChild(li);
    }
  }

  async function showHistory(x, y, beforeId) {
    const fresh = beforeId == null;
    if (fresh) {
      historyKey = `${x},${y}`;
      historyTitle.textContent = t("historyTitleFmt", { x, y });
      historyList.innerHTML = "";
      const loading = document.createElement("li");
      loading.className = "muted";
      loading.textContent = t("historyLoading");
      historyList.appendChild(loading);
      historyPanel.classList.remove("hidden");
    }
    try {
      let url = `/api/history?x=${x}&y=${y}&limit=20`;
      if (beforeId != null) url += `&beforeId=${beforeId}`;
      const data = await (await fetch(url)).json();
      if (historyKey !== `${x},${y}`) return;
      if (fresh) historyList.innerHTML = "";
      else document.getElementById("historyMore")?.remove();
      const items = data.items || [];
      if (fresh && items.length === 0) {
        const li = document.createElement("li");
        li.className = "muted";
        li.textContent = t("historyEmpty");
        historyList.appendChild(li);
        return;
      }
      appendHistoryItems(x, y, items);
      if (data.hasMore && items.length > 0) {
        const more = document.createElement("li");
        const btn = document.createElement("button");
        btn.id = "historyMore";
        btn.className = "blockBtn";
        btn.textContent = t("historyMore");
        btn.onclick = () => showHistory(x, y, items[items.length - 1].id);
        more.appendChild(btn);
        historyList.appendChild(more);
      }
    } catch {
      if (historyKey !== `${x},${y}`) return;
      if (!fresh) return;
      historyList.innerHTML = "";
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = t("historyFailed");
      historyList.appendChild(li);
    }
  }

  function closeHistory() {
    historyPanel.classList.add("hidden");
    historyKey = null;
  }

  async function place(x, y) {
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
    const inkToUse = tool === "eraser" ? "erase" : ink;
    if (inkToUse !== "normal" && inkToUse !== "erase" && (inventory[inkToUse] || 0) <= 0) {
      toast(t("noInkRevert"));
      ink = "normal";
      document.querySelectorAll(".ink").forEach((btn) => btn.classList.toggle("active", btn.dataset.ink === "normal"));
      return;
    }
    try {
      const res = await fetch("/api/place", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x, y, color: paintColor, ink: inkToUse, token }),
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
        } else {
          toast(t("placeFailedToast", { error: data.error }));
        }
        return;
      }
      const prevForUndo = prevPix ? { c: prevPix.c, t: prevPix.t } : null;
      if (inkToUse === "erase") pixels.delete(key);
      else pixels.set(key, { c: data.pixel.c, t: data.pixel.t, by: data.by || myUid || null, x, y });
      cooldownUntil = data.cooldownUntil * 1000;
      inventory = data.inventory;
      applyLevelData(data);
      refreshInkUI();
      zoneDirty = true;
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
      const body = { token, x: target.x, y: target.y, prevEmpty: target.prev == null };
      if (target.prev) {
        body.prevC = target.prev.c;
        body.prevT = target.prev.t;
      }
      const res = await fetch("/api/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      if (data.pixel.erased) pixels.delete(key);
      else pixels.set(key, { c: data.pixel.c, t: data.pixel.t, by: data.by || myUid || null, x: target.x, y: target.y });
      inventory = data.inventory;
      refreshInkUI();
      applyLevelData(data);
      zoneDirty = true;
      toast(t("undoneToast"));
    } catch {
      toast(t("commError"));
    }
  }

  // ---------- input (left: paint on click + pan, right/middle: pan only) ----------
  let panning = false, moved = 0, lastPX = 0, lastPY = 0, downPos = null, downButton = 0;
  // 指タップはぶれやすいのでタップ判定の遊びを大きめに (マウスは精密なまま)
  let tapSlop = 6;
  const pointers = new Map();
  let pinchDist = 0;

  // 右クリックメニューを出さない (右ドラッグ移動のため)
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button === 1) e.preventDefault(); // 中クリックの自動スクロール抑止
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      panning = false;
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
    const downCell = screenToCell(e.clientX, e.clientY);
    sendCursor(downCell.x, downCell.y);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) {
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        zoomAt(cx, cy, dist / pinchDist);
      }
      pinchDist = dist;
      return;
    }
    const cell = screenToCell(e.clientX, e.clientY);
    hover = cell;
    coordsEl.textContent = formatCoords(cell);
    sendCursor(cell.x, cell.y);
    if (panning) {
      const dx = e.clientX - lastPX, dy = e.clientY - lastPY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > tapSlop) {
        cam.x += dx;
        cam.y += dy;
      }
      lastPX = e.clientX;
      lastPY = e.clientY;
    }
  });
  canvas.addEventListener("pointerup", (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (panning && pointers.size === 0) {
      if (moved <= tapSlop && downPos && downButton === 0) {
        const cell = screenToCell(e.clientX, e.clientY);
        // タップ操作の優先度: 履歴 > スポイト > 設計図 > 配置
        if (historyMode) showHistory(cell.x, cell.y);
        else if (eyedropMode) pickColor(cell.x, cell.y);
        else if (draftMode) paintDraft(cell.x, cell.y);
        else place(cell.x, cell.y);
      }
      panning = false;
    }
    if (pointers.size === 0) {
      scheduleViewportFetch(); // パン・ピンチ確定後に視野を再取得
      scheduleSaveCamera();
    }
  });
  canvas.addEventListener("pointercancel", (e) => {
    pointers.delete(e.pointerId);
    panning = false;
  });
  canvas.addEventListener("pointerleave", () => {
    hover = null;
  });

  function zoomAt(cx, cy, factor) {
    const old = cam.zoom;
    const next = Math.min(96, Math.max(1, old * factor));
    cam.x = cx - ((cx - cam.x) / old) * next;
    cam.y = cy - ((cy - cam.y) / old) * next;
    cam.zoom = next;
  }
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    scheduleViewportFetch();
    scheduleSaveCamera();
  }, { passive: false });

  // ---------- custom color picker (HEX/RGB/HSV/HSL) ----------
  const cpSvCtx = cpSv.getContext("2d");
  const cpState = { h: 0, s: 100, v: 100, fmt: "hex" };
  function clampNum(v, lo, hi, fallback = 0) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  }
  function hsvToRgb(h, s, v) {
    s /= 100;
    v /= 100;
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }
  function rgbToHsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const d = mx - mn;
    let h = 0;
    if (d !== 0) {
      if (mx === r) h = 60 * (((g - b) / d) % 6);
      else if (mx === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return [Math.round(h) % 360, Math.round((mx === 0 ? 0 : d / mx) * 100), Math.round(mx * 100)];
  }
  function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const l = (mx + mn) / 2;
    const d = mx - mn;
    let h = 0, s = 0;
    if (d !== 0) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (mx === r) h = 60 * (((g - b) / d) % 6);
      else if (mx === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return [Math.round(h) % 360, Math.round(s * 100), Math.round(l * 100)];
  }
  function hslToRgb(h, s, l) {
    s /= 100;
    l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }
  function rgbToHex(r, g, b) {
    const hx = (n) => clampNum(Math.round(n), 0, 255).toString(16).padStart(2, "0");
    return `#${hx(r)}${hx(g)}${hx(b)}`;
  }
  function parseHexToRgb(text) {
    let t = String(text || "").trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{3}$/.test(t)) t = t.split("").map((c) => c + c).join("");
    if (!/^[0-9a-fA-F]{6}$/.test(t)) return null;
    const n = parseInt(t, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function cpCurrentHex() {
    return rgbToHex(...hsvToRgb(cpState.h, cpState.s, cpState.v));
  }
  function drawCpSv() {
    const w = cpSv.width, h = cpSv.height;
    const hueCss = `hsl(${cpState.h},100%,50%)`;
    const gradH = cpSvCtx.createLinearGradient(0, 0, w, 0);
    gradH.addColorStop(0, "#ffffff");
    gradH.addColorStop(1, hueCss);
    cpSvCtx.fillStyle = gradH;
    cpSvCtx.fillRect(0, 0, w, h);
    const gradV = cpSvCtx.createLinearGradient(0, 0, 0, h);
    gradV.addColorStop(0, "rgba(0,0,0,0)");
    gradV.addColorStop(1, "rgba(0,0,0,1)");
    cpSvCtx.fillStyle = gradV;
    cpSvCtx.fillRect(0, 0, w, h);
    const px = (cpState.s / 100) * w;
    const py = (1 - cpState.v / 100) * h;
    cpSvCtx.strokeStyle = "#fff";
    cpSvCtx.lineWidth = 2;
    cpSvCtx.beginPath();
    cpSvCtx.arc(px, py, 7, 0, Math.PI * 2);
    cpSvCtx.stroke();
    cpSvCtx.strokeStyle = "#000";
    cpSvCtx.lineWidth = 1;
    cpSvCtx.beginPath();
    cpSvCtx.arc(px, py, 7, 0, Math.PI * 2);
    cpSvCtx.stroke();
  }
  function syncCpForms() {
    const [r, g, b] = hsvToRgb(cpState.h, cpState.s, cpState.v);
    const [hh, ss, ll] = rgbToHsl(r, g, b);
    cpHue.value = String(Math.round(cpState.h));
    cpHex.value = cpCurrentHex().slice(1);
    cpR.value = String(r);
    cpG.value = String(g);
    cpB.value = String(b);
    cpHsvH.value = String(Math.round(cpState.h));
    cpHsvS.value = String(Math.round(cpState.s));
    cpHsvV.value = String(Math.round(cpState.v));
    cpHslH.value = String(hh);
    cpHslS.value = String(ss);
    cpHslL.value = String(ll);
    cpPreview.style.background = cpCurrentHex();
    drawCpSv();
    cpApply(cpCurrentHex());
  }
  function cpFromRgb(r, g, b) {
    const [h, s, v] = rgbToHsv(clampNum(r, 0, 255), clampNum(g, 0, 255), clampNum(b, 0, 255));
    cpState.h = h;
    cpState.s = s;
    cpState.v = v;
    syncCpForms();
  }
  function cpSvPoint(e) {
    const rect = cpSv.getBoundingClientRect();
    const cx = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX) - rect.left;
    const cy = (e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY) - rect.top;
    cpState.s = clampNum((cx / rect.width) * 100, 0, 100);
    cpState.v = clampNum((1 - cy / rect.height) * 100, 0, 100);
    syncCpForms();
  }
  let cpDragging = false;
  cpSv.addEventListener("pointerdown", (e) => {
    cpDragging = true;
    cpSv.setPointerCapture(e.pointerId);
    cpSvPoint(e);
  });
  cpSv.addEventListener("pointermove", (e) => {
    if (cpDragging) cpSvPoint(e);
  });
  cpSv.addEventListener("pointerup", () => {
    cpDragging = false;
  });
  cpHue.addEventListener("input", () => {
    cpState.h = clampNum(cpHue.value, 0, 359);
    syncCpForms();
  });
  cpHex.addEventListener("change", () => {
    const rgb = parseHexToRgb(cpHex.value);
    if (rgb) cpFromRgb(...rgb);
    else syncCpForms();
  });
  const cpNum = (el, fn) => el.addEventListener("change", fn);
  cpNum(cpR, () => cpFromRgb(cpR.value, cpG.value, cpB.value));
  cpNum(cpG, () => cpFromRgb(cpR.value, cpG.value, cpB.value));
  cpNum(cpB, () => cpFromRgb(cpR.value, cpG.value, cpB.value));
  cpNum(cpHsvH, () => {
    cpState.h = clampNum(cpHsvH.value, 0, 359);
    cpState.s = clampNum(cpHsvS.value, 0, 100);
    cpState.v = clampNum(cpHsvV.value, 0, 100);
    syncCpForms();
  });
  cpNum(cpHsvS, () => {
    cpState.h = clampNum(cpHsvH.value, 0, 359);
    cpState.s = clampNum(cpHsvS.value, 0, 100);
    cpState.v = clampNum(cpHsvV.value, 0, 100);
    syncCpForms();
  });
  cpNum(cpHsvV, () => {
    cpState.h = clampNum(cpHsvH.value, 0, 359);
    cpState.s = clampNum(cpHsvS.value, 0, 100);
    cpState.v = clampNum(cpHsvV.value, 0, 100);
    syncCpForms();
  });
  cpNum(cpHslH, () => {
    const [r, g, b] = hslToRgb(
      clampNum(cpHslH.value, 0, 359), clampNum(cpHslS.value, 0, 100), clampNum(cpHslL.value, 0, 100)
    );
    cpFromRgb(r, g, b);
  });
  cpNum(cpHslS, () => {
    const [r, g, b] = hslToRgb(
      clampNum(cpHslH.value, 0, 359), clampNum(cpHslS.value, 0, 100), clampNum(cpHslL.value, 0, 100)
    );
    cpFromRgb(r, g, b);
  });
  cpNum(cpHslL, () => {
    const [r, g, b] = hslToRgb(
      clampNum(cpHslH.value, 0, 359), clampNum(cpHslS.value, 0, 100), clampNum(cpHslL.value, 0, 100)
    );
    cpFromRgb(r, g, b);
  });
  document.querySelectorAll(".cpTabs button").forEach((btn) => {
    btn.onclick = () => {
      cpState.fmt = btn.dataset.fmt;
      document.querySelectorAll(".cpTabs button").forEach((el) => el.classList.toggle("active", el === btn));
      document.querySelectorAll(".cpForm").forEach((el) => el.classList.toggle("hidden", el.dataset.fmt !== cpState.fmt));
    };
  });
  let cpTarget = { kind: "paint" };
  function cpApply(hex) {
    if (cpTarget.kind === "profile") {
      setProfileColor(hex);
      return;
    }
    if (cpTarget.kind === "swatch") {
      palette[cpTarget.index] = hex;
      const el = swatchesEl.children[cpTarget.index];
      if (el) {
        el.style.background = hex;
        el.dataset.color = hex;
        el.title = t("swatchTitle", { c: hex });
      }
    }
    setPaintColor(hex);
  }
  function openColorPanel(target) {
    cpTarget = target || { kind: "paint" };
    const current =
      cpTarget.kind === "profile"
        ? myColor
        : cpTarget.kind === "swatch"
          ? palette[cpTarget.index]
          : paintColor;
    const rgb = parseHexToRgb(current);
    if (rgb) cpFromRgb(...rgb);
    else {
      cpState.h = 0;
      cpState.s = 100;
      cpState.v = 100;
      syncCpForms();
    }
    colorPanel.classList.remove("hidden");
  }
  function closeColorPanel() {
    if (cpTarget.kind === "swatch") {
      savePalette();
      renderSwatches();
    }
    colorPanel.classList.add("hidden");
  }
  colorBtn.onclick = () => openColorPanel({ kind: "paint" });
  profileColorBtn.onclick = () => openColorPanel({ kind: "profile" });
  colorClose.onclick = closeColorPanel;
  cpOk.onclick = closeColorPanel;

  // ---------- toolbar ----------
  function setHistoryMode(on) {
    historyMode = on;
    toolHistory.classList.toggle("active", on);
    if (on) setEyedropMode(false);
    canvas.style.cursor = on ? "help" : "";
    if (on)       toast(t("historyModeToast"));
    else closeHistory();
  }
  function setDraftMode(on) {
    // 設計図はレイヤー扱い。筆・消しゴム・履歴・スポイトの切替では維持される。
    // ボタンで入るときだけタップ操作を設計図に戻す
    draftMode = on;
    toolDraft.classList.toggle("active", on);
    if (on) {
      setHistoryMode(false);
      setEyedropMode(false);
      toast(t("draftModeToast"));
    }
    refreshColorUI();
  }
  function setEyedropMode(on) {
    eyedropMode = on;
    toolEyedropper.classList.toggle("active", on);
    if (on) {
      setHistoryMode(false);
      toast(t("eyedropToast"));
    }
    canvas.style.cursor = on ? "copy" : "";
  }
  function pickColor(x, y) {
    const pix = pixels.get(`${x},${y}`);
    if (!pix) {
      toast(t("emptyCellToast"));
      return;
    }
    let hex = pix.c;
    const pickedInk = pix.t || "normal";
    if (pix.t === "rainbow") {
      // 表示色（アニメーション中の色相）から算出
      const hue = (x * 7 + y * 13 + (Date.now() / 1000) * 90) % 360;
      const [r, g, b] = hslToRgb(hue, 100, 55);
      hex = rgbToHex(r, g, b);
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(hex || "")) {
      toast(t("eyedropNoColor"));
      return;
    }
    hex = String(hex).toLowerCase();
    setPaintColor(hex);
    // 色とあわせてインクも取得（所持なしは色のみ・インクは維持）
    const inkLabel = inkName(pickedInk);
    if (pickedInk !== "normal" && (inventory[pickedInk] || 0) <= 0) {
      toast(t("eyedropInkMissing", { hex, ink: inkLabel }));
    } else {
      ink = pickedInk;
      document.querySelectorAll(".ink").forEach((el) => el.classList.toggle("active", el.dataset.ink === ink));
      toast(t("eyedropGot", { hex, ink: inkLabel }));
    }
    setEyedropMode(false);
    tool = "pen";
    toolPen.classList.add("active");
    toolEraser.classList.remove("active");
    refreshColorUI();
  }
  toolPen.onclick = () => {
    tool = "pen";
    toolPen.classList.add("active");
    toolEraser.classList.remove("active");
    setHistoryMode(false);
    setEyedropMode(false);
    refreshColorUI();
  };
  toolEraser.onclick = () => {
    tool = "eraser";
    toolEraser.classList.add("active");
    toolPen.classList.remove("active");
    setHistoryMode(false);
    setEyedropMode(false);
    refreshColorUI();
  };
  toolHistory.onclick = () => setHistoryMode(!historyMode);
  toolDraft.onclick = () => setDraftMode(!draftMode);
  toolEyedropper.onclick = () => setEyedropMode(!eyedropMode);
  historyClose.onclick = () => setHistoryMode(false);
  document.querySelectorAll(".ink").forEach((btn) => {
    btn.onclick = () => {
      const key = btn.dataset.ink;
      if (key !== "normal" && (inventory[key] || 0) <= 0) {
        toast(t("inkMissingToast"));
        return;
      }
      ink = key;
      document.querySelectorAll(".ink").forEach((el) => el.classList.toggle("active", el === btn));
      if (key !== "normal") {
        tool = "pen";
        toolPen.classList.add("active");
        toolEraser.classList.remove("active");
      }
      setEyedropMode(false);
      refreshColorUI();
    };
  });
  onlineEl.onclick = () => userPanel.classList.toggle("hidden");
  function flagEmoji(cc) {
    if (typeof cc !== "string" || !/^[A-Za-z]{2}$/.test(cc)) return "";
    return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 127397 + c.charCodeAt(0)));
  }
  async function saveShowCountry() {
    const show = countryChk.checked;
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name: myName, color: myColor, showCountry: show }),
      });
      const data = await res.json();
      if (!data.ok) {
        toast(t("profileFailed"));
        countryChk.checked = myShowCountry;
        return;
      }
      myShowCountry = data.profile.showCountry;
      myCountry = data.profile.country ?? null;
      countryChk.checked = myShowCountry;
      refreshUserList();
    } catch {
      toast(t("commError"));
      countryChk.checked = myShowCountry;
    }
  }
  undoBtn.onclick = doUndo;
  // ツールバー折りたたみ (描画領域の確保・端末に保存)
  let chromeHidden = false;
  try {
    chromeHidden = localStorage.getItem("wd_chromeHidden") === "1";
  } catch {}
  function applyChrome() {
    toolbarEl.classList.toggle("collapsed", chromeHidden);
    document.body.classList.toggle("chromeHidden", chromeHidden);
    const icon = chromeToggle.querySelector("i");
    if (icon) icon.className = chromeHidden ? "bi bi-chevron-up" : "bi bi-chevron-down";
  }
  chromeToggle.onclick = () => {
    chromeHidden = !chromeHidden;
    try {
      localStorage.setItem("wd_chromeHidden", chromeHidden ? "1" : "0");
    } catch {}
    applyChrome();
  };
  applyChrome();
  accountBtn.onclick = () => accountPanel.classList.toggle("hidden");
  accountClose.onclick = () => accountPanel.classList.add("hidden");
  countryChk.checked = myShowCountry;
  countryChk.onchange = saveShowCountry;
  issueBtn.onclick = async () => {
    const pw = issuePassword.value || "";
    if (pw.length < 8) {
      toast(t("pwLenToast"));
      return;
    }
    try {
      const res = await fetch("/api/account/issue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: pw }),
      });
      const data = await res.json();
      if (!data.ok) {
        toast(t("issueFailed", { error: data.error || "" }));
        return;
      }
      issueResult.textContent = data.code;
      issueResult.classList.remove("hidden");
      issuePassword.value = "";
      toast(t("issuedToast"));
    } catch {
      toast(t("commError"));
    }
  };
  loginBtn.onclick = async () => {
    try {
      const res = await fetch("/api/account/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: loginCode.value, password: loginPassword.value }),
      });
      const data = await res.json();
      if (!data.ok) {
        toast(t(data.error === "locked" ? "lockedToast" : "badLoginToast"));
        return;
      }
      localStorage.setItem("wd_token", data.token);
      location.reload();
    } catch {
      toast(t("commError"));
    }
  };
  gridToggle.onchange = () => { showGrid = gridToggle.checked; };
  cursorToggle.onchange = () => { showCursors = cursorToggle.checked; };
  draftToggle.onchange = () => {
    showDrafts = draftToggle.checked;
    localStorage.setItem("wd_showDraft", showDrafts ? "1" : "0");
  };
  draftToggle.checked = showDrafts;
  axisToggle.onchange = () => {
    showAxes = axisToggle.checked;
    try {
      localStorage.setItem("wd_showAxes", showAxes ? "1" : "0");
    } catch {}
  };
  axisToggle.checked = showAxes;
  zoneToggle.onchange = () => {
    showZone = zoneToggle.checked;
    try {
      localStorage.setItem("wd_showZone", showZone ? "1" : "0");
    } catch {}
  };
  zoneToggle.checked = showZone;
  let cursorMinMs = 80;
  try {
    const savedRate = localStorage.getItem("wd_cursorRate");
    if (["200", "80", "30", "15", "5"].includes(savedRate)) {
      cursorMinMs = Number(savedRate);
    }
  } catch {}
  cursorRateSel.value = String(cursorMinMs);
  cursorRateSel.onchange = () => {
    cursorMinMs = Number(cursorRateSel.value) || 80;
    try {
      localStorage.setItem("wd_cursorRate", String(cursorMinMs));
    } catch {}
  };
  // 言語切替時の動的UIの再描画 (静的文言は i18n.js が適用)
  window.wdLocaleRefresh = () => {
    renderSwatches();
    refreshLevelUI();
    refreshUserList();
    cooldownShown = "";
    updateCooldownUI();
    if (historyMode && historyKey) {
      const [hx, hy] = historyKey.split(",").map(Number);
      showHistory(hx, hy);
    }
  };
  settingsBtn.onclick = () => settingsPanel.classList.toggle("hidden");
  profileSave.onclick = saveProfile;
  profileName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveProfile();
  });
  document.getElementById("zoomIn").onclick = () => { zoomAt(innerWidth / 2, innerHeight / 2, 1.4); scheduleViewportFetch(); scheduleSaveCamera(); };
  document.getElementById("zoomOut").onclick = () => { zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.4); scheduleViewportFetch(); scheduleSaveCamera(); };
  document.getElementById("zoomOrigin").onclick = goOrigin;
  document.getElementById("zoomOrigin").onclick = goOrigin;

  loadInitial().then(() => requestAnimationFrame(render));
  if (document.readyState === "complete") connectSocket();
  else window.addEventListener("load", connectSocket);
  setTimeout(() => { if (!socket) connectSocket(); }, 1500);
  refreshInkUI();
  refreshColorUI();
  refreshLevelUI();
  refreshUserList();
})();
