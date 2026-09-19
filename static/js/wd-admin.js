// wd-admin.js — 管理ボタンの表示切替のみ。管理操作は /admin ページに統一。
// (旧キャンバス内管理モーダルは撤去。ユーザー一覧からの遷移は wd-ui.js 側で行う)
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
"use strict";
  // adminBtn は /admin へのリンク (a.pill)。isAdmin のときだけ表示する。
  function refreshAdminUI() {
    try {
      if (typeof adminBtn !== "undefined" && adminBtn) adminBtn.classList.toggle("hidden", !isAdmin);
    } catch {}
  }
