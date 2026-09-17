// wd-modal.js — パネル系の共通モーダル基盤。
// 既存パネル(settings/user/history/account/admin/color)を排他モーダル化する。
// HTML変更なしで動く: overlayを生成し、Esc/外側クリックで閉じる。
"use strict";
  const __modalPanels = [];
  function __collectModals() {
    if (__modalPanels.length) return __modalPanels;
    for (const id of ["settingsPanel", "userPanel", "historyPanel", "accountPanel", "adminPanel", "noticesPanel", "colorPanel"]) {
      const el = document.getElementById(id);
      if (el) {
        el.classList.add("wd-modal");
        __modalPanels.push(el);
      }
    }
    return __modalPanels;
  }
  function __ensureOverlay() {
    let ov = document.getElementById("modal-overlay");
    if (ov) return ov;
    ov = document.createElement("div");
    ov.id = "modal-overlay";
    ov.className = "hidden";
    ov.addEventListener("click", closeAllModals);
    document.body.appendChild(ov);
    return ov;
  }
  function openModal(el) {
    __collectModals();
    const ov = __ensureOverlay();
    const opening = el.classList.contains("hidden");
    closeAllModals(true);
    if (opening) {
      el.classList.remove("hidden");
      ov.classList.remove("hidden");
      const f = el.querySelector("input, select, button");
      if (f) { try { f.focus({ preventScroll: true }); } catch {} }
    }
  }
  function closeAllModals(silent) {
    __collectModals();
    for (const el of __modalPanels) el.classList.add("hidden");
    const ov = document.getElementById("modal-overlay");
    if (ov) ov.classList.add("hidden");
    if (!silent) {
      historyKey = null;
    }
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllModals();
  });
  // 設定タブ化 (表示/操作/画質). 既存.setRowを再配置するのみ
  function initSettingsTabs() {
    const panel = document.getElementById("settingsPanel");
    if (!panel || panel.dataset.tabsDone) return;
    panel.dataset.tabsDone = "1";
    const groups = {
      view: ["gridToggle", "cursorToggle", "draftToggle", "axisToggle", "zoneToggle", "shieldToggle"],
      ops: ["cursorRateSel", "rightClickSel", "middleClickSel"],
      quality: ["simplifySel", "qualitySel", "glowSel", "themeSel"],
    };
    const rows = [...panel.querySelectorAll(".setRow")];
    const findRow = (id) => rows.find((r) => r.querySelector(`#${id}`));
    const panes = {};
    const tabs = document.createElement("div");
    tabs.className = "wd-tabs";
    const names = { view: "表示", ops: "操作", quality: "画質" };
    for (const key of Object.keys(groups)) {
      const btn = document.createElement("button");
      btn.textContent = names[key];
      btn.dataset.tab = key;
      btn.onclick = () => {
        tabs.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
        for (const k of Object.keys(panes)) panes[k].classList.toggle("hidden", k !== key);
      };
      tabs.appendChild(btn);
      const pane = document.createElement("div");
      pane.className = "wd-tabpane";
      pane.dataset.pane = key;
      if (key !== "view") pane.classList.add("hidden");
      panes[key] = pane;
    }
    tabs.querySelector("button").classList.add("active");
    panel.insertBefore(tabs, panel.firstChild);
    for (const key of Object.keys(groups)) {
      for (const id of groups[key]) {
        const row = findRow(id);
        if (row) panes[key].appendChild(row);
      }
      panel.appendChild(panes[key]);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSettingsTabs);
  } else {
    initSettingsTabs();
  }
