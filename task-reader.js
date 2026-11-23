// Mobile's sealed task list (README "Encryption required"): opened and merged with public/task-merge.js, sticky once seen sealed, guarded against an older book.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./task-merge"));
  else root.TaskReader = factory(root.TaskMerge);
})(typeof self !== "undefined" ? self : this, (TaskMerge) => {
  "use strict";
  const UNTRUSTED = "The hub says tasks are no longer protected. Mobile here does not trust that, so it shows no list.";
  const OLDER = "The hub sent an older task list than this phone has seen.";
  const NO_KEY = "This device isn't approved yet: approve it from another device, then tasks open here.";
  const MEMO = "golemworks-tasks";

  /** Per account: when tasks were first seen sealed here (sealedAt, ms) and the last mark merged (high); storage is localStorage or a stand-in. */
  function reader({ storage = null, clock = () => Date.now() } = {}) {
    let memo = {};
    try {
      memo = JSON.parse(storage?.getItem(MEMO) || "{}") || {};
    } catch {}
    const save = () => {
      try {
        storage?.setItem(MEMO, JSON.stringify(memo));
      } catch {}
    };
    const of = (accountId) => (memo[accountId] ||= {});
    const last = new Map(); // accountId -> the last good list, in memory only

    /** Remembered once this phone holds the key and has seen the account's tasks sealed. */
    function markSealed(accountId) {
      if (!accountId || of(accountId).sealedAt) return;
      of(accountId).sealedAt = clock();
      save();
    }
    const sticky = (accountId) => Boolean(accountId && memo[accountId]?.sealedAt);

    /** Encryption stopped (this phone's own Stop requiring, or a stop record that opened here): plaintext tasks are trusted again and the next sealed book starts a new count. */
    function stopRequiring(accountId) {
      last.delete(accountId);
      if (!memo[accountId]) return;
      delete memo[accountId].sealedAt;
      delete memo[accountId].high;
      save();
    }

    /** GET /api/feed's encryption.stop: clears the mark only when it opens under a key held here, says required: false, and is not older than the mark. */
    function acceptStop(acts, envelope) {
      const accountId = acts?.accountId?.() || null;
      if (!envelope || !sticky(accountId)) return false;
      const body = acts.open("tasks", "encryption-stop", "stop", envelope);
      if (!TaskMerge.stopClears(body, memo[accountId].sealedAt)) return false;
      stopRequiring(accountId);
      return true;
    }

    /** Reset encryption: the hub's sealed book starts over, so the newest list seen no longer applies. */
    function reset(accountId) {
      last.delete(accountId);
      if (!memo[accountId]) return;
      delete memo[accountId].high;
      save();
    }

    /** GET /api/tasks as the Tasks tab shows it; acts: this phone's sealer ({ open, accountId, epoch }) or null without the key. */
    function view(got, { acts = null, now } = {}) {
      const accountId = acts?.accountId?.() || null;
      const base = { tasks: [], workshops: Array.isArray(got?.workshops) ? got.workshops : [], sealed: true, seeding: false, skipped: 0, problem: null, warning: null };
      if (!got?.sealed) return sticky(accountId) ? { ...base, untrusted: true, problem: UNTRUSTED } : got;
      base.seeding = got.sealed.seeding === true;
      if (!acts || !accountId) return { ...base, problem: NO_KEY };
      markSealed(accountId);
      const merged = TaskMerge.mergeSealed(got.sealed, (kind, id, record) => acts.open("tasks", kind, id, record), now ? { now } : {});
      const next = TaskMerge.advance(memo[accountId].high || null, merged, acts.epoch?.() ?? 0);
      if (!next) return { ...(last.get(accountId) || base), workshops: base.workshops, warning: OLDER };
      memo[accountId].high = next;
      save();
      const out = { ...base, tasks: merged.tasks, skipped: merged.skipped };
      last.set(accountId, out);
      return out;
    }

    return { view, sticky, markSealed, stopRequiring, acceptStop, reset };
  }

  return { reader, UNTRUSTED, OLDER, NO_KEY };
});
