// Mobile's Orchestrator chat (README "Orchestrator chat"): the desktop's Quiet feed as a conversation of bubbles.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.QuietChat = factory();
})(typeof self !== "undefined" ? self : this, () => {
  // A message sent from here shows queued under the feed until the feed has it, at most this long (golemd's PENDING_MS).
  const QUEUED_MS = 30 * 60e3;
  // The hub's clock stamps a sent message, golemd's the transcript's copy: this much apart still counts as after it.
  const SKEW_MS = 2 * 60e3;
  // Bubbles from one side this close together share a group (no gap, one tail).
  const GROUP_MS = 5 * 60e3;

  // A compaction shows running at most this long, and one asked from Chat or Mobile waits this long to start (golemd's PENDING_MS).
  const COMPACT_STALL_MS = 10 * 60e3;
  // The commands that act on the context: a notice shows each, never a message of the operator's.
  const CONTEXT_COMMAND = /^\s*\/(compact|clear)(?=\s|$)/i;
  const contextCommand = (text) => CONTEXT_COMMAND.exec(String(text ?? ""))?.[1].toLowerCase() || null;

  const spent = (ms) => {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };

  /** A notice entry as shown: { state: queued|running|done|failed|stalled|info, label }; a running one past its limit reads stalled with no write. */
  function notice(entry, now = Date.now()) {
    const age = now - Date.parse(entry.since || entry.at);
    const clear = entry.event === "clear";
    if (entry.event === "compact") {
      if (entry.state === "queued") return entry.held || age < QUEUED_MS ? { state: "queued", label: "Compaction queued" } : { state: "stalled", label: "Compaction did not run" };
      if (entry.state === "running") return age < COMPACT_STALL_MS ? { state: "running", label: "Compacting context" } : { state: "stalled", label: "Compaction has not finished" };
      if (entry.state === "failed") return { state: "failed", label: "Compaction failed" };
      return { state: "done", label: `Context compacted${Number(entry.ms) > 0 ? ` in ${spent(entry.ms)}` : ""}` };
    }
    if (clear && entry.state === "queued") return entry.held || age < QUEUED_MS ? { state: "queued", label: "Context reset queued" } : { state: "stalled", label: "Context reset did not run" };
    if (clear && entry.state === "failed") return { state: "failed", label: "Context reset failed" };
    if (clear) return { state: "done", label: "Context cleared" };
    if (entry.event === "restart") return { state: "info", label: "Golemworks restarted" };
    if (entry.event === "stopped") return { state: "info", label: "Turn stopped" };
    return { state: "info", label: String(entry.text || "") };
  }

  const words = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
  const count = (files) => (Array.isArray(files) ? files.length : 0);
  // golemd saves a file under its own safe name, so a copy matches on the words and how many files.
  const key = (text, files) => `${words(text)}|${count(files)}`;

  // A sealed message's words as sent (public/acts.js); its text may be a stand-in such as "(1 attachment)".
  const saidWords = (s) => (typeof s.words === "string" ? s.words : typeof s.text === "string" ? s.text : "");

  // Held or not sent: still his to see and retry, even a /compact.
  const notGone = (s) => s.delivery === "queued" || s.delivery === "failed";

  /** Messages sent from here (said: the sheet's opened thread) against their copies in the feed: { waiting: the ones not shown yet, as queued entries, oldest first; sent: feed seq -> the said entry it copies }. */
  function pair(said, entries, now = Date.now()) {
    const mine = (Array.isArray(said) ? said : []).filter((s) => s && s.kind === "message" && (saidWords(s).trim() || count(s.files)) && (!contextCommand(saidWords(s)) || notGone(s))).map((s) => ({ s, at: Date.parse(s.at) || 0, key: key(saidWords(s), s.files), used: false }));
    const sent = new Map();
    // Newest copy first, each to the newest same-words message at most a queued spell before it: a lost one takes no later copy.
    const copies = (Array.isArray(entries) ? entries : []).filter((e) => e.kind === "you" && e.via === "mobile");
    for (const copy of [...copies].reverse()) {
      const at = Date.parse(copy.at) || 0;
      const k = key(copy.text, copy.files);
      // One that has not gone (queued, failed) has no copy.
      const match = mine.filter((m) => !m.used && m.s.delivery !== "failed" && m.s.delivery !== "queued" && m.key === k && m.at <= at + SKEW_MS && at - m.at < QUEUED_MS + SKEW_MS).sort((a, b) => b.at - a.at)[0];
      if (!match) continue;
      match.used = true;
      sent.set(copy.seq, match.s);
    }
    // One held or not sent stays at the end in the order typed, whatever its age, until it goes or is dismissed.
    const waiting = mine
      .filter((m) => !m.used && (now - m.at < QUEUED_MS || m.s.delivery === "queued" || m.s.delivery === "failed"))
      .sort((a, b) => a.at - b.at)
      .map(({ s }) => ({ kind: "you", at: s.at, text: saidWords(s), via: "mobile", queued: true, failed: s.delivery === "failed", said: s }));
    // Past its queued spell with no copy in the feed: kept in place, as the thread under the chat once showed it, when it was never confirmed or has a reply.
    const stray = mine
      .filter((m) => !m.used && now - m.at >= QUEUED_MS && m.s.delivery !== "queued" && m.s.delivery !== "failed" && (m.s.delivery === "unconfirmed" || m.s.replies?.some((r) => words(r.text))))
      .map(({ s }) => ({ kind: "you", at: s.at, text: saidWords(s), via: "mobile", unconfirmed: s.delivery === "unconfirmed", said: s }));
    return { waiting, sent, stray };
  }

  /** The Orchestrator's gw reply answers to messages sent from here, as feed-like entries, leaving out one whose words its feed already holds. */
  function replies(said, entries) {
    const feedWords = new Set((Array.isArray(entries) ? entries : []).filter((e) => e.kind === "orchestrator").map((e) => words(e.text)));
    return (Array.isArray(said) ? said : [])
      .filter((s) => s && s.kind === "message")
      .flatMap((s) => (s.replies || []).filter((r) => words(r.text) && !feedWords.has(words(r.text))).map((r) => ({ kind: "orchestrator", at: r.at, text: String(r.text), replyTo: s.id })));
  }

  /** Feed entries with others merged in by time: each goes after the last entry at or before it. */
  function byTime(feed, extra) {
    const out = [...feed];
    for (const entry of [...extra].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
      const at = Date.parse(entry.at) || 0;
      let i = out.length;
      while (i > 0 && (Date.parse(out[i - 1].at) || 0) > at) i--;
      out.splice(i, 0, entry);
    }
    return out;
  }

  /** The messages sent from here the feed has not shown yet (pair's waiting). */
  const queued = (said, entries, now) => pair(said, entries, now).waiting;

  /** The feed then the queued messages, oldest first, as { day } separators and bubbles { side, kind, text, at, state?, from?, files?, said?, replyTo?, first, last }; sent: pair's, so a feed copy carries the said entry it copies; extra: pair's stray and replies' entries, merged in by time (a reply to a queued message after it). */
  function conversation(entries, waiting = [], { dayOf = (iso) => String(iso).slice(0, 10), sent = new Map(), extra = [], now = Date.now() } = {}) {
    const out = [];
    let day = null;
    let prev = null;
    const queuedIds = new Set((Array.isArray(waiting) ? waiting : []).map((w) => w.said?.id).filter(Boolean));
    const late = extra.filter((e) => queuedIds.has(e.replyTo));
    const merged = [...byTime(Array.isArray(entries) ? entries : [], extra.filter((e) => !queuedIds.has(e.replyTo))), ...(Array.isArray(waiting) ? waiting : []), ...late];
    // A turn's done line draws nothing in a chat: the reply above it already ended the turn.
    for (const entry of merged) {
      // A machine event: a gray line of its own, from no side.
      if (entry.kind === "notice") {
        const label = dayOf(entry.at);
        if (label !== day) (out.push({ day: label }), (day = label));
        out.push({ side: "center", kind: "notice", at: entry.at, event: entry.event, ...notice(entry, now), first: true, last: true });
        prev = null;
        continue;
      }
      if (!["you", "orchestrator", "note"].includes(entry.kind) || (!String(entry.text ?? "").trim() && !count(entry.files) && !count(entry.said?.files))) continue;
      const label = dayOf(entry.at);
      if (label !== day) {
        out.push({ day: label });
        day = label;
        prev = null;
      }
      const side = entry.kind === "you" ? "me" : "them";
      const bubble = { side, kind: entry.kind, text: String(entry.text), at: entry.at, first: true, last: true };
      // A reply keeps its feed id, which is what plays it.
      if (side === "them" && Number.isInteger(entry.seq)) bubble.seq = entry.seq;
      if (side === "me") {
        bubble.state = entry.failed ? "failed" : entry.queued || entry.pending ? "queued" : entry.unconfirmed ? "unconfirmed" : "sent";
        bubble.from = entry.via === "mobile" ? "mobile" : "desktop";
        if (entry.answer) bubble.answer = true;
        const said = entry.said || sent.get(entry.seq);
        if (said) bubble.said = said;
        const files = count(said?.files) ? said.files : entry.files;
        if (count(files)) bubble.files = files;
      } else if (entry.replyTo) bubble.replyTo = entry.replyTo;
      if (prev && prev.side === side && prev.kind === bubble.kind && Date.parse(bubble.at) - Date.parse(prev.at) < GROUP_MS) {
        prev.last = false;
        bubble.first = false;
      }
      out.push(bubble);
      prev = bubble;
    }
    return out;
  }

  /** What a golem's sheet shows: the Orchestrator's chat ends at its message row (David, 2026-11-20), closed from an ✕ in its header; every other sheet keeps its steps, status history and bottom Close. */
  const sheetParts = (chat) => ({ chat: Boolean(chat), steps: !chat, history: !chat, closeButton: !chat });

  // A gap under the visual viewport smaller than this is rounding or a short Home Screen frame, not the keyboard.
  const KEYBOARD_MIN = 120;
  const CLOSED = { open: false, top: 0, bottom: 0 };

  /** Where the chat sheet sits while the keyboard is open: iOS keeps the layout viewport and only shrinks (and pans) the visual one, so the sheet takes its top and bottom from it. frameBottom: where the app's column ends (frame.js); typing: the chat's box has focus; a pinch zoom (scale) is not the keyboard. */
  function keyboard({ frameBottom, height, offsetTop = 0, scale = 1, typing = true }) {
    if (!frameBottom || !height || !typing || Math.abs(scale - 1) > 0.05) return CLOSED;
    const top = Math.max(0, Math.round(offsetTop));
    const bottom = Math.max(0, Math.round(frameBottom - height - offsetTop));
    return bottom >= KEYBOARD_MIN ? { open: true, top, bottom } : CLOSED;
  }

  // This close to the end of the conversation counts as reading the newest.
  const NEAR_END = 24;

  /** The chat's place (G-108): at the end it stays there through every redraw, resize and late photo (Safari has no scroll anchoring); scrolled up, nothing moves it. Only a scroll up leaves the end, so content growing before a scroll event is read never counts as him scrolling. Observer: ResizeObserver, none in tests. */
  function keeper(panel, { Observer = typeof ResizeObserver === "function" ? ResizeObserver : null } = {}) {
    if (panel.chatKeeper) return panel.chatKeeper;
    let lastTop = panel.scrollTop;
    const k = {
      pinned: true,
      gap: () => panel.scrollHeight - panel.scrollTop - panel.clientHeight,
      /** To the newest and kept there (a send, the New message pill). */
      pin(smooth = false) {
        k.pinned = true;
        if (smooth) panel.scrollTo({ top: panel.scrollHeight, behavior: "smooth" });
        else panel.scrollTop = panel.scrollHeight;
        lastTop = panel.scrollTop;
      },
      /** To a place of the code's choosing (a chat opened again): at the end only if that place is. */
      jump(to) {
        panel.scrollTop = to;
        lastTop = panel.scrollTop;
        k.pinned = k.gap() < NEAR_END;
      },
      /** At the end: back to it after the rows or the panel changed size. */
      follow() {
        if (!k.pinned) return;
        panel.scrollTop = panel.scrollHeight;
        lastTop = panel.scrollTop;
      },
      /** Size changes to watch: the panel (keyboard, needs strip, a growing box) and each row (a photo or font loading late). */
      watch() {
        if (!observer) return;
        observer.disconnect();
        observer.observe(panel);
        for (const row of panel.children) observer.observe(row);
      },
      // Called when a scroll reaches the end (the pill has done its job), and after every scroll.
      onEnd: null,
      onScroll: null,
      // The newest bubble's time he has had on screen, and how he left the chat when it is to be placed again (rule 4).
      seenAt: null,
      opening: null,
    };
    const observer = Observer ? new Observer(() => k.follow()) : null;
    panel.addEventListener("scroll", () => {
      const top = panel.scrollTop;
      if (k.gap() < NEAR_END) {
        k.pinned = true;
        k.onEnd?.();
      } else if (top < lastTop) k.pinned = false;
      lastTop = top;
      k.onScroll?.();
    }, { passive: true });
    // His own finger or wheel takes over from a placing still to come (a slow fetch on return), so it never jumps him mid-read.
    for (const type of ["touchstart", "wheel"]) panel.addEventListener(type, () => (k.opening = null), { passive: true });
    panel.chatKeeper = k;
    return k;
  }

  /** How many drawn rows stay as they are: the run from the start whose keys match, since what changes is nearly always at the end (a new bubble, Queued to Sent, the typing dots). */
  function sameStart(was, now) {
    let i = 0;
    while (i < was.length && i < now.length && was[i] === now[i]) i++;
    return i;
  }

  /** The first reply he has not seen, as an index into rows ({ side, at }), or -1: the first of theirs newer than seenAt. No seenAt: -1, as nothing says he missed any. */
  function firstUnseen(rows, seenAt) {
    const seen = Date.parse(seenAt);
    if (!Number.isFinite(seen)) return -1;
    return rows.findIndex((r) => r.side === "them" && Date.parse(r.at) > seen);
  }

  return { notice, contextCommand, COMPACT_STALL_MS, pair, queued, replies, conversation, sheetParts, keyboard, keeper, sameStart, firstUnseen, NEAR_END, QUEUED_MS };
});
