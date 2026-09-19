// wd-ui.js — トースト・レベル・オンライン表示などのHUD。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
"use strict";
  function updateCooldownUI() {
    const remain = Math.max(0, (cooldownUntil - Date.now()) / 1000);
    const s = fmtRemain(remain);
    const text = s ? t("cooldownToast", { s }) : t("ready");
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
    document.getElementById("c-chalk").textContent = inventory.chalk || 0;
    document.getElementById("c-shield").textContent = inventory.shield || 0;
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
    if (typeof data.isAdmin === "boolean" && data.isAdmin !== isAdmin) {
      isAdmin = data.isAdmin;
      refreshAdminUI();
    }
    refreshLevelUI();
  }

  function refreshOnlineUI() {
    onlineCount.textContent = String((onlineTotal ?? remotes.size) + 1);
  }

  function refreshUserList() {
    // 色と名前とレベルの一覧 (座標は出さない)
    const items = [{ uid: myUid, name: myName, color: myColor, level: myLevel, country: myShowCountry ? myCountry : null, self: true }];
    for (const cur of remotes.values()) {
      items.push({ uid: cur.uid || "?", name: cur.name || t("anon"), color: cur.color || "#22aa66", level: cur.level ?? 1, country: cur.country });
    }
    items.sort((a, b) => (a.self ? -1 : b.self ? 1 : String(a.name).localeCompare(String(b.name), window.wdI18n.locale)));
    userList.innerHTML = "";
    for (const u of items) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.className = "uname";
      label.textContent = "";
      const flagEl = makeFlagEl(u.country);
      if (flagEl) {
        label.appendChild(flagEl);
        label.appendChild(document.createTextNode(" "));
      }
      const nameEl = document.createElement("span");
      nameEl.className = "nname";
      nameEl.textContent = u.name || t("anon");
      nameEl.style.color = u.color || "#22aa66";
      label.appendChild(nameEl);
      const metaEl = document.createElement("span");
      metaEl.className = "nmeta";
      metaEl.textContent = `#${u.uid || "?"} Lv${u.level ?? "?"}`;
      label.appendChild(metaEl);
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
        // 管理者向け: 照会・巻き戻し (管理パネルと同等の操作)
        if (typeof isAdmin !== "undefined" && isAdmin) {
          const lookupBtn = document.createElement("button");
          lookupBtn.className = "blockBtn";
          lookupBtn.textContent = t("adminLookup");
          lookupBtn.title = t("adminLookup");
          lookupBtn.onclick = () => {
            try {
              if (typeof adminUid !== "undefined" && adminUid) adminUid.value = u.uid;
              if (typeof adminLookup === "function") adminLookup();
              if (typeof openModal === "function" && typeof adminPanel !== "undefined" && adminPanel) openModal(adminPanel);
            } catch {}
          };
          li.appendChild(lookupBtn);
          const rbBtn = document.createElement("button");
          rbBtn.className = "blockBtn";
          rbBtn.textContent = t("adminRollback");
          rbBtn.title = t("adminRollback");
          rbBtn.onclick = async () => {
            try {
              if (typeof adminUid !== "undefined" && adminUid) adminUid.value = u.uid;
              if (typeof adminLookup === "function") await adminLookup();
              if (typeof adminRollback === "function") adminRollback();
            } catch {}
          };
          li.appendChild(rbBtn);
        }
      }
      userList.appendChild(li);
    }
    refreshOnlineUI();
  }

  function formatCoords(cell) {
    return `(${cell.x}, ${cell.y})`;
  }

  // 残り秒の表示整形。1秒未満も0でなければ小数2桁で必ず表示する
  function fmtRemain(sec) {
    const v = Math.max(0, Number(sec) || 0);
    if (!(v > 0)) return "";
    return v < 1 ? v.toFixed(2) : v.toFixed(1);
  }

  // chrome計測: topbar/toolbarの実高さをCSS変数へ反映し、固定px配置を排除する。
  // toast・profileBar・統計・ドック・undoはすべて変数参照のため重ならない
  function measureChrome() {
    try {
      const root = document.documentElement;
      if (typeof toolbarEl !== "undefined" && toolbarEl) {
        root.style.setProperty("--toolbar-h", `${Math.ceil(toolbarEl.getBoundingClientRect().height)}px`);
      }
      const tb = document.getElementById("topbar");
      if (tb) {
        root.style.setProperty("--topbar-h", `${Math.ceil(tb.getBoundingClientRect().height + 16)}px`);
      }
    } catch {}
  }
  try {
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => measureChrome());
      if (typeof toolbarEl !== "undefined" && toolbarEl) ro.observe(toolbarEl);
      const tb = document.getElementById("topbar");
      if (tb) ro.observe(tb);
    }
    window.addEventListener("resize", measureChrome);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", measureChrome);
    } else {
      measureChrome();
    }
    setTimeout(measureChrome, 500);
  } catch {}
