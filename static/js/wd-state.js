// wd-state.js — 共有のDOM参照・定数・状態 + dirtyフラグ基盤。最初に読むこと。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
"use strict";

  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
  // forceWebsocket時 (サーバーがWS専用) はpollingを使わない。metaはindexのみ保有
  const wsOnly = (() => {
    try {
      const m = document.querySelector('meta[name="wd-wsonly"]');
      return !!m && m.content === "1";
    } catch {
      return false;
    }
  })();
  const coordsEl = document.getElementById("coords");
  const cooldownEl = document.getElementById("cooldown");
  const levelEl = document.getElementById("level");
  const onlineEl = document.getElementById("online");
  const onlineCount = document.getElementById("onlineCount");
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsPanel = document.getElementById("settingsPanel");
  const settingsClose = document.getElementById("settingsClose");
  const gridToggle = document.getElementById("gridToggle");
  const cursorToggle = document.getElementById("cursorToggle");
  const draftToggle = document.getElementById("draftToggle");
  const axisToggle = document.getElementById("axisToggle");
  const zoneToggle = document.getElementById("zoneToggle");
  const cursorRateSel = document.getElementById("cursorRateSel");
  const simplifySel = document.getElementById("simplifySel");
  const qualitySel = document.getElementById("qualitySel");
  const glowSel = document.getElementById("glowSel");
  const shieldToggle = document.getElementById("shieldToggle");
  const statsToggle = document.getElementById("statsToggle");
  const rightClickSel = document.getElementById("rightClickSel");
  const middleClickSel = document.getElementById("middleClickSel");
  const themeSel = document.getElementById("themeSel");
  const colorBtn = document.getElementById("colorBtn");
  const colorChip = document.getElementById("colorChip");
  const swatchesEl = document.getElementById("swatches");
  const toolPen = document.getElementById("toolPen");
  const toolEraser = document.getElementById("toolEraser");
  const toolHistory = document.getElementById("toolHistory");
  const toolDraft = document.getElementById("toolDraft");
  const toolEyedropper = document.getElementById("toolEyedropper");
  const draftBar = document.getElementById("draftBar");
  const draftUndoBtn = document.getElementById("draftUndo");
  const draftClearBtn = document.getElementById("draftClear");
  const toastWrap = document.getElementById("toast-wrap");
  const profileName = document.getElementById("profileName");
  const profileColorBtn = document.getElementById("profileColorBtn");
  const profileColorChip = document.getElementById("profileColorChip");
  const profileSave = document.getElementById("profileSave");
  const myUidEl = document.getElementById("myUid");
  const userPanel = document.getElementById("userPanel");
  const userList = document.getElementById("userList");
  const userClose = document.getElementById("userClose");
  const rankingBtn = document.getElementById("rankingBtn");
  const rankingPanel = document.getElementById("rankingPanel");
  const rankingList = document.getElementById("rankingList");
  const rankingClose = document.getElementById("rankingClose");
  const profilePanel = document.getElementById("profilePanel");
  const profileCard = document.getElementById("profileCard");
  const profileClose = document.getElementById("profileClose");
  const historyPanel = document.getElementById("historyPanel");
  const historyTitle = document.getElementById("historyTitle");
  const historyList = document.getElementById("historyList");
  const historyClose = document.getElementById("historyClose");
  const undoBtn = document.getElementById("undoBtn");
  const colorPanel = document.getElementById("colorPanel");
  const colorClose = document.getElementById("colorClose");
  const cpSv = document.getElementById("cpSv");
  const cpHueBar = document.getElementById("cpHueBar");
  const cpHex = document.getElementById("cpHex");
  const cpR = document.getElementById("cpR");
  const cpG = document.getElementById("cpG");
  const cpB = document.getElementById("cpB");
  const cpRs = document.getElementById("cpRs");
  const cpGs = document.getElementById("cpGs");
  const cpBs = document.getElementById("cpBs");
  const cpHsvH = document.getElementById("cpHsvH");
  const cpHsvS = document.getElementById("cpHsvS");
  const cpHsvV = document.getElementById("cpHsvV");
  const cpHsvHs = document.getElementById("cpHsvHs");
  const cpHsvSs = document.getElementById("cpHsvSs");
  const cpHsvVs = document.getElementById("cpHsvVs");
  const cpLchL = document.getElementById("cpLchL");
  const cpLchC = document.getElementById("cpLchC");
  const cpLchH = document.getElementById("cpLchH");
  const cpLchLs = document.getElementById("cpLchLs");
  const cpLchCs = document.getElementById("cpLchCs");
  const cpLchHs = document.getElementById("cpLchHs");
  const cpBasicGrid = document.getElementById("cpBasicGrid");
  const cpRecentGrid = document.getElementById("cpRecentGrid");
  const cpRecentEmpty = document.getElementById("cpRecentEmpty");
  const cpPreview = document.getElementById("cpPreview");
  const cpOk = document.getElementById("cpOk");
  const issuePassword = document.getElementById("issuePassword");
  const issueBtn = document.getElementById("issueBtn");
  const issueResult = document.getElementById("issueResult");
  const loginCode = document.getElementById("loginCode");
  const loginPassword = document.getElementById("loginPassword");
  const loginBtn = document.getElementById("loginBtn");
  const countryChk = document.getElementById("countryChk");
  const adminBtn = document.getElementById("adminBtn");
  // 管理操作は /admin ページに統一 (キャンバス内の管理モーダルは持たない)
  const noticesBtn = document.getElementById("noticesBtn");
  const noticesBadge = document.getElementById("noticesBadge");
  const statsOverlay = document.getElementById("statsOverlay");
  const stFps = document.getElementById("stFps");
  const stMs = document.getElementById("stMs");
  const stCache = document.getElementById("stCache");
  const stDraw = document.getElementById("stDraw");
  const stUp = document.getElementById("stUp");
  const stDown = document.getElementById("stDown");
  const stGraph = document.getElementById("stGraph");
  const chatBtn = document.getElementById("chatBtn");
  const chatBadge = document.getElementById("chatBadge");
  const chatDock = document.getElementById("chatDock");
  const chatList = document.getElementById("chatList");
  const chatMore = document.getElementById("chatMore");
  const chatNew = document.getElementById("chatNew");
  const chatForm = document.getElementById("chatForm");
  const chatInput = document.getElementById("chatInput");
  const chatCount = document.getElementById("chatCount");
  const chatSend = document.getElementById("chatSend");
  const chatClose = document.getElementById("chatClose");
  const chatReplyBar = document.getElementById("chatReplyBar");
  const chatReplyLabel = document.getElementById("chatReplyLabel");
  const chatReplyCancel = document.getElementById("chatReplyCancel");
  const toolbarEl = document.getElementById("toolbar");
  const chromeToggle = document.getElementById("chromeToggle");
  const t = (key, params) => window.wdI18n.t(key, params);
  // 重ねがけ ("ghost+glow") は各名を合成表示
  const inkName = (k) => String(k || "").split("+").map((p) => t("inkL_" + p)).join("+");

  const coordLimit = 1000000;
  const fetchMargin = 256; // 視野外の保持余白セル数 (要求は視野きっかり。保持・WS選別用)
  const maxCache = 150000; // 手元に保持するピクセル数の上限
  const maxDrafts = 2000000; // 設計図の保持上限 (メモリ上)
  // 端末保存 (localStorage約5MB) には全件入らないため先頭まで。
  // 超過分はメモリ上でのみ保持し、再訪で消える。
  const DRAFT_SAVE_MAX = 20000;
  // 端末タイムゾーン (国旗の推定用。CF-IPCountryが無い場合の代替)
  const myTz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch {
      return "";
    }
  })();

  // ---------- state (camelCase) ----------
  let background = "#ffffff";
  let cooldown = 10;
  let myLevel = 1, myXp = 0, xpNeeded = 3;
  const pixels = new Map(); // "x,y" -> {c, t, by}
  const remotes = new Map(); // uid -> {uid, name, color, x, y, updatedAt} (tokenは扱わない)
  let inventory = { glow: 0, rainbow: 0, ghost: 0 };
  let cooldownUntil = 0;
  // クールダウンの表示・ゲート用マージン (早読み防止。表示と送信可否は同じ式で統一)。
  // 実RTTに応じて伸ばす (往復のばらつきを吸収。上限3秒)
  const COOLDOWN_MARGIN_BASE_MS = 700;
  const COOLDOWN_MARGIN_MAX_MS = 3000;
  let rttEmaMs = 0; // place・me の往復時間の指数平均 (applyLevelDataで学習)
  function cooldownMarginMs() {
    const m = COOLDOWN_MARGIN_BASE_MS + (rttEmaMs > 0 ? rttEmaMs : 0);
    return Math.min(COOLDOWN_MARGIN_MAX_MS, Math.max(COOLDOWN_MARGIN_BASE_MS, m));
  }
  // サーバ時計との差 (serverNow*1000 - Date.now())。applyLevelDataで学習する
  let serverOffsetMs = 0;
  let serverOffsetInit = true;
  function adjustedNowMs() {
    return Date.now() + serverOffsetMs;
  }
  // 仮想サーバ時計。WS kind=9 (接続直後＋1分毎) で補正し、
  // 間は単調時計でローカルと同じ増え方をする。未同期時はREST学習値に落とす
  let serverTimeBase = 0; // 最終同期時のサーバ時刻ms
  let serverTimePerf = 0; // 同期時のperformance.now()
  let serverTimeSynced = false;
  function serverClockSync(serverSec) {
    const n = Number(serverSec);
    if (!Number.isFinite(n) || n <= 0) return;
    serverTimeBase = n * 1000;
    try {
      serverTimePerf = performance.now();
    } catch {
      try {
        serverTimePerf = Date.now();
      } catch {
        serverTimePerf = 0;
      }
    }
    serverTimeSynced = true;
  }
  function serverPerfNow() {
    try {
      if (typeof performance !== "undefined" && typeof performance.now === "function") {
        return performance.now();
      }
    } catch {}
    try {
      return Date.now();
    } catch {
      return 0;
    }
  }
  function serverNowMs() {
    if (serverTimeSynced) return serverTimeBase + (serverPerfNow() - serverTimePerf);
    return adjustedNowMs();
  }
  let tool = "pen";
  // 特殊インクの複数押し選択。空=通常。正準形はソート結合 ("ghost+glow")
  const inkSet = new Set();
  function inkKey() {
    return inkSet.size === 0 ? "normal" : [...inkSet].sort().join("+");
  }
  function syncInkButtons() {
    document.querySelectorAll(".ink").forEach((el) => {
      const k = el.dataset.ink;
      el.classList.toggle("active", k === "normal" ? inkSet.size === 0 : inkSet.has(k));
    });
  }
  let showGrid = true;
  let showCursors = true;
  let showAxes = true;
  let showZone = true;
  try {
    if (localStorage.getItem("wd_showAxes") === "0") showAxes = false;
    if (localStorage.getItem("wd_showZone") === "0") showZone = false;
  } catch {}
  // 簡易表示 (ズーム連動の描画レベル) と画質 (解像度スケール)。設定パネルから変更
  let simplifyMode = "auto"; // "auto" | "off"
  let qualityMode = "high"; // "ultra" | "high" | "medium" | "low" | "minimal"
  try {
    if (localStorage.getItem("wd_simplify") === "off") simplifyMode = "off";
    const savedQ = localStorage.getItem("wd_quality");
    if (["ultra", "medium", "low", "minimal"].includes(savedQ)) qualityMode = savedQ;
  } catch {}
  function dprCap() {
    if (qualityMode === "minimal") return 0.75;
    return qualityMode === "low" ? 1 : qualityMode === "medium" ? 1.5 : 2;
  }
  // 発光の強さ (全テーマ統一) とシールド表示。設定パネルから変更
  let glowMode = "medium"; // "off" | "weak" | "medium" | "strong" | "excessive"
  let showShield = true;
  // 統計オーバーレイ (既定は非表示)。表示中のみ500ms毎に更新する
  let showStats = false;
  // 直近フレーム時間の履歴 (統計グラフ用。最大120件のリング)
  const frameMsHist = [];
  // 直近フレームの簡易表示レベル (統計の描画表示用)
  let renderDl = 0;
  try {
    const savedGlow = localStorage.getItem("wd_glow");
    if (["off", "weak", "medium", "strong", "excessive"].includes(savedGlow)) glowMode = savedGlow;
    if (localStorage.getItem("wd_showShield") === "0") showShield = false;
    if (localStorage.getItem("wd_showStats") === "1") showStats = true;
  } catch {}
  // 現在の描画DPR (resize時に設定。セル矩形のスナップ基準に使う)
  let viewDpr = 1;
  let trustedLevel = 5;
  let placeRadius = 1000;
  let hover = null;
  let fpsEma = 0, fpsLastT = 0;
  let historyMode = false;
  let eyedropMode = false;
  let historyKey = null;
  let draftMode = false;
  // 点・矩形・直線・円・バケツの切替 (サブバー)。端末に保存
  let draftTool = "dot";
  try {
    const savedTool = localStorage.getItem("wd_draftTool");
    if (["dot", "rect", "line", "circle", "bucket"].includes(savedTool)) draftTool = savedTool;
  } catch {}
  let showDrafts = localStorage.getItem("wd_showDraft") !== "0";
  const drafts = new Map(); // "x,y" -> "#rrggbb" (自分専用・サーバー送信なし)
  const draftDirty = new Map(); // key -> color|null (nullは削除。IDB差分書込用)
  let draftNeedsFullSave = false; // 移行直後の全件書込フラグ
  let draftSavePending = false; // IDB準備前の保存要求 (準備後に全件保存)
  let draftSaveTimer = 0;
  let draftFlushing = false;
  let draftStoreReady = false; // initDraftStore完了まで保存要求は全件保存へ回す
  const DRAFT_FLUSH_MS = 1000; // 保存デバウンス (連打中の書込を抑える)
  function draftDb() {
    try {
      return window.wdDraftDb || null;
    } catch {
      return null;
    }
  }
  function validDraftKey(key) {
    return /^-?\d+,-?\d+$/.test(key || "");
  }
  function validDraftColor(color) {
    return /^#[0-9a-fA-F]{6}$/.test(color || "");
  }
  // 変更点の記録付き更新 (wd-drafts.jsの全更新経路はこの3つを使うこと)
  function draftSetCell(key, color) {
    drafts.set(key, color);
    draftDirty.set(key, color);
  }
  function draftDelCell(key) {
    if (drafts.delete(key)) draftDirty.set(key, null);
  }
  function draftClearCells() {
    if (drafts.size === 0) return;
    for (const key of drafts.keys()) draftDirty.set(key, null);
    drafts.clear();
  }
  // 戻り値: 読込件数。既存キー優先 (起動直後の描画との競合は手元を勝たせる)
  function legacyDraftLoad() {
    let n = 0;
    try {
      const saved = JSON.parse(localStorage.getItem("wd_draft") || "{}");
      if (saved && typeof saved === "object") {
        for (const [key, color] of Object.entries(saved)) {
          if (drafts.size >= maxDrafts) break;
          if (drafts.has(key)) continue;
          if (validDraftKey(key) && validDraftColor(color)) {
            drafts.set(key, color);
            n++;
          }
        }
      }
    } catch {}
    return n;
  }
  function legacyDraftSave() {
    // IDB不可時の代替。容量上限のため先頭まで
    try {
      const out = {};
      let n = 0;
      for (const [key, color] of drafts) {
        if (n >= DRAFT_SAVE_MAX) break;
        out[key] = color;
        n++;
      }
      localStorage.setItem("wd_draft", JSON.stringify(out));
    } catch {}
  }
  function removeLegacyDraft() {
    try {
      localStorage.removeItem("wd_draft");
    } catch {}
  }
  function saveDrafts() {
    // hot pathからはスケジュールのみ。実書込はIDBへ非同期・デバウンス
    try {
      if (!draftStoreReady) draftSavePending = true;
      if (draftDb()) scheduleDraftFlush(false);
      else legacyDraftSave();
    } catch {
      try {
        legacyDraftSave();
      } catch {}
    }
    markStatic();
  }
  function scheduleDraftFlush(immediate) {
    try {
      if (draftSaveTimer) {
        if (!immediate) return;
        clearTimeout(draftSaveTimer);
        draftSaveTimer = 0;
      }
      if (immediate) {
        flushDrafts();
        return;
      }
      draftSaveTimer = setTimeout(() => {
        draftSaveTimer = 0;
        flushDrafts();
      }, DRAFT_FLUSH_MS);
    } catch {}
  }
  async function flushDrafts() {
    if (draftFlushing) {
      scheduleDraftFlush(false);
      return;
    }
    const db = draftDb();
    if (!db) {
      try {
        legacyDraftSave();
      } catch {}
      return;
    }
    draftFlushing = true;
    try {
      if (draftNeedsFullSave) {
        draftNeedsFullSave = false;
        const entries = [...drafts.entries()];
        draftDirty.clear();
        const ok = await db.replaceAll(entries);
        if (!ok) draftNeedsFullSave = true; // 次回再試行
        return;
      }
      if (draftDirty.size === 0) return;
      const batch = new Map(draftDirty);
      draftDirty.clear();
      const ok = await db.applyDirty(batch);
      if (!ok) {
        // 失敗分は戻して次回再試行
        for (const [k, v] of batch) {
          if (!draftDirty.has(k)) draftDirty.set(k, v);
        }
        scheduleDraftFlush(false);
      }
    } catch {
      try {
        scheduleDraftFlush(false);
      } catch {}
    } finally {
      draftFlushing = false;
    }
  }
  // 設計図ストア初期化 (非同期)。IDB優先、空ならlocalStorageを引き継いで移行する。
  // 旧サイトhandoff直後 (wd_mig_done + wd_draftあり) はlocalStorageを正として置換する。
  // localStorage側はIDB化前の残骸のため、取り込み後は削除する。
  function initDraftStore() {
    const finish = () => {
      draftStoreReady = true;
      try {
        if (typeof rebuildDraftList === "function") rebuildDraftList();
      } catch {}
      try {
        if (typeof refreshDraftUI === "function") refreshDraftUI();
      } catch {}
      try {
        markStatic();
      } catch {}
    };
    const boot = async () => {
      const db = draftDb();
      if (!db) {
        legacyDraftLoad();
        finish();
        return;
      }
      let opened = null;
      try {
        opened = await db.open();
      } catch {
        opened = null;
      }
      if (!opened) {
        legacyDraftLoad();
        finish();
        return;
      }
      let stored = null;
      try {
        stored = await db.loadAll();
      } catch {
        stored = null;
      }
      if (stored === null) {
        legacyDraftLoad();
        finish();
        return;
      }
      let localData = false;
      let migDone = false;
      try {
        localData = !!localStorage.getItem("wd_draft");
      } catch {
        localData = false;
      }
      try {
        migDone = !!sessionStorage.getItem("wd_mig_done");
      } catch {
        migDone = false;
      }
      if (localData && (stored.size === 0 || migDone)) {
        // 初回移行 or 引っ越し直後: localStorageを取り込んでIDBへ (置換)
        drafts.clear();
        draftDirty.clear();
        const n = legacyDraftLoad();
        if (n > 0) {
          draftNeedsFullSave = true;
          scheduleDraftFlush(true);
        }
        removeLegacyDraft();
      } else {
        if (stored.size > 0) {
          // IDB優先。既存キー優先で足りない分だけ補う
          for (const [k, c] of stored) {
            if (drafts.size >= maxDrafts) break;
            if (drafts.has(k)) continue;
            if (validDraftKey(k) && validDraftColor(String(c))) {
              drafts.set(k, String(c));
            }
          }
        } else {
          // 両方空: 何もしない
        }
      }
      if (draftSavePending) {
        draftSavePending = false;
        draftNeedsFullSave = true;
        scheduleDraftFlush(true);
      }
      finish();
    };
    try {
      boot();
    } catch {
      try {
        legacyDraftLoad();
      } catch {}
    }
  }
  // タブを閉じる前の取りこぼしを減らす (ベストエフォート)
  try {
    document.addEventListener("visibilitychange", () => {
      try {
        if (document.visibilityState === "hidden") {
          if (draftSaveTimer) {
            clearTimeout(draftSaveTimer);
            draftSaveTimer = 0;
          }
          flushDrafts();
        }
      } catch {}
    });
    window.addEventListener("pagehide", () => {
      try {
        flushDrafts();
      } catch {}
    });
  } catch {}
  initDraftStore();
  let myUid = "";
  // 自分のUID表示。data-uid付きでクリックコピー対応 (wd-ui.jsの委任が拾う)
  function setMyUidEl(uid) {
    if (!uid) return;
    myUid = uid;
    try {
      if (typeof myUidEl !== "undefined" && myUidEl) {
        myUidEl.textContent = `#${uid}`;
        myUidEl.dataset.uid = uid;
      }
    } catch {}
  }
  let isDark = false;
  let isAdmin = false;

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
    try { if (typeof refreshChatList === "function") refreshChatList(); } catch {}
    markStatic();
  }

  // ---------- render dirty基盤 (変化がなければ描画スキップしてCPU/電池を節約) ----------
  let renderDirty = true;
  function markDirty() {
    renderDirty = true;
  }
  let staticDirty = true; // 静的レイヤーの再構築要否 (カメラ・画素・見た目設定の変化)
  function markStatic() {
    staticDirty = true;
    markDirty();
  }
  let rainbowCount = 0; // 手元ピクセルの虹色数 (アニメ継続要否の判定用)
  let glowCount = 0; // 手元ピクセルの発光数 (高負荷時は簡易描画に切替)
  const chalkKeys = new Set(); // e>0セルのキー ("x,y")。期限切れ掃除はここだけ見る (全走査しない)
  function trackPixelWrite(prevVal, nextVal) {
    const wasRainbow = !!prevVal && String(prevVal.t || "normal").includes("rainbow");
    const isRainbow = !!nextVal && String(nextVal.t || "normal").includes("rainbow");
    if (wasRainbow && !isRainbow) rainbowCount = Math.max(0, rainbowCount - 1);
    else if (isRainbow && !wasRainbow) rainbowCount++;
    const wasGlow = !!prevVal && String(prevVal.t || "normal").includes("glow");
    const isGlow = !!nextVal && String(nextVal.t || "normal").includes("glow");
    if (wasGlow && !isGlow) glowCount = Math.max(0, glowCount - 1);
    else if (isGlow && !wasGlow) glowCount++;
    // 全pixels.set/deleteはここを経由する前提 (現状すべて満たす)
    if (prevVal && prevVal.x != null) chalkKeys.delete(prevVal.x + "," + prevVal.y);
    if (nextVal && (nextVal.e || 0) > 0 && nextVal.x != null) chalkKeys.add(nextVal.x + "," + nextVal.y);
  }

  // トークンはサーバー発行 (secrets使用) のみ。クライアント側生成はしない。
  let token = localStorage.getItem("wd_token") || "";
  let myName = localStorage.getItem("wd_name") || t("anon");
  let myCountry = null;
  let myShowCountry = true;
  let myColor = localStorage.getItem("wd_userColor") || "#22aa66";
  profileName.value = myName;