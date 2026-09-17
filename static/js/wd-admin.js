// wd-admin.js — 管理画面 (荒らし対応。isAdmin のときのみ表示)。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
"use strict";
  // 直近の照会結果 (巻き戻し・禁止の対象)
  let adminTarget = null; // {uid, ip}
  function refreshAdminUI() {
    if (adminBtn) adminBtn.classList.toggle("hidden", !isAdmin);
    if (!isAdmin && adminPanel) adminPanel.classList.add("hidden");
  }
  async function adminPost(path, body) {
    const res = await fetch(`${apiBase()}${path}`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ ...body }),
    });
    return await res.json();
  }
  function renderAdminResult(u) {
    if (!adminResult) return;
    adminResult.textContent =
      `${u.name} #${u.uid} Lv${u.level} · ${u.touchedCells} ${t("h_cells")}` +
      ` · ${u.lastIp || "?"}${u.online ? " · online" : ""}`;
  }
  async function adminLookup() {
    const uid = (adminUid.value || "").trim();
    if (!uid) {
      toast(t("adminNeedUid"));
      return;
    }
    try {
      const data = await adminPost("/api/admin/lookup", { uid });
      if (!data.ok) {
        adminTarget = null;
        toast(t(data.error === "noUser" ? "adminNoUser" : "commError"));
        return;
      }
      adminTarget = { uid: data.user.uid, ip: data.user.lastIp || null };
      renderAdminResult(data.user);
    } catch {
      toast(t("commError"));
    }
  }
  async function adminRollback() {
    if (!adminTarget) {
      toast(t("adminNeedUid"));
      return;
    }
    if (!confirm(`rollback #${adminTarget.uid} ?`)) return;
    try {
      const data = await adminPost("/api/admin/rollback", { uid: adminTarget.uid, limit: 1000 });
      if (!data.ok) {
        toast(t(data.error === "forbidden" ? "adminForbidden" : "commError"));
        return;
      }
      toast(t("adminRollbackDone", { n: data.restored, skip: data.skipped }));
      adminLookup();
    } catch {
      toast(t("commError"));
    }
  }
  async function adminBan() {
    if (!adminTarget || !adminTarget.ip) {
      toast(t("adminNeedUid"));
      return;
    }
    if (!confirm(`ban ${adminTarget.ip} 24h ?`)) return;
    try {
      const data = await adminPost("/api/admin/ban", { ip: adminTarget.ip, seconds: 86400 });
      if (!data.ok) {
        toast(t(data.error === "forbidden" ? "adminForbidden" : data.error === "badIp" ? "adminBadIp" : "commError"));
        return;
      }
      toast(t("adminBanDone", { ip: data.ip }));
    } catch {
      toast(t("commError"));
    }
  }
  if (adminBtn) {
    adminBtn.onclick = () => openModal(adminPanel);
  }
  if (adminClose) adminClose.onclick = () => closeAllModals();
  if (adminLookupBtn) adminLookupBtn.onclick = adminLookup;
  if (adminRollbackBtn) adminRollbackBtn.onclick = adminRollback;
  if (adminBanBtn) adminBanBtn.onclick = adminBan;
  if (adminUid) {
    adminUid.addEventListener("keydown", (e) => {
      if (e.key === "Enter") adminLookup();
    });
  }
