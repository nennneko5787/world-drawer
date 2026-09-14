// wd-ui.js — トースト・レベル・オンライン表示などのHUD。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
"use strict";
  function updateCooldownUI() {
    const remain = Math.max(0, (cooldownUntil - Date.now()) / 1000);
    const text = remain > 0 ? t("cooldownToast", { s: remain.toFixed(1) }) : t("ready");
    if (text === cooldownShown) return; // 毎フレームのDOM更新を抑制
    cooldownShown = text;
    cooldownEl.textContent = text;
    cooldownEl.classList.toggle("cool", remain > 0);
  }

  function toast(msg, cls = "", action) {
    const el = document.createElement("div");
    el.className = "toast " + cls;
    el.textContent = msg;
    if (action) {
      const btn = document.createElement("button");
      btn.className = "toastBtn";
      btn.textContent = action.label;
      btn.onclick = () => {
        try {
          action.fn();
        } finally {
          el.remove();
        }
      };
      el.appendChild(btn);
    }
    toastWrap.appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .4s"; }, 2600);
    setTimeout(() => el.remove(), 3200);
    while (toastWrap.children.length > 3) toastWrap.firstChild.remove();
  }

  function refreshInkUI() {
    document.getElementById("c-glow").textContent = inventory.glow || 0;
    document.getElementById("c-rainbow").textContent = inventory.rainbow || 0;
    document.getElementById("c-ghost").textContent = inventory.ghost || 0;
    document.querySelectorAll(".ink").forEach((btn) => {
      const key = btn.dataset.ink;
      if (key === "normal") return;
      if (key === "normal") {
        btn.disabled = false;
        return;
      }
      btn.disabled = (inventory[key] || 0) <= 0 && !inkSet.has(key);
    });
  }

  function refreshColorUI() {
    // 虹インクは色指定なしのためカラー選択を無効化 (設計図モードを除く)
    const disabled = tool === "pen" && inkSet.has("rainbow") && !draftMode;
    colorBtn.disabled = disabled;
    swatchesEl.classList.toggle("disabled", disabled);
  }

  function refreshLevelUI() {
    levelEl.textContent = t("levelFmt", { level: myLevel, xp: myXp, need: xpNeeded });
    levelEl.title = t("levelTitleFmt", {
      level: myLevel,
      cooldown: cooldown.toFixed(1),
      remain: Math.max(0, xpNeeded - myXp),
    });
  }

  function applyLevelData(data) {
    if (!data) return;
    if (data.level) myLevel = data.level;
    if (data.xp != null) myXp = data.xp;
    if (data.xpNeeded) xpNeeded = data.xpNeeded;
    if (data.cooldown) cooldown = data.cooldown;
    refreshLevelUI();
  }

  function refreshOnlineUI() {
    onlineCount.textContent = String((onlineTotal ?? remotes.size) + 1);
  }

  function refreshUserList() {
    // 色と名前の一覧 (座標は出さない)
    const items = [{ uid: myUid, name: myName, color: myColor, country: myShowCountry ? myCountry : null, self: true }];
    for (const cur of remotes.values()) {
      items.push({ uid: cur.uid || "?", name: cur.name || t("anon"), color: cur.color || "#22aa66", country: cur.country });
    }
    items.sort((a, b) => (a.self ? -1 : b.self ? 1 : String(a.name).localeCompare(String(b.name), window.wdI18n.locale)));
    userList.innerHTML = "";
    for (const u of items) {
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = u.color;
      li.appendChild(dot);
      const label = document.createElement("span");
      label.className = "uname";
      label.textContent = "";
      const flagEl = makeFlagEl(u.country);
      if (flagEl) {
        label.appendChild(flagEl);
        label.appendChild(document.createTextNode(" "));
      }
      label.appendChild(document.createTextNode(`${u.name} #${u.uid || "?"}`));
      li.appendChild(label);
      if (u.self) {
        const me = document.createElement("span");
        me.className = "selfTag";
        me.textContent = t("selfTag");
        li.appendChild(me);
      } else {
        const btn = document.createElement("button");
        btn.className = "blockBtn";
        const isBlocked = blocked.has(u.uid);
        btn.textContent = isBlocked ? t("unblockBtn") : t("blockBtn");
        btn.title = isBlocked ? t("blockTitle") : t("unblockTitle");
        btn.onclick = () => toggleBlock(u.uid);
        li.appendChild(btn);
      }
      userList.appendChild(li);
    }
    refreshOnlineUI();
  }

  function formatCoords(cell) {
    return `(${cell.x}, ${cell.y})`;
  }
