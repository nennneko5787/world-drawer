// wd-modal.js — パネル系の共通モーダル基盤。
// 設定・ユーザー・ランキング・履歴・管理・お知らせを排他モーダル化する。
// 色パネルとチャットはドック (非モーダル) のため対象外。モーダルを開く際は色ドックを閉じる。
// HTML変更なしで動く: overlayを生成し、Esc/外側クリックで閉じる。
"use strict";
  const __modalPanels = [];
  function __collectModals() {
    if (__modalPanels.length) return __modalPanels;
    for (const id of ["settingsPanel", "userPanel", "rankingPanel", "historyPanel", "adminPanel", "noticesPanel"]) {
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
    // 色ドックは非モーダルのためoverlayの外に置けない。モーダル表示中は閉じる
    try {
      if (typeof colorPanel !== "undefined" && colorPanel) colorPanel.classList.add("hidden");
    } catch {}
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
  // 設定タブの配線 (骨格はindex.htmlに静的記述。ここでは切替のみ)。
  // ついでにAboutタブのバージョン表示を埋める
  function initSettingsTabs() {
    const panel = document.getElementById("settingsPanel");
    if (!panel || panel.dataset.tabsDone) return;
    panel.dataset.tabsDone = "1";
    const tabs = panel.querySelector(".wd-tabs");
    const panes = [...panel.querySelectorAll(".wd-tabpane")];
    if (!tabs || panes.length === 0) return;
    const btns = [...tabs.querySelectorAll("button[data-tab]")];
    const select = (key) => {
      btns.forEach((b) => {
        const on = b.dataset.tab === key;
        b.classList.toggle("active", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });
      panes.forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== key));
    };
    btns.forEach((b) => {
      b.onclick = () => select(b.dataset.tab);
    });
    select("view");
    try {
      const verMeta = document.querySelector('meta[name="wd-ver"]');
      const verEl = document.getElementById("appVer");
      if (verEl) verEl.textContent = (verMeta && verMeta.content) || "-";
    } catch {}
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSettingsTabs);
  } else {
    initSettingsTabs();
  }
