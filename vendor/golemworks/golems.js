"use strict";
// Golems on the Board (docs/architecture.md "Golem animations"); the art is GolemArt. Rebuilt cards carry on mid-motion via --clock and --fx-<kind>.
const Golems = (() => {
  const reducedQuery = matchMedia("(prefers-reduced-motion: reduce)");
  const reduced = () => reducedQuery.matches;
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const EFFECT_MS = { launch: 2700, done: 2000, crumble: 1800, ghost: 2400, ping: 2000, point: 1600, cheer: 1600, "core-gone": 3200, grow: 900 };
  const FLIGHT_MS = 1200;
  const VEIN_MS = 5000;
  const SET_WINDOW_MS = 1500;

  const effects = new Map(); // golem name -> Map(kind -> { at, tone })
  const ghosts = new Map(); // golem name -> { pane, index, height }
  const offscreen = new Set(); // golem names whose card is scrolled out of view
  let observer = null;
  let rerender = () => {};
  let term = (key) => key;

  // ---------- the figure ----------

  // Parsed once each; a card clones its copy.
  const templates = {};
  function avatar(crown) {
    const key = crown ? "crown" : "plain";
    if (!templates[key]) {
      const template = document.createElement("template");
      template.innerHTML = GolemArt.avatar({ crown });
      templates[key] = template.content.firstElementChild;
    }
    return templates[key].cloneNode(true);
  }

  // ---------- one-off effects ----------

  function addEffect(name, kind, at, extra = {}) {
    if (!effects.has(name)) effects.set(name, new Map());
    effects.get(name).set(kind, { at, ...extra });
    // Its classes come off with the next render after it ends, so the state's own loop takes over again.
    setTimeout(() => rerender(), Math.max(0, at - performance.now()) + EFFECT_MS[kind] + 50);
  }
  function activeEffects(name, now) {
    const mine = effects.get(name);
    if (!mine) return [];
    for (const [kind, effect] of mine) if (now - effect.at >= EFFECT_MS[kind]) mine.delete(kind);
    if (!mine.size) effects.delete(name);
    return [...mine];
  }

  /** A state push: launch, done and crumble effects, and a ghost card for a golem that left the Board (already closed). */
  function observe(previous, next, { wasLoaded, onBoard, order }) {
    if (!wasLoaded || reduced()) return;
    const now = performance.now();
    const golems = (panes) => new Map(panes.filter((pane) => pane.kind === "claude").map((pane) => [pane.id, pane]));
    const before = golems(previous);
    const after = golems(next);
    for (const [id, pane] of after) {
      const old = before.get(id);
      if (!old) {
        if (onBoard(pane)) addEffect(pane.name, "launch", now);
        continue;
      }
      if (pane.state === "done" && old.state !== "done") addEffect(pane.name, "done", now);
      if (pane.state === "exited" && !["exited", "parked"].includes(old.state)) addEffect(pane.name, "crumble", now);
    }
    const shown = order(previous);
    const names = new Set([...after.values()].map((pane) => pane.name));
    for (const [id, old] of before) {
      // A relaunch replaces the pane under the same name: that card assembles, it does not crumble.
      if (after.has(id) || names.has(old.name) || old.role === "orchestrator" || !onBoard(old)) continue;
      const node = document.querySelector(`#board .card[data-pane="${CSS.escape(old.name)}"]`);
      if (!node?.offsetHeight) continue;
      ghosts.set(old.name, { pane: old, index: shown.findIndex((pane) => pane.name === old.name), height: node.offsetHeight });
      if (old.state !== "exited") addEffect(old.name, "crumble", now);
      addEffect(old.name, "ghost", now);
      setTimeout(() => ghosts.delete(old.name), EFFECT_MS.ghost);
    }
  }

  /** The Board's golems with the closing ones still in their places, each marked { ghost: true }. */
  function withGhosts(golems) {
    const list = golems.map((pane) => ({ pane, ghost: false }));
    const now = performance.now();
    for (const [name, ghost] of [...ghosts].sort((a, b) => a[1].index - b[1].index)) {
      if (!activeEffects(name, now).some(([kind]) => kind === "ghost")) continue;
      if (golems.some((pane) => pane.name === name)) continue;
      list.splice(Math.max(0, Math.min(ghost.index, list.length)), 0, { pane: ghost.pane, ghost: true });
    }
    return list;
  }

  /** Puts the golem on a freshly built card: the avatar beside the card's rows, its clock, its running effects. */
  function decorate(card, pane, { ghost = false } = {}) {
    const now = performance.now();
    const main = document.createElement("div");
    main.className = "card-main";
    main.append(...card.childNodes);
    card.append(avatar(pane.role === "orchestrator"), main);
    if (pane.role === "orchestrator" && card.classList.contains("card") && !ghost) {
      orchestrator = pane.name;
      card.append(mergedBlock(activeEffects(pane.name, now).some(([kind]) => kind === "grow")));
    }
    card.classList.add("has-golem");
    // Each golem keeps its own phase, so two working golems never swing in step.
    const phase = [...pane.name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 997, 0) * 7;
    card.style.setProperty("--clock", `${-Math.round(now + phase)}ms`);
    for (const [kind, effect] of activeEffects(pane.name, now)) {
      card.classList.add(`fx-${kind}`);
      card.style.setProperty(`--fx-${kind}`, `${Math.round(effect.at - now)}ms`);
      if (effect.tone) card.style.setProperty("--ping", effect.tone);
    }
    if (offscreen.has(pane.name)) card.classList.add("offscreen");
    if (ghost) {
      const record = ghosts.get(pane.name);
      card.classList.add("ghost");
      card.removeAttribute("data-pane");
      card.removeAttribute("role");
      card.removeAttribute("tabindex");
      card.removeAttribute("draggable");
      card.setAttribute("data-ghost", pane.name);
      card.setAttribute("aria-hidden", "true");
      card.inert = true;
      if (record) card.style.setProperty("--ghost-height", `${record.height}px`);
    }
    return card;
  }

  /** After the Board renders: watch which cards are on screen, so the ones scrolled away stand still. */
  function watchBoard(board) {
    if (!("IntersectionObserver" in window)) return;
    observer ||= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const name = entry.target.dataset.pane;
        if (!name) continue;
        if (entry.isIntersecting) offscreen.delete(name);
        else offscreen.add(name);
        entry.target.classList.toggle("offscreen", !entry.isIntersecting);
      }
    });
    observer.disconnect();
    for (const card of board.querySelectorAll(".card.has-golem[data-pane]")) observer.observe(card);
  }

  // ---------- flights ----------

  function sky() {
    let layer = document.getElementById("golem-sky");
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "golem-sky";
      layer.setAttribute("aria-hidden", "true");
      document.body.append(layer);
    }
    return layer;
  }
  const center = (node) => {
    const box = node.getBoundingClientRect();
    return [box.left + box.width / 2, box.top + box.height / 2];
  };
  const canFly = () => !reduced() && !document.hidden;

  /** One flight from one element to another, around the Board cards in between (Web Animations API); the trail draws behind a spark. */
  function fly(from, to, { kind, tone, trail = false, lift = 40, onArrive }) {
    const start = center(from);
    const end = center(to);
    const ends = [from.closest(".card"), to.closest(".card")];
    const cards = [...document.querySelectorAll("#board .card")].filter((card) => !ends.includes(card)).map((card) => card.getBoundingClientRect());
    const path = GolemPath.route(start, end, cards, { width: innerWidth, lift });
    const layer = sky();
    const traveler = document.createElement("div");
    traveler.className = kind;
    if (tone) traveler.style.setProperty("--tone", tone);
    if (kind === "shard") traveler.append(document.createElement("i"));
    layer.append(traveler);
    const spots = GolemPath.sample(path, 32);
    const frames = spots.map(([x, y], i) => ({ transform: `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${1 + 0.5 * Math.sin((Math.PI * i) / (spots.length - 1))})` }));
    const easing = "cubic-bezier(.45,0,.25,1)";
    traveler.animate(frames, { duration: FLIGHT_MS, easing, fill: "forwards" }).onfinish = () => {
      traveler.remove();
      onArrive?.();
    };
    if (!trail) return;
    const svg = document.createElementNS(SVG_NAMESPACE, "svg");
    svg.setAttribute("class", "trail");
    svg.style.setProperty("--tone", tone);
    const line = document.createElementNS(SVG_NAMESPACE, "path");
    line.setAttribute("d", GolemPath.svgPath(path));
    svg.append(line);
    layer.append(svg);
    const length = line.getTotalLength();
    line.style.strokeDasharray = length;
    line.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], { duration: FLIGHT_MS, easing, fill: "forwards" });
    svg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 700, delay: FLIGHT_MS, fill: "forwards" }).onfinish = () => svg.remove();
  }

  const boardCard = (name) => document.querySelector(`#board-view:not([hidden]) #board .card[data-pane="${CSS.escape(name)}"]`);

  /** golemd's spark event: the Orchestrator messaged a golem (accent), or a golem reported to it (in the golem's state color). */
  function spark({ from, to, kind }) {
    if (!canFly()) return;
    const sender = boardCard(from);
    const target = boardCard(to);
    if (!sender || !target) return;
    const tone = kind === "report" ? `var(--${STATE_TONE[sender.dataset.state] || "idle"})` : "var(--accent)";
    const now = performance.now();
    addEffect(from, "point", now);
    addEffect(to, "ping", now + FLIGHT_MS, { tone });
    fly(sender.querySelector(".golem-avatar"), target.querySelector(".golem-avatar"), { kind: "spark", tone, trail: true, lift: 30 });
    rerender();
  }
  const STATE_TONE = { working: "working", waiting: "waiting", queued: "queued", blocked: "blocked", done: "done", idle: "idle", listening: "idle", exited: "exited", parked: "exited", resuming: "unknown", unknown: "unknown" };

  // ---------- Merged today, on the Orchestrator's card ----------

  let merges = [];
  const flying = new Set(); // PRs whose crystal is still in the air: counted once it lands
  const growing = new Set(); // merged PRs with no flight whose crystal grows once the state counts them
  let orchestrator = null; // the Orchestrator's name, whose card holds the cluster
  let midnight = null;

  /** The Orchestrator card's cluster and today's count; its newest crystal grows in while the card's grow effect runs. */
  function mergedBlock(grows) {
    const count = MergedToday.mergedToday(merges, new Date(), flying).length;
    const block = document.createElement("div");
    block.className = "golem-merged";
    block.title = `${count} ${term("mergedTodayCount")}`;
    block.innerHTML = `<div class="merged-cluster" aria-hidden="true">${GolemArt.cluster(count, { grow: grows && !reduced() })}</div><div class="merged-text"><span class="merged-count"></span><span class="merged-label"></span></div>`;
    block.querySelector(".merged-count").textContent = String(count);
    block.querySelector(".merged-label").textContent = term("mergedToday");
    return block;
  }

  function grow() {
    if (orchestrator && !reduced()) addEffect(orchestrator, "grow", performance.now());
    rerender();
  }

  /** The state's recent merges ({ pr, golem, at }); the count is today's, in local time, and starts over at midnight. */
  function setMerges(list) {
    merges = Array.isArray(list) ? list : [];
    if (MergedToday.mergedToday(merges).some((merge) => growing.delete(merge.pr)) && orchestrator && !reduced()) addEffect(orchestrator, "grow", performance.now());
    clearTimeout(midnight);
    midnight = setTimeout(() => rerender(), MergedToday.msToMidnight() + 1000);
  }

  /** golemd's merged event: the golem cheers and its core crystal flies to the Orchestrator's cluster, which grows as it lands. */
  function merged({ pr, golem }) {
    const card = golem ? boardCard(golem) : null;
    const landing = () => {
      const cluster = orchestrator ? boardCard(orchestrator)?.querySelector(".golem-merged .merged-cluster") : null;
      const box = cluster?.getBoundingClientRect();
      return box && box.width > 0 && box.bottom > 0 && box.top < innerHeight ? cluster : null;
    };
    if (!card || !landing() || !canFly()) {
      if (MergedToday.mergedToday(merges).some((merge) => merge.pr === pr)) return grow();
      growing.add(pr);
      return;
    }
    flying.add(pr);
    const now = performance.now();
    addEffect(golem, "cheer", now);
    addEffect(golem, "core-gone", now + 500);
    rerender();
    setTimeout(() => {
      const from = boardCard(golem)?.querySelector(".golem-avatar .torso .core");
      const to = landing();
      const land = () => {
        flying.delete(pr);
        grow();
      };
      if (!from || !to) return land();
      fly(from, to, { kind: "shard", lift: 60, onArrive: land });
    }, 500);
  }

  // ---------- step vein ----------

  /** A step segment's vein: the current one fills for 5 s after it starts, a finished one flashes as it sets. */
  function stepVein(step) {
    if (reduced()) return {};
    const now = Date.now();
    if (step.state === "current" && step.enteredAt) {
      const elapsed = now - Date.parse(step.enteredAt);
      if (elapsed >= 0 && elapsed < VEIN_MS) return { class: "filling", style: `--vein: ${-elapsed}ms` };
    }
    if (step.state === "done" && step.finishedAt) {
      const elapsed = now - Date.parse(step.finishedAt);
      if (elapsed >= 0 && elapsed < SET_WINDOW_MS) return { class: "setting", style: `--set: ${-elapsed}ms` };
    }
    return {};
  }

  // ---------- page-wide ----------

  function start({ render, t }) {
    rerender = render;
    term = t;
    const hold = () => document.body.classList.toggle("motion-hold", document.hidden);
    document.addEventListener("visibilitychange", hold);
    hold();
  }

  return { start, observe, withGhosts, decorate, watchBoard, spark, merged, setMerges, stepVein, EFFECT_MS };
})();
