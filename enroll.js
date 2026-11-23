// Encryption devices on the phone (README "Encryption devices"): this phone's key pair, the account key, confirming devices by safety code.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Enroll = api;
})(typeof self !== "undefined" ? self : this, () => {
  const PENDING = ["committed", "approving", "revealed", "keyed"];
  const MEMO = "golemworks-enroll";

  /** Groups a 12-character safety code in fours, as both screens show it. */
  const showCode = (code) => (code ? code.match(/.{1,4}/g).join(" ") : "");

  /** One phone's enrollment without the page: api is the page's fetch, E GolemworksE2E after init(), store E.phoneKeyStore(), memo what this phone saw and said. */
  function create({ api, E, sodium, store, memo = memoryMemo() }) {
    const b64 = (bytes) => sodium.to_base64(bytes);
    const raw = (text) => sodium.from_base64(text);
    let keys = null;
    let state = null;

    async function ownKeys() {
      keys ||= await store.load();
      if (!keys) {
        keys = { device: E.newDeviceKeyPair(), accountKeys: {} };
        await store.save(keys);
      }
      return keys;
    }

    const mine = () => state?.devices.find((d) => d.mine) || null;
    const others = () => (state?.devices || []).filter((d) => !d.mine);
    // The hub's record for this passkey is this page only while it carries this page's key: Safari and its Home Screen app share the passkey but not their keys.
    const isThisPage = (own) => Boolean(own && keys && (!own.publicKey || own.publicKey === b64(keys.device.publicKey)));
    // This page holds the key while its passkey's other page (the Home Screen app) asks for it: this page approves that request.
    const handsOver = (own) => Boolean(own && own.kind === "phone" && PENDING.includes(own.state) && newestKey() && !ours(own));
    // The waiting devices this page may act on: others' when it holds the key, or its own passkey's request when it hands the key over.
    const actable = () => {
      const own = mine();
      if (own?.state === "active" && isThisPage(own) && newestKey()) return others();
      return handsOver(own) ? [own] : [];
    };
    const newestKey = () => {
      const epoch = Math.max(...Object.keys(keys?.accountKeys || {}).map(Number));
      return Number.isFinite(epoch) ? { epoch, key: keys.accountKeys[epoch] } : null;
    };
    // The approver this phone revealed its key to, pinned at that moment: the key may come from it alone.
    const pinned = (own) => (own ? memo.get(`approver:${own.id}`) : null);
    // This attempt's key (new at each ask), the one request it is revealed for, and its account id: a hub that saw the key, or changes the id later, cannot search for a matching code.
    const ours = (own) => {
      const attempt = memo.get("attempt");
      return Boolean(attempt && keys && attempt.key === b64(keys.device.publicKey) && attempt.accountId === state.accountId && (!attempt.deviceId || attempt.deviceId === own.id));
    };
    const changed = (own) => Boolean(own && ((own.approver && pinned(own) && own.approver.publicKey !== pinned(own)) || (own.state !== "committed" && own.state !== "active" && !ours(own))));

    /** Brings this phone one step on; it never asks to join on its own (ask() is a tap), so a dropped request is not repeated. */
    async function sync() {
      state = await api("GET", "/api/devices");
      if (!state.on) return view();
      await ownKeys();
      const publicKey = b64(keys.device.publicKey);
      let own = mine();
      if (!own && !state.devices.some((d) => d.state === "active")) {
        // A key this phone already holds is never replaced: a hub that hides or lost its devices gets this one back, sealed. After Reset encryption (a floor), the new key starts above every older epoch.
        const newest = newestKey();
        const held = newest && !(state.floor > newest.epoch) ? newest : { epoch: state.floor || 1, key: E.newAccountKey() };
        keys.accountKeys = { ...keys.accountKeys, [held.epoch]: held.key };
        await store.save(keys);
        state = await api("POST", "/api/devices/first", { publicKey, sealed: b64(E.sealAccountKey(held.key, keys.device.publicKey, { epoch: held.epoch })), epoch: held.epoch });
      }
      own = mine();
      if (own?.state === "approving" && !changed(own)) {
        if (!pinned(own)) memo.set(`approver:${own.id}`, own.approver.publicKey);
        memo.set("attempt", { ...memo.get("attempt"), deviceId: own.id });
        state = await api("POST", "/api/devices/reveal", { publicKey });
      }
      own = mine();
      if (own?.state === "keyed" && !changed(own) && memo.get(`confirmed:${own.id}`) === pinned(own)) await open(own);
      own = mine();
      if (own?.state === "active" && isThisPage(own) && own.rotation) await takeRotation(own.rotation);
      // A device left and no phone has made the next epoch yet: this one does (any phone that holds the key).
      if (mine()?.state === "active" && isThisPage(mine()) && state.rotationDue && newestKey()) await rotate();
      return view();
    }

    /** A rotation for this phone: the proof under the newest key held before it names the sender, the new key opens only from it (checked again if the epoch is held: a different key is refused), and it is stored sealed back on the hub. */
    async function takeRotation({ epoch, boxed, proofs }) {
      const before = Object.fromEntries(Object.entries(keys.accountKeys).filter(([n]) => Number(n) < epoch));
      const newest = Math.max(...Object.keys(before).map(Number));
      const from = E.checkRotationProof(before, proofs?.[newest], { accountId: state.accountId, epoch });
      const adk = E.openBoxedAccountKey(raw(boxed), from, keys.device, { epoch });
      const held = keys.accountKeys[epoch];
      if (held && b64(held) !== b64(adk)) throw new Error(`two different account keys arrived for epoch ${epoch}: a removed device may be acting through the hub; use Settings > Your devices > Lost all your devices?`);
      if (!held) {
        keys.accountKeys = { ...keys.accountKeys, [epoch]: adk };
        await store.save(keys);
      }
      state = await api("POST", "/api/devices/rotated", { sealed: b64(E.sealAccountKey(adk, keys.device.publicKey, { epoch })), epoch });
    }

    /** The next epoch after a device left: a new key, boxed from this phone to every other device still listed, with a proof under the epoch each one last stored. The removed device gets nothing. */
    async function rotate() {
      // Above the hub's epoch and every key held here: a hub that reports a lower one cannot make this phone overwrite a key it holds.
      const epoch = Math.max(state.epoch || 0, newestKey()?.epoch || 0) + 1;
      if (epoch !== (state.epoch || 0) + 1) throw new Error(`the hub says the account key is epoch ${state.epoch}, but this device holds a newer one; use Settings > Your devices > Lost all your devices?`);
      const adk = E.newAccountKey();
      const boxes = {};
      for (const device of others().filter((d) => d.state === "active")) {
        // A proof under each epoch the device may hold: the one the hub recorded, and any newer one it opened but the hub has not recorded.
        const held = Object.keys(keys.accountKeys).map(Number).filter((n) => n >= (device.epoch || 0) && n < epoch);
        if (!held.length) throw new Error(`"${device.name}" holds an account key this device does not have (epoch ${device.epoch}); open Mobile on another of your devices to finish, or use Settings > Your devices > Lost all your devices?`);
        boxes[device.id] = {
          boxed: b64(E.boxAccountKey(adk, raw(device.publicKey), keys.device, { epoch })),
          proofs: Object.fromEntries(held.map((heldEpoch) => [heldEpoch, E.rotationProof(keys.accountKeys[heldEpoch], { accountId: state.accountId, heldEpoch, epoch, from: keys.device.publicKey })])),
        };
      }
      // Kept here first: if the hub refuses, the extra key is unused and the next try makes another.
      keys.accountKeys = { ...keys.accountKeys, [epoch]: adk };
      await store.save(keys);
      try {
        state = await api("POST", "/api/devices/rotate", { epoch, sealed: b64(E.sealAccountKey(adk, keys.device.publicKey, { epoch })), boxes });
      } catch (error) {
        // Refused: the key made for this try is never used, so a rotation from another phone for this epoch opens here later.
        const { [epoch]: unused, ...kept } = keys.accountKeys;
        keys.accountKeys = kept;
        await store.save(keys);
        // Another phone (or this one's own sync) made the epoch first: nothing left to do.
        if (error.status !== 409) throw error;
        state = await api("GET", "/api/devices");
        if (state.rotationDue) throw error;
      }
    }

    /** Remove a lost device (Face ID through send), then make the next epoch so it cannot read anything written after. */
    async function remove(id, send = (request) => request()) {
      const device = others().find((d) => d.id === id);
      if (!device) throw new Error("that device is no longer listed");
      state = await send(() => api("POST", `/api/devices/${encodeURIComponent(id)}/remove`));
      if (state.rotationDue && mine()?.state === "active") await rotate();
      return view();
    }

    /** Everything lost: the hub drops every device and stored ciphertext (Face ID through send); this phone forgets its keys and makes a new one, and every other device enrolls again. */
    async function reset(send = (request) => request()) {
      state = await send(() => api("POST", "/api/devices/reset"));
      keys = { device: E.newDeviceKeyPair(), accountKeys: {} };
      await store.save(keys);
      memo.delete("attempt");
      return sync();
    }

    async function open(own) {
      if (!Number.isInteger(own.boxed?.epoch) || own.boxed.epoch < 1) throw new Error("the key came with no valid epoch");
      const adk = E.openBoxedAccountKey(raw(own.boxed.boxed), raw(pinned(own)), keys.device, { epoch: own.boxed.epoch });
      keys.accountKeys = { ...keys.accountKeys, [own.boxed.epoch]: adk };
      await store.save(keys);
      state = await api("POST", "/api/devices/finish", { sealed: b64(E.sealAccountKey(adk, keys.device.publicKey, { epoch: own.boxed.epoch })), epoch: own.boxed.epoch });
      memo.delete(`approver:${own.id}`);
      memo.delete(`confirmed:${own.id}`);
      memo.delete("attempt");
    }

    /** What the page shows: this phone's own step and code, and the one device this phone should act on. */
    function view() {
      if (!state?.on) return { on: false };
      const own = mine();
      const holdsKey = own?.state === "active" && isThisPage(own) && Boolean(newestKey());
      const handing = handsOver(own);
      const tookOn = (d) => (d.approver?.self ? d.approver.publicKey === b64(keys.device.publicKey) : d.approver?.deviceId === own.id);
      const waiting = actable().filter((d) => PENDING.includes(d.state)).map((d) => ({ ...d, mineToConfirm: tookOn(d), check: d.state !== "committed" && d.publicKey ? check(d) : null }));
      const pending = own && PENDING.includes(own.state) && !handing;
      return {
        on: true,
        accountId: state.accountId,
        mine: own,
        holdsKey,
        handsOver: handing,
        canAsk: !own && !holdsKey,
        // The hub knows this passkey's device, but the key is not on this page (a Home Screen app keeps its own storage): it asks again, approved by another phone.
        rekey: own?.state === "active" && own.kind === "phone" && !newestKey() && others().some((d) => d.state === "active" && d.kind === "phone"),
        approverChanged: !handing && changed(own),
        confirmed: Boolean(pending && memo.get(`confirmed:${own.id}`)),
        // A new phone's code: the approver it pinned and its own key.
        code: pending && pinned(own) && memo.get("attempt")?.accountId ? E.safetyCode(raw(pinned(own)), keys.device.publicKey, memo.get("attempt").accountId) : null,
        waiting,
        // The device to act on: one this phone took on first, else the first still waiting for a Start.
        next: waiting.find((d) => d.mineToConfirm) || waiting.find((d) => d.state === "committed") || null,
        // Settings' list: every device with the key; a phone that holds it may remove any other.
        devices: state.devices.filter((d) => d.state === "active").map((d) => ({ id: d.id, kind: d.kind, name: d.name, mine: d.mine, epoch: d.epoch, lastSeenAt: d.lastSeenAt || null, signedInAt: d.signedInAt || null, removable: holdsKey && !d.mine })),
        epoch: state.epoch,
      };
    }

    /** A revealed device's code, if its key is the one it committed to before this phone approved it; else mismatch. */
    function check(device) {
      const seen = memo.get(`commitment:${device.id}`);
      if (!seen || !E.checkKeyCommitment(seen, raw(device.publicKey), state.accountId)) return { mismatch: true };
      return { code: E.safetyCode(keys.device.publicKey, raw(device.publicKey), state.accountId) };
    }

    /** This phone asks a phone that has the key: a new key pair for this attempt, and its hash goes first. */
    async function ask({ rekey = false } = {}) {
      keys = { ...(await ownKeys()), device: E.newDeviceKeyPair() };
      await store.save(keys);
      memo.set("attempt", { key: b64(keys.device.publicKey), deviceId: null, accountId: state.accountId });
      state = await api("POST", "/api/devices/commit", { commitment: E.keyCommitment(keys.device.publicKey, state.accountId), ...(rekey ? { rekey: true } : {}) });
      return view();
    }

    /** The new phone's own They match, for the request and code its screen showed: the key is opened only after this, and only from the pinned approver. */
    async function confirmOwn(id, code) {
      const own = mine();
      if (!own || !pinned(own) || changed(own)) throw new Error("there is no code to confirm");
      if (own.id !== id || view().code !== code) throw new Error("the safety code changed since it was shown: compare the new one");
      memo.set(`confirmed:${own.id}`, pinned(own));
      if (own.state === "keyed") await open(own);
      return view();
    }

    /** Takes a committed device on: remembers its commitment first, so a key it reveals later must match it. */
    async function take(id) {
      const device = actable().find((d) => d.id === id && d.state === "committed");
      if (!device) throw new Error("that device is no longer waiting");
      memo.set(`commitment:${id}`, device.commitment);
      // Its own passkey's request: the hub has no record of this page's key, so this page names it.
      state = await api("POST", `/api/devices/${encodeURIComponent(id)}/approve`, device.mine ? { publicKey: b64(keys.device.publicKey) } : undefined);
      return view();
    }

    /** The approver's They match: the account key, boxed from this phone's key to the device's. send wraps the request (Face ID). */
    async function confirm(id, send = (request) => request()) {
      const device = actable().find((d) => d.id === id && d.state === "revealed");
      if (!device) throw new Error("that device is not ready for the key");
      if (check(device).mismatch) throw new Error("its key does not match what it promised: tap They don't match");
      const { epoch, key } = newestKey();
      const boxed = b64(E.boxAccountKey(key, raw(device.publicKey), keys.device, { epoch }));
      state = await send(() => api("POST", `/api/devices/${encodeURIComponent(id)}/key`, { boxed, epoch }));
      memo.delete(`commitment:${id}`);
      return view();
    }

    /** They don't match, Not mine, or a new phone giving up: the waiting device is dropped. */
    async function reject(id) {
      if (mine()?.id === id) memo.delete("attempt");
      memo.delete(`commitment:${id}`);
      memo.delete(`approver:${id}`);
      memo.delete(`confirmed:${id}`);
      state = await api("DELETE", `/api/devices/${encodeURIComponent(id)}`);
      return view();
    }

    return { sync, view, ask, confirmOwn, take, confirm, reject, remove, reset, keys: () => keys };
  }

  function memoryMemo() {
    const map = new Map();
    return { get: (id) => map.get(id), set: (id, value) => map.set(id, value), delete: (id) => map.delete(id) };
  }

  /** What this phone saw and said while enrolling, kept across a reload: public keys, their hashes, and its own confirms. Storage that refuses a write (private mode) leaves it in memory for this page. */
  function localMemo(storage) {
    let held = null;
    const read = () => {
      if (held) return { ...held };
      try {
        return JSON.parse(storage.getItem(MEMO) || "{}");
      } catch {
        return {};
      }
    };
    const write = (all) => {
      if (!held) {
        try {
          return void storage.setItem(MEMO, JSON.stringify(all));
        } catch {}
      }
      held = all;
    };
    return {
      get: (id) => read()[id],
      set: (id, value) => write({ ...read(), [id]: value }),
      delete: (id) => {
        const all = read();
        delete all[id];
        write(all);
      },
    };
  }

  /** The page's part: runs sync on each account change and shows one sheet for whatever needs this phone. */
  function mount({ api, h, showSheet, closeSheet, withFaceId, toast, skip = () => false, onReset = () => {}, sheetOpen = () => !document.getElementById("sheet")?.hidden, ownSheet = () => Boolean(document.querySelector("#sheet:not([hidden]) [data-enroll]")), enrollment: given = null, onView = () => {} }) {
    // given: a ready enrollment (tests); the page makes its own from the phone's keys.
    let enrollment = given;
    let shown = "";
    let running = false;
    let again = false;
    let lastError = "";
    let acting = 0;
    // Devices this phone sent the key to: each says Approved once the hub lists it as holding the key, not before.
    const sentKey = new Map();

    async function ready() {
      if (enrollment) return enrollment;
      if (typeof GolemworksE2E === "undefined" || typeof sodium === "undefined") return null;
      const E = await GolemworksE2E.init();
      enrollment = create({ api, E, sodium, store: E.phoneKeyStore(), memo: localMemo(localStorage) });
      return enrollment;
    }

    /** One sync at a time; an account change during one runs another after it, so no step is missed. */
    async function refresh() {
      // A computer's browser signs in strict and is no phone: it neither enrolls nor confirms.
      if (skip()) return;
      if (running) return void (again = true);
      running = true;
      try {
        do {
          again = false;
          const e = await ready();
          if (!e) return;
          const view = await e.sync();
          // A tap's request is still out: this read may predate it, so it must not reopen the sheet just closed (act() renders after).
          if (!acting) render(view);
          // The Fleet's approval line reads this view: the page redraws it once the phone's own state is known.
          onView(view);
          lastError = "";
        } while (again);
      } catch (error) {
        // The same failure on every account change shows once.
        if (error.message !== lastError) toast?.(`Device approval: ${error.message}`, true);
        lastError = error.message;
      } finally {
        running = false;
      }
    }

    // A step's sheet shows once: closed by the person, it stays closed until the step changes (or the page reloads). It never covers another sheet; the next account change tries again.
    function once(key, children) {
      if (shown === key) return;
      if (sheetOpen() && !ownSheet()) return;
      shown = key;
      showSheet(children);
    }

    function quiet() {
      if (ownSheet()) closeSheet();
      shown = "";
    }

    const row = (...buttons) => h("div", { class: "row" }, buttons);
    const button = (text, run, { primary = false, danger = false, done } = {}) => h("button", { type: "button", class: [primary && "primary", danger && "danger-fill"].filter(Boolean).join(" "), onclick: () => act(run, done) }, text);
    const title = (text) => h("h2", { id: "sheet-title", "data-enroll": true }, text);

    function render(view) {
      if (!view.on) return quiet();
      const own = view.mine;
      if (view.rekey) {
        return once("rekey", [title("Approve this device again"), h("p", {}, "Mobile here is signed in, but this device's key isn't here: an app on the Home Screen keeps its own storage, apart from Safari. Ask, then approve it in Mobile on another device."), row(h("button", { type: "button", onclick: closeSheet }, "Not now"), button("Ask for approval", () => enrollment.ask({ rekey: true }), { primary: true }))]);
      }
      if (view.canAsk) {
        return once("ask", [title("Approve this device"), h("p", {}, "Mobile here needs approval from another device where you already use Mobile. Ask, then open Mobile there."), row(h("button", { type: "button", onclick: closeSheet }, "Not now"), button("Ask for approval", () => enrollment.ask(), { primary: true }))]);
      }
      if (own && PENDING.includes(own.state) && !view.handsOver) {
        if (view.approverChanged) return once(`changed-${own.id}`, [title("Another device answered"), h("p", {}, "The answer came from a different device than the one you compared codes with. Nothing was taken."), row(button("Start over", () => enrollment.reject(own.id).then(() => enrollment.ask()), { danger: true }))]);
        if (!view.code) return once(`wait-${own.id}`, [title("Waiting for your other device"), h("p", {}, "Open Mobile on another device you already use and tap Start there.")]);
        if (view.confirmed) return once(`sent-${own.id}`, [title("Waiting for your other device"), h("p", { class: "safety-code" }, showCode(view.code)), h("p", {}, "Tap They match in Mobile on your other device too.")]);
        return once(`code-${own.id}`, [
          title("Approve your new device"),
          h("p", {}, "Check the code matches on both screens."),
          h("p", { class: "safety-code" }, showCode(view.code)),
          h("p", {}, "Does Mobile on your other device show this same code?"),
          row(button("They don't match", () => enrollment.reject(own.id), { danger: true }), button("They match", () => enrollment.confirmOwn(own.id, view.code), { primary: true })),
        ]);
      }
      if (own?.state === "active" && /^(code|sent)-/.test(shown)) {
        quiet();
        return void toast?.("Mobile here is approved");
      }
      for (const [id, name] of sentKey) {
        if ((view.devices || []).some((d) => d.id === id)) toast?.(`"${name}" is approved`);
        if (!(view.waiting || []).some((d) => d.id === id)) sentKey.delete(id);
      }
      const device = view.next;
      if (!device) return quiet();
      const what = device.kind === "workshop" ? `the computer "${device.name}"` : device.mine ? "Mobile on this device's Home Screen" : `a new device in Mobile ("${device.name}")`;
      if (device.state === "committed" && device.mine) {
        return once(`take-${device.id}`, [title("Your Home Screen app asks for the key"), h("p", {}, "Mobile on this device's Home Screen asks for the key this Safari page holds. Start only if you just tapped Ask for approval there; it takes over from this page."), row(button("Not mine", () => enrollment.reject(device.id)), button("Start", () => enrollment.take(device.id), { primary: true }))]);
      }
      if (device.state === "committed") {
        return once(`take-${device.id}`, [title("A new device asks to join"), h("p", {}, `${cap(what)} asks to join your account. Start only if you just added it.`), row(button("Not mine", () => enrollment.reject(device.id)), button("Start", () => enrollment.take(device.id), { primary: true }))]);
      }
      if (device.state === "revealed" && device.check?.mismatch) {
        return once(`bad-${device.id}`, [title("This request changed: nothing was shared"), h("p", {}, "The device's code is not the one it promised, so nothing was sent. Start again from that device."), row(button("Drop it", () => enrollment.reject(device.id), { danger: true }))]);
      }
      if (device.state === "revealed") {
        const where = device.kind === "workshop" ? `Golemworks on "${device.name}"` : "Mobile on the new device";
        return once(`confirm-${device.id}`, [
          title("Approve your new device"),
          h("p", {}, "Check the code matches on both screens."),
          h("p", { class: "safety-code" }, showCode(device.check.code)),
          h("p", {}, `Does ${where} show this same code? Then click They match there too: both screens must say so.`),
          row(button("They don't match", () => enrollment.reject(device.id), { danger: true }), button("They match", () => enrollment.confirm(device.id, withFaceId).then((after) => (sentKey.set(device.id, device.name), after)), { primary: true })),
        ]);
      }
      // A computer waits for a click on the computer itself: send the person there, or the Fleet's empty board reads as a failed pairing.
      if (device.state === "keyed" && device.kind === "workshop") {
        return once(`keyed-${device.id}`, [title("Now finish on your computer"), h("p", {}, `In Golemworks on "${device.name}", click They match. Its overlord and golems show here once you do.`), row(button("Cancel", () => enrollment.reject(device.id)), h("button", { type: "button", class: "primary", onclick: closeSheet }, "OK"))]);
      }
      const doing = device.state === "keyed" ? `Waiting for ${what} to confirm the code too.` : `Waiting for ${what} to answer.`;
      return once(`${device.state}-${device.id}`, [title("Waiting for the device"), h("p", {}, doing), row(button("Cancel", () => enrollment.reject(device.id)))]);
    }

    // Close first, then run: the tap's Face ID (withFaceId) starts before any await.
    function act(run, done) {
      shown = "";
      closeSheet();
      acting += 1;
      const running = run();
      running
        .then((view) => (render(view || enrollment.view()), done && toast?.(done)))
        .catch((error) => toast?.(error.message, true))
        .finally(() => ((acting -= 1), refresh()));
    }

    const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);

    /** Settings' Your devices: the devices that hold the account key with when each was last seen, Remove for a lost one (the key changes after), and Lost all your devices? (Reset) when everything is lost. after() redraws the page; label: false when the group heading already says Your devices. */
    function panel(after = () => {}, { label = true } = {}) {
      const view = enrollment?.view();
      if (!view?.on) return null;
      const done = (text) => (toast?.(text), after());
      const fail = (error) => (toast?.(error.message, true), after());
      const removeOne = (d) => {
        const what = d.kind === "workshop" ? `the computer "${d.name}" (it is unpaired and must be paired again)` : `"${d.name}"`;
        if (!confirm(`Remove ${what}? It keeps what it already saw, but can't read anything new.`)) return;
        enrollment.remove(d.id, withFaceId).then(() => done(`Removed "${d.name}"`), fail);
      };
      const resetAll = () => {
        if (!confirm(START_OVER)) return;
        enrollment.reset(withFaceId).then(() => (onReset(), done("Started over: approve each computer and Mobile device as it asks, checking the code matches on both screens")), fail);
      };
      return h("div", { class: "stack", "data-devices": true }, [
        label ? h("span", { class: "rank-name" }, "Your devices") : null,
        h("ul", { class: "list" }, view.devices.map((d) => h("li", {}, [
          h("div", { class: "grow" }, [h("span", { class: "rank-name" }, d.name), h("span", { class: "note" }, [d.kind === "workshop" ? "Computer" : "Mobile", d.mine ? "this device" : null, d.lastSeenAt ? `last seen ${seen(d.lastSeenAt)}` : d.signedInAt ? `signed in ${seen(d.signedInAt)}` : null].filter(Boolean).join(" · "))]),
          d.removable ? h("button", { type: "button", class: "small danger", onclick: () => removeOne(d) }, "Remove") : null,
        ]))),
        h("div", { class: "row" }, [h("span", { class: "note grow" }, "Lost all your devices?"), h("button", { type: "button", class: "small danger", onclick: resetAll }, "Start over")]),
      ]);
    }
    // view: Settings' steps and the banner read where enrollment stands; reopen: the banner's Continue shows the current step's sheet again.
    return { refresh, panel, view: () => enrollment?.view() || null, reopen: () => ((shown = ""), refresh()) };
  }

  /** When a device was last seen, in a few words: just now, minutes, hours, then the date. */
  function seen(iso, now = Date.now()) {
    const minutes = Math.round((now - Date.parse(iso)) / 60000);
    if (!(minutes >= 0)) return "just now";
    if (minutes < 2) return "just now";
    if (minutes < 60) return `${minutes} minutes ago`;
    if (minutes < 48 * 60) return `${Math.round(minutes / 60)} hour${Math.round(minutes / 60) === 1 ? "" : "s"} ago`;
    return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
  }

  // What Start over loses, plainly: only what this account's devices could read goes; tasks come back from a computer.
  const START_OVER = "Start over? Your hub forgets every device and what only they could read: the feed, history and messages it holds and the security log entries only your devices could read. Tasks come back from your computers once one is approved again. Then approve each computer and Mobile device again, checking the code matches on both screens.";

  const longDay = (iso) => new Date(iso).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });

  const SET_UP = "Encryption is off. Set it up to lock everything the hub keeps; Mobile makes the key on this device, then each workshop confirms by safety code.";

  /** Settings' plain words for the account's encryption (GET /api/feed encryption) and which buttons it offers; phone: Set up, Stop requiring and Delete are the phone's (the hub refuses a desktop). Null from a hub that does not say. */
  function status(enc, { day = longDay, phone = false } = {}) {
    if (!enc || typeof enc !== "object") return null;
    const required = enc.state === "required";
    const ready = enc.ready?.ok === true;
    const missing = (Array.isArray(enc.ready?.missing) ? enc.ready.missing : []).filter((m) => m && typeof m.name === "string");
    const off = !required && enc.state !== "on";
    let line = off && phone ? SET_UP : "Encryption is off.";
    if (required) line = "Encryption is required: the hub refuses anything unencrypted.";
    else if (enc.state === "on") {
      line = "Encryption is on; the hub still accepts unencrypted writes until you require it.";
      if (!ready) line += missing.length ? ` Not ready to require yet: ${missing.map((m) => (m.why ? `${m.name} ${m.why}` : m.name)).join("; ")}.` : " Not ready to require yet.";
    }
    let held = null;
    // Off: nothing is held for deletion to act on, so no line and no button.
    if (!off && enc.held && typeof enc.held === "object") {
      const items = Number.isInteger(enc.held.items) && enc.held.items > 0 ? enc.held.items : 0;
      const since = typeof enc.held.since === "string" && !Number.isNaN(Date.parse(enc.held.since)) ? ` since ${day(enc.held.since)}` : "";
      const copies = `${items} unencrypted ${items === 1 ? "copy is" : "copies are"} held for deletion${since}`;
      // The hub's older single-account backup file (hub.json) also holds plaintext until this deletes it.
      if (items && enc.held.backup) held = `${copies}, with an older unencrypted backup file of the hub.`;
      else if (items) held = `${copies}.`;
      else if (enc.held.backup) held = "An older unencrypted backup file of the hub is held for deletion.";
    }
    return { state: required ? "required" : off ? "off" : "on", line, canRequire: enc.state === "on" && ready, canStop: required && phone, canSetUp: off && phone, held, canDelete: Boolean(held) && phone };
  }

  /** A required account's held plaintext (enc.held), in plain words: how many older copies the hub still holds and since when; null when none. */
  function older(enc, { day = longDay } = {}) {
    const held = enc && typeof enc.held === "object" ? enc.held : null;
    if (!held) return null;
    const items = Number.isInteger(held.items) && held.items > 0 ? held.items : 0;
    const since = typeof held.since === "string" && !Number.isNaN(Date.parse(held.since)) ? ` from before ${day(held.since)}` : "";
    const copies = items ? `${items} older ${items === 1 ? "copy" : "copies"}${since}` : "";
    if (copies && held.backup) return `The hub still holds ${copies}, and an older backup file.`;
    if (copies) return `The hub still holds ${copies}.`;
    return held.backup ? "The hub still holds an older backup file." : null;
  }

  /** The Fleet's line when no overlord shows because a computer is not approved yet (a required account takes nothing from it): what is left and where, so a tester does not read it as a failed pairing. feed: GET /api/feed; view: this phone's enrollment view, or null on the desktop. Null when no computer waits. */
  function fleetNote(feed, view = null) {
    if (feed?.encryption?.state !== "required") return null;
    if (view?.rekey) return { text: "This device's key isn't here, so nothing sealed can show: approve this device again from Mobile on another device.", phone: true };
    const keyless = (feed.workshops || []).filter((w) => w.holdsKey === false);
    // Devices carry no workshop id, only its name: the computer mid-request first, then one that is online.
    const requested = (w) => (view?.waiting || []).find((d) => d.kind === "workshop" && d.name === w.name);
    const shop = keyless.find(requested) || keyless.find((w) => w.online) || keyless[0];
    if (!shop) return null;
    const name = `"${shop.name}"`;
    const device = requested(shop);
    if (device?.state === "keyed") return { text: `${device.mineToConfirm ? "You tapped They match here. " : ""}To finish, click They match in Golemworks on ${name}: its overlord and golems show here after that.`, phone: false };
    if (device && device.id === view.next?.id) return { text: `${name} asks to join your account: approve it here to see its overlord and golems.`, phone: true };
    if (device) return { text: `${name} is being approved from your other device. Finish there, then click They match in Golemworks on ${name}.`, phone: false };
    return { text: `${name} isn't approved yet, so nothing from it shows here. Open Golemworks on that computer and approve it there (Settings > Account); Mobile then asks you to check the code.`, phone: false };
  }

  return { create, mount, showCode, localMemo, status, seen, older, fleetNote, START_OVER };
});
