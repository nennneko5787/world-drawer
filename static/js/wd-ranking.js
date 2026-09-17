// wd-ranking.js — レベルランキング (公開・新規パネル)。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
"use strict";
  async function fetchRanking() {
    if (typeof rankingList === "undefined" || !rankingList) return;
    rankingList.innerHTML = "";
    const loading = document.createElement("li");
    loading.className = "muted";
    loading.textContent = t("rankingLoading");
    rankingList.appendChild(loading);
    try {
      const res = await fetch(`${apiBase()}/api/ranking?limit=100`, { headers: { "Accept": "application/json" } });
      const data = await res.json();
      if (!data || !data.ok || !Array.isArray(data.ranking)) throw new Error("bad");
      rankingList.innerHTML = "";
      if (data.ranking.length === 0) {
        const li = document.createElement("li");
        li.className = "muted";
        li.textContent = t("rankingEmpty");
        rankingList.appendChild(li);
        return;
      }
      for (const r of data.ranking) {
        const li = document.createElement("li");
        const rankEl = document.createElement("span");
        rankEl.className = "rrank";
        rankEl.textContent = String(r.rank ?? "?");
        li.appendChild(rankEl);
        const dot = document.createElement("span");
        dot.className = "dot";
        dot.style.background = r.color || "#22aa66";
        li.appendChild(dot);
        const label = document.createElement("span");
        label.className = "uname";
        const flagEl = (typeof makeFlagEl === "function") ? makeFlagEl(r.country) : null;
        if (flagEl) {
          label.appendChild(flagEl);
          label.appendChild(document.createTextNode(" "));
        }
        const nameEl = document.createElement("span");
        nameEl.className = "nname";
        nameEl.textContent = r.name || t("anon");
        label.appendChild(nameEl);
        const metaEl = document.createElement("span");
        metaEl.className = "nmeta";
        metaEl.textContent = `#${r.uid || "?"} Lv${r.level ?? "?"}`;
        label.appendChild(metaEl);
        li.appendChild(label);
        rankingList.appendChild(li);
      }
    } catch {
      rankingList.innerHTML = "";
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = t("rankingFailed");
      rankingList.appendChild(li);
    }
  }

  function openRanking() {
    if (typeof rankingPanel === "undefined" || !rankingPanel) return;
    openModal(rankingPanel);
    fetchRanking();
  }

  if (typeof rankingBtn !== "undefined" && rankingBtn) {
    rankingBtn.onclick = () => {
      const opening = typeof rankingPanel !== "undefined" && rankingPanel && rankingPanel.classList.contains("hidden");
      if (opening) openRanking();
      else closeAllModals();
    };
  }
  if (typeof rankingClose !== "undefined" && rankingClose) {
    rankingClose.onclick = () => closeAllModals();
  }
  // 言語切替時は開いていれば描き直す
  {
    const prevRefresh = window.wdLocaleRefresh;
    window.wdLocaleRefresh = () => {
      try {
        if (typeof prevRefresh === "function") prevRefresh();
      } catch {}
      try {
        if (typeof rankingPanel !== "undefined" && rankingPanel && !rankingPanel.classList.contains("hidden")) fetchRanking();
      } catch {}
    };
  }
