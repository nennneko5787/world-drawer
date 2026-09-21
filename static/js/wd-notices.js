// wd-notices.js — お知らせ未読バッジ専用 (一覧表示は /notices ページに移行)。
// トップバーの #noticesBtn は /notices へのリンク。ここでは未読数バッジの
// 更新 (初回 + 5分ごと) と、クリック時の既読保存だけを行う。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
"use strict";
  let noticesCache = []; // [{id}]

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

  async function fetchNotices() {
    try {
      const res = await fetch(`${apiBase()}/api/notices?limit=100`, { headers: { "Accept": "application/json" } });
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.notices)) {
        noticesCache = data.notices.map((n) => ({
          id: Number(n.id) || 0,
        })).filter((n) => n.id > 0);
        refreshNoticesBadge();
      }
    } catch {}
  }

  if (typeof noticesBtn !== "undefined" && noticesBtn) {
    // リンク遷移前に手持ちの最大idを既読にする (戻ってきた時にバッジ消灯)。
    // /notices 側でも開いた時点で既読保存するため、両方向で整合する。
    noticesBtn.addEventListener("click", () => {
      if (noticesCache.length > 0) {
        const maxId = Math.max(...noticesCache.map((n) => n.id));
        noticesSaveSeen(maxId);
      }
      refreshNoticesBadge();
    });
  }
  // 初回取得 + 5分ごとに更新 (バッジ用)
  fetchNotices();
  setInterval(fetchNotices, 5 * 60 * 1000);
