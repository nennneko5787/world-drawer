// wd-auth.js — API基底・Bearer・Turnstile・WSチケットの共通基盤。
// classic script (wd-stateの直後に読む。前方参照は実行時解決)。
"use strict";
  function apiBase() {
    try {
      const m = document.querySelector('meta[name="wd-api"]');
      if (m && m.content) return String(m.content).replace(/\/$/, "");
    } catch {}
    return "";
  }
  function wsUrl() {
    try {
      const m = document.querySelector('meta[name="wd-ws"]');
      if (m && m.content) return String(m.content);
    } catch {}
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  }
  function turnstileSiteKey() {
    try {
      const m = document.querySelector('meta[name="wd-turnstile-site"]');
      return (m && m.content) || "";
    } catch {
      return "";
    }
  }
  function authHeaders(extra) {
    return { ...(extra || {}), "Authorization": `Bearer ${token}` };
  }
  async function apiFetch(path, opts) {
    const o = opts || {};
    // body内のtokenは送らない (設計として廃止)。Bearerのみ
    return fetch(`${apiBase()}${path}`, {
      ...o,
      headers: authHeaders({ "Content-Type": "application/json", ...(o.headers || {}) }),
    });
  }
  // Turnstile: ページ表示の度に1トークン取得 (invisible managed)。
  // ウィジェット未読込・鍵なし時は空文字 (サーバがenforceなら弾かれる)。
  let _tsWidgetId = null;
  function ensureTurnstileSlot() {
    let el = document.getElementById("ts-slot");
    if (el) return el;
    el = document.createElement("div");
    el.id = "ts-slot";
    document.body.appendChild(el);
    return el;
  }
  function getTurnstileToken() {
    const key = turnstileSiteKey();
    if (!key) return Promise.resolve("");
    if (typeof turnstile === "undefined") return Promise.resolve("");
    return new Promise((resolve) => {
      try {
        const slot = ensureTurnstileSlot();
        slot.innerHTML = "";
        const dark = document.documentElement.dataset.theme === "dark";
        const id = turnstile.render(slot, {
          sitekey: key,
          theme: dark ? "dark" : "light",
          callback: (tok) => {
            try { turnstile.remove(id); } catch {}
            slot.innerHTML = "";
            resolve(tok || "");
          },
          "expired-callback": () => resolve(""),
          "error-callback": () => resolve(""),
        });
        // invisible時は自動実行、checkbox時はユーザ操作待ち (10秒で諦め)
        try { turnstile.execute(id); } catch {}
        setTimeout(() => resolve(""), 15000);
      } catch {
        resolve("");
      }
    });
  }
  async function fetchWsTicket() {
    const res = await apiFetch("/api/ws-ticket", { method: "POST" });
    const data = await res.json();
    if (!data.ok || !data.ticket) throw new Error("ticket failed");
    return data.ticket;
  }
