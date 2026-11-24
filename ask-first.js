// The Orchestrator's question takes over its chat until answered (G-110): which of its asks lead, which wait in the bar, and when the app lands on one.
"use strict";

const AskFirst = (() => {
  const oldestFirst = (a, b) => String(a.at || "").localeCompare(String(b.at || ""));

  const RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

  /** The question queue, as golemd orders Chat's: one item per question (a several-question menu's answered ones left out), by priority, workspace order (names), then oldest. */
  function queue(asks, { workspaces = [] } = {}) {
    const place = new Map(workspaces.map((name, i) => [String(name).toLowerCase(), i]));
    const where = (ask) => place.get(String(ask.workspace || "").toLowerCase()) ?? place.size;
    const items = [];
    for (const ask of asks) {
      // Split only for a golemd that takes one question's answer (it names each ask's priority); an older one takes the menu whole.
      const menu = ask.priority && Array.isArray(ask.menu) && ask.menu.length > 1 ? ask.menu : null;
      if (!menu) {
        items.push(ask);
        continue;
      }
      const held = new Set(ask.heldParts || []);
      menu.forEach((q, part) => held.has(part) || items.push({ ...ask, id: `${ask.id}~${part}`, askId: ask.id, part, parts: menu.length, question: q.question, menu: [q], detail: null }));
    }
    const rank = (ask) => RANK[ask.priority] ?? RANK.normal;
    // Put off (Not now) last, first put off first, as golemd orders Chat's.
    const off = (ask) => String(ask.waitedAt || "");
    return items.sort((a, b) => Boolean(a.waitedAt) - Boolean(b.waitedAt) || off(a).localeCompare(off(b)) || rank(a) - rank(b) || where(a) - where(b) || oldestFirst(a, b) || (a.part ?? 0) - (b.part ?? 0));
  }

  /** The chat's asks in the order given (queue's): lead (answerable, not put off; the first blocks, or first: the one mid-answer), waited (Not now here or on any phone, or snoozed, unless reopened from the bar), rest (answered or unanswerable). */
  function split(asks, { canAnswer, keyOf, held = new Set(), reopened = new Set(), first = null }) {
    const lead = [];
    const waited = [];
    const rest = [];
    for (const ask of asks) {
      const putOff = Boolean(ask.waitedAt || ask.snoozedUntil) || held.has(keyOf(ask));
      if (ask.answeredAt || !canAnswer(ask)) rest.push(ask);
      else if (putOff && !reopened.has(keyOf(ask))) waited.push(ask);
      else lead.push(ask);
    }
    // The question the operator is mid-answer on keeps the card: a question queued after it never takes its place.
    const at = first ? lead.findIndex((ask) => keyOf(ask) === first) : -1;
    if (at > 0) lead.unshift(...lead.splice(at, 1));
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
      const { lead } = split([...row.asks].sort(oldestFirst), { canAnswer, keyOf, held });
      const first = lead.find((ask) => !landed.has(keyOf(ask)));
      if (first && (!best || oldestFirst(first, best.ask) < 0)) best = { golem: row.golem, ask: first };
    }
    return best;
  }

  return { queue, split, position, barText, landing };
})();

if (typeof module !== "undefined") module.exports = AskFirst;
