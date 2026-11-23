"use strict";
// Before first paint: the desktop app's theme (?theme=, Settings > Account), else one chosen on this phone (This phone > Theme), else the system's.
(() => {
  let theme = new URLSearchParams(location.search).get("theme");
  try {
    if (theme !== "light" && theme !== "dark") theme = localStorage.getItem("gwh-theme");
  } catch {}
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
})();
