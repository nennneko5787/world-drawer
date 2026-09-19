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

  function setAuthed(ok, uid) {
    authed = ok;
    $("admBody").classList.toggle("hidden", !ok);
    const line = $("admAuthLine");
    line.classList.toggle("ok", ok);
    line.classList.toggle("ng", !ok);
    if (ok) {
      line.textContent = uid ? `#${uid} · ${t("admAuthOk")}` : t("admAuthOk");
    } else {
      line.textContent = t("admAuthNg");
    }
  }

  // ---- UID/IPコピー (管理ページ独自。キャンバス側のwd-ui.jsは読み込まないため) ----
  function showAdmToast(msg) {
    try {
      document.querySelectorAll(".admToast").forEach((el) => el.remove());
      const el = document.createElement("div");
      el.className = "admToast";
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 1600);
    } catch {}
  }

  function copyText(val) {
    if (!val) return;
    const done = () => showAdmToast(t("uidCopied", { uid: val }));
    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = val;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        done();
      } catch {}
      ta.remove();
    };
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        navigator.clipboard.writeText(val).then(done).catch(fallback);
      } else {
        fallback();
      }
    } catch {
      fallback();
    }
  }

  document.addEventListener("click", (e) => {
    const target = e.target && e.target.closest ? e.target.closest("[data-uid],[data-copy]") : null;
    if (!target) return;
    const val = target.dataset.uid || target.dataset.copy;
    if (!val) return;
    e.preventDefault();
    copyText(val);
  });

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

  // 禁止IP表 (IPセルはクリックでコピー可。解除ボタン付き)。
  // topPlace/topSessionは仕様で返さないため表示しない (admin.md参照)。
  function renderBanned(list) {
    const host = $("admBannedList");
    host.innerHTML = "";
    if (list.length === 0) {
      const p = document.createElement("p");
      p.className = "admMuted";
      p.textContent = t("admNoData");
      host.appendChild(p);
      return;
    }
    const wrap = document.createElement("div");
    wrap.className = "admTableWrap";
    const table = document.createElement("table");
    table.className = "admTable";
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    for (const c of ["IP", "until", ""]) {
      const th = document.createElement("th");
      th.textContent = c;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const body = document.createElement("tbody");
    for (const b of list) {
      const tr = document.createElement("tr");
      const ipTd = document.createElement("td");
      ipTd.className = "mono";
      ipTd.textContent = b.ip;
      ipTd.dataset.copy = b.ip;
      ipTd.title = t("copyUidHint");
      tr.appendChild(ipTd);
      const untilTd = document.createElement("td");
      untilTd.textContent = fmtTime(b.until);
      tr.appendChild(untilTd);
      const actTd = document.createElement("td");
      const btn = document.createElement("button");
      btn.textContent = t("admUnban");
      btn.onclick = () => unbanIp(b.ip);
      actTd.appendChild(btn);
      tr.appendChild(actTd);
      body.appendChild(tr);
    }
    table.appendChild(body);
    wrap.appendChild(table);
    host.appendChild(wrap);
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
    cfgLine.className = "admCfg";
    cfgLine.textContent =
      `place/min/ip=${cfg.placePerMinPerIp ?? "?"} session/h/ip=${cfg.sessionPerHour ?? "?"}` +
      ` socket=${cfg.requireSocketForPlace ?? "?"} maxSocks/ip=${cfg.maxSocketsPerIp ?? "?"}`;
    grid.appendChild(cfgLine);
    renderBanned(d.banned || []);
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

  // ユーザー詳細カード。UID・IPはクリックでコピー可。
  function kvRow(kv, term, dd) {
    const cell = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = term;
    cell.appendChild(dt);
    cell.appendChild(dd);
    kv.appendChild(cell);
  }

  function kvText(kv, term, text, opts) {
    opts = opts || {};
    const dd = document.createElement("dd");
    dd.textContent = text;
    if (opts.mono) dd.className = "mono";
    if (opts.copy) {
      dd.dataset.copy = opts.copy;
      dd.title = t("copyUidHint");
    }
    kvRow(kv, term, dd);
    if (opts.copyBtn) {
      const btn = document.createElement("button");
      btn.className = "admCopy";
      btn.type = "button";
      btn.textContent = t("admCopy");
      btn.dataset.copy = opts.copy;
      dd.appendChild(btn);
    }
  }

  function renderUserCard(u) {
    const card = $("admUserCard");
    card.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "admUser";
    const head = document.createElement("div");
    head.className = "admUserHead";
    const dot = document.createElement("span");
    dot.className = "admDot";
    dot.style.background = /^#[0-9a-fA-F]{6}$/.test(u.color || "") ? u.color : "#22aa66";
    head.appendChild(dot);
    const nameEl = document.createElement("b");
    nameEl.textContent = u.name || "?";
    head.appendChild(nameEl);
    const uidEl = document.createElement("span");
    uidEl.className = "mono";
    uidEl.textContent = `#${u.uid || "?"}`;
    if (u.uid) {
      uidEl.dataset.uid = u.uid;
      uidEl.title = t("copyUidHint");
    }
    head.appendChild(uidEl);
    const badge = document.createElement("span");
    const online = !!u.online;
    badge.className = "admBadge" + (online ? "" : " off");
    badge.textContent = t(online ? "admOnline" : "admOffline");
    head.appendChild(badge);
    wrap.appendChild(head);
    const kv = document.createElement("dl");
    kv.className = "admKv";
    kvText(kv, "Lv", `Lv${u.level ?? "?"} · ${u.xp ?? 0}xp`, { mono: true });
    kvText(kv, t("admCells"), `${u.touchedCells ?? "?"} ${t("h_cells")}`, { mono: true });
    if (u.lastIp) {
      kvText(kv, t("admLastIp"), u.lastIp, { mono: true, copy: u.lastIp, copyBtn: true });
    } else {
      kvText(kv, t("admLastIp"), "-", { mono: true });
    }
    const country = u.country || "-";
    kvText(kv, t("admCountry"), u.showCountry === false ? `${country} (非表示)` : country, { mono: true });
    const inv = u.inventory && typeof u.inventory === "object" ? u.inventory : {};
    const invKeys = Object.keys(inv).filter((k) => (inv[k] || 0) > 0);
    kvText(kv, t("admInk"), invKeys.length ? invKeys.map((k) => `${k}x${inv[k]}`).join(" ") : "-", { mono: true });
    wrap.appendChild(kv);
    card.appendChild(wrap);
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
      box.appendChild(meta);
      // 翻訳の有無が一目で分かるよう言語バッジを付ける。
      const langRow = document.createElement("div");
      langRow.className = "admMuted";
      for (const l of NOTICE_LANGS) {
        if (l === "ja") continue;
        const s = document.createElement("span");
        const tr = n.translations && n.translations[l];
        const has = !!(tr && (tr.title || tr.body));
        s.className = "admLang" + (has ? " have" : "");
        s.textContent = l;
        langRow.appendChild(s);
      }
      box.appendChild(langRow);
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
  if (sessionToken()) {
    refreshAll().then(() => {
      // キャンバス側のユーザー一覧から ?uid=付きで遷移した場合は自動照会する
      try {
        const q = new URLSearchParams(location.search).get("uid");
        if (q && authed && $("admUid")) {
          $("admUid").value = q;
          lookup();
        }
      } catch {}
    });
  } else setAuthed(false);
})();
