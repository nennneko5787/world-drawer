/* pixDraw お知らせ専用ページ (/notices)。公開一覧の取得・描画のみ。
 * 認証不要 (GET /api/notices は公開)。投稿・編集・削除は /admin のまま。
 * classic script (i18n.js・wd-markdown.js より後に読む)。
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const t = (key, params) => window.wdI18n.t(key, params);
  let cache = []; // [{id,title,body,translations,createdAt,updatedAt}]

  function apiBase() {
    try {
      const m = document.querySelector('meta[name="wd-api"]');
      if (m && m.content) return String(m.content).replace(/\/$/, "");
    } catch {}
    return "";
  }

  function saveSeen(id) {
    try {
      const cur = Number(localStorage.getItem("wd_notices_seen") || 0) || 0;
      if (id > cur) localStorage.setItem("wd_notices_seen", String(id));
    } catch {}
  }

  // 表示言語の本文を選ぶ。日本語ベースが正準で、翻訳があれば使う。
  function localizeNotice(n) {
    let lang = "ja";
    try {
      lang = window.wdI18n.lang || "ja";
    } catch {}
    if (lang !== "ja" && n.translations && typeof n.translations === "object") {
      const tr = n.translations[lang];
      if (tr && typeof tr === "object") {
        return {
          title: (typeof tr.title === "string" && tr.title) ? tr.title : (n.title || ""),
          body: (typeof tr.body === "string" && tr.body) ? tr.body : (n.body || ""),
        };
      }
    }
    return { title: n.title || "", body: n.body || "" };
  }

  function fmtTime(at) {
    try {
      return new Date(at * 1000).toLocaleString(window.wdI18n.locale);
    } catch {
      return "";
    }
  }

  function setStatus(key) {
    const el = $("noticesStatus");
    if (!el) return;
    el.textContent = key ? t(key) : "";
  }

  function render() {
    const host = $("noticesList");
    if (!host) return;
    host.innerHTML = "";
    if (cache.length === 0) {
      setStatus("noticesEmpty");
      return;
    }
    setStatus("");
    for (const n of cache) {
      const loc = localizeNotice(n);
      const card = document.createElement("article");
      card.className = "notice";
      const head = document.createElement("div");
      head.className = "noticeHead";
      const h = document.createElement("h2");
      h.className = "noticeTitle";
      h.textContent = loc.title;
      head.appendChild(h);
      const time = document.createElement("span");
      time.className = "noticeTime";
      time.textContent = fmtTime(n.updatedAt || n.createdAt);
      head.appendChild(time);
      card.appendChild(head);
      const body = document.createElement("div");
      body.className = "noticeBody";
      // 本文は安全なMarkdown描画器のみ (生HTMLは通らない)。なければ素の文字列。
      if (typeof window.wdMarkdown === "function") body.innerHTML = window.wdMarkdown(loc.body);
      else body.textContent = loc.body;
      card.appendChild(body);
      host.appendChild(card);
    }
  }

  async function fetchNotices() {
    setStatus("noticesLoading");
    try {
      const res = await fetch(`${apiBase()}/api/notices?limit=100`, { headers: { "Accept": "application/json" } });
      const data = await res.json();
      if (!data || !data.ok || !Array.isArray(data.notices)) throw new Error("badResponse");
      cache = data.notices.map((n) => ({
        id: Number(n.id) || 0,
        title: String(n.title || ""),
        body: String(n.body || ""),
        translations: (n.translations && typeof n.translations === "object") ? n.translations : {},
        createdAt: Number(n.createdAt) || 0,
        updatedAt: Number(n.updatedAt) || 0,
      })).filter((n) => n.id > 0);
      render();
      // 開いた時点で既読にする (index側バッジ消灯用。キー名は従来と同じ)
      if (cache.length > 0) saveSeen(Math.max(...cache.map((n) => n.id)));
    } catch {
      cache = [];
      const host = $("noticesList");
      if (host) host.innerHTML = "";
      setStatus("noticesFailed");
    }
  }

  // 言語切替時は表示言語で描き直す。
  {
    const prevRefresh = window.wdLocaleRefresh;
    window.wdLocaleRefresh = () => {
      try {
        if (typeof prevRefresh === "function") prevRefresh();
      } catch {}
      render();
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fetchNotices);
  } else {
    fetchNotices();
  }
})();
