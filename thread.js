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

  /** A tap on a menu's option oi of question qi: ticks or unticks it where several go, else picks or unpicks it for that question; words stay. */
  function tick(draft, menu, qi, oi) {
    const now = draft || { text: "", option: null };
    const picks = menu.map((_, i) => [...(now.picks?.[i] || [])]);
    const at = picks[qi].indexOf(oi);
    if (at >= 0) picks[qi].splice(at, 1);
    else if (menu[qi].multiSelect) picks[qi].push(oi);
    else picks[qi] = [oi];
    return { ...now, text: now.text || "", option: null, picks };
  }

  /** What a menu's draft sends: its picks and words, picks: null with no tick at all; null while it cannot go (no words, and a question still unpicked). */
  function menuAnswer(draft, menu) {
    const picks = menu.map((_, i) => [...(draft?.picks?.[i] || [])].sort((a, b) => a - b));
    const text = (draft?.text || "").trim();
    const any = picks.some((p) => p.length);
    if (!text && !(any && picks.every((p) => p.length))) return null;
    return { picks: any ? picks : null, text };
  }

  /** What an answer's draft sends, { body: { option?, picks?, text? } }, or { error } while it cannot go; files: how many attachments wait with it. */
  function answerBody(draft, menu, { files = 0 } = {}) {
    const option = Number.isInteger(draft?.option) ? draft.option : null;
    const text = (draft?.text || "").trim();
    const ticked = menu ? menuAnswer(draft, menu) : null;
    if (menu && !ticked && draft?.picks?.some((p) => p.length)) return { error: "Pick one for each question, or add words to send with your picks" };
    // Attachments alone are an answer: the hub gives the golem words that point at them.
    if (option === null && !ticked && !text && !files) return { error: "Pick an option, write a reply or attach a file first" };
    return { body: { ...(option !== null ? { option } : {}), ...(ticked?.picks ? { picks: ticked.picks } : {}), ...(text ? { text } : {}) } };
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

  return { split, pick, tick, menuAnswer, answerBody, summary, SHOWN };
})();

if (typeof module !== "undefined") module.exports = Thread;
