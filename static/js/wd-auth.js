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
  // Turnstile: 1呼び出し=1ウィジェット=1トークン。直列化して潰し合いを防ぐ。
  // (共有slotのinnerHTML消去が実行中widgetを殺して全滅する事故の対策)
  let _tsChain = Promise.resolve();
  function ensureTurnstileSlot() {
    let el = document.getElementById("ts-slot");
    if (el) return el;
    el = document.createElement("div");
    el.id = "ts-slot";
    document.body.appendChild(el);
    return el;
  }
  // invisible実行: ウィジェットUIを出さずheadlessに検証する。
  // appearance interaction-only のため、判定に操作が必要な稀な場合のみ
  // チェックボックスがslot位置に出る (それ以外はbackdrop等なし)
  function getTurnstileToken() {
    _tsChain = _tsChain.catch(() => {}).then(_mintTurnstileToken);
    return _tsChain;
  }
  function _mintTurnstileToken() {
    const key = turnstileSiteKey();
    if (!key || typeof turnstile === "undefined") return Promise.resolve("");
    return new Promise((resolve) => {
      let done = false;
      let id = null;
      let timer = 0;
      const host = ensureTurnstileSlot();
      const slot = document.createElement("div");
      host.appendChild(slot);
      const finish = (tok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          if (id !== null) turnstile.remove(id);
        } catch {}
        try { slot.remove(); } catch {}
        resolve(tok || "");
      };
      try {
        const dark = document.documentElement.dataset.theme === "dark";
        id = turnstile.render(slot, {
          sitekey: key,
          theme: dark ? "dark" : "light",
          execution: "execute",
          appearance: "interaction-only",
          callback: finish,
          "expired-callback": () => finish(""),
          "error-callback": () => finish(""),
        });
        turnstile.execute(id);
      } catch {
        finish("");
        return;
      }
      timer = setTimeout(() => finish(""), 15000);
    });
  }
  async function fetchWsTicket() {
    const res = await apiFetch("/api/ws-ticket", { method: "POST" });
    const data = await res.json();
    if (!data.ok || !data.ticket) throw new Error("ticket failed");
    return { ticket: data.ticket, turnstileRequired: data.turnstileRequired === true };
  }
  // サーバが要求した時だけTurnstileを実行するPOST。先に空トークンで試し、
  // turnstileRequiredで返ってきたら1回だけトークン付きで再送する。
  async function postWithTurnstile(path, headers, makeBody) {
    const send = async (ts) => {
      const res = await fetch(`${apiBase()}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(makeBody(ts)),
      });
      return res.json();
    };
    let data = await send("");
    if (!data.ok && data.error === "turnstileRequired") {
      data = await send(await getTurnstileToken());
    }
    return data;
  }
