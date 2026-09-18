// wd-main.js — 起動シーケンス (最後に読むこと)。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
"use strict";
  loadInitial().then(() => requestAnimationFrame(render));
  if (document.readyState === "complete") connectSocket();
  else window.addEventListener("load", connectSocket);
  setTimeout(() => { if (!socket) connectSocket(); }, 1500);
  refreshInkUI();
  refreshColorUI();
  refreshLevelUI();
  refreshUserList();
  refreshDraftUI();
  refreshAdminUI();
  try { if (typeof initChat === "function") initChat(); } catch (e) { console.error(e); }