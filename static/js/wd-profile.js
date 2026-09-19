// wd-profile.js — 公開プロフィールモーダル。
// 一覧系（オンライン・ランキング・チャット・履歴）は名前のみ表示し、
// 名前クリック ([data-prof]) でこのモーダルを開く。
// ID・Lv・登録日・累計配置数・順位はここに集約する (ID行はクリックでコピー)。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
"use strict";
  let lastProfile = null; // 直近表示のユーザー ({uid,...}。言語切替の描き直し用)

  function formatRegTime(at) {
    const n = Number(at);
    if (at == null || !Number.isFinite(n)) return t("profileRegUnknown");
    try {
      return new Date(n * 1000).toLocaleString(window.wdI18n.locale);
    } catch {
      return t("profileRegUnknown");
    }
  }

  function renderProfileCard(u) {
    lastProfile = u;
    profileCard.innerHTML = "";
    const head = document.createElement("div");
    head.className = "pfHead";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = /^#[0-9a-fA-F]{6}$/.test(u.color || "") ? u.color : "#22aa66";
    head.appendChild(dot);
    const flagEl = (typeof makeFlagEl === "function") ? makeFlagEl(u.country) : null;
    if (flagEl) head.appendChild(flagEl);
    const nameEl = document.createElement("b");
    nameEl.className = "nname";
    nameEl.textContent = u.name || t("anon");
    head.appendChild(nameEl);
    profileCard.appendChild(head);

    const grid = document.createElement("dl");
    grid.className = "pfGrid";
    const rows = [
      ["ID", `#${u.uid || "?"}`, true],
      ["Lv", t("profileLevelFmt", { level: u.level ?? "?", xp: u.xp ?? 0 }), false],
      [t("profileReg"), formatRegTime(u.registeredAt), false],
      [t("profilePlaced"), `${u.placedTotal ?? "?"} ${t("h_cells")}`, false],
      [t("profileRank"), t("profileRankFmt", { n: u.rank ?? "?" }), false],
    ];
    for (const [term, text, copyable] of rows) {
      const cell = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = text;
      if (copyable && u.uid) {
        // ID行はクリックでコピー (wd-ui.jsの委任が拾う)
        dd.className = "mono";
        dd.dataset.uid = u.uid;
        dd.title = t("copyUidHint");
      }
      cell.appendChild(dt);
      cell.appendChild(dd);
      grid.appendChild(cell);
    }
    profileCard.appendChild(grid);

    const acts = document.createElement("div");
    acts.className = "pfActs";
    if (u.uid && u.uid !== myUid) {
      const btn = document.createElement("button");
      btn.className = "blockBtn";
      const isBlocked = typeof blocked !== "undefined" && blocked.has(u.uid);
      btn.textContent = isBlocked ? t("unblockBtn") : t("blockBtn");
      btn.title = t("blockTitleBoth");
      btn.onclick = () => {
        toggleBlock(u.uid);
        renderProfileCard(lastProfile); // ボタン表示を更新
      };
      acts.appendChild(btn);
      // 管理者は詳細操作へ (/adminにUIDを引き継いで遷移)
      if (typeof isAdmin !== "undefined" && isAdmin) {
        const admBtn = document.createElement("button");
        admBtn.className = "blockBtn";
        admBtn.textContent = t("adminTitle");
        admBtn.title = t("adminOpenTitle");
        admBtn.onclick = () => {
          location.href = "/admin?uid=" + encodeURIComponent(u.uid);
        };
        acts.appendChild(admBtn);
      }
    }
    if (acts.children.length) profileCard.appendChild(acts);
  }

  async function openProfile(uid) {
    if (!uid || uid === "?") return;
    if (typeof profilePanel === "undefined" || !profilePanel) return;
    if (typeof openModal === "function") openModal(profilePanel);
    else profilePanel.classList.remove("hidden");
    profileCard.innerHTML = "";
    const loading = document.createElement("p");
    loading.className = "muted";
    loading.textContent = t("profileLoading");
    profileCard.appendChild(loading);
    try {
      const res = await fetch(`${apiBase()}/api/profile?uid=${encodeURIComponent(uid)}`, {
        headers: { "Accept": "application/json" },
      });
      const data = await res.json();
      if (!data || !data.ok || !data.user) throw new Error("bad");
      // 取得中に閉じられていたら描かない
      if (profilePanel.classList.contains("hidden")) return;
      renderProfileCard(data.user);
    } catch {
      if (profilePanel.classList.contains("hidden")) return;
      profileCard.innerHTML = "";
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = t("profileFailed");
      profileCard.appendChild(p);
    }
  }

  // 名前クリック ([data-prof]) で開く。全画面共通
  document.addEventListener("click", (e) => {
    const target = e.target && e.target.closest ? e.target.closest("[data-prof]") : null;
    if (!target) return;
    const uid = target.dataset.prof;
    if (!uid) return;
    e.preventDefault();
    openProfile(uid);
  });

  if (typeof profileClose !== "undefined" && profileClose) {
    profileClose.onclick = () => closeAllModals();
  }
  // 言語切替時は開いていれば描き直す (再取得はしない)
  {
    const prevRefresh = window.wdLocaleRefresh;
    window.wdLocaleRefresh = () => {
      try {
        if (typeof prevRefresh === "function") prevRefresh();
      } catch {}
      try {
        if (typeof profilePanel !== "undefined" && profilePanel
          && !profilePanel.classList.contains("hidden") && lastProfile) {
          renderProfileCard(lastProfile);
        }
      } catch {}
    };
  }
