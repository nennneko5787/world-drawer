// wd-notices.js — お知らせ一覧 (ボタン+モーダル・未読バッジ付き)。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
"use strict";
  let noticesCache = []; // [{id,title,body,createdAt,updatedAt}]

  function noticesSeenId() {
    try {
      return Number(localStorage.getItem("wd_notices_seen") || 0) || 0;
    } catch {
      return 0;
    }
  }

  function noticesSaveSeen(id) {
    try {
      const cur = noticesSeenId();
      if (id > cur) localStorage.setItem("wd_notices_seen", String(id));
    } catch {}
  }

  function refreshNoticesBadge() {
    if (typeof noticesBadge === "undefined" || !noticesBadge) return;
    const seen = noticesSeenId();
    const unread = noticesCache.filter((n) => n.id > seen).length;
    if (unread > 0) {
      noticesBadge.textContent = unread > 99 ? "99+" : String(unread);
      noticesBadge.classList.remove("hidden");
    } else {
      noticesBadge.textContent = "";
      noticesBadge.classList.add("hidden");
    }
  }

  function formatNoticeTime(at) {
    try {
      return new Date(at * 1000).toLocaleString(window.wdI18n.locale);
    } catch {
      return "";
    }
  }

  function renderNoticesList() {
    if (typeof noticesList === "undefined" || !noticesList) return;
    noticesList.innerHTML = "";
    if (noticesCache.length === 0) {
      const li = document.createElement("li");
      li.className = "noticesEmpty";
      li.textContent = t("noticesEmpty");
      noticesList.appendChild(li);
      return;
    }
    for (const n of noticesCache) {
      const li = document.createElement("li");
      li.className = "noticesItem";
      const head = document.createElement("div");
      head.className = "noticesHead";
      const title = document.createElement("b");
      title.textContent = n.title;
      head.appendChild(title);
      const time = document.createElement("span");
      time.className = "noticesTime";
      time.textContent = formatNoticeTime(n.updatedAt || n.createdAt);
      head.appendChild(time);
      li.appendChild(head);
      const body = document.createElement("div");
      body.className = "noticesBody";
      // 本文はMarkdown描画 (リンク等)。描画器が無ければ素の文字列。
      if (typeof window.wdMarkdown === "function") body.innerHTML = window.wdMarkdown(n.body);
      else body.textContent = n.body;
      li.appendChild(body);
      noticesList.appendChild(li);
    }
  }

  async function fetchNotices() {
    try {
      const res = await fetch(`${apiBase()}/api/notices?limit=100`, { headers: { "Accept": "application/json" } });
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.notices)) {
        noticesCache = data.notices.map((n) => ({
          id: Number(n.id) || 0,
          title: String(n.title || ""),
          body: String(n.body || ""),
          createdAt: Number(n.createdAt) || 0,
          updatedAt: Number(n.updatedAt) || 0,
        })).filter((n) => n.id > 0);
        renderNoticesList();
        refreshNoticesBadge();
      }
    } catch {}
  }

  function openNotices() {
    renderNoticesList();
    if (typeof noticesPanel !== "undefined" && noticesPanel) openModal(noticesPanel);
    if (noticesCache.length > 0) {
      const maxId = Math.max(...noticesCache.map((n) => n.id));
      noticesSaveSeen(maxId);
    }
    refreshNoticesBadge();
  }

  if (typeof noticesBtn !== "undefined" && noticesBtn) {
    noticesBtn.onclick = () => {
      const opening = typeof noticesPanel !== "undefined" && noticesPanel && noticesPanel.classList.contains("hidden");
      if (opening) openNotices();
      else closeAllModals();
      fetchNotices();
    };
  }
  if (typeof noticesClose !== "undefined" && noticesClose) {
    noticesClose.onclick = () => closeAllModals();
  }
  // 初回取得 + 5分ごとに更新 (バッジ用。開いている時は一覧も更新)
  fetchNotices();
  setInterval(fetchNotices, 5 * 60 * 1000);
