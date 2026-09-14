// wd-state.js — 共有のDOM参照・定数・状態 + dirtyフラグ基盤。最初に読むこと。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
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
  const settingsClose = document.getElementById("settingsClose");
  const gridToggle = document.getElementById("gridToggle");
  const cursorToggle = document.getElementById("cursorToggle");
  const draftToggle = document.getElementById("draftToggle");
  const axisToggle = document.getElementById("axisToggle");
  const zoneToggle = document.getElementById("zoneToggle");
  const cursorRateSel = document.getElementById("cursorRateSel");
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
  const adminBtn = document.getElementById("adminBtn");
  const adminPanel = document.getElementById("adminPanel");
  const adminClose = document.getElementById("adminClose");
  const adminUid = document.getElementById("adminUid");
  const adminLookupBtn = document.getElementById("adminLookup");
  const adminResult = document.getElementById("adminResult");
  const adminRollbackBtn = document.getElementById("adminRollback");
  const adminBanBtn = document.getElementById("adminBanIp");
  const toolbarEl = document.getElementById("toolbar");
  const chromeToggle = document.getElementById("chromeToggle");
  const fpsVal = document.getElementById("fpsVal");
  const cacheVal = document.getElementById("cacheVal");
  const t = (key, params) => window.wdI18n.t(key, params);
  // 重ねがけ ("ghost+glow") は各名を合成表示
  const inkName = (k) => String(k || "").split("+").map((p) => t("inkL_" + p)).join("+");

  const coordLimit = 1000000;
  const fetchMargin = 256; // 視野の外側に余分に取得するセル数
  const maxCache = 150000; // 手元に保持するピクセル数の上限
  const maxDrafts = 20000; // 設計図の保持上限
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
  let trustedLevel = 5;
  let placeRadius = 1000;
  let hover = null;
  let fpsEma = 0, fpsLastT = 0, fpsShownAt = 0;
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
    markDirty();
  }
  let myUid = "";
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
    markDirty();
  }

  // ---------- render dirty基盤 (変化がなければ描画スキップしてCPU/電池を節約) ----------
  let renderDirty = true;
  function markDirty() {
    renderDirty = true;
  }
  let rainbowCount = 0; // 手元ピクセルの虹色数 (アニメ継続要否の判定用)
  let glowCount = 0; // 手元ピクセルの発光数 (高負荷時は簡易描画に切替)
  function trackPixelWrite(prevVal, nextVal) {
    const wasRainbow = !!prevVal && String(prevVal.t || "normal").includes("rainbow");
    const isRainbow = !!nextVal && String(nextVal.t || "normal").includes("rainbow");
    if (wasRainbow && !isRainbow) rainbowCount = Math.max(0, rainbowCount - 1);
    else if (isRainbow && !wasRainbow) rainbowCount++;
    const wasGlow = !!prevVal && String(prevVal.t || "normal").includes("glow");
    const isGlow = !!nextVal && String(nextVal.t || "normal").includes("glow");
    if (wasGlow && !isGlow) glowCount = Math.max(0, glowCount - 1);
    else if (isGlow && !wasGlow) glowCount++;
  }

  // トークンはサーバー発行 (secrets使用) のみ。クライアント側生成はしない。
  let token = localStorage.getItem("wd_token") || "";
  let myName = localStorage.getItem("wd_name") || t("anon");
  let myCountry = null;
  let myShowCountry = true;
  let myColor = localStorage.getItem("wd_userColor") || "#22aa66";
  profileName.value = myName;