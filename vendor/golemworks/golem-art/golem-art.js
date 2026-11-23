// Golem art (docs/architecture.md "Golem animations"): SVG markup only, no DOM, so the phone app can copy this folder as is.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.GolemArt = api;
})(typeof self !== "undefined" ? self : this, () => {
  const MAX_CRYSTALS = 12;
  const PEBBLES = [[18, 62], [26, 63], [34, 62.5], [42, 63], [30, 59], [38, 59.5], [22, 59]]
    .map(([x, y], i) => `<circle class="pebble" cx="${x}" cy="${y}" r="${2.6 + ((i * 7) % 3) * 0.5}" style="--i:${i}"/>`)
    .join("");
  const CROWN = '<g class="crown"><polygon class="core" points="25,8 27.5,1 30,8"/><polygon class="core" points="29.5,7 32,-2 34.5,7"/><polygon class="core" points="34,8 36.5,1 39,8"/></g>';
  const figure = (crown) => `<svg class="golem" viewBox="-6 -6 84 72" aria-hidden="true" focusable="false">
    <g class="pebbles">${PEBBLES}</g>
    <g class="work-rock"><polygon points="62,62 64,53 70,51 76,55 77,62"/></g>
    <g class="figure">
      <g class="legs part"><rect class="stone-d" x="21" y="48" width="9" height="13" rx="3"/><rect class="stone-d leg-right" x="34" y="48" width="9" height="13" rx="3"/></g>
      <g class="torso part"><rect class="stone" x="16" y="23" width="32" height="28" rx="8"/><path class="crack" d="M21 29 l4 3 l-2 5 M43 42 l-3 3"/><polygon class="core" points="32,30 37.5,37 32,45 26.5,37"/><polygon class="core-hi" points="32,30 37.5,37 32,37"/></g>
      <g class="arm arm-left part"><rect class="stone" x="8" y="27" width="9" height="20" rx="4"/><rect class="stone-d" x="8" y="41" width="9" height="6" rx="3"/><g class="watch"><rect class="band" x="7.5" y="37.6" width="10" height="3" rx="1"/><circle class="face" cx="12.5" cy="39.1" r="2.7"/><path class="hands" d="M12.5 39.1 V37.3 M12.5 39.1 H13.9"/></g></g>
      <g class="head part"><rect class="stone-l" x="22" y="6" width="20" height="18" rx="6"/>${crown ? CROWN : ""}<g class="eyes"><rect class="eye" x="26" y="13" width="4.5" height="4" rx="1.2"/><rect class="eye" x="33.5" y="13" width="4.5" height="4" rx="1.2"/></g></g>
      <g class="arm arm-right part"><g class="tool"><rect class="wood" x="50.5" y="42" width="3" height="14" rx="1"/><rect class="metal" x="46" y="52" width="12" height="5.5" rx="1.2"/></g><rect class="stone" x="47" y="27" width="9" height="20" rx="4"/><rect class="stone-d" x="47" y="41" width="9" height="6" rx="3"/></g>
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

  return { avatar, cluster, MAX_CRYSTALS };
});
