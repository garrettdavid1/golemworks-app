// Encrypted actions on the phone (README "Encrypted actions"): answers, messages and files sealed for a workshop; replies, relays and the security log opened.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Acts = api;
})(typeof self !== "undefined" ? self : this, () => {
  const NOT_OPENED = "(a message this device cannot open)";
  const NOT_SEALED = "(not verified: the hub could have written this)";

  /** One phone's sealing without the page: E GolemworksE2E after init(), store its phoneKeyStore(), account() GET /api/devices, memo the account id it sealed for. */
  function create({ E, store, account, memo = memoryMemo(), now = () => Date.now(), uuid = () => crypto.randomUUID() }) {
    let keys = null;
    let accountId = null;
    const newest = () => {
      const epoch = Math.max(...Object.keys(keys?.accountKeys || {}).map(Number));
      return Number.isFinite(epoch) ? { epoch, key: keys.accountKeys[epoch] } : null;
    };
    const where = (workshopId, kind, id) => ({ accountId, workshopId, kind, id: String(id) });

    /** null only while this phone holds no account key; once it does it always seals, whatever the hub says, or throws. */
    async function sealing() {
      keys = await store.load();
      if (!newest()) return null;
      const info = await account();
      const known = memo.get("account");
      // The account this key was first used for: a hub that names another (or none) gets no plain act and no seal for it.
      if (known && info?.accountId && info.accountId !== known) throw new Error("the hub names a different account than this device's key belongs to; nothing was sent");
      accountId = known || info?.accountId;
      if (!accountId) throw new Error("the hub did not say which account this is; nothing was sent");
      if (!known) memo.set("account", accountId);
      return api;
    }

    /** An act for a workshop, sealed with this phone's clock as its seq (golemd refuses an old or repeated one). */
    function seal(workshopId, kind, id, body) {
      const { epoch, key } = newest();
      return E.encryptRecord(key, where(workshopId, kind, id), body, { epoch, seq: now() });
    }

    /** A file for a workshop (secretstream), bound to a ref of its own; the message names the ref inside its seal. */
    function sealFile(workshopId, bytes) {
      const ref = uuid();
      const { epoch, key } = newest();
      return { ref, blob: E.encryptFile(key, where(workshopId, "attachment", ref), bytes, { epoch }) };
    }

    /** What a sealed record holds, or null when it does not open here (another key, moved, or changed). */
    function open(workshopId, kind, id, envelope) {
      if (!envelope || !keys) return null;
      try {
        return E.decryptRecord(keys.accountKeys, where(workshopId, kind, id), envelope).body;
      } catch {
        return null;
      }
    }

    // accountId and epoch: the account this key seals for and its newest key, for the task reader's memo (public/task-merge.js).
    const api = { seal, sealFile, open, uuid, accountId: () => accountId, epoch: () => newest()?.epoch ?? null };
    return { sealing, api };
  }

  /** Opens a golem's thread in place (a reply only under its own message and golem); with a key held, unsealed items are marked unverified. */
  function openThread(acts, workshopId, golemId, items) {
    if (!acts) return items;
    const list = items || [];
    const lastMessage = list.filter((t) => t.kind === "message").at(-1);
    for (const item of list) {
      if (item.kind === "link") {
        const body = item.sealed ? acts.open(item.fromId, "link", item.id, item.sealed) : null;
        item.text = !item.sealed ? `${NOT_SEALED} ${item.text || ""}` : typeof body?.text === "string" ? body.text : NOT_OPENED;
        continue;
      }
      if (!item.sealed) item.text = `${NOT_SEALED} ${item.text || ""}`;
      else {
        const body = acts.open(workshopId, item.kind, item.id, item.sealed);
        const words = typeof body?.text === "string" ? body.text : "";
        if (!body || body.golemId !== golemId) item.text = NOT_OPENED;
        else if (item.kind === "answer" && typeof body.label === "string" && Number.isInteger(body.option)) item.text = words ? `${body.label}: ${words}` : body.label;
        else item.text = words || attachedOnly(body.files);
        // The words as sent (none for files alone): the Orchestrator chat matches them to the feed's copy.
        if (body && body.golemId === golemId) item.words = words;
        if (body && Array.isArray(body.files)) item.files = body.files.map((f) => String(f?.name || "file"));
      }
      for (const reply of item.replies || []) {
        if (!reply.sealed) {
          reply.text = `${NOT_SEALED} ${reply.text || ""}`;
          continue;
        }
        const body = acts.open(workshopId, "reply", reply.id, reply.sealed);
        // A reply golemd sealed with no message id (after its restart) belongs under the golem's latest message only.
        const placed = body && body.golemId === golemId && (body.saidId === item.id || (body.saidId == null && item === lastMessage));
        reply.text = placed && typeof body.text === "string" ? body.text : NOT_OPENED;
      }
    }
    return items;
  }

  /** Security-log entries golemd sealed (approvals from the phone), opened for the list; the hub's own entries (passkeys, limits) stay as they are. */
  function openLog(acts, entries) {
    for (const entry of entries || []) {
      if (!entry.sealed) continue;
      const body = acts?.open(entry.workshopId, "security", entry.id, entry.sealed);
      Object.assign(entry, body ? { golem: body.golem, kind: body.kind, what: body.what, choice: body.choice } : { what: NOT_OPENED, choice: "" });
    }
    return entries;
  }

  const attachedOnly = (files) => (Array.isArray(files) && files.length ? `(${files.length} attachment${files.length === 1 ? "" : "s"})` : "");

  /** An act goes plain to a workshop holding no account key yet: only before require, never to one this phone opened sealed. */
  function plainFor(feed, workshopId, { everSealed = false } = {}) {
    if (everSealed || feed?.encryption?.required === true) return false;
    const w = (feed?.workshops || []).find((x) => x.id === workshopId);
    return Boolean(w && w.holdsKey === false && !w.sealed);
  }

  function memoryMemo() {
    const map = new Map();
    return { get: (k) => map.get(k) ?? null, set: (k, v) => map.set(k, v) };
  }

  /** The page's memo: localStorage, so the account a key was first used for outlives a reload. */
  function localMemo(storage) {
    const key = (k) => `golemworks-acts:${k}`;
    return {
      get: (k) => {
        try {
          return storage.getItem(key(k));
        } catch {
          return null;
        }
      },
      set: (k, v) => {
        try {
          storage.setItem(key(k), v);
        } catch {}
      },
    };
  }

  return { create, openThread, openLog, localMemo, plainFor };
});
