/* pixDraw 管理ページ (/admin)。管理者UID制・お知らせ投稿付き。 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const t = (key, params) => window.wdI18n.t(key, params);
  let authed = false;
  let adminTarget = null; // {uid, ip}
  let autoTimer = 0;
  let myUid = "";
  let editingNoticeId = 0;
  // お知らせ翻訳の下書き (日本語ベースが正準)。編集中の言語だけ切替表示する。
  const NOTICE_LANGS = ["ja", "en", "ko", "zh-CN", "zh-TW"];
  let editLang = "ja";
  let drafts = { ja: { title: "", body: "" } };
  let lastNotices = [];

  function stashDraft() {
    drafts[editLang] = { title: $("admNoticeTitle").value || "", body: $("admNoticeBody").value || "" };
  }

  function loadDraft() {
    const d = drafts[editLang] || { title: "", body: "" };
    $("admNoticeTitle").value = d.title;
    $("admNoticeBody").value = d.body;
  }

  // 利用者側と同じ表示言語選択 (日本語フォールバック)。
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

  function apiBase() {
    try {
      const m = document.querySelector('meta[name="wd-api"]');
      if (m && m.content) return String(m.content).replace(/\/$/, "");
    } catch {}
    return "";
  }

  function sessionToken() {
    try {
      return localStorage.getItem("wd_token") || "";
    } catch {
      return "";
    }
  }

  async function post(path, body) {
    const res = await fetch(`${apiBase()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${sessionToken()}` },
      body: JSON.stringify({ ...(body || {}) }),
    });
    return await res.json();
  }

  async function get(path) {
    const res = await fetch(`${apiBase()}${path}`, {
      headers: { "Authorization": `Bearer ${sessionToken()}` },
    });
    return await res.json();
  }

  function td(text) {
    const el = document.createElement("td");
    el.textContent = text;
    return el;
  }

  function setAuthed(ok, uid) {
    authed = ok;
    $("admBody").classList.toggle("hidden", !ok);
    if (ok) {
      $("admAuthLine").textContent = uid ? `#${uid} · ${t("admAuthOk")}` : t("admAuthOk");
    } else {
      $("admAuthLine").textContent = t("admAuthNg");
    }
  }

  function statCard(num, label) {
    const div = document.createElement("div");
    div.className = "admStat";
    const b = document.createElement("b");
    b.textContent = String(num);
    const s = document.createElement("span");
    s.textContent = label;
    div.appendChild(b);
    div.appendChild(s);
    return div;
  }

  function renderTable(host, rows, cols, action) {
    host.innerHTML = "";
    if (rows.length === 0) {
      const p = document.createElement("p");
      p.className = "admMuted";
      p.textContent = t("admNoData");
      host.appendChild(p);
      return;
    }
    const table = document.createElement("table");
    table.className = "admTable";
    const head = document.createElement("tr");
    for (const c of cols) {
      const th = document.createElement("th");
      th.textContent = c;
      head.appendChild(th);
    }
    if (action) {
      const th = document.createElement("th");
      head.appendChild(th);
    }
    table.appendChild(head);
    for (const row of rows) {
      const tr = document.createElement("tr");
      for (const cell of row) tr.appendChild(td(cell));
      if (action) {
        const at = document.createElement("td");
        const btn = document.createElement("button");
        btn.textContent = action.label;
        btn.onclick = () => action.fn(row);
        at.appendChild(btn);
        tr.appendChild(at);
      }
    }
    table.appendChild(tr);
    host.appendChild(table);
  }

  function fmtTime(sec) {
    try {
      return new Date(sec * 1000).toLocaleString(window.wdI18n.locale);
    } catch {
      return "";
    }
  }

  function renderStatus(d) {
    const grid = $("admStatus");
    grid.innerHTML = "";
    grid.appendChild(statCard(d.presence ?? "?", t("admPresence")));
    grid.appendChild(statCard(d.sockets ?? "?", t("admSockets")));
    grid.appendChild(statCard((d.banned || []).length, t("admBanned")));
    const cfg = d.config || {};
    const cfgLine = document.createElement("p");
    cfgLine.className = "admMuted";
    cfgLine.textContent =
      `place/min/ip=${cfg.placePerMinPerIp ?? "?"} session/h/ip=${cfg.sessionPerHour ?? "?"}` +
      ` socket=${cfg.requireSocketForPlace ?? "?"} maxSocks/ip=${cfg.maxSocketsPerIp ?? "?"}`;
    grid.appendChild(cfgLine);
    renderTable(
      $("admBannedList"),
      (d.banned || []).map((b) => [b.ip, fmtTime(b.until)]),
      ["IP", "until"],
      { label: t("admUnban"), fn: (row) => unbanIp(row[0]) }
    );
    renderTable(
      $("admTopPlace"),
      (d.topPlaceIps || []).map((e) => [e.ip, String(e.n)]),
      ["IP", "n"]
    );
    renderTable(
      $("admTopSession"),
      (d.topSessionIps || []).map((e) => [e.ip, String(e.n)]),
      ["IP", "n"]
    );
  }

  async function refreshAll() {
    try {
      // 自UIDの表示用に /api/me を先に読む (失敗しても管理判定は status で行う)
      try {
        const me = await get("/api/me");
        if (me && me.uid) myUid = me.uid;
      } catch {}
      const d = await post("/api/admin/status", {});
      if (!d.ok) {
        setAuthed(false);
        return;
      }
      setAuthed(true, myUid);
      renderStatus(d);
      fetchNotices();
    } catch {
      setAuthed(false);
    }
  }

  function renderUserCard(u) {
    const card = $("admUserCard");
    card.innerHTML = "";
    const main = document.createElement("div");
    main.textContent =
      `${u.name} #${u.uid} Lv${u.level} · ${u.touchedCells} ${t("h_cells")}` +
      ` · ${u.lastIp || "?"}${u.online ? " · online" : ""}`;
    card.appendChild(main);
  }

  async function lookup() {
    const uid = ($("admUid").value || "").trim();
    if (!uid) {
      $("admMsg").textContent = t("adminNeedUid");
      return;
    }
    try {
      const data = await post("/api/admin/lookup", { uid });
      if (!data.ok) {
        adminTarget = null;
        $("admMsg").textContent = t(data.error === "noUser" ? "adminNoUser" : data.error === "forbidden" ? "adminForbidden" : "commError");
        return;
      }
      adminTarget = { uid: data.user.uid, ip: data.user.lastIp || null };
      renderUserCard(data.user);
      $("admMsg").textContent = "";
    } catch {
      $("admMsg").textContent = t("commError");
    }
  }

  async function rollback() {
    if (!adminTarget) {
      $("admMsg").textContent = t("adminNeedUid");
      return;
    }
    const limit = Math.max(1, Math.min(5000, Number($("admLimit").value) || 1000));
    if (!confirm(`rollback #${adminTarget.uid} x${limit}?`)) return;
    try {
      const data = await post("/api/admin/rollback", { uid: adminTarget.uid, limit });
      if (!data.ok) {
        $("admMsg").textContent = t(data.error === "forbidden" ? "adminForbidden" : "commError");
        return;
      }
      $("admMsg").textContent = t("adminRollbackDone", { n: data.restored, skip: data.skipped });
      lookup();
    } catch {
      $("admMsg").textContent = t("commError");
    }
  }

  async function ban(ip, seconds) {
    if (!ip) {
      $("admMsg").textContent = t("adminNeedUid");
      return;
    }
    if (!confirm(`ban ${ip}?`)) return;
    try {
      const data = await post("/api/admin/ban", { ip, seconds });
      if (!data.ok) {
        $("admMsg").textContent = t(data.error === "forbidden" ? "adminForbidden" : data.error === "badIp" ? "adminBadIp" : "commError");
        return;
      }
      $("admMsg").textContent = data.banned ? t("adminBanDone", { ip: data.ip }) : t("admUnbanned", { ip: data.ip });
      refreshAll();
    } catch {
      $("admMsg").textContent = t("commError");
    }
  }

  async function unbanIp(ip) {
    await ban(ip, 0);
  }

  // ---- お知らせ CRUD ----
  function resetNoticeForm() {
    editingNoticeId = 0;
    editLang = "ja";
    drafts = { ja: { title: "", body: "" } };
    if ($("admNoticeLang")) $("admNoticeLang").value = "ja";
    $("admNoticeTitle").value = "";
    $("admNoticeBody").value = "";
    $("admNoticePost").textContent = t("noticesPost");
    $("admNoticeCancel").classList.add("hidden");
  }

  function renderNoticeList(notices) {
    const host = $("admNoticeList");
    if (!host) return;
    host.innerHTML = "";
    for (const n of notices || []) {
      const box = document.createElement("div");
      box.className = "admNotice";
      const h = document.createElement("h4");
      h.textContent = `#${n.id} ${localizeNotice(n).title}`;
      box.appendChild(h);
      // 本文プレビューも利用者側と同じMarkdown描画にする。
      const p = document.createElement("div");
      p.className = "mdBody";
      const loc = localizeNotice(n);
      if (typeof window.wdMarkdown === "function") p.innerHTML = window.wdMarkdown(loc.body);
      else p.textContent = loc.body;
      box.appendChild(p);
      const meta = document.createElement("p");
      meta.className = "admMuted";
      meta.textContent = fmtTime(n.updatedAt || n.createdAt);
      // 翻訳の有無が一目で分かるよう言語バッジを付ける。
      try {
        const langs = NOTICE_LANGS.filter((l) => l !== "ja" && n.translations && n.translations[l]);
        if (langs.length > 0) meta.textContent += ` · ${langs.join("/")}`;
      } catch {}
      box.appendChild(meta);
      const row = document.createElement("div");
      row.className = "admRow";
      const editBtn = document.createElement("button");
      editBtn.textContent = t("noticesEdit");
      editBtn.onclick = () => {
        editingNoticeId = n.id;
        drafts = { ja: { title: n.title || "", body: n.body || "" } };
        for (const l of NOTICE_LANGS) {
          if (l === "ja") continue;
          const tr = (n.translations && n.translations[l]) || {};
          drafts[l] = { title: tr.title || "", body: tr.body || "" };
        }
        loadDraft();
        $("admNoticePost").textContent = t("noticesUpdate");
        $("admNoticeCancel").classList.remove("hidden");
        $("admNoticeCancel").textContent = t("close");
      };
      const delBtn = document.createElement("button");
      delBtn.textContent = t("noticesDelete");
      delBtn.onclick = () => deleteNotice(n.id);
      row.appendChild(editBtn);
      row.appendChild(delBtn);
      box.appendChild(row);
      host.appendChild(box);
    }
    if ((notices || []).length === 0) {
      const p = document.createElement("p");
      p.className = "admMuted";
      p.textContent = t("noticesEmpty");
      host.appendChild(p);
    }
  }

  async function fetchNotices() {
    try {
      const data = await get("/api/notices?limit=100");
      if (!data.ok) return;
      lastNotices = data.notices || [];
      renderNoticeList(lastNotices);
    } catch {}
  }

  async function submitNotice() {
    stashDraft();
    const base = drafts.ja || { title: "", body: "" };
    const title = (base.title || "").trim();
    const body = (base.body || "").trim();
    if (!title) {
      $("admMsg").textContent = t("noticesTitlePh");
      return;
    }
    // 日本語ベース以外は空でない言語だけ送る (空はサーバ側でも落とす)。
    const translations = {};
    for (const l of NOTICE_LANGS) {
      if (l === "ja") continue;
      const d = drafts[l] || { title: "", body: "" };
      if ((d.title || "").trim() || (d.body || "").trim()) {
        translations[l] = { title: d.title || "", body: d.body || "" };
      }
    }
    try {
      const payload = { title, body, translations };
      let data;
      if (editingNoticeId) {
        const res = await fetch(`${apiBase()}/api/admin/notices/${editingNoticeId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${sessionToken()}` },
          body: JSON.stringify(payload),
        });
        data = await res.json();
      } else {
        data = await post("/api/admin/notices", payload);
      }
      if (!data.ok) {
        $("admMsg").textContent = t(data.error === "forbidden" ? "adminForbidden" : "commError");
        return;
      }
      $("admMsg").textContent = t(editingNoticeId ? "noticesUpdated" : "noticesPosted");
      resetNoticeForm();
      fetchNotices();
    } catch {
      $("admMsg").textContent = t("commError");
    }
  }

  async function deleteNotice(id) {
    if (!confirm(t("noticesConfirmDel"))) return;
    try {
      const res = await fetch(`${apiBase()}/api/admin/notices/${id}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${sessionToken()}` },
      });
      const data = await res.json();
      if (!data.ok) {
        $("admMsg").textContent = t(data.error === "forbidden" ? "adminForbidden" : "commError");
        return;
      }
      $("admMsg").textContent = t("noticesDeleted");
      if (editingNoticeId === id) resetNoticeForm();
      fetchNotices();
    } catch {
      $("admMsg").textContent = t("commError");
    }
  }

  $("admRefresh").onclick = refreshAll;
  $("admAuto").onchange = () => {
    clearInterval(autoTimer);
    autoTimer = 0;
    if ($("admAuto").checked) autoTimer = setInterval(refreshAll, 15000);
  };
  $("admLookupBtn").onclick = lookup;
  $("admUid").addEventListener("keydown", (e) => {
    if (e.key === "Enter") lookup();
  });
  $("admRollbackBtn").onclick = rollback;
  $("admBanBtn").onclick = () => {
    if (!adminTarget || !adminTarget.ip) {
      $("admMsg").textContent = t("adminNeedUid");
      return;
    }
    ban(adminTarget.ip, Number($("admDuration").value) || 86400);
  };
  if ($("admNoticePost")) $("admNoticePost").onclick = submitNotice;
  if ($("admNoticeCancel")) $("admNoticeCancel").onclick = resetNoticeForm;
  // 翻訳の編集言語切替 (入力中の他言語は下書き保持)
  if ($("admNoticeLang")) $("admNoticeLang").onchange = () => {
    stashDraft();
    editLang = $("admNoticeLang").value || "ja";
    if (!NOTICE_LANGS.includes(editLang)) editLang = "ja";
    loadDraft();
  };
  // ページ言語切替時はプレビューを表示言語で描き直す。
  window.wdLocaleRefresh = () => renderNoticeList(lastNotices);

  // 旧wd_adminTokenが残っていれば掃除 (UID制では不要)
  try {
    localStorage.removeItem("wd_adminToken");
  } catch {}
  resetNoticeForm();
  if (sessionToken()) refreshAll();
  else setAuthed(false);
})();
