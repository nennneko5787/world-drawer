// wd-toolbar.js — ツールバー・モード切替・各種設定配線。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
"use strict";
  // ---------- theme (light / dark / auto。実体は theme.js で一元管理) ----------
  themeSel.value = window.wdTheme ? window.wdTheme.get() : "auto";
  function applyTheme() {
    if (window.wdTheme) window.wdTheme.paint();
    isDark = document.documentElement.dataset.theme === "dark";
  }
  themeSel.onchange = () => {
    if (window.wdTheme) window.wdTheme.set(themeSel.value);
    applyTheme();
    markDirty();
  };
  applyTheme();

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
    // 設計図はレイヤー扱い。筆・消しゴム・履歴・スポイトの切替では維持される
    draftMode = on;
    toolDraft.classList.toggle("active", on);
    if (!on) {
      // 描画途中のプレビュー・ストロークは破棄 (適用分は残る)
      draftPreview = null;
      draftStroke = null;
      draftDrawing = false;
      lastStrokeCell = null;
    } else {
      setHistoryMode(false);
      setEyedropMode(false);
      // 入ったら表示もONに (描いているのに見えない事故防止)
      if (!showDrafts) {
        showDrafts = true;
        draftToggle.checked = true;
        try {
          localStorage.setItem("wd_showDraft", "1");
        } catch {}
      }
      toast(t("draftModeToast"));
    }
    refreshColorUI();
    refreshDraftUI();
    markDirty();
  }
  function setDraftTool(next) {
    if (!["dot", "rect", "line", "circle", "bucket"].includes(next)) return;
    draftTool = next;
    try {
      localStorage.setItem("wd_draftTool", draftTool);
    } catch {}
    draftPreview = null;
    refreshDraftUI();
    markDirty();
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
    const pickedParts = String(pix.t || "normal").split("+");
    if (pickedParts.includes("rainbow")) {
      // 表示色（アニメーション中の色相）から算出
      const hue = (x * 7 + y * 13 + (Date.now() / 1000) * 90) % 360;
      const [r, g, b] = hsvToRgb(hue, 100, 100);
      hex = rgbToHex(r, g, b);
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(hex || "")) {
      toast(t("eyedropNoColor"));
      return;
    }
    hex = String(hex).toLowerCase();
    setPaintColor(hex);
    pushRecentColor(hex);
    // セルのインク集合をそのまま選択に反映（不足分があれば現状維持）
    const cellParts = pickedParts.filter((p) => ["glow", "rainbow", "ghost"].includes(p));
    const missing = cellParts.filter((p) => (inventory[p] || 0) <= 0);
    if (missing.length > 0) {
      toast(t("eyedropInkMissing", { hex, ink: missing.map((p) => inkName(p)).join("+") }));
    } else {
      inkSet.clear();
      cellParts.forEach((p) => inkSet.add(p));
      syncInkButtons();
      const gotLabel = cellParts.length > 0 ? inkName(cellParts.slice().sort().join("+")) : inkName("normal");
      toast(t("eyedropGot", { hex, ink: gotLabel }));
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
    markDirty();
  };
  toolEraser.onclick = () => {
    tool = "eraser";
    toolEraser.classList.add("active");
    toolPen.classList.remove("active");
    setHistoryMode(false);
    setEyedropMode(false);
    refreshColorUI();
    markDirty();
  };
  toolHistory.onclick = () => setHistoryMode(!historyMode);
  toolDraft.onclick = () => setDraftMode(!draftMode);
  toolEyedropper.onclick = () => setEyedropMode(!eyedropMode);
  document.querySelectorAll("[data-drafttool]").forEach((btn) => {
    btn.onclick = () => {
      if (!draftMode) setDraftMode(true);
      setDraftTool(btn.dataset.drafttool);
    };
  });
  if (draftUndoBtn) draftUndoBtn.onclick = undoDraft;
  if (draftClearBtn) draftClearBtn.onclick = clearDrafts;
  historyClose.onclick = () => setHistoryMode(false);
  document.querySelectorAll(".ink").forEach((btn) => {
    btn.onclick = () => {
      const key = btn.dataset.ink;
      if (key === "normal") {
        inkSet.clear();
      } else if (inkSet.has(key)) {
        inkSet.delete(key);
      } else {
        if ((inventory[key] || 0) <= 0) {
          toast(t("inkMissingToast"));
          return;
        }
        inkSet.add(key);
        tool = "pen";
        toolPen.classList.add("active");
        toolEraser.classList.remove("active");
      }
      syncInkButtons();
      setEyedropMode(false);
      refreshColorUI();
    };
  });
  // 一覧と設定は同じ場所に出るため同時に開かない (排他)
  onlineEl.onclick = () => {
    const opening = userPanel.classList.contains("hidden");
    userPanel.classList.toggle("hidden");
    if (opening) settingsPanel.classList.add("hidden");
  };
  function flagCode(cc) {
    if (typeof cc !== "string" || !/^[A-Za-z]{2}$/.test(cc)) return "";
    const up = cc.toUpperCase();
    if (up === "XX") return "";
    return up;
  }
  // 国旗は全機種で画像表示 (絵文字は Windows 等で旗にならないため使わない)
  function makeFlagEl(cc) {
    const code = flagCode(cc);
    if (!code) return null;
    const img = document.createElement("img");
    img.className = "flag";
    img.alt = code;
    img.title = code;
    img.loading = "lazy";
    img.draggable = false;
    const low = code.toLowerCase();
    img.src = `https://flagcdn.com/w20/${low}.png`;
    img.srcset = `https://flagcdn.com/w40/${low}.png 2x`;
    img.onerror = () => {
      // 画像が取れない場合も絵文字ではなく国コード表記にする (全機種で同じ見た目)
      const fallback = document.createElement("span");
      fallback.className = "flagFallback";
      fallback.textContent = code;
      img.replaceWith(fallback);
    };
    return img;
  }
  async function saveShowCountry() {
    const show = countryChk.checked;
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name: myName, color: myColor, showCountry: show, tz: myTz }),
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
    resize();
  };
  applyChrome();
  accountBtn.onclick = () => {
    const opening = accountPanel.classList.contains("hidden");
    accountPanel.classList.toggle("hidden");
    if (opening && adminPanel) adminPanel.classList.add("hidden");
  };
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
        body: JSON.stringify({ code: loginCode.value, password: loginPassword.value, fromToken: token }),
      });
      const data = await res.json();
      if (!data.ok) {
        toast(t(data.error === "locked" ? "lockedToast" : "badLoginToast"));
        return;
      }
      // 統合時はリロード後に完了トーストを出す
      try {
        if (data.merged) sessionStorage.setItem("wd_merged", "1");
      } catch {}
      localStorage.setItem("wd_token", data.token);
      // 生き残りアカウントの名前・色をこの端末にも反映 (古い端末別名での上書き防止)
      try {
        if (data.profile) {
          if (data.profile.name) localStorage.setItem("wd_name", data.profile.name);
          if (data.profile.color) localStorage.setItem("wd_userColor", data.profile.color);
        }
      } catch {}
      location.reload();
    } catch {
      toast(t("commError"));
    }
  };
  gridToggle.onchange = () => { showGrid = gridToggle.checked; markDirty(); };
  cursorToggle.onchange = () => { showCursors = cursorToggle.checked; markDirty(); };
  draftToggle.onchange = () => {
    showDrafts = draftToggle.checked;
    localStorage.setItem("wd_showDraft", showDrafts ? "1" : "0");
    markDirty();
  };
  draftToggle.checked = showDrafts;
  axisToggle.onchange = () => {
    showAxes = axisToggle.checked;
    try {
      localStorage.setItem("wd_showAxes", showAxes ? "1" : "0");
    } catch {}
    markDirty();
  };
  axisToggle.checked = showAxes;
  zoneToggle.onchange = () => {
    showZone = zoneToggle.checked;
    try {
      localStorage.setItem("wd_showZone", showZone ? "1" : "0");
    } catch {}
    markDirty();
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
  // 右・中クリックのタップ動作カスタマイズ (ドラッグは常に移動のまま)
  let rightErase = false;
  let middleEyedrop = false;
  try {
    rightErase = localStorage.getItem("wd_rightClick") === "erase";
    middleEyedrop = localStorage.getItem("wd_middleClick") === "eyedrop";
  } catch {}
  if (rightClickSel) {
    rightClickSel.value = rightErase ? "erase" : "pan";
    rightClickSel.onchange = () => {
      rightErase = rightClickSel.value === "erase";
      try {
        localStorage.setItem("wd_rightClick", rightErase ? "erase" : "pan");
      } catch {}
    };
  }
  if (middleClickSel) {
    middleClickSel.value = middleEyedrop ? "eyedrop" : "pan";
    middleClickSel.onchange = () => {
      middleEyedrop = middleClickSel.value === "eyedrop";
      try {
        localStorage.setItem("wd_middleClick", middleEyedrop ? "eyedrop" : "pan");
      } catch {}
    };
  }
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
  settingsBtn.onclick = () => {
    const opening = settingsPanel.classList.contains("hidden");
    settingsPanel.classList.toggle("hidden");
    if (opening) userPanel.classList.add("hidden");
    if (opening) {
      // 横幅が狭いとトップバーが折り返してパネルと被るため、ボタンの直下に出す
      try {
        const r = settingsBtn.getBoundingClientRect();
        settingsPanel.style.top = `${Math.max(8, r.bottom + 8)}px`;
      } catch {}
    }
  };
  if (settingsClose) settingsClose.onclick = () => settingsPanel.classList.add("hidden");
  // saveProfile は後続ファイルのため実行時に解決する
  profileSave.onclick = (...args) => saveProfile(...args);
  profileName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveProfile();
  });
  document.getElementById("zoomIn").onclick = () => { zoomAt(viewW() / 2, viewH() / 2, 1.4); scheduleViewportFetch(); scheduleSaveCamera(); };
  document.getElementById("zoomOut").onclick = () => { zoomAt(viewW() / 2, viewH() / 2, 1 / 1.4); scheduleViewportFetch(); scheduleSaveCamera(); };
  document.getElementById("zoomOrigin").onclick = goOrigin;
