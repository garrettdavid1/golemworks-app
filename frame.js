"use strict";
// The app frame on iPhone: a Home Screen app's page can end 62 pt short, and iOS paints none of it below that, so the column stays in the frame and the strip under it stands in for the bottom insets (--frame-short); a hidden readout (Settings header tapped five times, or ?debug=1) shows the numbers.
const Frame = (() => {
  const app = () => document.getElementById("app");
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  /** The screen's height in this orientation (iOS reports screen.width and height as in portrait). */
  const screenHeight = () => (matchMedia("(orientation: landscape)").matches ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height));
  let short = 0;

  /** How many px short of the screen the frame ends: only in a Home Screen app whose viewport is short of the screen. */
  function shortfall({ standalone: isApp, innerHeight, screenHeight: full }) {
    if (!isApp || !full || !innerHeight) return 0;
    const gap = Math.round(full - innerHeight);
    // A small gap is rounding; a huge one is the keyboard or split view, not this bug.
    return gap >= 8 && gap <= full * 0.15 ? gap : 0;
  }

  /** Where the column really ends: iOS can report a full innerHeight while position: fixed still ends short. */
  const frameBottom = (rectBottom, innerHeight) => (rectBottom > 0 ? Math.min(rectBottom, innerHeight) : innerHeight);

  function fit() {
    const node = app();
    if (!node) return;
    const bottom = frameBottom(node.getBoundingClientRect().bottom, window.innerHeight);
    short = shortfall({ standalone: standalone(), innerHeight: bottom, screenHeight: screenHeight() });
    if (short) node.style.setProperty("--frame-short", `${short}px`);
    else node.style.removeProperty("--frame-short");
    if (panel && !panel.hidden) fill();
  }

  // ---------- readout ----------

  let panel = null;
  const px = (n) => `${Math.round(n * 10) / 10}`;

  /** A probe element's computed size: what env() and the viewport units resolve to on this phone. */
  function probe(style, read) {
    const el = document.createElement("div");
    el.style.cssText = `position: fixed; left: 0; top: 0; width: 0; visibility: hidden; pointer-events: none; ${style}`;
    document.body.append(el);
    const value = read(el);
    el.remove();
    return value;
  }

  function rows() {
    const insets = probe("padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)", (el) => {
      const s = getComputedStyle(el);
      return `${px(parseFloat(s.paddingTop))} / ${px(parseFloat(s.paddingRight))} / ${px(parseFloat(s.paddingBottom))} / ${px(parseFloat(s.paddingLeft))}`;
    });
    const unit = (u) => probe(`height: 100${u}`, (el) => px(el.getBoundingClientRect().height));
    const rect = (el) => (el ? (({ top, bottom, height }) => `top ${px(top)}, bottom ${px(bottom)}, height ${px(height)}`)(el.getBoundingClientRect()) : "not shown");
    const vv = window.visualViewport;
    const sheetBody = document.querySelector("#sheet:not([hidden]) .sheet-body");
    return [
      ["display-mode", `${standalone() ? "standalone" : "browser"}${navigator.standalone === true ? " (navigator.standalone)" : ""}`],
      ["innerHeight × innerWidth", `${window.innerHeight} × ${window.innerWidth}`],
      ["visualViewport", vv ? `${px(vv.height)} × ${px(vv.width)}, offsetTop ${px(vv.offsetTop)}` : "none"],
      ["screen", `${screen.width} × ${screen.height} (this orientation: ${screenHeight()})`],
      ["documentElement.clientHeight", String(document.documentElement.clientHeight)],
      ["safe-area top / right / bottom / left", insets],
      ["100dvh / 100svh / 100lvh / 100%", `${unit("dvh")} / ${unit("svh")} / ${unit("lvh")} / ${probe("height: 100%", (el) => px(el.getBoundingClientRect().height))}`],
      ["app shell", rect(app())],
      ["tab bar", rect(document.querySelector(".tabs:not([hidden])"))],
      ["sheet", rect(sheetBody)],
      ["short frame", short ? `${short}px under it, used as the bottom inset` : "no"],
      ["devicePixelRatio", String(window.devicePixelRatio)],
      ["browser", (navigator.userAgent.match(/OS [\d_]+|Version\/[\d.]+/g) || []).join(", ") || "unknown"],
    ];
  }

  function fill() {
    const list = panel.querySelector("dl");
    list.replaceChildren(...rows().flatMap(([k, v]) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      return [dt, dd];
    }));
  }

  function show() {
    if (!panel) {
      panel = document.createElement("section");
      panel.className = "frame-check";
      panel.setAttribute("aria-label", "Screen measurements");
      const head = document.createElement("div");
      head.className = "frame-check-head";
      const title = document.createElement("strong");
      title.textContent = "Screen measurements";
      const close = document.createElement("button");
      close.type = "button";
      close.className = "small";
      close.textContent = "Close";
      close.onclick = () => (panel.hidden = true);
      head.append(title, close);
      panel.append(head, document.createElement("dl"));
      document.body.append(panel);
    }
    panel.hidden = false;
    fill();
  }

  /** Five taps on the header within four seconds, while on Settings, opens the readout. */
  function watchTaps(header, onOverlords) {
    let taps = [];
    header.addEventListener("click", () => {
      if (!onOverlords()) return;
      const now = Date.now();
      taps = [...taps.filter((t) => now - t < 4000), now];
      if (taps.length >= 5) {
        taps = [];
        show();
      }
    });
  }

  function start({ header, onOverlords }) {
    fit();
    // A Home Screen app settles its viewport after launch and on return, often with no resize event.
    for (const ms of [300, 1200]) setTimeout(fit, ms);
    addEventListener("resize", fit);
    addEventListener("pageshow", fit);
    addEventListener("orientationchange", () => setTimeout(fit, 300));
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && setTimeout(fit, 300));
    window.visualViewport?.addEventListener("resize", () => {
      fit();
      if (panel && !panel.hidden) fill();
    });
    if (header) watchTaps(header, onOverlords);
    if (new URLSearchParams(location.search).get("debug") === "1") show();
  }

  return { start, fit, show, shortfall, frameBottom };
})();

if (typeof module !== "undefined") module.exports = Frame;
