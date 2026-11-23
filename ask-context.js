// A question's context, so it is never decided cold: what it is about, what each option does and costs, which one is recommended and why, or Ask for context when none came.
"use strict";

const AskContext = (() => {
  // Claude Code marks its pick in the label; the answer still sends the label as it came, only the screen drops it.
  const SUFFIX = /\s*\(Recommended\)\s*$/i;
  // Past this many characters the about line opens two lines tall, with More.
  const LONG = 160;
  // The hub's caps (src/summary.js cleanAsk), here too.
  const words = (value, max = 300) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

  /** An option's label as shown: without " (Recommended)". */
  const label = (option) => String(option).replace(SUFFIX, "") || String(option);

  /** The ask's context checked again here, since a sealed workshop's never passes the hub's check (src/summary.js cleanAsk). */
  function of(ask) {
    const options = Array.isArray(ask?.options) ? ask.options : [];
    const choices = Array.isArray(ask?.choices) && ask.choices.length === options.length ? ask.choices : [];
    const noRecommend = words(ask?.noRecommend);
    // The label's own mark stands in for recommend, unless the golem says it recommends none.
    const marked = noRecommend ? -1 : options.findIndex((o) => SUFFIX.test(String(o)));
    const recommend = Number.isInteger(ask?.recommend) && ask.recommend >= 0 && ask.recommend < options.length ? ask.recommend : marked >= 0 ? marked : null;
    const rows = options.map((o, i) => ({ label: label(o), recommended: i === recommend, does: words(choices[i]?.does), cost: words(choices[i]?.cost) }));
    const because = words(ask?.because);
    // For a terminal menu golemd's because is the option's does line: shown once, on the option.
    const why = recommend !== null && because && because !== rows[recommend]?.does ? because : null;
    return { about: words(ask?.about, 1200), options: rows, why, noRecommend, bare: ask?.bare === true };
  }

  // A terminal menu: golemd cannot have the golem ask it again on a sealed workshop, so it refuses Ask for context there.
  const MENU_KINDS = new Set(["question", "plan", "permission", "dialog"]);

  /** Whether to offer Ask for context: a bare ask answerable here, and not a sealed workshop's terminal menu. */
  const offers = (ask, { answerable, sealed }) => ask?.bare === true && Boolean(answerable) && !(sealed && MENU_KINDS.has(ask.kind));

  /** What the question is about, under it: two lines, with More when it is long. */
  function about(h, text) {
    if (!text) return null;
    const long = text.length > LONG;
    const line = h("p", { class: `ask-about${long ? " clamped" : ""}` }, text);
    if (!long) return line;
    const more = h("button", { type: "button", class: "small ask-about-more", "aria-expanded": "false", onclick: () => {
      const open = !line.classList.toggle("clamped");
      more.textContent = open ? "Less" : "More";
      more.setAttribute("aria-expanded", String(open));
    } }, "More");
    return h("div", { class: "ask-about-wrap" }, [line, more]);
  }

  /** An option's button: its class and what it holds (the label, Recommended, what it does, what it costs). */
  function option(h, row) {
    const extra = row.does || row.cost;
    return {
      class: `option pick${extra ? " has-context" : ""}${row.recommended ? " recommended" : ""}`,
      children: [
        h("span", { class: "option-label" }, [row.label, row.recommended ? h("span", { class: "rec-chip" }, "Recommended") : null]),
        row.does ? h("span", { class: "option-does" }, row.does) : null,
        row.cost ? h("span", { class: "option-cost" }, `Cost: ${row.cost}`) : null,
      ].filter(Boolean),
    };
  }

  /** Under the options: why the recommended one, or why there is none. */
  function after(h, view) {
    return [
      view.why ? h("div", { class: "ask-why" }, `Why I recommend it: ${view.why}`) : null,
      view.noRecommend ? h("div", { class: "ask-why" }, `No recommendation: ${view.noRecommend}`) : null,
    ].filter(Boolean);
  }

  /** A question that came bare: says so, and Ask for context (onAsk, off while its answer is sending) has the golem ask it again with its context. */
  function bare(h, onAsk, { busy = false } = {}) {
    return h("div", { class: "ask-bare" }, [
      h("span", { class: "ask-bare-note" }, "No context came with this question"),
      h("button", { type: "button", class: "small ask-context", disabled: busy, onclick: (e) => {
        e.currentTarget.disabled = true; // one tap: it waits on golemd
        onAsk();
      } }, "Ask for context"),
    ]);
  }

  return { label, of, offers, about, option, after, bare };
})();

if (typeof module !== "undefined") module.exports = AskContext;
