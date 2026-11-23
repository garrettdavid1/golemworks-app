"use strict";
// Opens a push in the service worker (README "Notifications"): a sealed one with the account key in IndexedDB, else the generic note.
(function (root) {
  // iOS needs a notification for every push, so one that cannot be opened still shows, with nothing in it.
  const FALLBACK = Object.freeze({ title: "Golemworks", body: "Something needs you", tag: "golemworks-sealed", url: "/#fleet" });
  const CONTEXT = { kind: "push", id: "notification" };
  const SEEN_DB = "golemworks-push";
  // Pushes can arrive out of order, so a seq is refused only when already seen or a day older than the newest.
  const SEEN_KEPT = 256;
  const SEEN_SPAN = 24 * 60 * 60 * 1000;
  // What the hub may still push in plaintext once this phone holds a key: facts it knows itself.
  const HUB_TAGS = /^(security-|takeover-|test$|waiting-task:|waiting-burst$)/;

  const line = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

  /** Only the app's own page: never another site, an API route or a script URL, even from a note that opened. */
  function inApp(url) {
    try {
      const origin = root.location?.origin || "https://app.invalid";
      const parsed = new URL(String(url), origin);
      return parsed.origin === origin && parsed.pathname === "/" && !parsed.search ? `/${parsed.hash}`.slice(0, 400) : "/#fleet";
    } catch {
      return "/#fleet";
    }
  }

  /** The seqs taken per workshop, in its own IndexedDB database beside the keys, so a push the hub sends again is refused. */
  function seenStore(indexedDB = root.indexedDB) {
    const open = () => new Promise((resolve, reject) => {
      const request = indexedDB.open(SEEN_DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("seen");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const run = async (mode, act) => {
      const db = await open();
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction("seen", mode);
          const request = act(tx.objectStore("seen"));
          tx.oncomplete = () => resolve(request.result);
          tx.onerror = (event) => reject(event.target.error);
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    };
    return {
      load: async (key) => (await run("readonly", (store) => store.get(key))) || [],
      save: (key, seqs) => run("readwrite", (store) => store.put(seqs, key)),
    };
  }

  const plainNote = (data) => ({ title: line(data?.title, 200) || "Golemworks", body: line(data?.body, 1000), tag: line(data?.tag, 200) || undefined, url: inApp(data?.url || "/#fleet") });

  let queue = Promise.resolve();
  /** What to show for one push's data: { title, body, tag, url }. One at a time, so two pushes never race on the seen seqs. */
  function openPush(data, { E, loadKeys, seen }) {
    const next = queue.then(() => openOne(data, { E, loadKeys, seen }));
    queue = next.catch(() => {});
    return next;
  }

  async function openOne(data, { E, loadKeys, seen }) {
    try {
      const keys = E ? (await E.init(), await loadKeys()) : null;
      // With a key here the account is encrypted: a plaintext push about a golem is something the hub made up.
      if (!data?.sealed) return !keys || HUB_TAGS.test(String(data?.tag || "")) ? plainNote(data) : FALLBACK;
      if (!keys) return FALLBACK;
      const { accountId, workshopId, envelope } = data.sealed;
      const { body, seq } = E.decryptRecord(keys.accountKeys, { accountId, workshopId, ...CONTEXT }, envelope);
      const key = JSON.stringify([accountId, workshopId]);
      const seqs = await seen.load(key);
      if (seqs.includes(seq) || seq < Math.max(0, ...seqs) - SEEN_SPAN) return FALLBACK;
      await seen.save(key, [...seqs, seq].sort((a, b) => a - b).slice(-SEEN_KEPT));
      return { title: line(body?.title, 200) || "Golemworks", body: line(body?.body, 1000), tag: line(body?.tag, 200) || undefined, url: inApp(body?.url) };
    } catch {
      return FALLBACK;
    }
  }

  root.GolemworksPush = { openPush, seenStore, inApp, FALLBACK, CONTEXT, HUB_TAGS };
})(typeof self !== "undefined" ? self : globalThis);
