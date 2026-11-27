// Golem art (docs/architecture.md "Golem animations"): SVG markup only, no DOM, so the phone app can copy this folder as is.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.GolemArt = api;
})(typeof self !== "undefined" ? self : this, () => {
  const MAX_CRYSTALS = 12;
  // The pebbles it assembles from and crumbles to: crystal chips.
  const PEBBLES = [[18, 62], [26, 63], [34, 62.5], [42, 63], [30, 59], [38, 59.5], [22, 59]]
    .map(([x, y], i) => {
      const r = 2.8 + ((i * 7) % 3) * 0.5;
      return `<polygon class="pebble" points="${x - r},${y} ${x - r * 0.3},${y - r} ${x + r},${y - r * 0.2} ${x + r * 0.4},${y + r * 0.8}" style="--i:${i}"/>`;
    })
    .join("");
  const points = (list) => list.map(([x, y]) => `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`).join(" ");
  const poly = (cls, list) => `<polygon class="${cls}" points="${points(list)}"/>`;
  /** Flat facets from center c to each edge of ring, lit by shades. */
  const fan = (c, ring, shades) => ring.map((p, i) => poly(shades[i], [p, ring[(i + 1) % ring.length], c])).join("");
  // A three-quarter view is the same outline with its ridge moved across and the flank it uncovers in shadow.
  const views = (cls, [x, y], by, ring, right, left) => yaw(`${cls}-r`, fan([x + by, y], ring, right.split(" "))) + yaw(`${cls}-l`, fan([x - by, y], ring, left.split(" ")));
  const mirror = (list) => list.map(([x, y]) => [64 - x, y]);
  /** A part a turn moves (golem-art.css "turns"): its own group, so a turn never fights the part's pose. */
  const yaw = (cls, inner) => `<g class="yaw ${cls}">${inner}</g>`;

  const TORSO = [[16, 26], [24, 22], [40, 22], [48, 26], [47, 42], [40, 51], [24, 51], [17, 42]];
  const TORSO_SHADES = ["f1", "f2", "f2", "f3", "f4", "f4", "f3", "f2"];
  const HEAD = [[23, 9], [29, 5], [37, 5.5], [42, 10], [41.5, 20], [37, 24], [27, 24], [22, 19.5]];
  const HEAD_SHADES = ["f1", "f1", "f2", "f3", "f4", "f3", "f3", "f2"];
  const ARM = [[[[9, 28], [16, 26], [8, 38]], "f1", "f2"], [[[16, 26], [17, 38], [8, 38]], "f2", "f1"], [[[8, 38], [17, 38], [16, 47]], "f3", "f3"], [[[8, 38], [16, 47], [9, 47]], "f4", "f4"]];
  // Upper arm and forearm hinge at the elbow; a stone at the elbow, and one on each side of the torso, fill the gaps a bent or raised arm would open.
  const SHOULDER = [[16, 25.5], [20, 30], [16, 35], [11, 29.5]];
  const ELBOW = [[12.5, 34], [16.8, 38], [12.5, 42], [8.2, 38]];
  const UPPER_L = poly("f3", ELBOW) + ARM.slice(0, 2).map(([list, cls]) => poly(cls, list)).join("");
  const UPPER_R = poly("f3", mirror(ELBOW)) + ARM.slice(0, 2).map(([list, , cls]) => poly(cls, mirror(list))).join("");
  const FORE_L = ARM.slice(2).map(([list, cls]) => poly(cls, list)).join("");
  const FORE_R = ARM.slice(2).map(([list, , cls]) => poly(cls, mirror(list))).join("");
  const leg = (dx) => [["f2", [[21, 48], [30, 48], [20.5, 57]]], ["f3", [[30, 48], [30.5, 57], [20.5, 57]]], ["f4", [[20.5, 57], [30.5, 57], [28.5, 61], [22, 61]]]]
    .map(([cls, list]) => poly(cls, list.map(([x, y]) => [x + dx, y]))).join("");

  const shard = (x, top, half) => `<polygon class="core" points="${x - half},7 ${x},${top} ${x + half},7"/><polygon class="gem-a" points="${x - half},7 ${x},${top} ${x},7"/>`;
  const CROWN = `<g class="crown">${shard(27, 0, 2.2)}${shard(32, -3, 2.5)}${shard(37, 0, 2.2)}</g>`;
  const eye = (side, list) => yaw(`yh y-eye-${side}`, poly("eye", list));

  const figure = (crown) => `<svg class="golem" viewBox="-6 -6 84 72" aria-hidden="true" focusable="false">
    <g class="pebbles">${PEBBLES}</g>
    <g class="work-rock"><polygon points="62,62 64,53 70,51 76,55 77,62"/></g>
    <g class="figure">
      <g class="legs part">${yaw("y-leg-l", leg(0))}${yaw("y-leg-r", `<g class="leg-right">${leg(13)}</g>`)}</g>
      <g class="lean">
      <g class="torso part">${poly("f3", SHOULDER)}${poly("f3", mirror(SHOULDER))}${yaw("y-torso", fan([32, 37], TORSO, TORSO_SHADES))}${views("y-chest", [32, 37], 8, TORSO, "f2 f1 f1 f2 f3 f4 f4 f3", "f1 f2 f3 f4 f4 f4 f3 f1")}<path class="crack" d="M21 29 l4 3 l-2 5 M43 42 l-3 3"/>${yaw("y-core", '<polygon class="core" points="32,29.5 38,37 32,45 26,37"/><polygon class="gem-a" points="32,29.5 26,37 32,37"/><polygon class="gem-b" points="32,37 38,37 32,45"/>')}</g>
      ${yaw("y-arm-l", `<g class="arm arm-left part">${UPPER_L}<g class="fore fore-left">${FORE_L}<g class="watch"><rect class="band" x="7.5" y="37.6" width="10" height="3" rx="1"/><circle class="face" cx="12.5" cy="39.1" r="2.7"/><path class="hands" d="M12.5 39.1 V37.3 M12.5 39.1 H13.9"/></g></g></g>`)}
      <g class="head part">${yaw("yh y-head", fan([32, 14], HEAD, HEAD_SHADES))}${views("yh y-brow", [32, 14], 6, HEAD, "f2 f1 f1 f2 f3 f3 f4 f3", "f1 f2 f3 f4 f4 f3 f3 f1")}${crown ? yaw("yh y-crown", CROWN) : ""}${yaw("yh y-visor", `<polygon class="f-void" points="24.5,13 39.5,13 40.5,15.5 38.5,18 25.5,18 23.5,15.5"/><g class="eyes">${eye("l", [[25.6, 14], [30.6, 14.8], [30.2, 17], [25.8, 16.4]])}${eye("r", [[33.4, 14.8], [38.4, 14], [38.2, 16.4], [33.8, 17]])}</g>`)}</g>
      ${yaw("y-arm-r", `<g class="arm arm-right part">${UPPER_R}<g class="fore fore-right"><g class="tool"><rect class="wood" x="50.5" y="42" width="3" height="14" rx="0.6"/><polygon class="metal" points="46,52.5 58,52 58,57.5 46,57"/><polygon class="metal-hi" points="46,52.5 58,52 57,54 47,54.5"/></g>${FORE_R}</g></g>`)}
      </g>
    </g>
    <g class="chips"><circle cx="68" cy="51" r="1.4"/><circle cx="68" cy="51" r="1.1"/><circle cx="68" cy="51" r="1.2"/></g>
  </svg>`;

  /** A golem with its Needs you badge; crown: the Orchestrator's. */
  function avatar({ crown = false } = {}) {
    return `<div class="golem-avatar" aria-hidden="true">${figure(crown)}<span class="golem-badge">!</span></div>`;
  }

  /** The cluster's crystals, center-out, so one more always lands beside the last. */
  const SLOTS = [
    { x: 60, h: 40, t: -2 }, { x: 47, h: 33, t: -12 }, { x: 73, h: 36, t: 10 }, { x: 36, h: 26, t: -20 }, { x: 84, h: 28, t: 18 }, { x: 54, h: 26, t: -6 },
    { x: 66, h: 30, t: 5 }, { x: 27, h: 20, t: -26 }, { x: 93, h: 21, t: 24 }, { x: 42, h: 22, t: -15 }, { x: 78, h: 23, t: 14 }, { x: 60, h: 18, t: 0 },
  ];
  /** The Merged today cluster with count crystals (at most MAX_CRYSTALS); grow: the newest one grows in. */
  function cluster(count, { grow = false } = {}) {
    const crystal = ({ x, h, t }, i) => {
      const w = Math.max(8, h * 0.32);
      const y = 56;
      const shoulder = w * 0.55;
      const body = `${x - w / 2},${y} ${x - w / 2},${y - h + shoulder} ${x},${y - h} ${x + w / 2},${y - h + shoulder} ${x + w / 2},${y}`;
      const facet = `${x},${y} ${x},${y - h} ${x + w / 2},${y - h + shoulder} ${x + w / 2},${y}`;
      return `<g class="crystal${grow && i === count - 1 ? " new" : ""}" transform="rotate(${t} ${x} ${y})"><g class="grow"><polygon class="crystal-body" points="${body}"/><polygon class="crystal-facet" points="${facet}"/></g></g>`;
    };
    const next = SLOTS[Math.min(count, MAX_CRYSTALS - 1)];
    return `<svg class="cluster" viewBox="0 0 120 68" aria-hidden="true" focusable="false">${SLOTS.slice(0, Math.min(count, MAX_CRYSTALS)).map(crystal).join("")}<polygon class="cluster-rock" points="8,66 16,56 38,52 64,54 92,52 108,58 112,67 6,67"/><circle class="landing" cx="${next.x}" cy="${56 - next.h / 2}" r="1" fill="none"/></svg>`;
  }

  // When each pose turns, as [period, [from, to, view]...] in ms of the golem's own clock; waiting's fall between its looks at the watch.
  const TURNS = {
    working: [7200, [500, 4400, "right"]],
    waiting: [12000, [600, 1300, "left"], [7900, 9400, "back"]],
    idle: [16000, [5000, 7400, "right"], [12000, 14200, "left"]],
  };
  TURNS.queued = TURNS.waiting;
  TURNS.listening = TURNS.idle;
  /** The way a golem in state faces at ms on its clock: "right", "left", "back" or "" (front, always so when it needs you). */
  function turnAt(state, ms) {
    if (!Object.hasOwn(TURNS, state)) return "";
    const [period, ...spans] = TURNS[state];
    const at = ms % period;
    return spans.find(([from, to]) => at >= from && at < to)?.[2] ?? "";
  }

  return { avatar, cluster, turnAt, MAX_CRYSTALS };
});
