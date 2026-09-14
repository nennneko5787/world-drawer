// wd-picker.js — パレット・カラーピッカー・最近使った色。
// classic script (defer順に読む。トップレベルスコープ共有、前方参照は実行時解決)。
"use strict";
  // ---------- custom color picker (GIMP-style: SV + hue bar + RGB/HSV/LCH sliders) ----------
  const cpSvCtx = cpSv.getContext("2d");
  const cpHueBarCtx = cpHueBar.getContext("2d");
  const cpState = { h: 0, s: 100, v: 100, lh: 0, fmt: "rgb" };
  function clampNum(v, lo, hi, fallback = 0) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  }
  function hsvToRgb(h, s, v) {
    s /= 100;
    v /= 100;
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }
  function rgbToHsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const d = mx - mn;
    let h = 0;
    if (d !== 0) {
      if (mx === r) h = 60 * (((g - b) / d) % 6);
      else if (mx === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return [Math.round(h) % 360, Math.round((mx === 0 ? 0 : d / mx) * 100), Math.round(mx * 100)];
  }
  function srgbToLinear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function linearToSrgb(c) {
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return clampNum(Math.round(v * 255), 0, 255);
  }
  function rgbToXyz(r, g, b) {
    const rl = srgbToLinear(r), gl = srgbToLinear(g), bl = srgbToLinear(b);
    return [
      rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375,
      rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750,
      rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041,
    ];
  }
  function xyzToLab(x, y, z) {
    const eps = 216 / 24389, kap = 24389 / 27;
    const f = (t) => (t > eps ? Math.cbrt(t) : (kap * t + 16) / 116);
    const fx = f(x / 0.95047), fy = f(y), fz = f(z / 1.08883);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  function labToXyz(l, a, b) {
    const eps = 216 / 24389, kap = 24389 / 27;
    const fy = (l + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const f3 = (t) => {
      const t3 = t * t * t;
      return t3 > eps ? t3 : (116 * t - 16) / kap;
    };
    return [f3(fx) * 0.95047, f3(fy), f3(fz) * 1.08883];
  }
  function rgbToLch(r, g, b) {
    const [l, a, bb] = xyzToLab(...rgbToXyz(r, g, b));
    const c = Math.hypot(a, bb);
    let h = (Math.atan2(bb, a) * 180) / Math.PI;
    if (h < 0) h += 360;
    return [l, c, h];
  }
  function lchToRgb(l, c, hDeg) {
    const h = (hDeg * Math.PI) / 180;
    const [x, y, z] = labToXyz(l, c * Math.cos(h), c * Math.sin(h));
    return [
      linearToSrgb(x * 3.2404542 + y * -1.5371385 + z * -0.4985314),
      linearToSrgb(x * -0.9692660 + y * 1.8760108 + z * 0.0415560),
      linearToSrgb(x * 0.0556434 + y * -0.2040259 + z * 1.0572252),
    ];
  }
  function rgbToHex(r, g, b) {
    const hx = (n) => clampNum(Math.round(n), 0, 255).toString(16).padStart(2, "0");
    return `#${hx(r)}${hx(g)}${hx(b)}`;
  }
  function parseHexToRgb(text) {
    let t = String(text || "").trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{3}$/.test(t)) t = t.split("").map((c) => c + c).join("");
    if (!/^[0-9a-fA-F]{6}$/.test(t)) return null;
    const n = parseInt(t, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function cpCurrentHex() {
    return rgbToHex(...hsvToRgb(cpState.h, cpState.s, cpState.v));
  }
  const cpCss = (r, g, b) => `rgb(${r},${g},${b})`;
  function sampleStops(n, fn) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(fn(n === 1 ? 0 : i / (n - 1)));
    return out;
  }
  function paintRange(el, stops) {
    const parts = stops.map((c, i) => `${c} ${(i / (stops.length - 1)) * 100}%`);
    el.style.background = `linear-gradient(90deg, ${parts.join(", ")})`;
  }
  function drawCpSv() {
    const w = cpSv.width, h = cpSv.height;
    const hueCss = `hsl(${cpState.h},100%,50%)`;
    const gradH = cpSvCtx.createLinearGradient(0, 0, w, 0);
    gradH.addColorStop(0, "#ffffff");
    gradH.addColorStop(1, hueCss);
    cpSvCtx.fillStyle = gradH;
    cpSvCtx.fillRect(0, 0, w, h);
    const gradV = cpSvCtx.createLinearGradient(0, 0, 0, h);
    gradV.addColorStop(0, "rgba(0,0,0,0)");
    gradV.addColorStop(1, "rgba(0,0,0,1)");
    cpSvCtx.fillStyle = gradV;
    cpSvCtx.fillRect(0, 0, w, h);
    const px = (cpState.s / 100) * w;
    const py = (1 - cpState.v / 100) * h;
    cpSvCtx.strokeStyle = "#fff";
    cpSvCtx.lineWidth = 2;
    cpSvCtx.beginPath();
    cpSvCtx.arc(px, py, 7, 0, Math.PI * 2);
    cpSvCtx.stroke();
    cpSvCtx.strokeStyle = "#000";
    cpSvCtx.lineWidth = 1;
    cpSvCtx.beginPath();
    cpSvCtx.arc(px, py, 7, 0, Math.PI * 2);
    cpSvCtx.stroke();
  }
  function drawCpHueBar() {
    const w = cpHueBar.width, h = cpHueBar.height;
    const grad = cpHueBarCtx.createLinearGradient(0, 0, 0, h);
    for (let i = 0; i <= 12; i++) grad.addColorStop(i / 12, `hsl(${i * 30},100%,50%)`);
    cpHueBarCtx.fillStyle = grad;
    cpHueBarCtx.fillRect(0, 0, w, h);
    const y = Math.min(h - 3, Math.max(3, (cpState.h / 359) * h));
    cpHueBarCtx.fillStyle = "#fff";
    cpHueBarCtx.fillRect(0, y - 3, w, 6);
    cpHueBarCtx.strokeStyle = "#000";
    cpHueBarCtx.lineWidth = 1;
    cpHueBarCtx.strokeRect(1, y - 3, w - 2, 6);
  }
  function syncCpForms() {
    const [r, g, b] = hsvToRgb(cpState.h, cpState.s, cpState.v);
    const [l, c, lh] = rgbToLch(r, g, b);
    if (c >= 0.5) cpState.lh = Math.round(lh) % 360;
    const li = Math.round(l), ci = Math.round(c);
    cpR.value = String(r);
    cpG.value = String(g);
    cpB.value = String(b);
    cpRs.value = String(r);
    cpGs.value = String(g);
    cpBs.value = String(b);
    cpHsvH.value = String(Math.round(cpState.h));
    cpHsvS.value = String(Math.round(cpState.s));
    cpHsvV.value = String(Math.round(cpState.v));
    cpHsvHs.value = String(Math.round(cpState.h));
    cpHsvSs.value = String(Math.round(cpState.s));
    cpHsvVs.value = String(Math.round(cpState.v));
    cpLchL.value = String(li);
    cpLchC.value = String(ci);
    cpLchH.value = String(cpState.lh);
    cpLchLs.value = String(li);
    cpLchCs.value = String(ci);
    cpLchHs.value = String(cpState.lh);
    paintRange(cpRs, sampleStops(8, (k) => cpCss(Math.round(k * 255), g, b)));
    paintRange(cpGs, sampleStops(8, (k) => cpCss(r, Math.round(k * 255), b)));
    paintRange(cpBs, sampleStops(8, (k) => cpCss(r, g, Math.round(k * 255))));
    paintRange(cpHsvHs, sampleStops(13, (k) => cpCss(...hsvToRgb(k * 360, 100, 100))));
    paintRange(cpHsvSs, sampleStops(8, (k) => cpCss(...hsvToRgb(cpState.h, k * 100, cpState.v))));
    paintRange(cpHsvVs, sampleStops(8, (k) => cpCss(...hsvToRgb(cpState.h, cpState.s, k * 100))));
    paintRange(cpLchLs, sampleStops(12, (k) => cpCss(...lchToRgb(k * 100, c, cpState.lh))));
    paintRange(cpLchCs, sampleStops(12, (k) => cpCss(...lchToRgb(l, k * 150, cpState.lh))));
    paintRange(cpLchHs, sampleStops(13, (k) => cpCss(...lchToRgb(l, c, k * 360))));
    cpHex.value = cpCurrentHex().slice(1);
    cpPreview.style.background = cpCurrentHex();
    drawCpSv();
    drawCpHueBar();
    cpApply(cpCurrentHex());
  }
  function cpFromRgb(r, g, b) {
    const [h, s, v] = rgbToHsv(clampNum(r, 0, 255), clampNum(g, 0, 255), clampNum(b, 0, 255));
    cpState.h = h;
    cpState.s = s;
    cpState.v = v;
    syncCpForms();
  }
  function cpFromLch(l, c, h) {
    cpFromRgb(...lchToRgb(clampNum(l, 0, 100), clampNum(c, 0, 150), clampNum(h, 0, 359)));
  }
  function cpSvPoint(e) {
    const rect = cpSv.getBoundingClientRect();
    const cx = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX) - rect.left;
    const cy = (e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY) - rect.top;
    cpState.s = clampNum((cx / rect.width) * 100, 0, 100);
    cpState.v = clampNum((1 - cy / rect.height) * 100, 0, 100);
    syncCpForms();
  }
  function cpHueBarPoint(e) {
    const rect = cpHueBar.getBoundingClientRect();
    cpState.h = clampNum(((e.clientY - rect.top) / rect.height) * 359, 0, 359);
    syncCpForms();
  }
  let cpDragging = false;
  cpSv.addEventListener("pointerdown", (e) => {
    cpDragging = true;
    cpSv.setPointerCapture(e.pointerId);
    cpSvPoint(e);
  });
  cpSv.addEventListener("pointermove", (e) => {
    if (cpDragging) cpSvPoint(e);
  });
  cpSv.addEventListener("pointerup", () => {
    cpDragging = false;
  });
  let cpHueDragging = false;
  cpHueBar.addEventListener("pointerdown", (e) => {
    cpHueDragging = true;
    cpHueBar.setPointerCapture(e.pointerId);
    cpHueBarPoint(e);
  });
  cpHueBar.addEventListener("pointermove", (e) => {
    if (cpHueDragging) cpHueBarPoint(e);
  });
  cpHueBar.addEventListener("pointerup", () => {
    cpHueDragging = false;
  });
  cpHex.addEventListener("change", () => {
    const rgb = parseHexToRgb(cpHex.value);
    if (rgb) cpFromRgb(...rgb);
    else syncCpForms();
  });
  const cpNum = (el, fn) => el.addEventListener("change", fn);
  const cpSlide = (el, fn) => el.addEventListener("input", fn);
  cpNum(cpR, () => cpFromRgb(cpR.value, cpG.value, cpB.value));
  cpNum(cpG, () => cpFromRgb(cpR.value, cpG.value, cpB.value));
  cpNum(cpB, () => cpFromRgb(cpR.value, cpG.value, cpB.value));
  cpSlide(cpRs, () => cpFromRgb(cpRs.value, cpG.value, cpB.value));
  cpSlide(cpGs, () => cpFromRgb(cpR.value, cpGs.value, cpB.value));
  cpSlide(cpBs, () => cpFromRgb(cpR.value, cpG.value, cpBs.value));
  const cpHsvFromInputs = (h, s, v) => {
    cpState.h = clampNum(h, 0, 359);
    cpState.s = clampNum(s, 0, 100);
    cpState.v = clampNum(v, 0, 100);
    syncCpForms();
  };
  cpNum(cpHsvH, () => cpHsvFromInputs(cpHsvH.value, cpHsvS.value, cpHsvV.value));
  cpNum(cpHsvS, () => cpHsvFromInputs(cpHsvH.value, cpHsvS.value, cpHsvV.value));
  cpNum(cpHsvV, () => cpHsvFromInputs(cpHsvH.value, cpHsvS.value, cpHsvV.value));
  cpSlide(cpHsvHs, () => cpHsvFromInputs(cpHsvHs.value, cpHsvS.value, cpHsvV.value));
  cpSlide(cpHsvSs, () => cpHsvFromInputs(cpHsvH.value, cpHsvSs.value, cpHsvV.value));
  cpSlide(cpHsvVs, () => cpHsvFromInputs(cpHsvH.value, cpHsvV.value, cpHsvVs.value));
  const cpLchFromInputs = (l, c, h) => cpFromLch(l, c, h);
  cpNum(cpLchL, () => cpLchFromInputs(cpLchL.value, cpLchC.value, cpLchH.value));
  cpNum(cpLchC, () => cpLchFromInputs(cpLchL.value, cpLchC.value, cpLchH.value));
  cpNum(cpLchH, () => cpLchFromInputs(cpLchL.value, cpLchC.value, cpLchH.value));
  cpSlide(cpLchLs, () => cpLchFromInputs(cpLchLs.value, cpLchC.value, cpLchH.value));
  cpSlide(cpLchCs, () => cpLchFromInputs(cpLchL.value, cpLchCs.value, cpLchH.value));
  cpSlide(cpLchHs, () => cpLchFromInputs(cpLchL.value, cpLchC.value, cpLchHs.value));
  document.querySelectorAll(".cpTabs button").forEach((btn) => {
    btn.onclick = () => {
      cpState.fmt = btn.dataset.fmt;
      document.querySelectorAll(".cpTabs button").forEach((el) => el.classList.toggle("active", el === btn));
      document.querySelectorAll(".cpSliders").forEach((el) => el.classList.toggle("hidden", el.dataset.fmt !== cpState.fmt));
    };
  });
  const CP_BASIC = [
    "#000000", "#434343", "#666666", "#999999", "#b7b7b7",
    "#cccccc", "#d9d9d9", "#efefef", "#f3f3f3", "#ffffff",
    "#7f0000", "#ff0000", "#ff6b6b", "#ff9e9e", "#7f3300",
    "#ff7f00", "#ffb36b", "#7f7f00", "#ffff00", "#ffff7f",
    "#007f00", "#00b300", "#00ff00", "#7fff7f", "#007f7f",
    "#00ffff", "#7fffff", "#00007f", "#0000ff", "#7f7fff",
    "#7f007f", "#ff00ff", "#ff7fff", "#ff007f", "#ff5c8a",
    "#7f0033", "#8a5a00", "#c9a227", "#5b3a00", "#a56900",
    "#3b2d6b", "#6b4fd8", "#9d8df1", "#0e4d64", "#1591b3",
    "#5bc8e8", "#1d6b38", "#37b24d", "#8ce99a", "#5c3d00",
  ];
  CP_BASIC.forEach((hex) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.style.background = hex;
    btn.title = hex;
    btn.setAttribute("aria-label", hex);
    btn.onclick = () => {
      const rgb = parseHexToRgb(hex);
      if (rgb) cpFromRgb(...rgb);
    };
    cpBasicGrid.appendChild(btn);
  });
  // 最近使った色 (新しい順・重複なし・端末に保存)。確定した色だけ記録し、
  // スライダー操作中の途中色は閉じる時の最終色として1件だけ残す
  const MAX_RECENT_COLORS = 20;
  let recentColors = [];
  try {
    const savedRecent = JSON.parse(localStorage.getItem("wd_recentColors") || "[]");
    if (Array.isArray(savedRecent)) {
      recentColors = savedRecent
        .filter((c) => /^#[0-9a-fA-F]{6}$/.test(c))
        .map((c) => String(c).toLowerCase())
        .slice(0, MAX_RECENT_COLORS);
    }
  } catch {}
  function saveRecentColors() {
    try {
      localStorage.setItem("wd_recentColors", JSON.stringify(recentColors));
    } catch {}
  }
  function renderRecentColors() {
    if (!cpRecentGrid) return;
    cpRecentGrid.innerHTML = "";
    recentColors.forEach((hex) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.style.background = hex;
      btn.title = hex;
      btn.setAttribute("aria-label", hex);
      btn.onclick = () => {
        const rgb = parseHexToRgb(hex);
        if (rgb) cpFromRgb(...rgb);
      };
      cpRecentGrid.appendChild(btn);
    });
    if (cpRecentEmpty) cpRecentEmpty.classList.toggle("hidden", recentColors.length > 0);
  }
  function pushRecentColor(hex) {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex || "")) return;
    const norm = String(hex).toLowerCase();
    recentColors = [norm, ...recentColors.filter((c) => c !== norm)].slice(0, MAX_RECENT_COLORS);
    saveRecentColors();
    renderRecentColors();
  }
  renderRecentColors();
  let cpTarget = { kind: "paint" };
  function cpApply(hex) {
    if (cpTarget.kind === "profile") {
      setProfileColor(hex);
      return;
    }
    if (cpTarget.kind === "swatch") {
      palette[cpTarget.index] = hex;
      const el = swatchesEl.children[cpTarget.index];
      if (el) {
        el.style.background = hex;
        el.dataset.color = hex;
        el.title = t("swatchTitle", { c: hex });
      }
    }
    setPaintColor(hex);
  }
  function openColorPanel(target) {
    cpTarget = target || { kind: "paint" };
    const current =
      cpTarget.kind === "profile"
        ? myColor
        : cpTarget.kind === "swatch"
          ? palette[cpTarget.index]
          : paintColor;
    const rgb = parseHexToRgb(current);
    if (rgb) cpFromRgb(...rgb);
    else {
      cpState.h = 0;
      cpState.s = 100;
      cpState.v = 100;
      syncCpForms();
    }
    colorPanel.classList.remove("hidden");
  }
  function closeColorPanel() {
    // 塗る色の確定として最終色を履歴に (カーソル色の編集時は除く)
    if (cpTarget.kind !== "profile") pushRecentColor(cpCurrentHex());
    if (cpTarget.kind === "swatch") {
      savePalette();
      renderSwatches();
    }
    colorPanel.classList.add("hidden");
  }
  colorBtn.onclick = () => openColorPanel({ kind: "paint" });
  profileColorBtn.onclick = () => openColorPanel({ kind: "profile" });
  colorClose.onclick = closeColorPanel;
  cpOk.onclick = closeColorPanel;

  let paintColor = "#ff0000";
  function setPaintColor(color) {
    if (!/^#[0-9a-fA-F]{6}$/.test(color || "")) return;
    paintColor = String(color).toLowerCase();
    colorChip.style.background = paintColor;
    document.querySelectorAll(".sw").forEach((el) => {
      el.classList.toggle("sel", el.dataset.color === paintColor);
    });
    markDirty(); // ホバープレビュー色に反映
  }
  function setProfileColor(color) {
    if (!/^#[0-9a-fA-F]{6}$/.test(color || "")) return;
    myColor = String(color).toLowerCase();
    profileColorChip.style.background = myColor;
  }
  setProfileColor(myColor);
  setPaintColor(paintColor);

  const defaultPalette = ["#000000", "#ffffff", "#ff0000", "#ff8000", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#8000ff", "#ff00ff", "#8b4513", "#808080", "#ffd700", "#ff69b4"];
  let palette = [...defaultPalette];
  try {
    const saved = JSON.parse(localStorage.getItem("wd_palette") || "[]");
    if (Array.isArray(saved) && saved.length > 0 && saved.every((c) => /^#[0-9a-fA-F]{6}$/.test(c))) {
      palette = saved;
    }
  } catch {}
  function savePalette() {
    localStorage.setItem("wd_palette", JSON.stringify(palette));
  }
  function renderSwatches() {
    swatchesEl.innerHTML = "";
    palette.forEach((c, i) => {
      const btn = document.createElement("button");
      btn.className = "sw" + (c.toLowerCase() === paintColor ? " sel" : "");
      btn.style.background = c;
      btn.dataset.color = c.toLowerCase();
      btn.title = t("swatchTitle", { c });
      btn.onclick = () => {
        if (btn.classList.contains("sel")) openColorPanel({ kind: "swatch", index: i });
        else {
          setPaintColor(c);
          pushRecentColor(c);
        }
      };
      btn.ondblclick = (e) => {
        e.preventDefault();
        openColorPanel({ kind: "swatch", index: i });
      };
      swatchesEl.appendChild(btn);
    });
  }
  renderSwatches();
