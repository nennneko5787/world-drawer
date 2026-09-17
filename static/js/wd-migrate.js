// wd-migrate.js — ドメイン移行時の旧サイト自動引っ越し (iframe + postMessage)。
// wd-auth.js の後に読むこと (apiBase を使う)。実行は loadInitial() の先頭で
// await されるため、ensureToken (新規セッション発行) より先に完了する。
// 成功時は localStorage へ書き込んで reload し、2周目で通常起動する。
"use strict";
  var WD_MIG_KEYS = ["wd_token", "wd_adminToken", "wd_name", "wd_userColor", "wd_lang",
    "wd_theme", "wd_showAxes", "wd_showZone", "wd_simplify", "wd_quality",
    "wd_glow", "wd_showShield", "wd_cursorRate", "wd_rightClick", "wd_middleClick",
    "wd_draftTool", "wd_showDraft", "wd_draft", "wd_blocked", "wd_recentColors",
    "wd_palette", "wd_cam", "wd_chromeHidden"];
  var WD_MIG_JSON_KEYS = { wd_draft: 1, wd_blocked: 1, wd_recentColors: 1, wd_palette: 1, wd_cam: 1 };

  function prevOrigins() {
    try {
      const m = document.querySelector('meta[name="wd-prev-origins"]');
      const raw = (m && m.content) || "";
      return raw.split(/[,\s]+/).map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
    } catch {
      return [];
    }
  }

  function migTried() {
    try {
      return !!sessionStorage.getItem("wd_mig_tried");
    } catch {
      return true;
    }
  }

  function markMigTried() {
    try {
      sessionStorage.setItem("wd_mig_tried", "1");
    } catch {}
  }

  function importOnce(origin, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const frame = document.createElement("iframe");
      frame.setAttribute("aria-hidden", "true");
      frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden;";
      let timer = 0;
      const cleanup = () => {
        clearTimeout(timer);
        try {
          frame.remove();
        } catch {}
        window.removeEventListener("message", onMsg);
      };
      const finish = (v) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(v);
      };
      const onMsg = (ev) => {
        try {
          if (ev.origin !== origin) return;
          if (ev.source !== frame.contentWindow) return;
          const d = ev.data;
          if (!d || d.wdMig !== 1 || !d.data || typeof d.data !== "object") return;
          finish(d.data);
        } catch {}
      };
      window.addEventListener("message", onMsg);
      timer = setTimeout(() => finish(null), timeoutMs);
      try {
        frame.src = origin + "/migrate.html?to=" + encodeURIComponent(location.origin);
        (document.body || document.documentElement).appendChild(frame);
      } catch {
        finish(null);
      }
    });
  }

  function sanitizeMig(data) {
    const out = {};
    for (const k of WD_MIG_KEYS) {
      const v = data[k];
      if (typeof v !== "string" || v.length === 0 || v.length > 1048576) continue;
      if (WD_MIG_JSON_KEYS[k]) {
        try {
          JSON.parse(v);
        } catch {
          continue;
        }
      }
      out[k] = v;
    }
    return out;
  }

  async function verifyMigToken(tok) {
    // 同一DB前提。無効トークンは引き継がない (設定のみ残す)。
    // 通信失敗時は fail-open (通常起動に任せる)。
    try {
      const res = await fetch(`${apiBase()}/api/me`, {
        headers: { "Authorization": `Bearer ${tok}` },
      });
      if (!res.ok) return false;
      const j = await res.json();
      return !!(j && j.uid);
    } catch {
      return true;
    }
  }

  async function maybeImportPrevOrigin() {
    try {
      if (migTried()) return;
      let hasToken = false;
      try {
        hasToken = !!localStorage.getItem("wd_token");
      } catch {
        return;
      }
      if (hasToken) {
        markMigTried();
        return;
      }
      const origins = prevOrigins();
      if (!origins.length) {
        markMigTried();
        return;
      }
      for (const origin of origins) {
        const data = await importOnce(origin, 4000);
        if (!data) continue;
        const clean = sanitizeMig(data);
        if (!Object.keys(clean).length) continue;
        if (clean.wd_token && !(await verifyMigToken(clean.wd_token))) {
          delete clean.wd_token;
          delete clean.wd_adminToken;
        }
        try {
          for (const k of Object.keys(clean)) {
            try {
              localStorage.setItem(k, clean[k]);
            } catch {}
          }
        } catch {}
        try {
          sessionStorage.setItem("wd_mig_done", "1");
        } catch {}
        markMigTried();
        location.reload();
        await new Promise(() => {}); // reload まで待機 (到達しない)
        return;
      }
      markMigTried();
    } catch {
      try {
        markMigTried();
      } catch {}
    }
  }
