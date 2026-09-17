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
        $("admMsg").textContent = t(data.error === "forbidden" ? "adminForbidden" : data.error === "badIp" ? "commError" : "commError");
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
    $("admNoticeTitle").value = "";
    $("admNoticeBody").value = "";
    $("admNoticePost").textContent = t("noticesPost");
    $("admNoticeCancel").classList.add("hidden");
  }

  async function fetchNotices() {
    const host = $("admNoticeList");
    if (!host) return;
    host.innerHTML = "";
    try {
      const data = await get("/api/notices?limit=100");
      if (!data.ok) return;
      for (const n of data.notices || []) {
        const box = document.createElement("div");
        box.className = "admNotice";
        const h = document.createElement("h4");
        h.textContent = `#${n.id} ${n.title}`;
        box.appendChild(h);
        const p = document.createElement("p");
        p.textContent = n.body || "";
        box.appendChild(p);
        const meta = document.createElement("p");
        meta.className = "admMuted";
        meta.textContent = fmtTime(n.updatedAt || n.createdAt);
        box.appendChild(meta);
        const row = document.createElement("div");
        row.className = "admRow";
        const editBtn = document.createElement("button");
        editBtn.textContent = t("noticesEdit");
        editBtn.onclick = () => {
          editingNoticeId = n.id;
          $("admNoticeTitle").value = n.title || "";
          $("admNoticeBody").value = n.body || "";
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
      if ((data.notices || []).length === 0) {
        const p = document.createElement("p");
        p.className = "admMuted";
        p.textContent = t("noticesEmpty");
        host.appendChild(p);
      }
    } catch {}
  }

  async function submitNotice() {
    const title = ($("admNoticeTitle").value || "").trim();
    const body = ($("admNoticeBody").value || "").trim();
    if (!title) {
      $("admMsg").textContent = t("noticesTitlePh");
      return;
    }
    try {
      let data;
      if (editingNoticeId) {
        const res = await fetch(`${apiBase()}/api/admin/notices/${editingNoticeId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${sessionToken()}` },
          body: JSON.stringify({ title, body }),
        });
        data = await res.json();
      } else {
        data = await post("/api/admin/notices", { title, body });
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

  // 旧wd_adminTokenが残っていれば掃除 (UID制では不要)
  try {
    localStorage.removeItem("wd_adminToken");
  } catch {}
  resetNoticeForm();
  if (sessionToken()) refreshAll();
  else setAuthed(false);
})();
