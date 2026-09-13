(() => {
  "use strict";

  function currentMode() {
    try {
      const mode = localStorage.getItem("wd_theme");
      if (mode === "light" || mode === "dark" || mode === "auto") return mode;
    } catch (e) {}
    return "auto";
  }

  function resolvedDark() {
    const mode = currentMode();
    if (mode === "dark") return true;
    if (mode === "light") return false;
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch (e) {
      return false;
    }
  }

  function paint() {
    document.documentElement.dataset.theme = resolvedDark() ? "dark" : "light";
  }

  window.wdTheme = {
    get: currentMode,
    set(mode) {
      try {
        localStorage.setItem("wd_theme", mode);
      } catch (e) {}
      paint();
    },
    paint,
  };

  paint();
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paint);
    window.addEventListener("storage", (e) => {
      if (!e.key || e.key === "wd_theme") paint();
    });
  } catch (e) {}
})();
