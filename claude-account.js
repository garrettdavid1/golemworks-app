// The Claude account a golem runs on, when its workshop has more than one (golemd names each): Mobile says "Claude account" with it, since Settings > Accounts is the hub account.
"use strict";

const ClaudeAccount = (() => {
  const MAX_NAME = 30;
  const MAX_ACCOUNTS = 8;
  const TIP_MS = 8000;

  /** The name as Mobile shows it: one line, trimmed, at most 30 characters; else null (one account, or an older golemd). A sealed summary skips the hub's cleaning (src/summary.js), so the phone checks again. */
  function name(value) {
    if (typeof value !== "string") return null;
    const flat = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    // Never an email: golemd sends the name David gave, and Mobile shows nothing shaped like an address.
    if (!flat || /\S@\S/.test(flat)) return null;
    return flat.length > MAX_NAME ? `${flat.slice(0, MAX_NAME - 1)}…` : flat;
  }

  const label = (account) => `Claude account: ${account}`;

  /** Each Claude account's plan bars from usage.accounts, at most 8 with a name; null with none (one account): the workshop's own weekly and 5-hour bars then. */
  function groups(usage) {
    if (!Array.isArray(usage?.accounts)) return null;
    const kept = usage.accounts.slice(0, MAX_ACCOUNTS).map((a) => ({ account: name(a?.name), weekly: a?.weekly ?? null, fiveHour: a?.fiveHour, stale: a?.stale === true })).filter((a) => a.account);
    return kept.length ? kept : null;
  }

  /** The name as a tag: a tap spells out "Claude account: <name>" in place for 8 seconds (a meta line clips anything that floats) and does not open the card it sits in; screen readers always hear the words, title and aria-label carry them too. */
  function tag(h, account) {
    const said = label(account);
    let timer = null;
    const node = h("span", { class: "account-tag", role: "note", title: said, "aria-label": said }, [h("span", { class: "account-said" }, "Claude account: "), account]);
    const close = () => (clearTimeout(timer), node.removeAttribute("data-open"));
    const open = (ms) => (node.setAttribute("data-open", ""), (timer = setTimeout(close, ms)));
    // Fleet redraws on every feed event: a tag drawn again inside its 8 seconds starts open.
    if (shown?.account === account && shown.until > Date.now()) open(shown.until - Date.now());
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      if (node.hasAttribute("data-open")) return (shown = null), close();
      shown = { account, until: Date.now() + TIP_MS };
      open(TIP_MS);
    });
    return node;
  }
  let shown = null;

  /** A meta line's parts joined by " · ", the account's tag after the first (the workshop); the plain string when there is no account, as before. */
  function meta(h, parts, account) {
    const kept = parts.filter(Boolean);
    const named = name(account);
    if (!named) return kept.join(" · ");
    const items = [...kept.slice(0, 1), tag(h, named), ...kept.slice(1)];
    return items.flatMap((item, i) => (i ? [" · ", item] : [item]));
  }

  return { name, label, groups, tag, meta, MAX_NAME, MAX_ACCOUNTS };
})();

if (typeof module !== "undefined") module.exports = ClaudeAccount;
