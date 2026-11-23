// The golem sheet's drag: down from its handle or header (or from content scrolled to the top) follows the finger and
// closes past 30% of its height or on a fast flick; up expands it to full height; otherwise it springs back.
"use strict";

const SheetDrag = (() => {
  const CLOSE_SHARE = 0.3; // of the sheet's height
  const FLICK = 0.5; // px per ms
  const FLICK_MIN = 24; // px: a flick still has to travel a little
  const EXPAND_PX = 48;

  /** Where a drag ends: "close", "expand", "collapse" (an expanded sheet pulled down a little) or "stay". dy > 0 is down. */
  function release({ dy, ms, height, expanded = false }) {
    const speed = ms > 0 ? dy / ms : 0;
    if (dy >= height * CLOSE_SHARE || (dy >= FLICK_MIN && speed >= FLICK)) return "close";
    if (!expanded && (dy <= -EXPAND_PX || (dy <= -FLICK_MIN && speed <= -FLICK))) return "expand";
    if (expanded && dy >= EXPAND_PX) return "collapse";
    return "stay";
  }

  /** Wires a sheet: body is the panel, handles start a drag, onClose ends it. Movement is skipped for reduced motion. contentPull false: only the handles move it (the Orchestrator's chat, whose scrolling must never move the sheet). */
  function attach({ body, handles, onClose, reducedMotion = () => false, contentPull = true }) {
    let drag = null;
    const height = () => body.getBoundingClientRect().height;
    const move = (dy) => {
      if (reducedMotion()) return;
      // Down follows the finger; up gives a little, the release expands it.
      body.style.transform = `translateY(${dy > 0 ? dy : dy / 4}px)`;
    };
    const settle = (dy, ms) => {
      const outcome = release({ dy, ms, height: height(), expanded: body.classList.contains("expanded") });
      body.classList.remove("dragging");
      if (outcome === "close") {
        if (reducedMotion()) return onClose();
        body.style.transform = "translateY(100%)";
        return setTimeout(onClose, 180);
      }
      body.style.transform = "";
      if (outcome === "expand") body.classList.add("expanded");
      if (outcome === "collapse") body.classList.remove("expanded");
    };
    const start = (y) => {
      drag = { y, at: Date.now(), dy: 0 };
      body.classList.add("dragging");
    };

    // Handle and header: pointer events, touch-action none (in the CSS), so the browser never takes the gesture.
    for (const handle of handles) {
      handle.addEventListener("pointerdown", (e) => {
        if (e.button > 0 || e.target.closest("button, a, textarea, input, select")) return;
        start(e.clientY);
        handle.setPointerCapture?.(e.pointerId);
      });
      handle.addEventListener("pointermove", (e) => {
        if (!drag) return;
        drag.dy = e.clientY - drag.y;
        move(drag.dy);
      });
      const end = () => {
        if (!drag) return;
        const { dy, at } = drag;
        drag = null;
        settle(dy, Date.now() - at);
      };
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    }

    if (!contentPull) return;
    // Content keeps its scrolling; pulled down while already at the top, it drags the sheet instead.
    let pull = null;
    body.addEventListener("touchstart", (e) => {
      if (drag || e.touches.length !== 1 || handles.some((h) => h.contains(e.target))) return;
      pull = { y: e.touches[0].clientY, top: body.scrollTop <= 0, on: false };
    }, { passive: true });
    body.addEventListener("touchmove", (e) => {
      if (!pull?.top) return;
      const dy = e.touches[0].clientY - pull.y;
      if (!pull.on) {
        if (dy < 8 || body.scrollTop > 0) return dy < 0 ? (pull = null) : undefined;
        pull.on = true;
        start(pull.y);
      }
      e.preventDefault(); // the sheet moves, not the page
      drag.dy = dy;
      move(dy);
    }, { passive: false });
    const endPull = () => {
      if (!pull?.on || !drag) return (pull = null);
      const { dy, at } = drag;
      drag = null;
      pull = null;
      settle(dy, Date.now() - at);
    };
    body.addEventListener("touchend", endPull);
    body.addEventListener("touchcancel", endPull);
  }

  return { release, attach, CLOSE_SHARE, FLICK, EXPAND_PX };
})();

if (typeof module !== "undefined") module.exports = SheetDrag;
