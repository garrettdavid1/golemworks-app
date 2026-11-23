"use strict";
// What a golem's sheet puts in front of David: his own messages and answers; overlord-to-overlord traffic and status flips fold away.

const Thread = (() => {
  const SHOWN = 5;

  /** GET /api/said split: `mine` his last five newest first (plus `focus`, a push's said id, if older); `between` the overlords' own, newest first. */
  function split(items, { focus = null } = {}) {
    const list = Array.isArray(items) ? items : [];
    const own = list.filter((s) => s.kind !== "link");
    const mine = own.slice(-SHOWN).reverse();
    const target = focus && own.find((s) => s.id === focus);
    if (target && !mine.includes(target)) mine.push(target);
    const between = list.filter((s) => s.kind === "link").reverse();
    return { mine, between };
  }

  /** An option tap on an answer draft: picks it, or unpicks it when it was already picked; typed text always stays. */
  function pick(draft, index) {
    const now = draft || { text: "", option: null };
    return { ...now, text: now.text || "", option: now.option === index ? null : index };
  }

  /** Status history as one line, e.g. "Needs you since 7:03 AM · 24 changes in 7 days"; label(row) and time(iso) format it. */
  function summary(history, { label, time, count = null }) {
    const list = Array.isArray(history) ? history : [];
    if (!list.length) return null;
    // Since the run of rows in today's state began: a new status line while still needing you keeps the earlier time.
    let start = list.length - 1;
    while (start > 0 && label(list[start - 1]) === label(list[start])) start--;
    const n = count ?? list.length;
    return `${label(list[start])} since ${time(list[start].at)} · ${n} change${n === 1 ? "" : "s"} in 7 days`;
  }

  return { split, pick, summary, SHOWN };
})();

if (typeof module !== "undefined") module.exports = Thread;
