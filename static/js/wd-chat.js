// wd-chat.js — テキストチャット (左下ドック・モーダル化しない常駐UI)。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
// 送信はRESTのみ (POST /api/chat)。受信はWSバイナリ kind=8 + GET履歴 + ポーリングfallback。
"use strict";
  const CHAT_LIMIT = 50;
  const CHAT_MAX = 200;
  let chatMsgs = []; // ASC (古い→新しい)。{id,uid,name,userColor,level,body,at}
  const chatIds = new Set();
  let chatHasMore = false;
  let chatLoading = false;
  let chatPosting = false;
  let chatAtBottom = true;

  function chatSeenId() {
    try {
      return Number(localStorage.getItem("wd_chat_seen") || 0) || 0;
    } catch {
      return 0;
    }
  }

  function chatSaveSeen(id) {
    try {
      const cur = chatSeenId();
      if (id > cur) localStorage.setItem("wd_chat_seen", String(id));
    } catch {}
  }

  function chatIsOpen() {
    try {
      return typeof chatDock !== "undefined" && chatDock && !chatDock.classList.contains("hidden");
    } catch {
      return false;
    }
  }

  function refreshChatBadge() {
    try {
      if (typeof chatBadge === "undefined" || !chatBadge) return;
      const seen = chatSeenId();
      let unread = 0;
      for (const m of chatMsgs) {
        if (m.id > seen && m.uid !== myUid && !(typeof blocked !== "undefined" && blocked.has(m.uid))) unread++;
      }
      if (unread > 0) {
        chatBadge.textContent = unread > 99 ? "99+" : String(unread);
        chatBadge.classList.remove("hidden");
      } else {
        chatBadge.textContent = "";
        chatBadge.classList.add("hidden");
      }
    } catch {}
  }

  function formatChatTime(at) {
    try {
      return new Date(at * 1000).toLocaleString(window.wdI18n.locale);
    } catch {
      return "";
    }
  }

  function chatNearBottom() {
    try {
      if (typeof chatList === "undefined" || !chatList) return true;
      return chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 48;
    } catch {
      return true;
    }
  }

  function chatScrollBottom() {
    try {
      if (typeof chatList !== "undefined" && chatList) chatList.scrollTop = chatList.scrollHeight;
      if (typeof chatNew !== "undefined" && chatNew) chatNew.classList.add("hidden");
      chatAtBottom = true;
    } catch {}
  }

  // サーバー正準は #rrggbb のはずだが、念のため形式検証してから流す
  // (不正値は既定色。style代入自体はスクリプトを実行しないが防御層として)。
  function safeUserColor(raw) {
    return /^#[0-9a-fA-F]{6}$/.test(raw || "") ? raw : "#22aa66";
  }

  function makeChatMsgEl(m) {
    const li = document.createElement("li");
    li.className = "chatMsg" + (m.uid === myUid ? " chatMine" : "");
    li.dataset.id = String(m.id);
    const head = document.createElement("div");
    head.className = "chatHead";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = safeUserColor(m.userColor);
    head.appendChild(dot);
    const nameEl = document.createElement("span");
    nameEl.className = "nname";
    nameEl.textContent = m.name || t("anon");
    head.appendChild(nameEl);
    const meta = document.createElement("span");
    meta.className = "nmeta";
    meta.textContent = `#${m.uid || "?"} Lv${m.level ?? "?"}`;
    head.appendChild(meta);
    const time = document.createElement("span");
    time.className = "ctime";
    time.textContent = formatChatTime(m.at);
    head.appendChild(time);
    if (m.uid && m.uid !== myUid && typeof blocked !== "undefined") {
      const btn = document.createElement("button");
      btn.className = "blockBtn";
      btn.type = "button";
      btn.textContent = blocked.has(m.uid) ? t("unblockBtn") : t("blockBtn");
      btn.title = t("blockTitleBoth");
      btn.onclick = (ev) => {
        ev.stopPropagation();
        toggleBlock(m.uid);
      };
      head.appendChild(btn);
    }
    li.appendChild(head);
    const body = document.createElement("p");
    body.className = "chatBody";
    body.textContent = m.body || "";
    li.appendChild(body);
    return li;
  }

  function refreshChatList() {
    try {
      if (typeof chatList === "undefined" || !chatList) return;
      chatList.innerHTML = "";
      const visible = chatMsgs.filter((m) => !(typeof blocked !== "undefined" && blocked.has(m.uid)));
      if (visible.length === 0) {
        const li = document.createElement("li");
        li.className = "chatEmpty";
        li.textContent = t("chatEmpty");
        chatList.appendChild(li);
      } else {
        for (const m of visible) chatList.appendChild(makeChatMsgEl(m));
      }
      if (typeof chatMore !== "undefined" && chatMore) {
        if (chatHasMore) {
          chatMore.textContent = t("chatMore");
          chatMore.classList.remove("hidden");
        } else {
          chatMore.classList.add("hidden");
        }
      }
      refreshChatBadge();
    } catch (e) {
      console.error(e);
    }
  }

  // 新着1件の取り込み (履歴・POST直後・WSの共通入口。重複はidで排除)。
  function ingestChatMessage(m, opts) {
    if (!m || typeof m.id !== "number" || !Number.isFinite(m.id)) return false;
    if (chatIds.has(m.id)) return false;
    chatIds.add(m.id);
    chatMsgs.push({
      id: m.id,
      uid: String(m.uid || ""),
      name: String(m.name || ""),
      userColor: String(m.userColor || "#22aa66"),
      level: typeof m.level === "number" ? m.level : 1,
      body: String(m.body || ""),
      at: Number(m.at) || 0,
    });
    chatMsgs.sort((a, b) => a.id - b.id);
    // 上限を超えた古い分は落とす (id集合も掃除)
    while (chatMsgs.length > 400) {
      const old = chatMsgs.shift();
      if (old) chatIds.delete(old.id);
    }
    const isBlocked = typeof blocked !== "undefined" && blocked.has(String(m.uid || ""));
    const mine = String(m.uid || "") === myUid;
    if (chatIsOpen()) {
      if (!isBlocked) {
        const wasBottom = chatNearBottom() || mine || !!(opts && opts.scroll);
        refreshChatList();
        if (wasBottom) chatScrollBottom();
        else if (typeof chatNew !== "undefined" && chatNew && !mine) {
          chatNew.textContent = t("chatNew");
          chatNew.classList.remove("hidden");
          chatAtBottom = false;
        }
      }
      chatSaveSeen(m.id);
      refreshChatBadge();
    } else {
      if (!isBlocked) refreshChatBadge();
      else chatSaveSeen(m.id);
    }
    return true;
  }

  async function fetchChat(opts) {
    opts = opts || {};
    if (chatLoading) return;
    if (typeof chatList === "undefined" || !chatList) return;
    chatLoading = true;
    try {
      let url = `${apiBase()}/api/chat?limit=${CHAT_LIMIT}`;
      if (opts.more && chatMsgs.length > 0) {
        const oldest = Math.min(...chatMsgs.map((m) => m.id));
        url += `&beforeId=${oldest}`;
      }
      const res = await fetch(url, { headers: { "Accept": "application/json" } });
      const data = await res.json();
      if (!data || !data.ok || !Array.isArray(data.messages)) return;
      if (opts.more) {
        const olds = [];
        for (const m of data.messages) {
          if (typeof m.id === "number" && !chatIds.has(m.id)) {
            chatIds.add(m.id);
            olds.push({
              id: m.id,
              uid: String(m.uid || ""),
              name: String(m.name || ""),
              userColor: String(m.userColor || "#22aa66"),
              level: typeof m.level === "number" ? m.level : 1,
              body: String(m.body || ""),
              at: Number(m.at) || 0,
            });
          }
        }
        chatMsgs = [...olds.sort((a, b) => a.id - b.id), ...chatMsgs];
        chatHasMore = data.hasMore === true;
        const prevH = chatList.scrollHeight;
        refreshChatList();
        // 読み足し位置を維持 (先頭ジャンプ防止)
        try { chatList.scrollTop = chatList.scrollHeight - prevH; } catch {}
      } else {
        // 差分だけ取り込む (ポーリング時のちらつき防止)
        let touched = false;
        for (const m of data.messages) {
          if (ingestChatMessage(m, { scroll: false })) touched = true;
        }
        chatHasMore = data.hasMore === true;
        if (touched || chatMsgs.length === 0) refreshChatList();
        else if (typeof chatMore !== "undefined" && chatMore) {
          if (chatHasMore) {
            chatMore.textContent = t("chatMore");
            chatMore.classList.remove("hidden");
          } else chatMore.classList.add("hidden");
        }
      }
    } catch (e) {
      if (!opts.silent) console.error(e);
    } finally {
      chatLoading = false;
    }
  }

  async function sendChat(text) {
    if (chatPosting) return;
    const body = String(text || "").replace(/\r/g, "").trim();
    if (!body) return;
    chatPosting = true;
    try {
      if (typeof chatSend !== "undefined" && chatSend) chatSend.disabled = true;
      const res = await fetch(`${apiBase()}/api/chat`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ body }),
      });
      const data = await res.json().catch(() => null);
      if (!data || !data.ok) {
        const code = (data && data.error) || "";
        if (code === "rateLimited") {
          const s = data.retryAfter ?? res.headers.get("Retry-After");
          toast(t("chatRate", { s: s ?? "?" }));
        } else if (code === "banned") {
          toast(t("chatBanned"));
        } else if (code === "badBody") {
          toast(t("chatBadBody"));
        } else {
          toast(t("chatFailed"));
        }
        return false;
      }
      if (data.message) ingestChatMessage(data.message, { scroll: true });
      if (typeof chatInput !== "undefined" && chatInput) {
        chatInput.value = "";
        updateChatCount();
      }
      chatScrollBottom();
      return true;
    } catch {
      toast(t("chatFailed"));
      return false;
    } finally {
      chatPosting = false;
      try {
        if (typeof chatSend !== "undefined" && chatSend) chatSend.disabled = false;
      } catch {}
    }
  }

  // WSバイナリ kind=8 の受信入口 (wd-net.jsのonWsBinから呼ばれる)。
  // Rust chat_bin対称: [8, id8, at8, uid6, nlen u8, name, r,g,b, level u16, blen u16, body]
  function onChatBinMsg(buf) {
    try {
      if (!buf || buf.byteLength < 31) return;
      const v = new DataView(buf);
      if (v.getUint8(0) !== 8) return;
      const id = Number(v.getBigInt64(1, true));
      const at = v.getFloat64(9, true);
      let uid = "";
      for (let i = 0; i < 6; i++) {
        const c = v.getUint8(17 + i);
        if (c === 0) break;
        uid += String.fromCharCode(c);
      }
      const nl = v.getUint8(23);
      if (buf.byteLength < 24 + nl + 7) return;
      const td = new TextDecoder();
      const name = td.decode(new Uint8Array(buf, 24, nl));
      const o = 24 + nl;
      const r = v.getUint8(o), g = v.getUint8(o + 1), b = v.getUint8(o + 2);
      const level = v.getUint16(o + 3, true);
      const blen = v.getUint16(o + 5, true);
      if (buf.byteLength !== o + 7 + blen) return;
      const body = td.decode(new Uint8Array(buf, o + 7, blen));
      const hex = "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
      ingestChatMessage({ id, uid, name, userColor: hex, level, body, at });
    } catch (e) {
      console.error(e);
    }
  }
  // wd-net.jsから見えるようwindowにも出す (classic script間の前方参照対策)
  try { window.wdChatOnMsg = onChatBinMsg; } catch {}

  function openChat() {
    try {
      if (typeof chatDock !== "undefined" && chatDock) chatDock.classList.remove("hidden");
      try { localStorage.setItem("wd_chat_open", "1"); } catch {}
      refreshChatList();
      chatScrollBottom();
      if (chatMsgs.length > 0) chatSaveSeen(chatMsgs[chatMsgs.length - 1].id);
      refreshChatBadge();
      fetchChat({ silent: true });
      try {
        if (typeof chatInput !== "undefined" && chatInput) chatInput.focus({ preventScroll: true });
      } catch {}
    } catch (e) {
      console.error(e);
    }
  }

  function closeChat() {
    try {
      if (typeof chatDock !== "undefined" && chatDock) chatDock.classList.add("hidden");
      try { localStorage.setItem("wd_chat_open", "0"); } catch {}
    } catch {}
  }

  function updateChatCount() {
    try {
      if (typeof chatInput === "undefined" || !chatInput) return;
      if (typeof chatCount !== "undefined" && chatCount) {
        const n = [...chatInput.value].length;
        chatCount.textContent = `${n}/${CHAT_MAX}`;
      }
    } catch {}
  }

  function initChat() {
    try {
      if (typeof chatBtn !== "undefined" && chatBtn) {
        chatBtn.onclick = () => {
          if (chatIsOpen()) closeChat();
          else openChat();
        };
      }
      if (typeof chatClose !== "undefined" && chatClose) chatClose.onclick = () => closeChat();
      if (typeof chatForm !== "undefined" && chatForm) {
        chatForm.addEventListener("submit", (ev) => {
          ev.preventDefault();
          if (typeof chatInput !== "undefined" && chatInput) sendChat(chatInput.value);
        });
      }
      if (typeof chatInput !== "undefined" && chatInput) {
        chatInput.addEventListener("input", updateChatCount);
        // ドック内のEnterは送信 (キャンバスのキー操作と競合しないよう伝播停止)
        chatInput.addEventListener("keydown", (ev) => { ev.stopPropagation(); });
        chatInput.addEventListener("keyup", (ev) => { ev.stopPropagation(); });
        chatInput.addEventListener("keypress", (ev) => { ev.stopPropagation(); });
      }
      if (typeof chatList !== "undefined" && chatList) {
        chatList.addEventListener("scroll", () => {
          chatAtBottom = chatNearBottom();
          if (chatAtBottom && typeof chatNew !== "undefined" && chatNew) chatNew.classList.add("hidden");
        });
      }
      if (typeof chatMore !== "undefined" && chatMore) {
        chatMore.onclick = () => fetchChat({ more: true });
      }
      if (typeof chatNew !== "undefined" && chatNew) {
        chatNew.onclick = () => chatScrollBottom();
      }
      // Escでドックを閉じる (モーダルと違いoverlayは出さない)
      document.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape" && chatIsOpen()) {
          try {
            if (document.activeElement === chatInput) return; // 入力中は閉じない
          } catch {}
          closeChat();
        }
      });
      updateChatCount();
      refreshChatList();
      fetchChat({ silent: true });
      // 前回の開閉状態を復元 (既定は閉)
      try {
        if (localStorage.getItem("wd_chat_open") === "1") openChat();
      } catch {}
      // WS不可時はポーリングで追随 (5秒。閲覧だけはできる)
      setInterval(() => {
        try {
          if (typeof socket === "undefined" || !socket || !socketReady) fetchChat({ silent: true });
        } catch {}
      }, 5000);
    } catch (e) {
      console.error(e);
    }
  }
  // 言語切替時は描き直す (wd-notices.jsの連鎖に追加)
  try {
    const prevRefresh = window.wdLocaleRefresh;
    window.wdLocaleRefresh = () => {
      try {
        if (typeof prevRefresh === "function") prevRefresh();
      } catch {}
      try { refreshChatList(); } catch {}
      try { updateChatCount(); } catch {}
    };
  } catch {}
