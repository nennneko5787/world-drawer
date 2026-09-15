// wd-panels.js — プロフィール・履歴パネル (サーバー連携UI)。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
"use strict";
  async function saveProfile() {
    myName = (profileName.value || "").trim().slice(0, 20) || t("anon");
    if (!/^#[0-9a-fA-F]{6}$/.test(myColor)) myColor = "#22aa66";
    localStorage.setItem("wd_name", myName);
    localStorage.setItem("wd_userColor", myColor);
    profileName.value = myName;
    try {
      await fetch(`${apiBase()}/api/profile`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ name: myName, color: myColor, showCountry: myShowCountry, tz: myTz }),
      });
      toast(t("profileSaved", { name: myName }));
      refreshUserList();
    } catch {
      toast(t("profileFailed"));
    }
  }

  function formatTime(at) {
    try {
      return new Date(at * 1000).toLocaleString(window.wdI18n.locale);
    } catch {
      return "";
    }
  }

  function appendHistoryItems(x, y, items) {
    for (const item of items) {
      const li = document.createElement("li");
      const chip = document.createElement("span");
      chip.className = "chip";
      if (item.t === "erase") {
        chip.innerHTML = '<i class="bi bi-eraser"></i>';
      } else {
        chip.style.background = item.c;
      }
      li.appendChild(chip);
      const main = document.createElement("span");
      main.className = "hmain";
      const inkEl = document.createElement("b");
      inkEl.textContent = inkName(item.t);
      main.appendChild(inkEl);
      const who = document.createElement("span");
      who.className = "hwho";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = item.userColor || "#22aa66";
      who.appendChild(dot);
      const hFlag = makeFlagEl(item.country);
      if (hFlag) {
        who.appendChild(hFlag);
        who.appendChild(document.createTextNode(" "));
      }
      const whoName = document.createElement("span");
      whoName.className = "nname";
      whoName.textContent = item.name;
      who.appendChild(whoName);
      const whoMeta = document.createElement("span");
      whoMeta.className = "nmeta";
      whoMeta.textContent = `#${item.uid || "?"} Lv${item.level ?? "?"}`;
      who.appendChild(whoMeta);
      main.appendChild(who);
      const time = document.createElement("span");
      time.className = "htime";
      time.textContent = formatTime(item.at);
      main.appendChild(time);
      li.appendChild(main);
      if (item.uid && item.uid !== myUid) {
        const btn = document.createElement("button");
        btn.className = "blockBtn";
        btn.textContent = blocked.has(item.uid) ? t("unblockBtn") : t("blockBtn");
        btn.title = t("blockTitleBoth");
        btn.onclick = () => {
          toggleBlock(item.uid);
          showHistory(x, y);
        };
        li.appendChild(btn);
      }
      historyList.appendChild(li);
    }
  }

  async function showHistory(x, y, beforeId) {
    const fresh = beforeId == null;
    if (fresh) {
      historyKey = `${x},${y}`;
      historyTitle.textContent = t("historyTitleFmt", { x, y });
      historyList.innerHTML = "";
      const loading = document.createElement("li");
      loading.className = "muted";
      loading.textContent = t("historyLoading");
      historyList.appendChild(loading);
      if (typeof openModal === "function") openModal(historyPanel);
      else historyPanel.classList.remove("hidden");
    }
    try {
      let url = `${apiBase()}/api/history?x=${x}&y=${y}&limit=20`;
      if (beforeId != null) url += `&beforeId=${beforeId}`;
      const data = await (await fetch(url)).json();
      if (historyKey !== `${x},${y}`) return;
      if (fresh) historyList.innerHTML = "";
      else document.getElementById("historyMore")?.remove();
      const items = data.items || [];
      if (fresh && items.length === 0) {
        const li = document.createElement("li");
        li.className = "muted";
        li.textContent = t("historyEmpty");
        historyList.appendChild(li);
        return;
      }
      appendHistoryItems(x, y, items);
      if (data.hasMore && items.length > 0) {
        const more = document.createElement("li");
        const btn = document.createElement("button");
        btn.id = "historyMore";
        btn.className = "blockBtn";
        btn.textContent = t("historyMore");
        btn.onclick = () => showHistory(x, y, items[items.length - 1].id);
        more.appendChild(btn);
        historyList.appendChild(more);
      }
    } catch {
      if (historyKey !== `${x},${y}`) return;
      if (!fresh) return;
      historyList.innerHTML = "";
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = t("historyFailed");
      historyList.appendChild(li);
    }
  }

  function closeHistory() {
    historyKey = null;
    if (typeof closeAllModals === "function") closeAllModals(true);
    else historyPanel.classList.add("hidden");
  }
