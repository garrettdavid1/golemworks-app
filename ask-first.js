// The Orchestrator's question takes over its chat until answered (G-110): which of its asks lead, which wait in the bar, and when the app lands on one.
"use strict";

const AskFirst = (() => {
  const oldestFirst = (a, b) => String(a.at || "").localeCompare(String(b.at || ""));

  /** The chat's asks, oldest first: lead (answerable, not put off; the first blocks), waited (Not now here or on any phone, or snoozed, unless reopened from the bar), rest (answered or unanswerable). */
  function split(asks, { canAnswer, keyOf, held = new Set(), reopened = new Set() }) {
    const lead = [];
    const waited = [];
    const rest = [];
    for (const ask of [...asks].sort(oldestFirst)) {
      const putOff = Boolean(ask.waitedAt || ask.snoozedUntil) || held.has(keyOf(ask));
      if (ask.answeredAt || !canAnswer(ask)) rest.push(ask);
      else if (putOff && !reopened.has(keyOf(ask))) waited.push(ask);
      else lead.push(ask);
    }
    return { lead, waited, rest };
  }

  /** "1 of 3" over the leading ask when more lead behind it (count: how many lead), else null. */
  const position = (count) => (count > 1 ? `1 of ${count}` : null);

  /** The bar's words for the asks put off: the oldest's question, and how many more. */
  const barText = (waited) => (waited.length ? `${waited.length > 1 ? `${waited.length} questions wait` : "A question waits"} for you: ${waited[0].question}` : null);

  /** The ask the app lands on when opened: the oldest leading one across the overlords not landed on yet, or null. rows: [{ golem, asks }]. */
  function landing(rows, { canAnswer, keyOf, held = new Set(), landed = new Set() }) {
    let best = null;
    for (const row of rows) {
      if (!row.golem) continue;
      const { lead } = split(row.asks, { canAnswer, keyOf, held });
      const first = lead.find((ask) => !landed.has(keyOf(ask)));
      if (first && (!best || oldestFirst(first, best.ask) < 0)) best = { golem: row.golem, ask: first };
    }
    return best;
  }

  return { split, position, barText, landing };
})();

if (typeof module !== "undefined") module.exports = AskFirst;
