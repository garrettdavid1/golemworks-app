// Who answers what on Fleet: the overlords lead with the asks David answers himself; a golem's need goes to its overlord (golemd tells it).
"use strict";

const Needs = (() => {
  const golemOf = (feed, workshopId, golemId) => feed?.workshops.find((w) => w.id === workshopId)?.golems.find((g) => g.id === golemId) || null;
  const isOverlordAsk = (feed, ask) => ask.golemType === "overlord" || golemOf(feed, ask.workshopId, ask.golemId)?.type === "overlord";
  // David answers an overlord's own asks, and one no golem holds; a regular golem's ask goes to its overlord first.
  const forDavid = (feed, ask) => !ask.golemId || isOverlordAsk(feed, ask);
  const open = (ask) => !ask.answeredAt && !ask.snoozedUntil;

  /** Each workshop's overlords in rank order with their open asks; its pause and loose asks ride its first overlord's row, or a row of their own. */
  function overlordRows(feed) {
    const rows = [];
    for (const w of feed?.workshops || []) {
      const asks = (feed.asks || []).filter((a) => a.workshopId === w.id && open(a) && forDavid(feed, a));
      const lords = w.golems.filter((g) => g.type === "overlord");
      const own = (g) => asks.filter((a) => a.golemId === g.id);
      const loose = asks.filter((a) => !lords.some((g) => g.id === a.golemId));
      const paused = w.paused ? w : null;
      // A failed automatic update needs David until he taps Got it or a later update works.
      const updateFailed = w.update?.failed ? w : null;
      if (!lords.length) {
        if (paused || updateFailed || loose.length) rows.push({ workshop: w, golem: null, asks: loose, paused, updateFailed });
        continue;
      }
      lords.forEach((g, i) => rows.push({ workshop: w, golem: g, asks: i ? own(g) : [...own(g), ...loose], paused: i ? null : paused, updateFailed: i ? null : updateFailed }));
    }
    return rows;
  }

  /** The "Overlords" count and the Fleet tab badge: the overlords' open asks, paused workshops and failed updates, never a golem's. */
  const count = (feed) => overlordRows(feed).reduce((n, row) => n + row.asks.length + (row.paused ? 1 : 0) + (row.updateFailed ? 1 : 0), 0);

  /** The overlord a golem's needs go to: its workshop's. */
  const overlordName = (feed, workshopId) => feed?.workshops.find((w) => w.id === workshopId)?.overlord?.name || "its overlord";

  /** A card's need line: an overlord's needs David ({ david: true }); a golem's waits on its overlord. Null when it needs nothing. */
  function line(feed, workshopId, golem) {
    const ask = (feed?.asks || []).find((a) => a.workshopId === workshopId && a.golemId === golem.id && open(a));
    const need = golem.needsYou || ask?.question;
    if (!need) return null;
    return golem.type === "overlord" ? { david: true, text: `Needs you: ${need}` } : { david: false, text: `Waiting on ${overlordName(feed, workshopId)}: ${need}` };
  }

  return { overlordRows, count, line, overlordName, open };
})();

if (typeof module !== "undefined") module.exports = Needs;
