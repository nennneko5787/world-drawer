// wd-ui.js — トースト・レベル・オンライン表示などのHUD + 共通UIユーティリティ (UIDコピー)。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
"use strict";
  // クールダウン残り秒 (表示も送信ゲートもこの式に統一する)。
  // 時刻源は仮想サーバ時計 (WS同期済み)・未同期時はREST学習値
  function cooldownRemainSec() {
    const margin = (typeof cooldownMarginMs === "function") ? cooldownMarginMs() : 700;
    const nowMs = (typeof serverNowMs === "function") ? serverNowMs() : Date.now();
    return Math.max(0, (cooldownUntil + margin - nowMs) / 1000);
  }

  function updateCooldownUI() {
    const remain = cooldownRemainSec();
    const s = fmtRemain(remain);
    const text = s ? t("cooldownToast", { s }) : t("ready");
    if (text === cooldownShown) return; // 毎フレームのDOM更新を抑制
    cooldownShown = text;
    cooldownEl.textContent = text;
    cooldownEl.classList.toggle("cool", remain > 0);
  }

  // toast(msg[, cls|ms[, action]]) — 第2引数は従来のクラス名か、表示msのどちらも受ける。
  function toast(msg, clsOrMs = "", action) {
    let cls = "";
    let ms = 2600;
    if (typeof clsOrMs === "number" && Number.isFinite(clsOrMs)) ms = clsOrMs;
    else if (typeof clsOrMs === "string") cls = clsOrMs;
    const el = document.createElement("div");
    el.className = ("toast " + cls).trim();
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
    setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .4s"; }, ms);
    setTimeout(() => el.remove(), ms + 600);
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

  // t0: リクエスト送信時刻ms。ありの時は往復半分を差し引いて時刻補正する
  function applyLevelData(data, t0) {
    if (!data) return;
    // サーバ時刻・RTTを学習 (端末時計ズレと回線遅延の吸収)
    try {
      const n = Number(data.now);
      if (Number.isFinite(n) && n > 0) {
        const nowMs = Date.now();
        let rtt = 0;
        const t0n = Number(t0);
        if (Number.isFinite(t0n) && t0n > 0) {
          rtt = Math.max(0, nowMs - t0n);
          try {
            rttEmaMs = rttEmaMs > 0 ? rttEmaMs * 0.8 + rtt * 0.2 : rtt;
          } catch {}
        }
        const inst = n * 1000 - (nowMs - rtt / 2);
        if (Math.abs(inst) < 60000) {
          if (serverOffsetInit) {
            serverOffsetMs = inst;
            serverOffsetInit = false;
          } else {
            serverOffsetMs = serverOffsetMs * 0.7 + inst * 0.3;
          }
        }
      }
    } catch {}
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
    // onlineTotal (サーバの count) は自分込みの総数のため足さない。
    // 未取得時だけ手元 (他人 remotes + 自分) で組み立てる
    if (typeof onlineCount === "undefined" || !onlineCount) return;
    if (typeof onlineTotal === "number" && Number.isFinite(onlineTotal)) {
      onlineCount.textContent = String(Math.max(0, Math.round(onlineTotal)));
    } else {
      const me = (typeof myUid === "string" && myUid) ? 1 : 0;
      onlineCount.textContent = String(remotes.size + me);
    }
  }

  function refreshUserList() {
    // 色と名前の一覧 (ID・レベルはプロフィールに集約。名前クリックで開く)
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
      // 自分・他人を問わず名前クリックでプロフィールを開く
      if (u.uid && u.uid !== "?") {
        nameEl.dataset.prof = u.uid;
        nameEl.title = t("profileOpenHint");
      }
      label.appendChild(nameEl);
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
        // 管理者は詳細操作へ (/adminにUIDを引き継いで遷移。モーダルは持たない)
        if (typeof isAdmin !== "undefined" && isAdmin) {
          const admBtn = document.createElement("button");
          admBtn.className = "blockBtn";
          admBtn.textContent = t("adminTitle");
          admBtn.title = t("adminOpenTitle");
          admBtn.onclick = () => {
            location.href = "/admin?uid=" + encodeURIComponent(u.uid);
          };
          li.appendChild(admBtn);
        }
      }
      userList.appendChild(li);
    }
    refreshOnlineUI();
  }

  function formatCoords(cell) {
    return `(${cell.x}, ${cell.y})`;
  }

  // 残り秒の表示整形。常に小数第1位まで (0は空文字→「準備OK」)
  function fmtRemain(sec) {
    const v = Math.max(0, Number(sec) || 0);
    if (!(v > 0)) return "";
    return v.toFixed(1);
  }

  // chrome計測: topbar/toolbarの実高さをCSS変数へ反映し、固定px配置を排除する。
  // toast・profileBar・統計ドック・undoはすべて変数参照のため重ならない
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

  // ---- UIDコピー (全画面共通。data-uid / data-copy を持つ要素のクリックでコピー) ----
  function copyUid(uid) {
    if (!uid) return;
    const done = () => {
      try {
        toast(t("uidCopied", { uid }), 1500);
      } catch {}
    };
    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = uid;
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
        navigator.clipboard.writeText(uid).then(done).catch(fallback);
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
    copyUid(val);
  });

  // グローバル公開 (classic script 互換)
  window.wdCopyUid = copyUid;
