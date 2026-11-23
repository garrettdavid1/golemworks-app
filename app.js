"use strict";
// Golemworks Mobile: Fleet (home, with what needs you on top) and Settings over the hub's API; answers asks and messages any golem.
(() => {
  // A static host cannot send frame-ancestors, so the page refuses to run inside another page's frame itself.
  if (window.top !== window.self) return document.documentElement.replaceChildren();
  const POLL_MS = 10000;
  // The desktop app's Settings > Account loads this page with ?surface=desktop: the account settings only, and each security change takes its own passkey check.
  const DESKTOP = new URLSearchParams(location.search).get("surface") === "desktop";
  if (DESKTOP) document.documentElement.dataset.surface = "desktop";
  // The desktop's door value (#door=, from golemd): which account this computer's sign-in and first passkey are for; kept for this tab, gone from the address.
  const DOOR = DESKTOP ? keptDoor() : null;
  function keptDoor() {
    const given = new URLSearchParams(location.hash.replace(/^#/, "")).get("door");
    if (given) history.replaceState(null, "", `${location.pathname}${location.search}`);
    try {
      if (given) sessionStorage.setItem("gw-door", given);
      return given || sessionStorage.getItem("gw-door");
    } catch {
      return given;
    }
  }
  const door = DOOR ? { door: DOOR } : {};
  // The hub's API: on the app's own host, the build names it (scripts/app-manifest.js); served by the hub itself, this origin.
  const HUB = document.querySelector('meta[name="golemworks-hub"]')?.content || "";
  const CREDENTIALS = HUB ? "include" : "same-origin";
  const MAC = /Mac/.test(navigator.userAgent);
  // What the passkey check is called where this page runs.
  const CHECK = DESKTOP ? (MAC ? "Touch ID" : "Windows Hello") : "Face ID";
  const STATE_LABEL = { working: "Working", idle: "Idle", blocked: "Needs you", done: "Done", waiting: "Waiting", queued: "Queued", listening: "Listening", exited: "Exited", parked: "Parked", resuming: "Resuming", unknown: "Unknown" };
  const main = document.getElementById("main");
  const title = document.getElementById("title");
  const conn = document.getElementById("conn");
  const tabs = document.getElementById("tabs");
  const sheet = document.getElementById("sheet");
  const badge = document.getElementById("fleet-badge");
  const toastNode = document.getElementById("toast");
  const bannerNode = document.getElementById("encryption-banner");

  let me = null;
  let feed = null;
  let screen = "fleet";
  let pollTimer = null;
  let sheetGolem = null; // the golem whose sheet is open
  let sheetFocus = null; // the said id a push opened the sheet on: shown even when older than the last five
  let pairing = null; // { code, expiresAt, before } shown on Settings; before: the workshop ids when it was made
  let workshops = null; // with createdAt, for Workshops list
  let link = null; // the workshop link: on, and each workshop's work limits (GET /api/link)
  let securityLog = null; // approvals and resumes sent from a phone (Settings > Approvals from Mobile)
  let passkeys = null;
  let services = null; // deployed apps that file tasks with their own token (GET /api/services)
  let operator = null; // the hub operator's counts and sign-up links (GET /api/operator), on the operator's phone only
  let signupLink = null; // { id, url, expiresAt, copied }: copied true once the clipboard took it; the last sign-up link made here, shown until it expires or is revoked
  let downloads = null; // { installable: { windows, mac }, commands }: install commands (GET /api/downloads), never their tokens
  let installCommand = null; // { id, windows, mac, expiresAt }: the last install command shown here, until it expires or is revoked
  let invite = null; // { url, expiresAt, copied }: copied true once the clipboard took it; the last invite link made here, shown until it expires
  let toastTimer = null;
  let golemsStarted = false;
  let dragging = false; // an overlord being dragged to a new rank
  let subscribed = null; // this phone's push subscription: null not checked yet, then true or false
  let doneOpen = false; // the Golems list's Done group, opened by David
  let boardView = "active"; // which of the desktop Board's views Golems shows: active, standby or completed
  let focus = null; // { key, sheet } from a push's link: the golem card to bring into view, or its sheet to open
  let bannerLater = false; // the encryption banner's Later: hidden until the page reloads
  let toEncryption = false; // the banner's button: Settings opens at Encryption with the current step's sheet
  const filters = { workshop: "", workspace: "" };
  const drafts = new Map(); // ask key -> { text, option }: survives the 10-second re-render
  const sending = new Set(); // ask keys with an answer in flight
  const MAX_SAY = 2000;

  // ---------- helpers ----------

  let toastExpire = null; // what an action toast does when it goes unanswered
  /** What a tap just did, for a few seconds above the tab bar; errors stay a little longer. An action adds one button. */
  function toast(text, error = false, action = null) {
    const expire = toastExpire;
    toastExpire = null;
    expire?.(); // a new toast replaces an unanswered action
    toastNode.replaceChildren(text);
    if (action) {
      toastExpire = action.onExpire || null;
      toastNode.append(h("button", { type: "button", class: "small toast-action", onclick: () => {
        toastExpire = null;
        clearTimeout(toastTimer);
        toastNode.hidden = true;
        action.run();
      } }, action.label));
    }
    toastNode.classList.toggle("error", error);
    toastNode.classList.toggle("bare", tabs.hidden);
    toastNode.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastNode.hidden = true;
      const left = toastExpire;
      toastExpire = null;
      left?.();
    }, action?.ms || (error ? 6000 : 3500));
  }

  function h(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (key === "text") node.textContent = value;
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of [].concat(children)) if (child !== null && child !== undefined && child !== false) node.append(child.nodeType ? child : String(child));
    return node;
  }

  // public/claude-account.js
  const metaLine = (parts, account) => ClaudeAccount.meta(h, parts, account);

  // Sealed records from keyed workshops (public/sealed.js): opened here with this device's keys, never by the hub.
  const sealed = typeof GolemworksSealed !== "undefined" && typeof GolemworksE2E !== "undefined" ? GolemworksSealed.create({ E: GolemworksE2E, loadKeys: () => GolemworksE2E.phoneKeyStore().load(), storage: localStorage }) : null;
  const opened = (what, ...args) => (sealed ? sealed[what](...args) : args.at(-1));

  async function api(method, path, body) {
    const response = await fetch(HUB + path, {
      method,
      credentials: CREDENTIALS,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    // confirm: on a desktop, the change a 428 wants its own passkey check for.
    if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status, confirm: data.confirm || null });
    return data;
  }

  // ---------- attachments ----------

  const MAX_FILES = 10;
  // The hub takes 25 MB a file; a sealed file is up to a few KB larger (its stream's tags and padding).
  const MAX_FILE_BYTES = 25 * 1024 * 1024 - 64 * 1024;
  const attached = new Map(); // draft key -> [{ file, id, url }]: picked for the next send (id once uploaded); survives re-renders
  const sizeText = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  /** A golem in a names-only workspace takes no attachments from the phone. */
  const namesOnly = (workshopId, golemId) => Boolean(feed?.workshops.find((w) => w.id === workshopId)?.golems.find((g) => g.id === golemId)?.namesOnly);

  /** Attach (iOS offers Photo Library, Take Photo or Choose File) and the picked files as chips, each removable; plus: a round + for a chat's composer row, returned apart as { button, bar }. */
  function attachBar(key, { disabled = false, plus = false } = {}) {
    const count = h("span", { class: "item-foot" });
    const chips = h("ul", { class: "attached", "aria-label": "Attachments" });
    const draw = () => {
      const list = attached.get(key) || [];
      chips.replaceChildren(...list.map((a) => h("li", { class: "chip" }, [
        a.url ? h("img", { src: a.url, alt: "" }) : h("span", { class: "chip-icon", "aria-hidden": "true" }, fileIcon()),
        h("span", { class: "chip-name" }, a.file.name),
        h("span", { class: "chip-size" }, sizeText(a.file.size)),
        h("button", { type: "button", class: "chip-remove", disabled, "aria-label": `Remove ${a.file.name}`, onclick: () => (dropAttachment(key, a), draw()) }, "×"),
      ])));
      chips.hidden = !list.length;
      count.textContent = list.length ? `${list.length} of ${MAX_FILES}, 25 MB each at most` : "";
    };
    const input = h("input", { type: "file", multiple: true, hidden: true, onchange: () => {
      const list = [...(attached.get(key) || [])];
      for (const file of input.files) {
        if (list.length >= MAX_FILES) {
          toast(`At most ${MAX_FILES} attachments a message`, true);
          break;
        }
        if (!file.size) toast(`${file.name} is empty`, true);
        else if (file.size > MAX_FILE_BYTES) toast(`${file.name} is over 25 MB`, true);
        else list.push({ file, id: null, url: file.type.startsWith("image/") ? URL.createObjectURL(file) : null });
      }
      input.value = "";
      attached.set(key, list);
      draw();
    } });
    draw();
    if (plus) {
      const button = h("button", { type: "button", class: "chat-plus", disabled, "aria-label": "Attach photos or files", onclick: () => input.click() }, plusIcon());
      return { button, bar: h("div", { class: "attach-bar" }, [chips, count, input]) };
    }
    const button = h("button", { type: "button", class: "small attach", disabled, "aria-label": "Attach photos or files", onclick: () => input.click() }, [clipIcon(), "Attach"]);
    return h("div", { class: "attach-bar" }, [h("div", { class: "attach-row" }, [button, count]), input, chips]);
  }

  const svg = (paths) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    node.setAttribute("viewBox", "0 0 24 24");
    node.setAttribute("aria-hidden", "true");
    node.setAttribute("class", "attach-icon");
    for (const d of paths) {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", d);
      node.append(p);
    }
    return node;
  };
  const clipIcon = () => svg(["M20 11.5 12.6 19a5 5 0 0 1-7.1-7.1L13.3 4a3.3 3.3 0 0 1 4.7 4.7l-7.8 7.8a1.6 1.6 0 0 1-2.3-2.3L15 7"]);
  const fileIcon = () => svg(["M7 3h7l4 4v14H7z", "M14 3v4h4"]);
  const plusIcon = () => svg(["M12 5v14", "M5 12h14"]);

  /** A chip removed: an upload the hub holds for it is deleted there too. */
  function dropAttachment(key, a) {
    attached.set(key, (attached.get(key) || []).filter((x) => x !== a));
    if (a.url) URL.revokeObjectURL(a.url);
    if (a.id) api("DELETE", `/api/attachments/${encodeURIComponent(a.id)}`).catch(() => {});
  }

  function clearAttached(key) {
    for (const a of attached.get(key) || []) if (a.url) URL.revokeObjectURL(a.url);
    attached.delete(key);
  }

  // ---------- encrypted actions (public/acts.js) ----------

  // Once this phone holds the account key, answers, messages and files go sealed for their workshop, and replies, relays and the log open here.
  let actsMade = null;
  async function sealer() {
    if (typeof Acts === "undefined" || typeof GolemworksE2E === "undefined") return null;
    actsMade ||= GolemworksE2E.init().then((E) => Acts.create({ E, store: E.phoneKeyStore(), account: () => api("GET", "/api/devices"), memo: Acts.localMemo(localStorage) }));
    // Null only while this device holds no account key; after that a send seals or fails, never goes plain.
    return (await actsMade).sealing();
  }

  /** The sealer for showing what the hub keeps: none when it cannot be had, so sealed items show as unopened. */
  const openerOrNull = () => sealer().then((acts) => acts || null, () => null);

  /** The sealer for an act to one workshop: none for a workshop that holds no account key yet (Acts.plainFor), else as sealer(). */
  async function sealerFor(workshopId) {
    const acts = await sealer();
    if (!acts) return null;
    const everSealed = Boolean((sealed && sealed.wasSealed(workshopId)) || taskReader?.sticky(acts.accountId()));
    return Acts.plainFor(feed, workshopId, { everSealed }) ? null : acts;
  }

  /** A sealed answer or message: what it says, the golem and each file's name, type and ref go inside; the hub sees ids alone. */
  function sealedBody(acts, workshopId, kind, inner, key, ids) {
    const id = acts.uuid();
    const files = (attached.get(key) || []).map((a) => ({ id: a.id, ref: a.ref, name: a.file.name, type: a.file.type || "application/octet-stream" }));
    const sealed = acts.seal(workshopId, kind, id, { ...inner, files });
    return { id, golemId: inner.golemId, sealed, ...(ids.length ? { attachments: ids } : {}) };
  }

  /** Uploads what is not up yet, one file at a time (sealed: encrypted here first); returns every id for the send. Runs inside withFaceId, after the check. */
  async function uploadAttached(key, workshopId, acts = null) {
    const list = attached.get(key) || [];
    for (const a of list) {
      // An upload made before this phone could seal goes up again, sealed.
      if (a.id && (!acts || a.ref)) continue;
      const sealedFile = acts ? acts.sealFile(workshopId, new Uint8Array(await a.file.arrayBuffer())) : null;
      const response = await fetch(`${HUB}/api/attachments/${encodeURIComponent(workshopId)}`, {
        method: "POST",
        credentials: CREDENTIALS,
        headers: sealedFile ? { "Content-Type": "application/octet-stream", "X-File-Name": "sealed" } : { "Content-Type": a.file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(a.file.name) },
        body: sealedFile ? sealedFile.blob : a.file,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(data.error || `${a.file.name}: HTTP ${response.status}`), { status: response.status });
      a.id = data.id;
      a.ref = sealedFile?.ref || null;
    }
    return list.map((a) => a.id);
  }

  /** A send that failed because the hub no longer holds an upload: those go up again next time. */
  function forgetUploads(key, error) {
    if (/attachment is gone/.test(error.message)) for (const a of attached.get(key) || []) a.id = null;
  }

  // ---------- attachments David sent, kept on this phone ----------

  // The hub deletes a file once golemd has it, so the phone that sent it keeps the copy David can open again.
  const KEPT_MS = 30 * 24 * 60 * 60 * 1000;
  let keptDb = null;
  const kept = new Map(); // "<said id>:<n>" -> { name, type, url } once read this session
  function openKept() {
    keptDb ||= new Promise((resolve) => {
      try {
        const request = indexedDB.open("golemworks-sent", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("files");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return keptDb;
  }
  const done = (request) => new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });

  /** After a send: each file under its said id and place, for 30 days. Storage refused (a private window) keeps nothing. */
  async function keepSent(saidId, list) {
    if (!saidId || !list?.length) return;
    const db = await openKept();
    if (!db) return;
    try {
      // Bytes, not the File: some WebKit builds refuse a Blob in IndexedDB. Read first, since a transaction ends at an await.
      const files = await Promise.all(list.map(async (a) => ({ name: a.file.name, type: a.file.type || "", bytes: await a.file.arrayBuffer(), at: Date.now() })));
      const store = db.transaction("files", "readwrite").objectStore("files");
      files.forEach((file, i) => store.put(file, `${saidId}:${i}`));
    } catch {}
  }

  async function keptFile(key) {
    if (kept.has(key)) return kept.get(key);
    const db = await openKept();
    let entry = null;
    try {
      entry = db && (await done(db.transaction("files").objectStore("files").get(key)));
    } catch {}
    const file = entry?.bytes ? { name: entry.name, type: entry.type, url: URL.createObjectURL(new Blob([entry.bytes], { type: entry.type })) } : null;
    kept.set(key, file);
    return file;
  }

  /** Copies past 30 days go, once a session. */
  async function pruneKept() {
    const db = await openKept();
    if (!db) return;
    try {
      const cursor = db.transaction("files", "readwrite").objectStore("files").openCursor();
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at) return;
        if (!(at.value?.at > Date.now() - KEPT_MS)) at.delete();
        at.continue();
      };
    } catch {}
  }

  /** A said entry's files as chips: a thumbnail or file icon to tap when this phone kept it, its name only when not. */
  function sentFiles(s) {
    return h("ul", { class: "attached sent", "aria-label": "Attachments you sent" }, s.files.map((name, i) => {
      const key = `${s.id}:${i}`;
      const icon = h("span", { class: "chip-icon", "aria-hidden": "true" }, fileIcon());
      const chip = h("button", { type: "button", class: "chip sent-file", disabled: true, title: "Kept only on the device that sent it", "aria-label": `${name} (kept only on the device that sent it)` }, [icon, h("span", { class: "chip-name" }, name)]);
      keptFile(key).then((file) => {
        if (!file) return;
        chip.disabled = false;
        chip.removeAttribute("title");
        chip.setAttribute("aria-label", `Open ${name}`);
        if (file.type.startsWith("image/")) icon.replaceWith(h("img", { src: file.url, alt: "" }));
        chip.onclick = () => showFile(file);
      });
      return h("li", {}, chip);
    }));
  }

  /** A photo full screen (tap or Close to go back); any other file opens as the phone opens a download. */
  function showFile(file) {
    if (!file.type.startsWith("image/")) {
      const link = h("a", { href: file.url, download: file.name, target: "_blank", rel: "noopener" });
      document.body.append(link);
      link.click();
      link.remove();
      return;
    }
    const close = () => viewer.remove();
    const viewer = h("div", { class: "viewer", role: "dialog", "aria-modal": "true", "aria-label": file.name, onclick: (e) => e.target === viewer && close() }, [
      h("img", { src: file.url, alt: file.name }),
      h("div", { class: "viewer-bar" }, [h("span", { class: "viewer-name" }, file.name), h("button", { type: "button", class: "small", onclick: close }, "Close")]),
    ]);
    document.getElementById("app").append(viewer);
    viewer.querySelector("button").focus({ preventScroll: true });
  }

  // ---------- Face ID for answers, messages and security changes ----------

  // A confirm challenge fetched ahead, so the Face ID prompt opens inside the tap: Safari opens one only from a tap.
  const TICKET_MS = 4 * 60 * 1000;
  let freshUntil = 0;
  let ticket = null; // { options, challengeId, at }

  let preparing = null; // the challenge fetch in flight: a resume and a poll at once share it
  function prepareConfirm() {
    if (ticket && Date.now() - ticket.at < TICKET_MS) return Promise.resolve();
    preparing ||= api("POST", "/api/auth/confirm/options")
      .then((out) => (ticket = { ...out, at: Date.now() }))
      .catch(() => (ticket = null))
      .finally(() => (preparing = null));
    return preparing;
  }

  /** Runs send() after one Face ID check when the last one is older than 5 minutes. Call it before any await in a tap handler. */
  async function withFaceId(send) {
    if (me?.strict) return withCheckFor(send);
    if (Date.now() < freshUntil - 15000) {
      try {
        return await send();
      } catch (error) {
        if (error.status !== 428) throw error;
        freshUntil = 0;
      }
    }
    try {
      return await checkThenSend(send);
    } catch (error) {
      if (!error.faceId) throw error;
      return retryFaceId(send, error);
    }
  }

  /** A desktop: send(), and when the hub wants a check for this change (a 428 naming it), one passkey check for that change, then send() again. */
  async function withCheckFor(send) {
    try {
      return await send();
    } catch (error) {
      if (error.status !== 428 || !error.confirm) throw error;
      try {
        return await checkThenSend(send, error.confirm);
      } catch (failed) {
        if (!failed.faceId) throw failed;
        return retryFaceId(send, failed, error.confirm);
      }
    }
  }

  /** One passkey check (for the change `key` names, on a desktop), then send(). A check the device refuses (it never reaches the hub) throws with faceId set and the browser's reason. */
  async function checkThenSend(send, key = null) {
    const held = ticket && Date.now() - ticket.at < TICKET_MS ? ticket : null;
    ticket = null;
    const { options, challengeId } = held || (await api("POST", "/api/auth/confirm/options"));
    let response;
    const began = Date.now();
    try {
      response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });
    } catch (error) {
      prepareConfirm();
      const cause = error.cause || error;
      const why = { name: cause.name || error.name || "Error", code: error.code && error.code !== "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY" ? error.code : null, message: String(cause.message || error.message || "").slice(0, 200) };
      api("POST", "/api/auth/confirm/failed", why).catch(() => {});
      throw Object.assign(new Error(`${CHECK} did not go through (${why.name}${why.message ? `: ${why.message}` : ""}). Nothing was sent.`), { faceId: true });
    }
    // took: how long the sheet was up, so the hub logs a check iOS refused once and then let through.
    const out = await api("POST", "/api/auth/confirm/verify", { challengeId, response, took: Date.now() - began, ...(key ? { for: key } : {}) });
    freshUntil = Date.parse(out.freshUntil) || 0;
    prepareConfirm();
    return send();
  }

  const RETRY_MS = 30000;
  /** A refused check waits here for "Try Face ID again": a new tap, so Safari opens the passkey sheet, with a fresh challenge. */
  function retryFaceId(send, failed, key = null) {
    return new Promise((resolve, reject) => {
      const giveUp = () => reject(new Error(`${CHECK} did not go through; nothing was sent`));
      toast(failed.message, true, { label: `Try ${CHECK} again`, ms: RETRY_MS, onExpire: giveUp, run: () => {
        checkThenSend(send, key).then(resolve, (error) => (error.faceId ? retryFaceId(send, error, key).then(resolve, reject) : reject(error)));
      } });
    });
  }

  function ago(iso) {
    if (!iso) return "";
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  const pill = (state, g = null) => h("span", { class: "pill", "data-state": state }, [h("span", { class: "dot", "data-state": state }), stateLabel(state, g)]);
  // Only an overlord's blocked reads "Needs you": a golem's need is its overlord's to handle first.
  const stateLabel = (state, g) => (state === "blocked" && g && g.type !== "overlord" ? "Blocked" : STATE_LABEL[state] || state);

  // ---------- data ----------

  async function load() {
    try {
      const next = await opened("feed", await api("GET", "/api/feed"));
      // Launch, done and close motions come from comparing the fleet before and after, as on the desktop Board.
      if (hasGolems()) Golems.observe(allPanes(feed), allPanes(next), { wasLoaded: Boolean(feed), onBoard: () => true, order: (panes) => panes });
      feed = next;
      pruneAskMarks();
      // Seen sealed with the key held: from now on this phone sends tasks only sealed and trusts no plaintext list.
      if (feed?.encryption?.tasksSealed && taskReader && !taskReader.sticky(myAccount())) sealer().then((acts) => acts && taskReader.markSealed(acts.accountId()), () => {});
      // A Stop requiring sealed by a device holding the key (never the hub's own word) lets plaintext tasks back in.
      else if (feed?.encryption?.stop && !feed.encryption.tasksSealed && taskReader?.sticky(myAccount())) sealer().then((acts) => acts && taskReader.acceptStop(acts, feed.encryption.stop) && (loadTasks(), loadWaiting()), () => {});
      conn.textContent = "";
      conn.dataset.state = "";
      prepareConfirm();
    } catch (error) {
      if (error.status === 401) return start();
      conn.textContent = "Offline";
      conn.dataset.state = "error";
    }
    quietRender();
    refreshSaid();
    refreshQuiet().catch(() => {});
    landOnAsk();
    if (screen === "artifacts") loadArtifacts();
    if (screen === "tasks") loadTasks();
    if (screen === "waiting") loadWaiting();
  }

  /** A render nobody asked for (a poll, a motion ending): skipped mid-drag or while a picker is open, so neither is torn away. */
  function quietRender() {
    // The Artifacts search box too: a rebuilt page would drop the keyboard mid-word.
    if (dragging || (main.contains(document.activeElement) && (["SELECT", "TEXTAREA"].includes(document.activeElement.tagName) || document.activeElement === artifactSearch))) return;
    // A link selected to copy (sign-up, invite, install command): a rebuild would drop it before Copy; held for at most a minute.
    if (linkSelected()) {
      linkHeldAt ||= Date.now();
      if (Date.now() - linkHeldAt < 60000) return void (renderAfterSelect = true);
    }
    linkHeldAt = 0;
    // A finger down: rebuilding the page under it would swallow the tap (iOS fires no click on a replaced button), so it waits.
    if (touching && Date.now() - touchAt < 2000) return void (renderAfterTouch = true);
    render();
  }
  /** True while the page's selection sits in a shown link (.invite-url); other selected text never holds a render. */
  function linkSelected() {
    const selected = getSelection();
    if (!selected || selected.isCollapsed) return false;
    const node = selected.anchorNode;
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    return Boolean(el?.closest(".invite-url") && main.contains(el));
  }
  let linkHeldAt = 0;
  let renderAfterSelect = false;
  // The held link let go of: the render it held runs now, not at the next poll.
  document.addEventListener("selectionchange", () => {
    if (!renderAfterSelect || linkSelected()) return;
    renderAfterSelect = false;
    quietRender();
  });
  let touching = false;
  let touchAt = 0; // a touch with no lift (the app left mid-touch) stops holding renders after 2 seconds
  let renderAfterTouch = false;
  addEventListener("pointerdown", () => ((touching = true), (touchAt = Date.now())), true);
  for (const type of ["pointerup", "pointercancel"]) addEventListener(type, () => {
    touching = false;
    if (!renderAfterTouch) return;
    renderAfterTouch = false;
    // After the click the lift makes.
    setTimeout(quietRender, 350);
  }, true);

  function schedule() {
    clearTimeout(pollTimer);
    if (document.visibilityState === "visible") pollTimer = setTimeout(async () => {
      await load();
      // A device step whose live event was missed (the page asleep, the stream reconnecting) still shows within one poll.
      enroll?.refresh();
      schedule();
    }, POLL_MS);
  }

  // ---------- screens ----------

  function render() {
    if (!me?.signedIn) return;
    const needing = needCount();
    badge.hidden = !needing;
    badge.textContent = String(needing);
    badge.setAttribute("aria-label", `${needing} need${needing === 1 ? "s" : ""} you`);
    for (const a of tabs.querySelectorAll("a")) {
      if (a.dataset.screen === screen) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    title.textContent = DESKTOP ? "Account" : { fleet: "Fleet", overlords: "Settings", artifacts: "Artifacts", tasks: "Tasks", waiting: "Waiting on you" }[screen];
    const view = { fleet: fleetView, overlords: overlordsView, artifacts: artifactsView, tasks: tasksView, waiting: waitingView }[screen]();
    main.replaceChildren(...[].concat(view));
    // Cards scrolled out of view stand still, as on the desktop.
    const board = document.getElementById("board");
    if (board && hasGolems()) Golems.watchBoard(board);
    if (screen === "fleet" && feed) showFocus();
    showBanner();
  }

  /** The banner while anything is unencrypted (public/encryption-guide.js): its button opens Settings at Encryption; Later hides it until the page reloads. */
  function showBanner() {
    const said = !bannerLater && typeof EncryptionGuide !== "undefined" ? EncryptionGuide.banner(feed?.encryption, enroll?.view(), { desktop: DESKTOP, screen }) : null;
    const key = said ? `${said.title}|${said.action}` : "";
    bannerNode.hidden = !said;
    // Rebuilt only when it says something new, so a poll never swaps a button under a finger.
    if (bannerNode.dataset.key === key) return;
    bannerNode.dataset.key = key;
    bannerNode.replaceChildren(...(said ? [
      h("div", { class: "grow" }, [h("strong", {}, said.title), h("span", { class: "note" }, said.detail)]),
      h("div", { class: "row" }, [h("button", { type: "button", class: "small", onclick: () => ((bannerLater = true), showBanner()) }, "Later"), h("button", { type: "button", class: "small primary", onclick: () => openEncryption(said.href) }, said.action)]),
    ] : []));
  }

  function openEncryption(href) {
    toEncryption = true;
    if (location.hash === href) route();
    else location.hash = href;
  }

  // golems.js declares Golems with const, so it is a page-wide name but not a property of window.
  const hasGolems = () => typeof Golems !== "undefined";

  /** The golem the desktop draws, on a phone card or ask: Golems (vendor/golemworks/golems.js) adds it and its motion. */
  function withGolem(node, pane, ghost = false) {
    if (!hasGolems()) return node;
    return Golems.decorate(node, pane, { ghost });
  }

  const golemOf = (workshopId, golemId) => feed?.workshops.find((w) => w.id === workshopId)?.golems.find((g) => g.id === golemId) || null;
  const paneKey = (workshopId, golemId) => `${workshopId}/${golemId}`;

  function askItem(ask) {
    const golem = golemOf(ask.workshopId, ask.golemId);
    const node = askBody(ask);
    return withGolem(node, { name: `ask-${paneKey(ask.workshopId, ask.golemId || ask.id)}`, role: golem?.type === "overlord" ? "orchestrator" : undefined, state: ask.kind === "gate" ? "waiting" : "blocked" });
  }

  /** Text with its https links tappable; anything else stays text. */
  function linked(text) {
    const out = [];
    let at = 0;
    for (const match of String(text || "").matchAll(/https:\/\/[^\s<>"']+/g)) {
      const url = match[0].replace(/[.,;:!?)\]]+$/, "");
      out.push(text.slice(at, match.index), h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, url));
      at = match.index + url.length;
    }
    out.push(String(text || "").slice(at));
    return out.filter((part) => part !== "");
  }

  const where = (ask) => (ask.workspace ? `${ask.workspace} · ` : "");

  // Each kind of needs-you: its label, and one line on what an answer does (the phone answers every one of them).
  const KIND = {
    permission: ["Permission", "Pick what the desktop would: Yes runs it. A reply alone says No and tells the golem why."],
    plan: ["Plan", "Pick how to go on, or reply to keep it planning with your note."],
    question: ["Question", "Pick an answer, add words if you like, and Send: they go in together as the answer."],
    dialog: ["Dialog", "Pick an option, or reply to cancel it and say why."],
    gate: ["Gate", "Approve moves the flow on. Hold sends it back with your note. A reply alone asks the golem without deciding."],
    stopped: ["Stopped", "Resume starts the Orchestrator's session again, as the desktop's Resume does. Words sent with it wait until it is back."],
    flag: ["Needs you", "Reply, or tell it you'll do it at the PC."],
    ask: ["Question", "Pick an answer or reply."],
    status: ["Needs you", "Reply, or tell it you'll do it at the PC."],
    unknown: ["Needs you", "Reply, and it reaches the golem as your message."],
  };
  const AT_PC = "I'll do this at the PC; carry on with anything that doesn't need me.";

  /** A dialog's own text: a few lines, the rest behind Show all. */
  function detailBlock(text) {
    const lines = String(text).split("\n");
    const long = lines.length > 6 || text.length > 320;
    const pre = h("pre", { class: "item-detail" + (long ? " clipped" : "") }, text);
    if (!long) return pre;
    const more = h("button", { type: "button", class: "small show-all", onclick: () => {
      const open = pre.classList.toggle("clipped");
      more.textContent = open ? "Show all" : "Show less";
    } }, "Show all");
    return h("div", { class: "detail-wrap" }, [pre, more]);
  }

  /** Why a need is not answerable here while its workshop is connected but not updating. */
  const staleNote = (x) => `Not updating: last heard from ${x.workshop} ${ago(x.receivedAt)}; ${x.stale}. It may already be answered; check on the desktop.`;

  function askBody(ask) {
    const key = `${ask.workshopId}:${ask.id}`;
    // A workshop that is connected but not sending: this need is as of its last summary and may already be answered.
    const answerable = !ask.answeredAt && ask.online !== false && !ask.stale && (ask.options?.length || ask.reply);
    const [label, kindDoes] = KIND[ask.kind] || KIND.unknown;
    // A question with no options to pick takes words only; its why says so.
    const questions = answerable && ask.reply ? AskContext.menu(ask) : null;
    const does = ask.kind === "question" && !ask.options?.length && !questions ? "Answer in your own words." : kindDoes;
    // A gate waits on a yes, not on trouble: amber, not red.
    const state = ask.kind === "gate" ? "waiting" : "blocked";
    const subject = ask.golemType === "overlord" ? `${ask.golem} · overlord` : ask.golem;
    const context = AskContext.of(ask);
    return h("article", { class: `item ask ${state === "blocked" ? "attention " : ""}kind-${ask.kind || "unknown"}`, "data-state": state, "data-ask": ask.id }, [
      h("div", { class: "item-head" }, [h("span", { class: `kind ask ${ask.kind === "gate" ? "gate" : ""}` }, ask.answeredAt ? "Answered" : label), h("span", { class: "who" }, subject || ask.overlord), h("span", {}, ago(ask.at))]),
      h("div", { class: "item-text" }, linked(ask.question)),
      AskContext.about(h, context.about),
      ask.detail && !questions ? detailBlock(ask.detail) : null,
      ask.context ? h("div", { class: "item-context" }, ["Its status: ", ...linked(ask.context)]) : null,
      answerable ? h("div", { class: "item-does" }, does) : null,
      ask.why && !ask.answeredAt && !questions ? h("div", { class: "item-why" }, ask.why) : null,
      answerable ? answerForm(ask, key, context) : ask.options?.length ? h("div", { class: "item-options" }, context.options.map((o) => h("span", { class: "option" }, o.label))) : null,
      ...(answerable ? [] : AskContext.after(h, context)),
      answerable ? null : h("div", { class: "item-foot" }, `${where(ask)}${ask.answeredAt ? `You answered${ask.answer ? ` "${ask.answer}"` : ""} ${ago(ask.answeredAt)}; waiting for the golem` : ask.online === false ? "Workshop offline" : ask.stale ? staleNote(ask) : ask.why ? "" : "Nothing to answer here"}`),
    ]);
  }

  /** Golems paused on the desktop: why, by whom, and Unpause (Face ID, like the desktop toggle). */
  function pausedItem(w) {
    const p = w.paused;
    return h("article", { class: "item ask attention kind-paused", "data-state": "waiting" }, [
      h("div", { class: "item-head" }, [h("span", { class: "kind ask gate" }, "Paused"), h("span", { class: "who" }, `All golems on ${w.name}`), p.since ? h("span", {}, ago(p.since)) : null]),
      h("div", { class: "item-text" }, `Paused${p.by ? ` by ${p.by}` : ""}: ${p.reason || "no reason given"}`),
      h("div", { class: "item-does" }, "Unpause lets every golem go on and sends what was held, as the desktop's Unpause does."),
      w.online === false ? h("div", { class: "item-foot" }, "Workshop offline") : h("div", { class: "answer-foot" }, [h("button", { type: "button", class: "primary small", onclick: async (e) => {
        e.target.disabled = true;
        try {
          const out = await withFaceId(async () => {
            const acts = await sealerFor(w.id);
            const id = acts?.uuid();
            const body = acts ? { id, sealed: acts.seal(w.id, "unpause", id, { since: p.since || null }) } : { since: p.since || null };
            return api("POST", `/api/workshops/${encodeURIComponent(w.id)}/unpause`, body);
          });
          toast(out.unconfirmed ? "Sent; the workshop has not confirmed it yet" : `Unpaused ${w.name}`);
        } catch (error) {
          toast(error.message, true);
        }
        await load();
      } }, "Unpause")]),
    ]);
  }

  async function snooze(ask, hours) {
    try {
      await api("POST", `/api/asks/${encodeURIComponent(ask.workshopId)}/${encodeURIComponent(ask.id)}/snooze`, { hours });
      toast(`Snoozed ${ask.golem} for ${hours} hours`);
    } catch (error) {
      toast(error.message, true);
    }
    await load();
  }

  /** What a reply box asks for, by the kind of need. */
  const replyPlaceholder = (ask) => (ask.kind === "gate" ? "A note (Hold needs one)" : ask.kind === "permission" ? "Why not (a reply alone says No)" : ask.kind === "question" ? (AskContext.menu(ask) ? "Words to send with your picks, or your own answer" : ask.options?.length ? "Words to send with your pick, or your own answer" : "Your answer, in your words") : ask.kind === "stopped" ? "A message for when it is back (optional)" : ask.options?.length ? "Write a reply, or a note with your pick" : "Write a reply");
  /** A need the phone can answer now: not answered, its workshop online and updating, and options or a reply to give. */
  const canAnswer = (ask) => Boolean(!ask.answeredAt && ask.online !== false && !ask.stale && (ask.options?.length || ask.reply));
  /** Why a need cannot be answered here, for its foot line. */
  const answerFoot = (ask) => `${where(ask)}${ask.answeredAt ? `You answered${ask.answer ? ` "${ask.answer}"` : ""} ${ago(ask.answeredAt)}; waiting for the golem` : ask.online === false ? "Workshop offline" : ask.stale ? staleNote(ask) : ask.why ? "" : "Nothing to answer here"}`;

  /** A need in the Orchestrator's chat it cannot answer now (answered and waiting for the golem, offline, not updating): compact, in the chat's style, over the message row. An answerable one leads instead (askFirstCard). */
  function chatNeed(ask) {
    const [label] = KIND[ask.kind] || KIND.unknown;
    return h("div", { class: `chat-need${ask.kind === "gate" ? " gate" : ""}`, "data-ask": ask.id, role: "group", "aria-label": `${label}: ${ask.question}` }, [
      h("div", { class: "chat-need-head" }, [h("span", { class: `kind ask${ask.kind === "gate" ? " gate" : ""}` }, ask.answeredAt ? "Answered" : label), h("span", { class: "chat-need-text" }, linked(ask.question)), h("time", { datetime: ask.at }, ago(ask.at))]),
      AskContext.about(h, AskContext.of(ask).about),
      ask.detail ? detailBlock(ask.detail) : null,
      ask.why && !ask.answeredAt && !AskContext.menu(ask) ? h("div", { class: "chat-need-why" }, ask.why) : null,
      answerFoot(ask) ? h("div", { class: "item-foot" }, answerFoot(ask)) : null,
    ]);
  }

  /** The Orchestrator's question over its chat, the conversation dimmed behind it (G-110): an option (with the row's words as its note), words from the row, or Not now; count: how many lead; form, rowKey: the message row. */
  function askFirstCard(ask, g, { count, form, rowKey }) {
    const askKey = askKeyOf(ask);
    const [label, kindDoes] = KIND[ask.kind] || KIND.unknown;
    const questions = ask.reply ? AskContext.menu(ask) : null;
    const does = ask.kind === "question" && !ask.options?.length && !questions ? "Answer in your own words below." : kindDoes;
    const busy = sending.has(askKey);
    const of = AskFirst.position(count);
    const context = AskContext.of(ask);
    // A question's option or ticks are chosen here and go with the row's Send, its words beside them (one Send, as on the desktop).
    const choosing = ask.kind === "question" && ask.reply;
    const choose = (next) => {
      drafts.set(askKey, next);
      for (const [n, button] of [...(options?.querySelectorAll(":scope > .option") || [])].entries()) button.setAttribute("aria-pressed", String(next.option === n));
      redrawMenu(options, next.picks);
    };
    const pick = async (i) => {
      if (choosing) return choose(Thread.pick(drafts.get(askKey), i));
      // A pick goes the row's way, so the row's words and files go with it as its note.
      if (ask.reply) {
        drafts.set(askKey, { option: i, text: form.querySelector("textarea")?.value || "" });
        return form.requestSubmit();
      }
      // Options only: the disabled row's words are a message for later, never this answer's note.
      drafts.set(askKey, { option: i, text: "" });
      await sendAnswer(ask, askKey);
      if (sheetGolem === g) openGolem(g);
    };
    const chosen = drafts.get(askKey) || { option: null, picks: null };
    const options = questions
      ? AskContext.menuBlock(h, questions, chosen.picks, (qi, oi) => choose(Thread.tick(drafts.get(askKey), questions, qi, oi)), { busy })
      : ask.options?.length
      ? h("div", { class: "item-options", role: "group", "aria-label": "Options" }, context.options.map((row, i) => {
        const shown = AskContext.option(h, row);
        return h("button", { type: "button", class: shown.class, disabled: busy, ...(choosing ? { "aria-pressed": String(chosen.option === i) } : {}), onclick: () => pick(i) }, shown.children);
      }))
      : null;
    const atPc = ["flag", "status", "unknown", "ask"].includes(ask.kind) ? h("button", { type: "button", class: "small", disabled: busy, onclick: async () => {
      drafts.set(askKey, { option: null, text: AT_PC });
      await sendAnswer(ask, askKey);
      if (sheetGolem === g) openGolem(g);
    } }, "I'll do it at the PC") : null;
    const wait = h("button", { type: "button", class: "small not-now", disabled: busy, onclick: (e) => {
      e.currentTarget.disabled = true; // one tap: the wait waits on golemd
      notNow(ask, g);
    } }, "Not now");
    const title = `ask-first-${ask.id}`;
    return h("section", { class: `ask-first${ask.kind === "gate" ? " gate" : ""}`, "data-ask": ask.id, role: "group", "aria-labelledby": title, tabindex: "-1" }, [
      h("div", { class: "ask-first-head" }, [h("span", { class: `kind ask${ask.kind === "gate" ? " gate" : ""}` }, label), of ? h("span", { class: "ask-first-of" }, of) : null, h("time", { datetime: ask.at }, ago(ask.at))]),
      h("p", { class: "ask-first-text", id: title }, linked(ask.question)),
      AskContext.about(h, context.about),
      ask.detail && !questions ? detailBlock(ask.detail) : null,
      h("div", { class: "chat-need-does" }, does),
      ask.why && !questions ? h("div", { class: "chat-need-why" }, ask.why) : null,
      options,
      ...AskContext.after(h, context),
      AskContext.offers(ask, { answerable: true, sealed: sealedWorkshop(ask.workshopId) }) ? AskContext.bare(h, () => askForContext(ask, g), { busy }) : null,
      h("div", { class: "ask-first-actions" }, [atPc, wait].filter(Boolean)),
    ]);
  }

  /** The Orchestrator's questions put off with Not now: one bar over the message row that brings them back, oldest first. */
  function waitsBar(waited, g) {
    return h("button", { type: "button", class: "chat-waits", "data-ask": waited[0].id, onclick: () => {
      for (const a of waited) reopenedAsks.add(askKeyOf(a));
      openGolem(g);
    } }, [h("span", { class: "grow" }, AskFirst.barText(waited)), h("span", { class: "chat-waits-open" }, "Answer")]);
  }

  /** Not now: the Orchestrator hears David says wait (golemd types it a note and keeps the ask open), the block lifts, and the ask waits in the bar. */
  async function notNow(ask, g) {
    const askKey = askKeyOf(ask);
    try {
      await api("POST", `/api/asks/${encodeURIComponent(ask.workshopId)}/${encodeURIComponent(ask.id)}/wait`);
      // Put off on this phone at once; the feed's waitedAt follows with the next summary.
      heldAsks.add(askKey);
      reopenedAsks.delete(askKey);
    } catch (error) {
      // No word from the workshop (an older golemd, a dropped socket): put off here so he is not held, and told the Orchestrator may not know.
      if (error.status === 504) {
        heldAsks.add(askKey);
        reopenedAsks.delete(askKey);
      }
      toast(error.message, true);
    }
    await load();
    if (sheetGolem === g) openGolem(g);
  }

  /** A workshop whose summary comes sealed (encryption on), as the opened feed or this phone has seen it. */
  const sealedWorkshop = (workshopId) => Boolean(feed?.workshops?.find((w) => w.id === workshopId)?.sealed || sealed?.wasSealed(workshopId));

  /** Ask for context on a bare question: golemd has the golem ask it again with its context, and the new question comes in its place. */
  async function askForContext(ask, g = null) {
    try {
      await api("POST", `/api/asks/${encodeURIComponent(ask.workshopId)}/${encodeURIComponent(ask.id)}/context`);
      toast("Asked for its context; the new question comes in its place");
    } catch (error) {
      toast(error.message, true);
    }
    await load();
    if (g && sheetGolem === g) openGolem(g);
  }

  /** A menu's boxes as the draft's picks have them now, redrawn in place so words typed since stay. */
  function redrawMenu(root, picks) {
    for (const b of root.querySelectorAll(".ask-menu [data-q]")) {
      const on = Boolean(picks?.[Number(b.dataset.q)]?.includes(Number(b.dataset.o)));
      b.setAttribute("aria-checked", String(on));
      const mark = b.querySelector(".ask-menu-box");
      if (mark) mark.textContent = on ? "☑" : "☐";
    }
  }

  /** Options to pick and, where the golem takes words, a reply box (a reply, or a note with the pick); one Send. */
  function answerForm(ask, key, context = AskContext.of(ask)) {
    const draft = drafts.get(key) || { text: "", option: null };
    const busy = sending.has(key);
    const form = h("form", { class: "answer", onsubmit: (e) => (e.preventDefault(), sendAnswer(ask, key)) });
    // A tap redraws only this form, wherever it is (Fleet or a sheet), from the draft as it is now: words typed since the last render stay.
    const pickOption = (i) => {
      const next = Thread.pick(drafts.get(key), i);
      drafts.set(key, next);
      for (const [n, button] of [...options.children].entries()) button.setAttribute("aria-pressed", String(next.option === n));
      send.disabled = busy || (next.option === null && !box);
    };
    // A menu (several picks or several questions): its boxes ticked here, sent with the words by the one Send.
    const questions = ask.reply ? AskContext.menu(ask) : null;
    const tickOption = (qi, oi) => {
      const next = Thread.tick(drafts.get(key), questions, qi, oi);
      drafts.set(key, next);
      redrawMenu(form, next.picks);
      send.disabled = busy || (!next.picks.some((p) => p.length) && !box);
    };
    const options = questions
      ? AskContext.menuBlock(h, questions, draft.picks, tickOption, { busy })
      : ask.options?.length
      ? h("div", { class: "item-options", role: "group", "aria-label": "Options" }, context.options.map((row, i) => {
        const shown = AskContext.option(h, row);
        return h("button", {
          type: "button",
          class: shown.class,
          disabled: busy,
          "aria-pressed": String(draft.option === i),
          onclick: () => pickOption(i),
        }, shown.children);
      }))
      : null;
    // Its options keep working on a bare question; Ask for context is one more way out.
    const bare = AskContext.offers(ask, { answerable: canAnswer(ask), sealed: sealedWorkshop(ask.workshopId) }) ? AskContext.bare(h, () => askForContext(ask), { busy }) : null;
    const box = ask.reply ? h("textarea", { rows: "2", maxlength: String(MAX_SAY), disabled: busy, "aria-label": `Reply to ${ask.golem || ask.overlord}`, placeholder: replyPlaceholder(ask), oninput: (e) => {
      // No re-render while typing, so the keyboard stays up; a picked option stays picked.
      drafts.set(key, { ...(drafts.get(key) || draft), text: e.target.value });
    } }) : null;
    if (box) box.value = draft.text;
    const attach = ask.reply && !namesOnly(ask.workshopId, ask.golemId) ? attachBar(key, { disabled: busy }) : null;
    const ready = draft.option !== null || Boolean(draft.text.trim()) || Boolean(draft.picks?.some((p) => p.length));
    // A need the phone cannot do itself (rotate keys in a browser, sign in) still gets an answer: later at the PC, or not now.
    const later = ["flag", "status", "unknown", "ask"].includes(ask.kind)
      ? h("div", { class: "quick" }, [
        h("button", { type: "button", class: "small", disabled: busy, onclick: () => (drafts.set(key, { option: null, text: AT_PC }), sendAnswer(ask, key)) }, "I'll do it at the PC"),
        h("button", { type: "button", class: "small", disabled: busy, onclick: () => snooze(ask, 2) }, "Snooze 2h"),
      ])
      : null;
    const send = h("button", { type: "submit", class: "primary small", disabled: busy || (!ready && !box) }, busy ? "Sending" : "Send");
    form.append(...[options, ...AskContext.after(h, context), bare, box, attach, later, h("div", { class: "answer-foot" }, [send])].filter(Boolean));
    return form;
  }

  /** Sends an ask's answer from its draft; files: the key its attachments are under (the chat's row keeps its own). True once sent. */
  async function sendAnswer(ask, key, { files = key } = {}) {
    if (sending.has(key)) return false; // a sheet's form is not redrawn as busy, so a second tap lands here
    const draft = drafts.get(key) || { text: "", option: null };
    // The option or a menu's ticks, with the words beside them; without words, every question needs its pick.
    const { body, error } = Thread.answerBody(draft, AskContext.menu(ask), { files: (attached.get(files) || []).length });
    if (error) return toast(error, true), false;
    // In flight: the 10-second refresh keeps this form disabled, so a second tap cannot send it again.
    sending.add(key);
    render();
    let sent = false;
    try {
      const out = await withFaceId(async () => {
        const acts = await sealerFor(ask.workshopId);
        const ids = await uploadAttached(files, ask.workshopId, acts);
        const label = body.option !== undefined ? { label: ask.options[body.option] } : {};
        const payload = acts ? sealedBody(acts, ask.workshopId, "answer", { askId: ask.id, golemId: ask.golemId, ...body, ...label }, files, ids) : { ...body, ...(ids.length ? { attachments: ids } : {}) };
        return api("POST", `/api/asks/${encodeURIComponent(ask.workshopId)}/${encodeURIComponent(ask.id)}/answer`, payload);
      });
      drafts.delete(key);
      await keepSent(out.said, attached.get(files));
      clearAttached(files);
      toast(sentNote(out, ask.golem));
      // Until golemd closes it, the chat does not lead with it again (G-110).
      answeredAsks.set(askKeyOf(ask), new Date().toISOString());
      sent = true;
    } catch (error) {
      forgetUploads(files, error);
      toast(error.message, true);
    }
    sending.delete(key);
    await load();
    return sent;
  }

  /** What a send says: delivered, held while golems are paused, or sent with no word back from the workshop. */
  function sentNote(out, who) {
    if (out.unconfirmed) return `Sent to ${who}; the workshop has not confirmed it yet, check the desktop before sending again`;
    if (out.held) return `Held for ${who}: golems are paused on the desktop`;
    return `Sent to ${who}`;
  }

  const NO_REPLY_MS = 10 * 60 * 1000;

  /** David's message with what came back under it; past ten minutes with nothing, "No reply yet" (it never notifies). */
  function threadLines(t, who) {
    const replies = t.replies || [];
    const line = (speaker, at, text, cls, read = null) => h("li", { class: cls }, [h("span", { class: "speaker" }, speaker), h("div", { class: "words" }, linked(text)), h("time", { datetime: at }, clockTime(at)), read]);
    const quiet = Date.now() - Date.parse(t.at) >= NO_REPLY_MS;
    return h("ol", { class: "thread", "data-said": t.id, "aria-label": `Your message to ${who}` }, [
      line("You", t.at, t.text, "said-line", t.delivery === "unconfirmed" ? h("span", { class: "note" }, "Sent, not confirmed") : null),
      t.files?.length ? h("li", { class: "said-files" }, sentFiles(t)) : null,
      ...replies.map((r) => line(who, r.at, r.text, "reply-line", readControls(`reply:${r.id}`, r.text, who))),
      replies.length ? null : h("li", { class: "reply-line pending" }, [h("span", { class: "speaker" }, who), h("div", { class: "words" }, quiet ? "No reply yet" : "Waiting for a reply")]),
    ]);
  }

  const overlordPart = (who) => String(who || "").split(" · ")[0];
  const LINK_STATUS = { held: (s) => `Waiting for ${s.to.split(" · ")[1] || "the other workshop"} to connect`, dropped: (s) => `Not delivered: ${s.error || "dropped"}`, unconfirmed: () => "Sent, not confirmed" };

  /** A message between two workshops' overlords, in both of their threads: who to whom, the words, and whether it arrived. */
  function linkLines(s) {
    const from = overlordPart(s.from);
    const status = LINK_STATUS[s.status]?.(s);
    return h("ol", { class: `thread link-thread${s.outgoing ? " outgoing" : ""}`, "data-said": s.id, "aria-label": `${s.from} to ${s.to}` }, [
      h("li", { class: "link-line" }, [h("span", { class: "speaker" }, `${from} → ${overlordPart(s.to)}`), h("div", { class: "words" }, linked(s.text)), h("time", { datetime: s.at }, clockTime(s.at)), readControls(`link:${s.id}`, s.text, from)]),
      status ? h("li", { class: `reply-line pending${s.status === "dropped" ? " failed" : ""}` }, [h("div", { class: "words" }, status)]) : null,
    ]);
  }

  // ---------- read aloud ----------

  // The phone's own voice (Web Speech): nothing leaves the phone, no service, no cost. One reply reads at a time.
  const voices = typeof speechSynthesis !== "undefined" ? speechSynthesis : null;
  let reading = null; // { key, paused } while a reply is being read
  let voice;
  voices?.addEventListener?.("voiceschanged", () => (voice = undefined));
  const pickVoice = () => (voice === undefined ? (voice = Speech.bestVoice(voices.getVoices(), navigator.language)) : voice);

  /** Listen, then Pause or Resume while it reads, and Stop beside it. Drawn from the reading state, so a refresh keeps it. */
  function readControls(key, text, who) {
    if (!voices || !Speech.sayable(text)) return null;
    const on = reading?.key === key;
    const label = !on ? "▶ Listen" : reading.paused ? "▶ Resume" : "❚❚ Pause";
    return h("div", { class: "read-row", "data-read": key }, [
      h("button", { type: "button", class: "small read", "aria-pressed": String(on && !reading.paused), "aria-label": `${on ? (reading.paused ? "Resume" : "Pause") : "Listen to"} ${who}'s reply`, onclick: () => readAloud(key, text) }, label),
      on ? h("button", { type: "button", class: "small read", "aria-label": "Stop reading", onclick: stopReading }, "■ Stop") : null,
    ]);
  }

  function readAloud(key, text) {
    if (reading?.key === key) {
      if (reading.paused) voices.resume();
      else voices.pause();
      reading.paused = !reading.paused;
      return redrawReading();
    }
    voices.cancel();
    const parts = Speech.pieces(Speech.sayable(text));
    reading = { key, paused: false };
    const over = () => {
      if (reading?.key !== key) return;
      reading = null;
      redrawReading();
    };
    parts.forEach((part, i) => {
      const said = new SpeechSynthesisUtterance(part);
      const chosen = pickVoice();
      if (chosen) {
        said.voice = chosen;
        said.lang = chosen.lang;
      }
      if (i === parts.length - 1) said.onend = over;
      said.onerror = (e) => e.error !== "interrupted" && e.error !== "canceled" && over();
      voices.speak(said);
    });
    redrawReading();
  }

  function stopReading() {
    reading = null;
    voices?.cancel();
    redrawReading();
  }

  /** Each reply's controls drawn again in place, wherever they show. */
  function redrawReading() {
    for (const row of document.querySelectorAll("[data-read]")) {
      const words = row.closest("li")?.querySelector(".words")?.textContent || "";
      const who = row.closest("li")?.querySelector(".speaker")?.textContent || "it";
      const next = readControls(row.dataset.read, words, who);
      if (next) row.replaceWith(next);
    }
  }

  // iOS pauses a page's speech when the app goes to the background or the screen locks; it picks up again on return.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && reading && !reading.paused) voices?.resume();
  });

  /** Every golem as Golems wants a pane: name is its key across workshops, role marks the overlord. */
  function allPanes(source = feed) {
    const all = [];
    for (const w of source?.workshops || []) {
      for (const g of w.golems) all.push({ ...g, golemId: g.id, id: paneKey(w.id, g.id), name: paneKey(w.id, g.id), kind: "claude", role: g.type === "overlord" ? "orchestrator" : undefined, workshopId: w.id, workshop: w.name, online: w.online });
    }
    return all;
  }

  function golemsShown() {
    const all = allPanes();
    return all.filter((g) => (!filters.workshop || g.workshopId === filters.workshop) && (!filters.workspace || g.workspace === filters.workspace) && g.type !== "overlord");
  }

  /** The Overlords group with none to show: a computer not approved yet says what is left and where (Enroll.fleetNote), with a way back to this phone's step; else none runs. */
  function noOverlord() {
    const said = typeof Enroll !== "undefined" ? Enroll.fleetNote(feed, enroll?.view() || null) : null;
    if (!said) return [h("p", { class: "note" }, "No overlord is running.")];
    const card = h("div", { class: "card attention", "data-approval": true }, [h("p", {}, said.text)]);
    if (said.phone && enroll) card.append(h("div", { class: "row" }, [h("button", { type: "button", class: "small primary", onclick: () => enroll.reopen() }, "Show the request")]));
    return [card];
  }

  function fleetView() {
    if (!feed) return loading();
    const select = (label, key, options) => {
      const node = h("select", { "aria-label": label, onchange: (e) => { filters[key] = e.target.value; render(); } }, [h("option", { value: "" }, "All"), ...options.map(([value, text]) => h("option", { value }, text))]);
      node.value = filters[key];
      return h("label", {}, [label, node]);
    };
    const workspaces = [...new Set(feed.workshops.flatMap((w) => w.golems.map((g) => g.workspace)).filter(Boolean))].sort();
    if (filters.workspace && !workspaces.includes(filters.workspace)) filters.workspace = "";
    const bar = h("div", { class: "filters" }, [select("Workshop", "workshop", feed.workshops.map((w) => [w.id, w.name])), select("Workspace", "workspace", workspaces.map((s) => [s, s]))]);
    if (!feed.workshops.length) return h("div", { class: "empty" }, [h("strong", {}, "No workshops yet"), "Pair your desktop app from Settings, then its golems show here."]);
    // The overlords lead, in rank order and whatever the filters, each with what it asks David and the controls on its card.
    const rows = overlordRows();
    const asking = needCount();
    const golems = golemsShown();
    // A golem that just closed stays in its place a moment as it crumbles (Golems.withGhosts).
    const shown = hasGolems() ? Golems.withGhosts(golems) : golems.map((pane) => ({ pane, ghost: false }));
    const board = h("div", { class: "cards", id: "board" });
    board.append(h("h2", { class: `group${asking ? " needs" : ""}` }, asking ? `Overlords · ${asking} need${asking === 1 ? "s" : ""} you` : "Overlords"));
    for (const row of rows) {
      if (row.golem) board.append(row.paused || row.updateFailed || row.asks.length ? needCard(row.golem, row.asks, row.paused, row.updateFailed) : card(row.golem));
      else board.append(...(row.paused ? [pausedItem(row.paused)] : []), ...(row.updateFailed ? [updateFailedItem(row.updateFailed)] : []), ...row.asks.map(askItem));
    }
    if (!rows.length) board.append(...noOverlord());
    board.append(...whatsNewCard(), ...usageBlock());
    // A golem keeps its place: what it needs goes to its overlord, who answers or asks David. Its views are the desktop Board's.
    const standby = golems.filter((g) => g.standby);
    const added = shopsShown().flatMap((w) => (w.standby || []).filter((e) => !filters.workspace || e.workspace === filters.workspace).map((e) => ({ ...e, workshop: w.name })));
    const completed = shopsShown().flatMap((w) => (w.completed || []).filter((c) => !filters.workspace || c.workspace === filters.workspace).map((c) => ({ ...c, workshop: w.name }))).sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)));
    board.append(h("h2", { class: "group" }, "Golems"), viewSwitch({ active: golems.length - standby.length, standby: standby.length + added.length, completed: completed.length }), bar);
    if (boardView === "standby") board.append(...standbyView(standby, added));
    else if (boardView === "completed") board.append(...completedView(completed));
    else board.append(...activeView(shown.filter(({ pane }) => !pane.standby), standby.length + added.length));
    return board;
  }

  /** The workshops the Workshop filter shows. */
  const shopsShown = () => (feed?.workshops || []).filter((w) => !filters.workshop || w.id === filters.workshop);

  /** Active, Standby and Completed, as the desktop Board names them, each with its count. */
  function viewSwitch(counts) {
    const names = { active: "Active", standby: "Standby", completed: "Completed" };
    return h("div", { class: "view-switch", role: "tablist", "aria-label": "Board views" }, Object.keys(names).map((key) => h("button", {
      type: "button",
      role: "tab",
      "aria-selected": String(boardView === key),
      onclick: () => {
        boardView = key;
        render();
      },
    }, [names[key], h("span", { class: "view-count" }, String(counts[key]))])));
  }

  // The desktop's order: golemd's rank (a drag or gw priority, then launch time), workshop by workshop.
  const byRank = (a, b) => (feed.workshops.findIndex((w) => w.id === a.workshopId) - feed.workshops.findIndex((w) => w.id === b.workshopId)) || (a.rank || 1e9) - (b.rank || 1e9);

  /** Active: the desktop Board's counts line, watchers apart, golems in rank order, and the done ones closed at the bottom. */
  function activeView(shown, onStandby) {
    const out = [];
    const live = shown.filter(({ pane, ghost }) => !ghost && !["exited", "parked"].includes(pane.state)).map(({ pane }) => pane);
    const counts = ["working", "queued", "waiting", "done", "idle"].map((name) => [name, live.filter((g) => g.state === name).length]).filter(([name, n]) => n || !["queued", "waiting"].includes(name));
    const needing = shown.filter(({ pane }) => pane.needsYou).length;
    out.push(h("p", { class: "board-summary" }, [h("strong", {}, String(live.length)), ` golem${live.length === 1 ? "" : "s"}`, ...counts.flatMap(([name, n]) => [" · ", h("strong", {}, String(n)), ` ${STATE_LABEL[name].toLowerCase()}`]), " · ", h("strong", {}, String(needing)), " waiting on an overlord"]));
    if (onStandby) out.push(h("button", { type: "button", class: "standby-chip", onclick: () => ((boardView = "standby"), render()) }, `◷ ${onStandby} on Standby →`));
    const watchers = shown.filter(({ pane }) => pane.watch);
    if (watchers.length) out.push(h("h3", { class: "subgroup" }, "Watchers"), h("div", { class: "watcher-list" }, watchers.map(({ pane }) => watcherRow(pane))));
    const golems = shown.filter(({ pane }) => !pane.watch).sort((a, b) => byRank(a.pane, b.pane));
    // A done golem waits in a closed group at the bottom, never above one still at work.
    const done = golems.filter(({ pane }) => pane.state === "done");
    const busy = golems.filter(({ pane }) => pane.state !== "done");
    if (busy.length) out.push(...busy.map(({ pane, ghost }) => card(pane, ghost)));
    else if (!done.length) out.push(h("div", { class: "empty" }, [h("strong", {}, "No golems"), "Nothing matches these filters."]));
    if (done.length) out.push(doneGroup(done));
    return out;
  }

  /** A watcher in one line: its health (amber once it misses two checks), its status, and when it last and next checks. */
  function watcherRow(g) {
    const w = g.watch || {};
    const last = Date.parse(w.lastTickAt || "");
    const stale = w.intervalMs && Number.isFinite(last) && Date.now() - last > 2 * w.intervalMs;
    const health = g.needsYou ? "blocked" : stale ? "stale" : last ? "working" : "idle";
    const when = w.lastTickAt ? `last check ${clockTime(w.lastTickAt)}${w.nextAt ? ` · next ${clockTime(w.nextAt)}` : ""}` : "no check yet";
    return h("button", { type: "button", class: "watcher-row", "data-health": health, onclick: () => openGolem(g) }, [
      h("span", { class: "dot", "data-state": health === "stale" ? "waiting" : health }),
      h("span", { class: "watcher-name" }, g.label || g.name),
      h("span", { class: "watcher-status" }, (g.status || "").replace(/^watching\b\s*[:—–-]?\s*/i, "") || when),
      h("span", { class: "watcher-when" }, when),
    ]);
  }

  const STANDBY_GROUPS = { parked: "Parked", paused: "Flow paused", waiting: "Waiting", added: "Added sessions" };
  const STANDBY_COUNTS = { parked: "parked", paused: "paused", waiting: "waiting", added: "added" };

  /** Standby: what the desktop moved off the Board (parked, a paused flow, waiting on something not David) and sessions added by hand. */
  function standbyView(golems, added) {
    const groups = { parked: [], paused: [], waiting: [], added };
    for (const g of golems.sort(byRank)) groups[g.standby.kind]?.push(g);
    const kinds = Object.keys(STANDBY_GROUPS).filter((k) => groups[k].length);
    if (!kinds.length) return [h("div", { class: "empty" }, [h("strong", {}, "Nothing on Standby"), "No golem is parked, paused or waiting on something, and no session was added by hand."])];
    return [
      h("p", { class: "board-summary" }, kinds.flatMap((k, i) => [i ? " · " : "", h("strong", {}, String(groups[k].length)), ` ${STANDBY_COUNTS[k]}`])),
      h("p", { class: "note" }, "Resume, unpark and close stay on the desktop."),
      ...kinds.flatMap((k) => [h("h3", { class: "subgroup" }, STANDBY_GROUPS[k]), ...groups[k].map((item) => (k === "added" ? addedRow(item) : standbyRow(item)))]),
    ];
  }

  function standbyRow(g) {
    const s = g.standby;
    return h("button", { type: "button", class: `standby-row${s.onYou ? " on-you" : ""}`, onclick: () => openGolem(g) }, [
      h("div", { class: "standby-top" }, [
        h("span", { class: "standby-title" }, g.label || g.name),
        h("span", { class: "chip-tag" }, g.rank ? `#${g.rank}` : "unranked"),
        s.onYou ? h("span", { class: "chip-tag on-you" }, "waits on you") : null,
        s.since ? h("span", { class: "standby-since" }, `◷ ${ago(s.since).replace(" ago", "")}`) : null,
      ]),
      h("div", { class: "card-meta" }, metaLine([g.workshop, g.workspace, g.flow], g.account)),
      h("div", { class: "standby-ask" }, s.on || g.status || "No reason given"),
    ]);
  }

  function addedRow(e) {
    return h("div", { class: "standby-row" }, [
      h("div", { class: "standby-top" }, [h("span", { class: "standby-title" }, e.title), e.task ? h("span", { class: "chip-tag" }, e.task) : null, e.addedAt ? h("span", { class: "standby-since" }, `◷ ${ago(e.addedAt).replace(" ago", "")}`) : null]),
      h("div", { class: "card-meta" }, [e.workshop, e.workspace].filter(Boolean).join(" · ")),
      h("div", { class: "standby-ask" }, "Added by hand: resume it from the desktop."),
    ]);
  }

  const span = (from, to) => {
    const ms = Date.parse(to) - Date.parse(from);
    if (!Number.isFinite(ms) || ms < 0) return "";
    const m = Math.round(ms / 60000);
    return m < 60 ? `${Math.max(1, m)}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
  };

  /** Completed: golems closed in the last 7 days, newest first, each with what it was for, did and came to. */
  function completedView(list) {
    if (!list.length) return [h("div", { class: "empty" }, [h("strong", {}, "Nothing completed"), "No golem closed in the last 7 days."])];
    return [
      h("p", { class: "board-summary" }, [h("strong", {}, String(list.length)), ` closed in the last 7 days`]),
      ...list.map((c) => {
        const state = c.endState === "done" ? "done" : c.endState === "blocked" ? "blocked" : "exited";
        const outcome = [["Purpose", c.purpose], ["Did", c.did], ["Result", c.result]].filter(([, text]) => text);
        return h("article", { class: "card completed-card", "data-state": state }, [
          h("div", { class: "card-top" }, [h("span", { class: "card-name" }, c.label || c.name), h("span", { class: "pill", "data-state": state }, [h("span", { class: "dot", "data-state": state }), c.endState === "closed" ? "Closed" : state === "blocked" ? "Ended blocked" : STATE_LABEL[state]])]),
          h("div", { class: "card-meta" }, metaLine([c.workshop, c.workspace, c.flow, `ended ${dayHeading(c.endedAt) === "Today" ? clockTime(c.endedAt) : `${dayHeading(c.endedAt)} ${clockTime(c.endedAt)}`}`, c.startedAt ? span(c.startedAt, c.endedAt) : ""], c.account)),
          outcome.length ? h("dl", { class: "completed-outcome" }, outcome.flatMap(([term, text]) => [h("dt", {}, term), h("dd", {}, linked(text))])) : null,
        ]);
      }),
    ];
  }

  // ---------- usage ----------

  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const resetDay = (iso) => {
    const d = new Date(iso);
    return `${DAYS[d.getDay()]} ${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  /** Each workshop's usage bars as its desktop draws them: weekly (and the 5-hour window when shown there), disk and memory. */
  function usageBlock() {
    const shops = shopsShown().filter((w) => w.usage);
    if (!shops.length) return [];
    return [h("h2", { class: "group" }, "Usage"), h("div", { class: "usage-shops" }, shops.map(usageShop))];
  }

  function usageShop(w) {
    const u = w.usage;
    // A workshop offline or not updating: its bars as last heard, gray.
    const old = w.online === false || Boolean(w.stale);
    const gray = old || u.stale;
    const plan = (p, grayed) => [
      usageBar("Weekly", p.weekly, grayed, p.weekly && !p.weekly.none && p.weekly.resetsAt ? `resets ${resetDay(p.weekly.resetsAt)}` : "", u.loading),
      p.fiveHour !== undefined ? usageBar("5-hour", p.fiveHour, grayed, p.fiveHour?.none ? "No 5-hour limit on this plan right now" : p.fiveHour?.resetsAt ? `resets ${clockTime(p.fiveHour.resetsAt)}` : "no window open", u.loading) : null,
    ];
    const machine = [
      usageBar("Disk", u.disk, old || u.disk?.stale, u.disk ? `${u.disk.freeGb.toFixed(1)} GB free` : ""),
      usageBar("Memory", u.memory, old || u.memory?.stale, u.memory?.totalGb ? `${((u.memory.percent / 100) * u.memory.totalGb).toFixed(1)} of ${u.memory.totalGb.toFixed(1)} GB used` : ""),
    ];
    const heard = old ? `${w.online === false ? "offline" : "not updating"}; as of ${ago(w.receivedAt)}` : u.stale ? `stale${u.updatedAt ? `, ${ago(u.updatedAt)}` : ""}${u.error ? `: ${u.error}` : ""}` : u.updatedAt ? `updated ${clockTime(u.updatedAt)}` : "";
    const head = h("div", { class: "usage-shop-head" }, [h("strong", {}, w.name), h("span", { class: "usage-heard" }, heard)]);
    // Disk and memory belong to the computer, so they show once under the accounts.
    const accounts = ClaudeAccount.groups(u);
    if (!accounts) return h("section", { class: "usage-shop", "aria-label": `${w.name} usage` }, [head, h("div", { class: "usage-bars" }, [...plan(u, gray), ...machine])]);
    return h("section", { class: "usage-shop", "aria-label": `${w.name} usage` }, [
      head,
      ...accounts.map((a) => h("div", { class: "usage-account", role: "group", "aria-label": `${w.name} usage, ${ClaudeAccount.label(a.account)}` }, [h("div", { class: "usage-account-head" }, [h("span", {}, [w.name, " · ", ClaudeAccount.tag(h, a.account)]), a.stale && !gray ? h("span", { class: "usage-heard" }, "stale") : null]), h("div", { class: "usage-bars" }, plan(a, gray || a.stale))])),
      h("div", { class: "usage-bars usage-machine" }, machine),
    ]);
  }

  /** One bar: percent and fill (gray when stale), the pace mark, a note; no number is an empty dashed track with "–", never 0%. */
  function usageBar(label, data, gray, note, loading = false) {
    const known = Boolean(data) && typeof data.percent === "number";
    const percent = known ? Math.max(0, Math.min(100, data.percent)) : 0;
    const level = !known || gray ? "gray" : data.level || "normal";
    const said = data?.none ? note : !data ? (loading ? "Loading" : "Not available") : note;
    const fill = h("div", { class: "usage-fill" });
    fill.style.setProperty("width", `${percent}%`);
    const pace = typeof data?.pace === "number" ? h("div", { class: "usage-pace" }) : null;
    if (pace) pace.style.setProperty("left", `${data.pace}%`);
    return h("div", { class: "usage-bar", "data-level": level, "data-empty": !known }, [
      h("div", { class: "usage-head" }, [h("span", { class: "usage-label" }, label), h("span", { class: "usage-pct" }, known ? `${percent}%` : "–")]),
      h("div", known ? { class: "usage-track", role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(percent), "aria-label": label, "aria-valuetext": `${percent}%, ${said}` } : { class: "usage-track", role: "img", "aria-label": `${label}: ${said}` }, [fill, pace]),
      h("div", { class: "usage-note" }, said),
    ]);
  }

  /** Done golems, closed until David opens it; it stays as he left it across the 10-second refresh. */
  function doneGroup(done) {
    const group = h("details", { class: "done-group", open: doneOpen, ontoggle: () => (doneOpen = group.open) }, [
      h("summary", {}, `Done · ${done.length}`),
      h("div", { class: "cards" }, done.map(({ pane, ghost }) => card(pane, ghost))),
    ]);
    return group;
  }

  /** Needs.overlordRows (needs.js) with each overlord as its pane, as cards and sheets want it. */
  const overlordRows = () => Needs.overlordRows(feed).map((row) => ({ ...row, golem: row.golem && allPanes().find((p) => p.name === paneKey(row.workshop.id, row.golem.id)) }));
  const needCount = () => Needs.count(feed);
  const overlordOf = (g) => Needs.overlordName(feed, g.workshopId);

  /** An overlord needing David: its card, tap the top for its sheet, then its paused workshop and every open ask with their controls. */
  function needCard(g, asks, paused = null, updateFailed = null) {
    const gate = !paused && !updateFailed && asks.every((a) => a.kind === "gate");
    const node = h("article", { class: `card need attention${gate ? " gate" : ""}${g.type === "overlord" ? " overlord orchestrator" : ""}`, "data-state": gate || (paused && !updateFailed && !asks.length) ? "waiting" : "blocked", "data-pane": g.name }, [
      h("button", { type: "button", class: "card-open", "aria-label": `Open ${g.label || g.name}${ClaudeAccount.name(g.account) ? `, ${ClaudeAccount.label(ClaudeAccount.name(g.account))}` : ""}`, onclick: () => openGolem(g) }, [
        h("div", { class: "card-top" }, [h("span", { class: "card-name" }, g.label || g.name), g.type === "overlord" ? h("span", { class: "tag" }, "Overlord") : null, pill(g.state, g)]),
        h("div", { class: "card-meta" }, metaLine([g.workshop, g.workspace, g.flow], g.account)),
        stepsOf(g),
      ]),
      ...(paused ? [pausedItem(paused)] : []),
      ...(updateFailed ? [updateFailedItem(updateFailed)] : []),
      ...asks.map(askBody),
    ]);
    return withGolem(node, g);
  }

  /** A push's link (#fleet&golem=<workshop>/<golem>[&sheet=1]): once the feed has the golem, its card scrolls into view or its sheet opens. */
  function showFocus() {
    if (!focus) return;
    const want = focus;
    const g = allPanes().find((p) => p.name === want.key);
    focus = null;
    // An app already open holds the last poll: a push about a golem or ask that came after it fetches the feed first, once.
    const missing = !g || (want.ask && !feed.asks.some((a) => a.id === want.ask && `${a.workshopId}/${a.golemId}` === want.key));
    if (missing && !want.fetched) {
      focus = { ...want, fetched: true };
      return void load();
    }
    if (!g) return;
    if (want.sheet) return openGolem(g, { ask: want.ask, said: want.said });
    const node = main.querySelector(`.card[data-pane="${CSS.escape(g.name)}"]`);
    if (!node) return;
    const group = node.closest("details");
    if (group && !group.open) group.open = doneOpen = true;
    node.scrollIntoView({ block: "center" });
    node.classList.add("focused");
    setTimeout(() => node.classList.remove("focused"), 2400);
  }

  /** The app opened, or back in front, with an Orchestrator's question open: it lands on that chat, once per question (G-110). Not on the desktop's Account page, nor over a sheet or a push's own link. */
  function landOnAsk() {
    if (DESKTOP || !feed || Date.now() > landingUntil) return;
    // A push's own link, or a sheet he opened, comes first: no landing this time.
    if (focus || sheetGolem || !sheet.hidden) return void (landingUntil = 0);
    const rows = overlordRows().map((row) => ({ golem: row.golem, asks: row.golem ? asksOf(row.golem).filter((a) => !answeredAsks.has(askKeyOf(a))) : [] }));
    const hit = AskFirst.landing(rows, { canAnswer, keyOf: askKeyOf, held: heldAsks, landed: landedAsks });
    if (!hit) return;
    landingUntil = 0;
    landedAsks.add(askKeyOf(hit.ask));
    openGolem(hit.golem);
  }
  // Tried on each load this long after the app opens or comes back, since a sealed feed can open a load or two late.
  const LANDING_MS = 20000;
  let landingUntil = 0;

  function loading() {
    return h("span", { class: "loading-shard", role: "status", "aria-label": "Loading" });
  }

  /** A step segment with the desktop's crystal vein: the current one fills, a finished one flashes as it sets. */
  function stepSegment(step) {
    const vein = hasGolems() ? Golems.stepVein(step) : {};
    const node = h("span", { class: vein.class ? `step ${vein.class}` : "step", "data-state": step.state });
    // CSSOM, not a style attribute: the page's content policy allows no inline styles.
    const custom = /^(--[\w-]+):\s*(.+)$/.exec(vein.style || "");
    if (custom) node.style.setProperty(custom[1], custom[2]);
    return node;
  }

  function stepsOf(g) {
    if (!g.steps?.length) return null;
    const i = g.steps.findIndex((s) => s.state === "current");
    const current = i >= 0 ? g.steps[i] : null;
    const done = g.steps.filter((s) => s.state === "done").length;
    return h("div", { class: "card-steps" }, [
      h("div", { class: "step-bar", "aria-hidden": "true" }, g.steps.map(stepSegment)),
      h("div", { class: "step-label" }, current ? [h("span", { class: "n" }, `Step ${i + 1} of ${g.steps.length}: `), current.text] : [h("span", { class: "n" }, `${done} of ${g.steps.length} steps done`)]),
    ]);
  }

  function card(g, ghost = false) {
    const state = g.state;
    // An overlord's need asks David; a golem's names the overlord it went to.
    const need = Needs.line(feed, g.workshopId, { ...g, id: g.golemId });
    const node = h("button", {
      type: "button",
      class: `card${g.type === "overlord" ? " overlord orchestrator" : ""}${need?.david ? " attention" : ""}`,
      "data-state": state,
      "data-pane": g.name,
      onclick: () => openGolem(g),
    }, [
      h("div", { class: "card-top" }, [h("span", { class: "card-name" }, g.label || g.name), g.type === "overlord" ? h("span", { class: "tag" }, "Overlord") : null, pill(state, g)]),
      h("div", { class: "card-meta" }, metaLine([g.workshop, g.workspace, g.flow], g.account)),
      stepsOf(g),
      waitLine(g) ? h("div", { class: "card-status" }, waitLine(g)) : need ? h("div", { class: need.david ? "card-attention" : "card-status" }, need.text) : cardLine(g) ? h("div", { class: "card-status" }, cardLine(g)) : null,
    ]);
    return withGolem(node, g, ghost);
  }


  /** A golem's open ask that left the top of Fleet: answered from the phone (until the golem moves on) or snoozed. */
  function waitLine(g) {
    const ask = (feed?.asks || []).find((a) => a.workshopId === g.workshopId && a.golemId === g.golemId && (a.answeredAt || a.snoozedUntil));
    if (!ask) return null;
    return ask.answeredAt ? `You answered ${ago(ask.answeredAt)}; waiting for it to go on` : `Snoozed until ${clockTime(ask.snoozedUntil)}`;
  }

  /** A golem's own asks in the feed, open or answered. */
  const asksOf = (g) => (feed?.asks || []).filter((a) => a.workshopId === g.workshopId && a.golemId === g.golemId);

  // An overlord seldom sets a status line, so its card shows its newest ask instead.
  const cardLine = (g) => g.status || (g.type === "overlord" ? asksOf(g).at(-1)?.question : null) || null;

  /** The golem sheet's message box: words to this golem as David, typed in once its input line is free; quiet: under the Orchestrator chat, as its input box. */
  function messageForm(g, said, { quiet = false, split = null } = {}) {
    const key = `message:${g.workshopId}/${g.golemId}`;
    // In the chat the Orchestrator's leading question blocks the conversation (G-110): the row answers it when it takes words (a dialog's reply cancels it and says why).
    const lead = quiet ? split?.lead[0] || null : null;
    const answering = lead?.reply ? lead : null;
    const form = h("form", { class: "answer message", onsubmit: async (e) => {
      e.preventDefault();
      if (answering) {
        // Settled elsewhere since the sheet drew (the desktop, a snooze): not sent, and the words stay in the box.
        const ask = asksOf(g).find((a) => a.id === answering.id);
        if (!ask || !canAnswer(ask)) {
          toast("That need was settled elsewhere; your words are still in the box", true);
          return openGolem(g);
        }
        const askKey = askKeyOf(ask);
        drafts.set(askKey, { ...(drafts.get(askKey) || { option: null }), text: box.value });
        for (const control of form.querySelectorAll("button, textarea")) control.disabled = true;
        // The row's files go with the answer and stay under the row's key until it is sent; the chat stays where it was placed (G-108).
        if (await sendAnswer(ask, askKey, { files: key })) drafts.delete(key);
        if (sheetGolem === g) openGolem(g);
        return;
      }
      // A question with options only: the row has nothing to send until it is answered or put off.
      if (lead) return toast("Pick an option, or Not now", true);
      const text = box.value.trim();
      if (!text && !attached.get(key)?.length) return toast("Write a message or attach a file first", true);
      for (const control of form.querySelectorAll("button, textarea")) control.disabled = true;
      try {
        const out = await withFaceId(async () => {
          const acts = await sealerFor(g.workshopId);
          const ids = await uploadAttached(key, g.workshopId, acts);
          // A command picked from the / list (or sent bare) is sealed as one, so golemd types it as is.
          const payload = acts ? sealedBody(acts, g.workshopId, "message", { golemId: g.golemId, text, ...(slash?.isCommand(text) ? { command: true } : {}) }, key, ids) : { text, ...(ids.length ? { attachments: ids } : {}) };
          return api("POST", `/api/golems/${encodeURIComponent(g.workshopId)}/${encodeURIComponent(g.golemId)}/message`, payload);
        });
        await keepSent(out.said, attached.get(key));
        clearAttached(key);
        drafts.delete(key);
        // In the chat the new bubble's own Queued, then Sent, is the note (David, 2026-11-20); a paused fleet or an unconfirmed send still says so.
        if (!quiet || out.held || out.unconfirmed) toast(sentNote(out, g.label || g.name));
        // Sent from the chat: down to the newest, where the new bubble lands, even from scrolled up (David, 2026-11-21).
        if (quiet) chatToEnd();
        return openGolem(g);
      } catch (error) {
        forgetUploads(key, error);
        toast(error.message, true);
      }
      for (const control of form.querySelectorAll("button, textarea")) control.disabled = false;
    } });
    let slash = null; // the / list on this box (public/slash-commands.js), when it has one
    const box = h("textarea", { rows: quiet ? "1" : "3", maxlength: String(MAX_SAY), "aria-label": `Message ${g.label || g.name}`, placeholder: `Message ${g.label || g.name}` });
    const offline = g.online === false;
    // Options only: the box waits, so no plain message slips past the question.
    const pickOnly = Boolean(lead && !answering);
    if (offline || pickOnly) box.disabled = true;
    const takesFiles = !offline && !g.namesOnly && !pickOnly;
    if (quiet) {
      // A chat's composer: + to attach, the words, a round Send; picked files show above the row.
      const attach = takesFiles ? attachBar(key, { plus: true }) : null;
      form.classList.add("chat-form");
      // Words typed in the row survive a redraw of the sheet (a card's Send, a need settled elsewhere, a failed send).
      box.value = drafts.get(key)?.text || "";
      box.addEventListener("input", () => drafts.set(key, { option: null, text: box.value }));
      if (answering) {
        // One line on a phone: the question's own options are right above.
        box.placeholder = answering.options?.length && ["ask", "flag", "status", "unknown"].includes(answering.kind) ? "Or write your own answer" : replyPlaceholder(answering);
        box.setAttribute("aria-label", `Reply to ${answering.question}`);
      } else if (pickOnly) box.placeholder = "Pick an option above, or Not now";
      form.append(...[attach?.bar, h("div", { class: "chat-composer" }, [attach?.button, box, h("button", { type: "submit", class: "primary chat-send", disabled: offline || pickOnly, "aria-label": answering ? "Send answer" : "Send" }, "➤")].filter(Boolean)), offline ? h("span", { class: "item-foot" }, "Workshop offline") : null].filter(Boolean));
      box.addEventListener("input", () => {
        box.style.height = "auto";
        // scrollHeight leaves out the border a border-box height includes: without it two lines show a scrollbar.
        box.style.height = `${Math.min(box.scrollHeight + box.offsetHeight - box.clientHeight, 140)}px`;
      });
    } else form.append(...[box, takesFiles ? attachBar(key) : null].filter(Boolean), h("div", { class: "answer-foot" }, [h("span", { class: "item-foot" }, offline ? "Workshop offline" : g.namesOnly ? "Arrives as a message from you; its workspace takes attachments only at the desktop" : "Arrives as a message from you"), h("button", { type: "submit", class: "primary small", disabled: offline }, "Send")]));
    // / lists the golem's own slash commands (its sealed commands record), over the chat's row or under the sheet's box; a picked one runs as a command, not a message.
    if (!offline && !g.namesOnly && !answering && !pickOnly && sealed && typeof SlashCommands !== "undefined") slash = SlashCommands.attach(box, { load: () => commandsOf(g), place: quiet ? form.querySelector(".chat-composer") : box.nextSibling });
    // The chat ends at its message row: the feed shows what was sent, so no thread under it. Over the row: the leading question, else the bar for put-off ones and any need it cannot answer.
    if (quiet) {
      if (lead) return [askFirstCard(lead, g, { count: split.lead.length, form, rowKey: key }), form];
      const waits = split?.waited.length ? waitsBar(split.waited, g) : null;
      return [waits || split?.rest.length ? h("div", { class: "chat-needs", role: "region", "aria-label": "Needs you" }, [waits, ...(split?.rest || []).map((a) => chatNeed(a, g))].filter(Boolean)) : null, form].filter(Boolean);
    }
    return [h("h3", {}, "Message"), form, h("div", { id: "sheet-said" }, saidList(g, said, { focus: sheetFocus }))];
  }

  // Each workshop's sealed commands record, fetched at most once a minute: a / in any of its golems' boxes reads it.
  const commandRecords = new Map(); // workshopId -> { at, got }
  /** A golem's slash commands for the / list (public/slash-commands.js), opened here; [] for none, a plaintext workshop or no key. */
  async function commandsOf(g) {
    let record = commandRecords.get(g.workshopId);
    if (!record || Date.now() - record.at > 60e3) {
      record = { at: Date.now(), got: api("GET", `/api/commands/${encodeURIComponent(g.workshopId)}`).catch(() => null) };
      commandRecords.set(g.workshopId, record);
    }
    return sealed.commands(feed?.accountId, g.workshopId, g.golemId, await record.got);
  }

  // ---------- the Orchestrator chat (public/quiet-chat.js) ----------

  // The open chat's last opened feed and said list, so a summary change redraws its working line without fetching the feed.
  let quietShown = null; // { key, view, said }
  let quietAsked = 0;
  const quietKey = (g) => `${g.workshopId}/${g.golemId}`;
  const askKeyOf = (ask) => `${ask.workshopId}:${ask.id}`;
  // A message sent from the open chat lands at the newest, even from scrolled up (David, 2026-11-21); an answer to the Orchestrator's question leaves it where it was (G-110).
  const chatToEnd = () => document.getElementById("sheet-quiet")?.chatKeeper?.pin();
  // The Orchestrator's question first (G-110), by ask key: put off here with Not now (until the feed says so too), reopened from the bar, answered here (until golemd closes it), and landed on when the app opened.
  const heldAsks = new Set();
  const reopenedAsks = new Set();
  const answeredAsks = new Map(); // ask key -> when this phone answered it
  const landedAsks = new Set();
  /** The chat's asks (public/ask-first.js): lead blocks the chat, oldest first; waited sit in the bar; rest show as today, one answered here as answered. */
  const askSplit = (asks) => AskFirst.split(asks.map((a) => (answeredAsks.has(askKeyOf(a)) && !a.answeredAt ? { ...a, answeredAt: answeredAsks.get(askKeyOf(a)) } : a)), { canAnswer, keyOf: askKeyOf, held: heldAsks, reopened: reopenedAsks });
  /** Marks for asks no longer in the feed go, so one asked again word for word leads again. */
  function pruneAskMarks() {
    const live = new Set((feed?.asks || []).map(askKeyOf));
    for (const marks of [heldAsks, reopenedAsks, answeredAsks]) for (const key of [...marks.keys()]) if (!live.has(key)) marks.delete(key);
  }
  // The chat's needs as drawn, so a refresh that changes them draws the sheet again.
  const needsMark = (g) => asksOf(g).map((a) => `${a.id}:${a.answeredAt || ""}:${a.waitedAt || ""}:${answeredAsks.has(askKeyOf(a))}:${a.online === false}:${Boolean(a.stale)}`).join("|");

  /** The Orchestrator's Quiet feed opened for its sheet, or null: not the overlord, names only, a plaintext workshop (it never sends one), none or an empty one, or no key. */
  async function loadQuiet(g) {
    if (g.type !== "overlord" || g.namesOnly || !sealed || typeof QuietChat === "undefined") return null;
    const got = await api("GET", `/api/quiet/${encodeURIComponent(g.workshopId)}`).catch(() => null);
    const view = await sealed.quiet(feed?.accountId, g.workshopId, got);
    return view && view.golemId === g.golemId ? view : null;
  }

  // Its own renderer: an image in a reply is drawn as its alt text, so no request ever leaves for it.
  let chatMarkdown = null;
  function chatRenderer() {
    const md = markdownit({ html: false, linkify: true });
    md.renderer.rules.image = (tokens, i) => `<span class="note">[${md.utils.escapeHtml(tokens[i].content || "image")}]</span>`;
    return md;
  }

  /** A bubble's Markdown as the Artifacts viewer renders it (no raw HTML, sanitized), links opening outside, images as their alt text. */
  function bubbleText(text) {
    const node = h("div", { class: "markdown bubble-text" });
    if (typeof markdownit === "undefined" || typeof DOMPurify === "undefined") return (node.textContent = text), node;
    chatMarkdown ||= chatRenderer();
    node.innerHTML = DOMPurify.sanitize(chatMarkdown.render(text), { FORBID_TAGS: ["img"] });
    for (const link of node.querySelectorAll("a[href]")) Object.assign(link, { target: "_blank", rel: "noopener noreferrer" });
    return node;
  }


  const BUBBLE_STATE = { sent: "✓ Sent", queued: "Queued", unconfirmed: "Sent, not confirmed" };

  /** One bubble: his on the right with its state, the Orchestrator's replies and raised notes on the left; a push's message (data-said) lands on its reply, or on the message while none came. */
  function bubbleNode(b, name, replied = new Set()) {
    const meta = [h("time", { datetime: b.at }, clockTime(b.at))];
    if (b.side === "me") {
      if (b.from === "desktop") meta.unshift(h("span", {}, "Desktop"));
      meta.push(h("span", { class: "bubble-state", "data-state": b.state }, BUBBLE_STATE[b.state] || b.state));
    }
    const target = b.replyTo || (b.said?.id && !replied.has(b.said.id) ? b.said.id : null);
    return h("div", { class: `bubble ${b.side}${b.kind === "note" ? " note" : ""}${b.first ? " first" : ""}${b.last ? " last" : ""}`, "data-state": b.state || null, "data-said": target }, [
      h("span", { class: "sr-only" }, b.side === "me" ? "You:" : `${name}:`),
      b.kind === "note" ? h("div", { class: "bubble-tag" }, `Note from ${name}`) : null,
      b.answer ? h("div", { class: "bubble-tag" }, "Your answer") : null,
      // A photo this phone kept shows as its thumbnail; a file sent from another device, by name.
      b.files ? h("div", { class: "bubble-files" }, sentFiles({ id: b.said?.id ?? "feed", files: b.files })) : null,
      b.text.trim() ? bubbleText(b.text) : null,
      h("div", { class: "bubble-meta" }, meta),
    ]);
  }

  /** The feed as a conversation, then messages sent from here still queued, then a typing dots bubble while it works; kept at the bottom unless scrolled up (QuietChat.keeper). fetched: the feed was just loaded, so a chat opened again is placed now (placeOpened). */
  function drawQuiet(panel, g, view, said, { fetched = false } = {}) {
    quietShown = { key: quietKey(g), view, said };
    const keep = QuietChat.keeper(panel);
    const { waiting, sent, stray } = QuietChat.pair(said, view.entries);
    // No thread under the chat: its gw reply answers and never-confirmed messages show in it.
    const extra = [...stray, ...QuietChat.replies(said, view.entries)];
    // Nothing new: left as it is, so a selection or a scroll position survives a poll.
    const drawn = JSON.stringify([new Date().toDateString(), g.state, view.entries, waiting, [...sent].map(([seq, s]) => [seq, s.id]), extra.map((e) => [e.at, e.replyTo || e.said?.id, e.text])]);
    const opening = Boolean(keep.opening && fetched);
    if (panel.quietDrawn === drawn && !opening) return;
    panel.quietDrawn = drawn;
    const name = g.label || g.name;
    const items = QuietChat.conversation(view.entries, waiting, { dayOf: dayHeading, sent, extra });
    const replied = new Set(items.map((i) => i.replyTo).filter(Boolean));
    // Each row keyed by what it draws, so a redraw builds only the rows that changed.
    const rows = items.map((item) => (item.day
      ? { key: `day|${item.day}`, make: () => h("div", { class: "chat-day" }, h("span", {}, item.day)) }
      : { key: JSON.stringify({ ...item, said: item.said?.id, replied: replied.has(item.said?.id) }), at: item.at, side: item.side, make: () => bubbleNode(item, name, replied) }));
    if (!items.length) rows.push({ key: `empty|${name}`, make: () => h("p", { class: "chat-empty" }, `Nothing between you and ${name} yet.`) });
    if (g.state === "working") rows.push({ key: `typing|${name}`, make: () => h("div", { class: "bubble them first last typing", role: "status", "aria-label": `${name} is working` }, [h("span"), h("span"), h("span")]) });
    // The panel is not live (a redraw would read every bubble again): the newest reply is announced on its own.
    const newest = items.filter((i) => i.side === "them").at(-1);
    const heard = newest && `${newest.at}|${newest.text.length}`;
    const fresh = panel.quietAnnounced !== undefined && heard && heard !== panel.quietAnnounced;
    if (fresh) document.getElementById("sheet-quiet-news")?.replaceChildren(`${name}: ${newest.text.slice(0, 300)}`);
    panel.quietAnnounced = heard || null;
    const top = panel.scrollTop;
    panel.querySelector(":scope > .chat-new")?.remove();
    // Rebuilding every row reset the place and loaded each photo again, which pushed the view up (David, 2026-11-21): unchanged rows stay.
    const old = [...panel.children];
    const kept = QuietChat.sameStart(old.map((node) => node.dataset.row), rows.map((r) => r.key));
    for (const node of old.slice(kept)) node.remove();
    panel.append(...rows.slice(kept).map((r) => {
      const node = r.make();
      node.dataset.row = r.key;
      if (r.at) Object.assign(node.dataset, { at: r.at, side: r.side });
      return node;
    }));
    keep.watch();
    keep.onEnd ||= () => {
      panel.quietUnseen = false;
      panel.querySelector(":scope > .chat-new")?.remove();
    };
    keep.onScroll ||= () => chatScrolled(panel);
    if (opening) return placeOpened(panel, keep);
    if (keep.pinned) {
      keep.follow();
      panel.quietUnseen = false;
      return markChatSeen(panel);
    }
    // Scrolled up: a redraw above the view (a new day's headings) goes back to where he was; a new bubble shows the pill.
    if (panel.scrollTop !== top) panel.scrollTop = top;
    panel.quietUnseen ||= Boolean(fresh);
    if (panel.quietUnseen) panel.append(newPill(panel));
  }

  // Where he left each chat on this phone (rule 4): at the end or not, the newest bubble he had on screen, the row at the top of his view.
  const PLACE_KEY = "gwh-chat-place";
  function loadPlace(key) {
    try {
      return JSON.parse(localStorage.getItem(PLACE_KEY) || "{}")[key] || null;
    } catch {
      return null;
    }
  }
  /** Saved as he leaves: the place a chat still to be placed was left at, else where it is now. */
  function savePlace(panel) {
    const keep = panel?.chatKeeper;
    if (!keep || !panel.isConnected) return;
    try {
      const all = JSON.parse(localStorage.getItem(PLACE_KEY) || "{}");
      all[panel.dataset.golem] = keep.opening || leftAt(panel);
      localStorage.setItem(PLACE_KEY, JSON.stringify(all));
    } catch {}
  }
  const leftAt = (panel) => ({ pinned: panel.chatKeeper.pinned, seenAt: panel.chatKeeper.seenAt, anchor: topRow(panel) });
  /** The bubble at the top of the view and how far below the panel's top it starts. */
  function topRow(panel) {
    const top = panel.getBoundingClientRect().top;
    const node = [...panel.querySelectorAll(":scope > .bubble[data-at]")].find((n) => n.getBoundingClientRect().bottom > top);
    return node ? { at: node.dataset.at, side: node.dataset.side, offset: Math.round(node.getBoundingClientRect().top - top) } : null;
  }
  /** The newest bubble on screen counts as seen, only while the app is in front and the chat is not waiting to be placed. */
  function markChatSeen(panel) {
    const keep = panel?.chatKeeper;
    if (!keep || keep.opening || panel.inert || document.visibilityState === "hidden" || !panel.isConnected) return;
    const bottom = panel.getBoundingClientRect().bottom;
    const bubbles = panel.querySelectorAll(":scope > .bubble[data-at]");
    for (let i = bubbles.length - 1; i >= 0; i--) {
      // Only replies count: his own carry this phone's clock, and only replies are ever unread (firstUnseen).
      if (bubbles[i].dataset.side !== "them" || bubbles[i].getBoundingClientRect().top >= bottom) continue;
      const at = bubbles[i].dataset.at;
      if (!keep.seenAt || Date.parse(at) > Date.parse(keep.seenAt)) keep.seenAt = at;
      break;
    }
    savePlace(panel);
  }
  let scrollMark = 0;
  const chatScrolled = (panel) => {
    clearTimeout(scrollMark);
    scrollMark = setTimeout(() => markChatSeen(panel), 150);
  };

  /** A chat opened again (the sheet, the app, back from the background; David, 2026-11-21): left at the end, the first reply he has not seen goes to the top so a long one reads from its start (the end when the rest fits or none came); left scrolled up, his place, with the pill when something came. */
  function placeOpened(panel, keep) {
    // Behind the Orchestrator's question nothing is read: placed once it clears (G-110).
    if (panel.inert) return;
    const was = keep.opening;
    keep.opening = null;
    panel.querySelector(":scope > .chat-new")?.remove();
    panel.quietUnseen = false;
    keep.seenAt = was.seenAt || keep.seenAt;
    const bubbles = [...panel.querySelectorAll(":scope > .bubble[data-at]")];
    const unseen = QuietChat.firstUnseen(bubbles.map((n) => ({ side: n.dataset.side, at: n.dataset.at })), was.seenAt);
    const toTop = (node, offset) => keep.jump(panel.scrollTop + node.getBoundingClientRect().top - panel.getBoundingClientRect().top - offset);
    if (was.pinned !== false) {
      if (unseen < 0) keep.pin();
      else {
        // Its day heading with it when the day changed there.
        const node = bubbles[unseen];
        toTop(node.previousElementSibling?.classList.contains("chat-day") ? node.previousElementSibling : node, 8);
      }
      return markChatSeen(panel);
    }
    const anchor = was.anchor && (bubbles.find((n) => n.dataset.at === was.anchor.at && n.dataset.side === was.anchor.side) || bubbles.find((n) => Date.parse(n.dataset.at) >= Date.parse(was.anchor.at)));
    if (anchor) toTop(anchor, was.anchor.offset);
    else keep.jump(panel.scrollTop);
    if (unseen >= 0 && !keep.pinned) {
      panel.quietUnseen = true;
      panel.append(newPill(panel));
    }
    markChatSeen(panel);
  }

  /** A reply that came while he was scrolled up: a pill over the conversation that takes him down to it. */
  function newPill(panel) {
    return h("button", { type: "button", class: "chat-new", onclick: () => {
      panel.quietUnseen = false;
      QuietChat.keeper(panel).pin(!matchMedia("(prefers-reduced-motion: reduce)").matches);
      panel.querySelector(":scope > .chat-new")?.remove();
    } }, "New message ↓");
  }

  /** A new feed from golemd: the open chat fetches it; an Orchestrator sheet opened before any feed came (or after an empty one) opens again with it, unless a draft is typed there. */
  async function quietArrived() {
    const g = sheetGolem;
    if (!g || sheet.hidden || g.type !== "overlord") return;
    if (document.getElementById("sheet-quiet")) return refreshQuiet({ fetch: true });
    const draft = sheet.querySelector("form.message textarea")?.value.trim() || attached.get(`message:${g.workshopId}/${g.golemId}`)?.length;
    if (!draft && (await loadQuiet(g)) && sheetGolem === g) openGolem(g);
  }

  /** The open Orchestrator chat drawn again: fetch (a quiet event, a message sent) opens the feed anew; otherwise the last one, with the newest said list and state. */
  async function refreshQuiet({ fetch = false, said = null } = {}) {
    const g = sheetGolem;
    const panel = document.getElementById("sheet-quiet");
    if (!g || !panel || sheet.hidden || panel.dataset.golem !== quietKey(g)) return;
    // A need came, or was settled elsewhere: the sheet draws again (the row's words are kept in drafts).
    const body = sheet.querySelector(":scope > .chat-sheet");
    if (body && body.dataset.needs !== needsMark(g)) return openGolem(allPanes(feed).find((p) => p.workshopId === g.workshopId && p.golemId === g.golemId) || g);
    const asked = ++quietAsked;
    const cached = quietShown?.key === quietKey(g) ? quietShown : null;
    // A chat waiting to be placed fetches whoever asks (the app's own return poll overtakes the chat's fetch), so it is placed on the newest feed.
    const fresh = fetch || !cached || Boolean(panel.chatKeeper?.opening);
    const [view, list] = await Promise.all([
      fresh ? loadQuiet(g) : cached.view,
      // The said list each time, as the thread was: a gw reply answer lands on it, not in the feed.
      said || api("GET", `/api/said/${encodeURIComponent(g.workshopId)}/${encodeURIComponent(g.golemId)}`).catch(() => null).then((got) => (got ? openSaid(g, got) : cached?.said || [])),
    ]);
    // Only the newest ask draws, and only into this golem's own panel.
    if (asked !== quietAsked || !view || sheetGolem !== g || !panel.isConnected) return;
    // The golem as the newest feed has it, so its working line follows the Board.
    const now = allPanes(feed).find((p) => p.workshopId === g.workshopId && p.golemId === g.golemId) || g;
    drawQuiet(panel, now, view, Array.isArray(list) ? list : [], { fetched: Boolean(fresh) });
  }

  /** David's last five messages and answers (and the one a push points at); overlord-to-overlord ones fold into "Between overlords". */
  function saidList(g, said, { focus = null, betweenOpen = false } = {}) {
    const { mine, between } = Thread.split(said, { focus });
    const own = (s) => s.kind === "message"
      ? threadLines(s, g.label || g.name)
      : [h("time", { datetime: s.at }, `${ago(s.at)} · you answered`), h("div", { class: "status" }, linked(s.text)), s.files?.length ? h("div", { class: "said-files" }, sentFiles(s)) : null];
    return [
      mine.length ? h("ul", { class: "history said" }, mine.map((s) => h("li", {}, own(s)))) : null,
      between.length ? h("details", { class: "between", open: betweenOpen }, [
        h("summary", {}, `Between overlords (${between.length})`),
        h("ul", { class: "history said" }, between.map((s) => h("li", {}, linkLines(s)))),
      ]) : null,
    ].filter(Boolean);
  }

  /** A golem's thread as the hub keeps it, its sealed messages, answers, replies and relays opened with this device's key. */
  async function openSaid(g, list) {
    if (!Array.isArray(list) || typeof Acts === "undefined") return list;
    return Acts.openThread(await openerOrNull(), g.workshopId, g.golemId, list);
  }

  /** A reply that lands while the sheet is open shows without reopening it. */
  async function refreshSaid() {
    const g = sheetGolem;
    // The chat has no thread (its own poll fetches the list); a flashing thread is not rebuilt mid-flash.
    if (!g || sheet.hidden || !document.getElementById("sheet-said") || document.querySelector("#sheet-said .flash")) return;
    const said = await openSaid(g, await api("GET", `/api/said/${encodeURIComponent(g.workshopId)}/${encodeURIComponent(g.golemId)}`).catch(() => null));
    const node = document.getElementById("sheet-said");
    if (said && node && sheetGolem === g) node.replaceChildren(...saidList(g, said, { focus: sheetFocus, betweenOpen: Boolean(node.querySelector("details.between[open]")) }));
  }

  async function openGolem(g, about = {}) {
    sheetGolem = g;
    sheetFocus = about.said || null;
    let history = [];
    let said = [];
    let quiet = null;
    const ref = `${encodeURIComponent(g.workshopId)}/${encodeURIComponent(g.golemId)}`;
    [history, said, quiet] = await Promise.all([api("GET", `/api/history/${ref}`).then((got) => opened("history", feed?.accountId, g.workshopId, g.golemId, got)).catch(() => []), api("GET", `/api/said/${ref}`).catch(() => []).then((list) => openSaid(g, list)), loadQuiet(g).catch(() => null)]);
    const marks = { done: "✓", current: "▸", pending: "·" };
    const asks = asksOf(g);
    const parts = QuietChat.sheetParts(Boolean(quiet));
    // The Orchestrator's question leads its chat and blocks the conversation until answered or put off (G-110).
    const split = parts.chat ? askSplit(asks) : null;
    const asking = Boolean(split?.lead.length);
    // The open chat's own panel carries over a redraw of its sheet (a need came or went, a send): its place and photos stay (G-108).
    const was = document.getElementById("sheet-quiet");
    const carried = quiet && !sheet.hidden && was?.dataset.golem === quietKey(g) ? was : null;
    const place = carried && { top: carried.scrollTop, pinned: carried.chatKeeper?.pinned !== false };
    const body = h("div", { class: `sheet-body${parts.chat ? " chat-sheet" : ""}${asking ? " asking" : ""}`, "data-needs": parts.chat ? needsMark(g) : null }, [
      h("div", { class: "sheet-head" }, [
        h("div", { class: "sheet-grip", "aria-hidden": "true" }),
        h("div", { class: "row" }, [
          h("div", { class: "grow" }, [h("h2", { id: "sheet-title" }, g.label || g.name), h("div", { class: "card-meta" }, metaLine([g.workshop, g.workspace, g.flow], g.account))]),
          pill(g.state, g),
          parts.chat ? h("button", { type: "button", class: "sheet-close sheet-x", "aria-label": "Close", onclick: closeSheet }, "✕") : null,
        ]),
      ]),
      // The chat's needs sit over its message row (messageForm); a line only for a need with no card.
      ...(parts.chat ? [g.needsYou && !asks.length ? h("p", { class: "card-attention chat-attention" }, ["Needs you: ", ...linked(g.needsYou)]) : null]
        : g.type === "overlord"
        ? [g.needsYou ? h("p", { class: "card-attention" }, ["Needs you: ", ...linked(g.needsYou)]) : null,
          // A sheet opened from a push leads with what the overlord asks, to answer here as on its card.
          ...(asks.length ? [h("h3", {}, "Needs you"), h("div", { class: "stack" }, asks.map(askItem))] : [])]
        // A golem's needs went to its overlord: its controls stay here as a fallback, under the overlord's name.
        : [g.needsYou ? h("p", { class: "card-status" }, [`Waiting on ${overlordOf(g)}: `, ...linked(g.needsYou)]) : null,
          ...(asks.length ? [h("h3", {}, `Asked of ${overlordOf(g)}`), h("p", { class: "note" }, `${overlordOf(g)} handles this or asks you. Answer here only if it can't.`), h("div", { class: "stack" }, asks.map(askItem))] : [])]),
      // The Orchestrator's chat as its desktop Quiet view shows it, when its workshop sends the feed (sealed only).
      ...(quiet ? [carried || h("div", { class: "chat", id: "sheet-quiet", "data-golem": quietKey(g), role: "log", "aria-live": "off", "aria-label": `Conversation with ${g.label || g.name}` }), h("div", { class: "sr-only", id: "sheet-quiet-news", "aria-live": "polite" })] : []),
      ...messageForm(g, said, { quiet: Boolean(quiet), split }),
      ...(parts.steps && g.steps?.length ? [h("h3", {}, "Steps"), h("ol", { class: "step-list" }, g.steps.map((s) => h("li", { "data-state": s.state }, [h("span", { class: "mark", "aria-label": s.state }, marks[s.state] || "·"), h("span", {}, s.text)])))] : []),
      // Where it stands in one line; the flips themselves only on a tap.
      ...(!parts.history ? [] : history.length
        ? [h("details", { class: "status-history" }, [h("summary", {}, `Status history: ${Thread.summary(history, { label: rowLabel, time: dayTime, count: foldHistory(history).length })}`), historyList(history)])]
        : [h("h3", {}, "Status history"), h("p", { class: "note" }, g.status ? "No changes in the last 7 days." : "No status lines (this workspace may send names and steps only).")]),
      parts.closeButton ? h("p", {}, h("button", { type: "button", class: "sheet-close", onclick: closeSheet }, "Close")) : null,
    ]);
    sheet.replaceChildren(body);
    sheet.hidden = false;
    // Moving the panel into the new sheet drops its scroll: back to the newest, or to where he was.
    if (carried) {
      if (place.pinned) carried.chatKeeper?.follow();
      else carried.scrollTop = place.top;
    }
    fitChatToKeyboard();
    // Drawn once the sheet is in place, so it can scroll to its newest bubble.
    const quietPanel = body.querySelector("#sheet-quiet");
    // Behind the question: seen, dimmed, out of reach (no taps, no focus, not read out) until it clears; its place is kept (G-108).
    if (quietPanel) quietPanel.inert = asking;
    // A chat opened afresh is placed as he left it on this phone (rule 4); none saved: the newest.
    if (quiet && quietPanel && !carried) QuietChat.keeper(quietPanel).opening = loadPlace(quietKey(g));
    if (quiet && quietPanel) drawQuiet(quietPanel, g, quiet, said, { fetched: true });
    // A tap on the dimmed backdrop closes it.
    sheet.onclick = (e) => {
      if (e.target === sheet) closeSheet();
    };
    // Scrolling the chat never moves the sheet (David, 2026-11-20): only its handle and header drag it.
    if (typeof SheetDrag !== "undefined") SheetDrag.attach({ body, handles: [body.querySelector(".sheet-head")], onClose: closeSheet, reducedMotion: () => matchMedia("(prefers-reduced-motion: reduce)").matches, contentPull: !parts.chat });
    (body.querySelector(".ask-first") || body.querySelector(".sheet-close"))?.focus({ preventScroll: true });
    flashAbout(body, about);
  }

  /** A push's ask or message in the open sheet: scrolled to the middle, its border flashing a moment so the eye lands there. */
  function flashAbout(body, { ask, said }) {
    const target = (ask && body.querySelector(`[data-ask="${CSS.escape(ask)}"]`)) || (said && body.querySelector(`[data-said="${CSS.escape(said)}"]`));
    if (!target) return;
    // A bubble a push points at is read where it is: the chat stops following the newest.
    const chat = target.closest("#sheet-quiet")?.chatKeeper;
    if (chat) chat.pinned = false;
    // In the chat at once: a smooth scroll starting at the end would read as staying there.
    target.scrollIntoView({ block: "center", behavior: chat || matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    target.classList.remove("flash");
    void target.offsetWidth; // a second push for the same item flashes again
    target.classList.add("flash");
    target.addEventListener("animationend", () => target.classList.remove("flash"), { once: true });
  }

  const HISTORY_SHOWN = 20;
  const clockTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const dayTime = (iso) => (dayHeading(iso) === "Today" ? clockTime(iso) : `${dayHeading(iso)} ${clockTime(iso)}`);
  function dayHeading(iso) {
    const day = new Date(iso).toDateString();
    const today = new Date();
    if (day === today.toDateString()) return "Today";
    if (day === new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).toDateString()) return "Yesterday";
    return new Date(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  }
  // Rows recorded before the hub kept "attention" are read from their state.
  const attentionOf = (e) => e.attention ?? (e.state === "blocked" ? "blocked" : e.state === "done" ? "done" : "");
  const rowLabel = (e) => (attentionOf(e) === "blocked" && e.state !== "blocked" ? "Needs you" : STATE_LABEL[e.state] || e.state);

  /** History oldest first, made readable: a repeat of the row before goes, and a change with no status line or new step folds into the row before it that has words. */
  function foldHistory(list) {
    const rows = [];
    for (const e of list) {
      const prev = rows[rows.length - 1];
      const sameStep = (e.step ?? null) === (prev?.step ?? null);
      const lastAttention = prev && attentionOf(prev.flips.at(-1) || prev);
      if (prev && e.status === prev.status && sameStep && attentionOf(e) === lastAttention) continue;
      // Needing you, then back to the same words: one row with its flips, not the words twice.
      if (prev && prev.status && (!e.status || e.status === prev.status) && sameStep) {
        if (attentionOf(e) !== lastAttention) prev.flips.push(e);
        continue;
      }
      rows.push({ ...e, flips: [] });
    }
    return rows;
  }

  function historyRow(r) {
    const words = r.status ? linked(r.status) : r.step ? [`Step: ${r.step}`] : null;
    return h("li", {}, [
      h("time", { datetime: r.at }, `${clockTime(r.at)} · ${rowLabel(r)}`),
      words ? h("div", { class: "status" }, words) : null,
      r.flips.length ? h("div", { class: "flips" }, `then ${r.flips.map((f) => `${rowLabel(f)} ${clockTime(f.at)}`).join(", ")}`) : null,
    ]);
  }

  /** Newest first under day headings, 20 rows at a time. */
  function historyList(history) {
    const rows = foldHistory(history).reverse();
    const list = h("div", { class: "history-days" });
    let shown = HISTORY_SHOWN;
    const draw = () => {
      let day = null;
      let ul = null;
      list.replaceChildren();
      for (const r of rows.slice(0, shown)) {
        if (dayHeading(r.at) !== day) {
          day = dayHeading(r.at);
          ul = h("ul", { class: "history" });
          list.append(h("h4", { class: "day" }, day), ul);
        }
        ul.append(historyRow(r));
      }
      if (rows.length > shown) list.append(h("button", { type: "button", class: "more", onclick: () => { shown += HISTORY_SHOWN; draw(); } }, `Show more (${rows.length - shown})`));
    };
    draw();
    return list;
  }

  /** The chat sheet held inside what the keyboard leaves, so its message row sits on the keyboard and nothing scrolls under it; other sheets stay as they are. */
  function fitChatToKeyboard() {
    const vv = window.visualViewport;
    const chat = !sheet.hidden && sheet.querySelector(":scope > .chat-sheet");
    // From where the app's column ends: a Home Screen app's can end short of innerHeight (frame.js).
    const frameBottom = chat && Frame.frameBottom(document.getElementById("app").getBoundingClientRect().bottom, window.innerHeight);
    const typing = Boolean(chat && document.activeElement?.closest(".chat-sheet form.message"));
    const fit = chat && vv ? QuietChat.keyboard({ frameBottom, height: vv.height, offsetTop: vv.offsetTop, scale: vv.scale, typing }) : { open: false, top: 0, bottom: 0 };
    const opened = fit.open && !sheet.classList.contains("keyboard");
    sheet.classList.toggle("keyboard", fit.open);
    sheet.style.setProperty("--vv-top", `${fit.top}px`);
    sheet.style.setProperty("--vv-bottom", `${fit.bottom}px`);
    // At the newest, it stays in sight as the keyboard comes up and the conversation shrinks (its keeper also sees the resize); scrolled up, it stays put.
    if (opened) document.getElementById("sheet-quiet")?.chatKeeper?.follow();
  }
  // Leaving the app saves the chat's place; back in front, it is placed as on opening once its feed is fetched again (rule 4).
  document.addEventListener("visibilitychange", async () => {
    const panel = !sheet.hidden && document.getElementById("sheet-quiet");
    const keep = panel?.chatKeeper;
    if (!keep) return;
    if (document.visibilityState === "hidden") {
      // Nothing follows while away: what comes is placed on return.
      keep.opening ||= leftAt(panel);
      keep.pinned = false;
      return savePlace(panel);
    }
    await refreshQuiet({ fetch: true }).catch(() => {});
    // The fetch drew nothing (offline, or the sheet drew again): placed with what it has.
    if (keep.opening && panel.isConnected) placeOpened(panel, keep);
  });
  window.addEventListener("pagehide", () => savePlace(document.getElementById("sheet-quiet")));
  window.visualViewport?.addEventListener("resize", fitChatToKeyboard);
  window.visualViewport?.addEventListener("scroll", fitChatToKeyboard);
  // Focus leaving the box can come before the viewport grows back, or with no resize at all.
  sheet.addEventListener("focusin", fitChatToKeyboard);
  sheet.addEventListener("focusout", () => setTimeout(fitChatToKeyboard, 0));

  function closeSheet() {
    savePlace(document.getElementById("sheet-quiet"));
    sheetGolem = null;
    sheetFocus = null;
    const was = !sheet.hidden;
    sheet.hidden = true;
    sheet.replaceChildren();
    fitChatToKeyboard();
    // A pick or words given in the sheet show on the Fleet copy of that ask too.
    if (was) quietRender();
  }

  // ---------- changelog ----------

  const AREAS = { desktop: "Desktop", phone: "Mobile", fleet: "Fleet" };
  const dismissed = new Set(); // What's new ids dismissed on this page

  function changeItem(e) {
    return h("li", { class: "change", "data-entry": e.id }, [
      h("span", { class: "change-area" }, AREAS[e.area] || e.area),
      h("span", { class: "change-text" }, [e.text, e.missingFrom?.length ? h("span", { class: "note" }, ` Not on ${e.missingFrom.join(", ")} yet.`) : null]),
    ]);
  }

  /** What's new after an update: on Fleet under what needs you, never above it. See all opens the changelog; both record them as seen. */
  function whatsNewCard() {
    // A poll that started before Got it may still carry them: dismissed ids stay hidden.
    const fresh = (feed?.whatsNew || []).filter((e) => !dismissed.has(e.id));
    if (!fresh.length) return [];
    const more = fresh.length - 3;
    return [h("section", { class: "panel whats-new", "aria-label": "What's new" }, [
      h("strong", { class: "whats-new-title" }, "What's new"),
      h("ul", { class: "changes" }, fresh.slice(0, 3).map(changeItem)),
      more > 0 ? h("p", { class: "note" }, `And ${more} more in the changelog.`) : null,
      h("div", { class: "row actions" }, [
        h("button", { type: "button", onclick: () => (markSeen(fresh), openChangelog()) }, "See all changes"),
        h("button", { type: "button", class: "primary", onclick: () => markSeen(fresh) }, "Got it"),
      ]),
    ])];
  }

  async function markSeen(entries) {
    for (const e of entries) dismissed.add(e.id);
    quietRender();
    try {
      const out = await api("POST", "/api/changelog/seen", { ids: entries.map((e) => e.id) });
      feed.whatsNew = out.whatsNew || [];
    } catch (error) {
      toast(error.message, true);
    }
    quietRender();
  }

  /** Every change the paired workshops and the hub have, by day, newest first. */
  async function openChangelog() {
    let entries;
    try {
      entries = (await api("GET", "/api/changelog")).entries || [];
    } catch (error) {
      return toast(error.message, true);
    }
    const days = [];
    for (const e of entries) {
      if (days.at(-1)?.date !== e.date) days.push({ date: e.date, entries: [] });
      days.at(-1).entries.push(e);
    }
    const body = h("div", { class: "sheet-body" }, [
      h("div", { class: "sheet-head" }, [h("div", { class: "sheet-grip", "aria-hidden": "true" }), h("h2", { id: "sheet-title" }, "Changelog"), h("div", { class: "card-meta" }, "What changed in Golemworks, newest first")]),
      ...(days.length
        ? days.flatMap((d) => [h("h3", {}, dayHeading(`${d.date}T12:00:00`)), h("ul", { class: "changes" }, d.entries.map(changeItem))])
        : [h("p", { class: "note" }, "No changes recorded yet. A workshop sends its list once it runs a version that has one.")]),
      h("p", {}, h("button", { type: "button", class: "sheet-close", onclick: closeSheet }, "Close")),
    ]);
    sheet.replaceChildren(body);
    sheet.hidden = false;
    sheet.onclick = (e) => {
      if (e.target === sheet) closeSheet();
    };
    if (typeof SheetDrag !== "undefined") SheetDrag.attach({ body, handles: [body.querySelector(".sheet-head")], onClose: closeSheet, reducedMotion: () => matchMedia("(prefers-reduced-motion: reduce)").matches });
  }

  /** The Settings screen (#settings, or the older #overlords): Encryption first, where people look for it, then the overlords' rank and the rest. */
  function overlordsView() {
    if (!feed) return loading();
    const out = [];
    const encryption = encryptionPanel();
    // A required account never sees encryption by name: its group is the devices list (README "Encryption devices").
    if (encryption) out.push(h("h2", { class: "group", id: "encryption" }, feed.encryption?.state === "required" ? "Your devices" : "Encryption"), encryption);
    out.push(h("h2", { class: "group" }, "Overlords"));
    if (!feed.workshops.length) out.push(h("p", { class: "note" }, "No overlords yet: pair a workshop below."));
    else {
      out.push(h("p", { class: "note" }, "Drag to rank: rank orders the overlords at the top of Fleet. Only an overlord needing you sends a notification; a golem's need goes to its overlord."));
      out.push(rankList());
    }
    out.push(h("h2", { class: "group" }, "Workshops"), workshopsPanel());
    // The phone shows a computer how to install Golemworks; the desktop app is installed already.
    if (!DESKTOP && (downloads?.installable.windows || downloads?.installable.mac)) out.push(h("h2", { class: "group", id: "install" }, "Install on a computer"), installPanel());
    if (link && link.workshops.length > 1) out.push(h("h2", { class: "group" }, "Workshop link"), linkPanel());
    if (services?.length) out.push(h("h2", { class: "group" }, "Services"), servicesPanel());
    if (operator) out.push(h("h2", { class: "group" }, "Accounts"), accountsPanel());
    out.push(h("h2", { class: "group" }, DESKTOP ? "Passkeys" : "This device"), phonePanel());
    out.push(h("h2", { class: "group" }, DESKTOP ? "Approvals and security changes" : "Approvals from Mobile"), approvalsPanel());
    out.push(h("h2", { class: "group" }, "Changelog"), h("div", { class: "panel stack" }, [h("p", { class: "note" }, "What changed in Golemworks on the desktop, in Mobile and in the fleet."), h("button", { type: "button", onclick: openChangelog }, "See what changed")]));
    return out;
  }

  /** Every approval, gate decision, Resume and Unpause sent from a phone in the last 7 days: when, what, from where. */
  function approvalsPanel() {
    if (!securityLog) return h("p", { class: "note" }, "Loading");
    if (!securityLog.length) return h("p", { class: "note" }, "None in the last 7 days.");
    return h("ul", { class: "panel history approvals" }, securityLog.slice(0, 20).map((e) => h("li", {}, [
      h("time", { datetime: e.at }, `${dayHeading(e.at)} ${clockTime(e.at)} · ${e.device || "a device"} at ${e.client || "?"}`),
      h("div", {}, `${e.golem ? `${e.golem}: ` : ""}${e.choice}`),
      h("div", { class: "status" }, e.what),
    ])));
  }

  function rankList() {
    const list = h("ol", { class: "rank-list" });
    const items = feed.workshops.map((w, i) => {
      const item = h("li", { class: "rank-item", "data-id": w.id }, [
        h("span", { class: "handle", "aria-hidden": "true" }, "⠿"),
        h("span", { class: "rank-no" }, String(w.rank)),
        h("div", { class: "grow" }, [h("span", { class: "rank-name" }, `${w.overlord?.name || "Overlord"} · ${w.name}`)]),
        h("button", { class: "move", type: "button", "aria-label": `Move ${w.name} up`, disabled: i === 0, onclick: () => move(w.id, -1) }, "▲"),
        h("button", { class: "move", type: "button", "aria-label": `Move ${w.name} down`, disabled: i === feed.workshops.length - 1, onclick: () => move(w.id, 1) }, "▼"),
      ]);
      dragOn(item, list);
      return item;
    });
    list.append(...items);
    return list;
  }

  async function saveOrder(order) {
    try {
      feed = await api("PUT", "/api/overlords", { order });
    } catch (error) {
      toast(error.message, true);
    }
    render();
  }

  function move(id, by) {
    const order = feed.workshops.map((w) => w.id);
    const i = order.indexOf(id);
    order.splice(i, 1);
    order.splice(Math.max(0, Math.min(order.length, i + by)), 0, id);
    saveOrder(order);
  }

  /** Drag by the handle (touch or mouse): the item follows the finger and the list reorders under it. */
  function dragOn(item, list) {
    const handle = item.querySelector(".handle");
    handle.addEventListener("pointerdown", (down) => {
      down.preventDefault();
      handle.setPointerCapture(down.pointerId);
      dragging = true;
      item.classList.add("dragging");
      const startY = down.clientY;
      let offset = 0;
      const onMove = (e) => {
        offset = e.clientY - startY;
        item.style.transform = `translateY(${offset}px)`;
        const siblings = [...list.children].filter((n) => n !== item);
        const mid = item.getBoundingClientRect().top + item.offsetHeight / 2;
        const before = siblings.find((n) => mid < n.getBoundingClientRect().top + n.offsetHeight / 2);
        const at = before || null;
        if (at !== item.nextSibling) {
          const top = item.getBoundingClientRect().top;
          list.insertBefore(item, at);
          offset -= item.getBoundingClientRect().top - top;
          item.style.transform = `translateY(${offset}px)`;
        }
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        item.classList.remove("dragging");
        dragging = false;
        item.style.transform = "";
        const order = [...list.children].map((n) => n.dataset.id);
        if (order.join() !== feed.workshops.map((w) => w.id).join()) saveOrder(order);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp, { once: true });
      handle.addEventListener("pointercancel", onUp, { once: true });
    });
  }

  function workshopsPanel() {
    const panel = h("div", { class: "panel stack" });
    if (pairing && Date.parse(pairing.expiresAt) > Date.now()) {
      panel.append(
        h("div", { class: "note" }, "On the desktop: Settings > Mobile, enter this hub's address and the code."),
        h("div", { class: "code", "aria-label": `Pairing code ${pairing.code.split("").join(" ")}` }, pairing.code),
        h("div", { class: "note" }, `${HUB || location.origin} · expires ${new Date(pairing.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}, works once`),
      );
    } else {
      panel.append(h("button", { type: "button", class: "primary", onclick: newCode }, "Pair a workshop"));
    }
    if (workshops?.length) {
      panel.append(h("ul", { class: "list" }, workshops.map((w) => {
        const info = feed?.workshops.find((f) => f.id === w.id);
        return h("li", { class: "workshop-row" }, [
          h("div", { class: "grow" }, [
            h("span", { class: "rank-name" }, w.name),
            h("span", { class: "note" }, `${w.online ? (w.stale ? `Connected, not updating (${w.stale})` : "Connected") : `Offline${w.lastSeenAt ? `, seen ${ago(w.lastSeenAt)}` : ""}`} · paired ${new Date(w.createdAt).toLocaleDateString()}`),
            h("span", { class: "note version-line" }, versionLine(info)),
            autoUpdateSwitch(w, info),
            namesOnlySwitches(w, info),
          ]),
          h("button", { type: "button", class: "small danger", onclick: () => revoke(w) }, "Revoke"),
        ]);
      })));
    }
    return panel;
  }

  /** Deployed apps that file tasks with their own token: a golem makes one from a workshop; Revoke (Face ID) stops it filing. */
  /** Install commands (README "Downloads"): each holds its own download token, shown once, for 24 hours and 3 downloads. */
  function installPanel() {
    const { windows, mac } = downloads.installable;
    const panel = h("div", { class: "panel stack" }, [h("p", { class: "note" }, `Run the command on the computer: ${[windows ? "in PowerShell on Windows" : null, mac ? "in Terminal on a Mac" : null].filter(Boolean).join(", or ")}. It installs Golemworks without an admin prompt; then pair it above. Each command works for 24 hours and 3 downloads.`)]);
    const shown = installCommand && Date.parse(installCommand.expiresAt) > Date.now() && downloads.commands.some((c) => c.id === installCommand.id && c.state === "open") ? installCommand : null;
    if (shown) {
      for (const [label, command, on] of [["Windows (PowerShell)", shown.windows, windows], ["Mac (Terminal)", shown.mac, mac]]) {
        if (!on) continue;
        panel.append(h("div", { class: "row" }, [
          h("div", { class: "grow stack" }, [h("span", { class: "rank-name" }, label), h("span", { class: "invite-url" }, command)]),
          h("button", { type: "button", class: "small", onclick: () => copyCommand(command) }, "Copy"),
        ]));
      }
    }
    const open = downloads.commands.filter((c) => c.state === "open");
    if (open.length) {
      panel.append(h("ul", { class: "list" }, open.map((c) => h("li", {}, [
        h("div", { class: "grow" }, [h("span", { class: "rank-name" }, c.id === shown?.id ? "This command" : "An earlier command"), h("span", { class: "note" }, `${c.uses} of ${c.maxUses} downloads · until ${new Date(c.expiresAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`)]),
        h("button", { type: "button", class: "small danger", onclick: () => revokeInstall(c) }, "Revoke"),
      ]))));
    }
    panel.append(h("div", { class: "row" }, [h("button", { type: "button", class: `small${shown ? "" : " primary"}`, onclick: newInstallCommand }, shown ? "Show a new command" : "Show install command")]));
    return panel;
  }

  async function newInstallCommand() {
    try {
      const made = await api("POST", "/api/downloads");
      installCommand = { id: made.id, windows: made.windows, mac: made.mac, expiresAt: made.expiresAt };
      downloads = { installable: made.installable, commands: made.commands };
    } catch (error) {
      toast(error.message, true);
    }
    render();
  }

  async function copyCommand(command) {
    try {
      await navigator.clipboard.writeText(command);
      toast("Copied. Paste it on the computer.");
    } catch {
      toast("Could not copy: press and hold the command to select it.", true);
    }
  }

  /** True only when the clipboard took the text; never throws. */
  async function tryCopy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  /** A link's Copy button: the write starts inside the tap, as iOS requires; refused, the link is selected for the phone's own Copy. */
  async function copyLink(url, shown, said) {
    if (await tryCopy(url)) {
      toast(said);
      return true;
    }
    getSelection()?.selectAllChildren(shown);
    toast("Could not copy. Press and hold the link, then tap Copy.", true);
    return false;
  }

  /** A just-made link (`made`: signupLink or invite) with its own Copy button; a copy that works marks it copied. */
  function linkRow(made, note, said) {
    const shown = h("span", { class: "invite-url" }, made.url);
    return h("div", { class: "row" }, [
      h("div", { class: "grow stack" }, [h("span", { class: "note" }, note), shown]),
      h("button", { type: "button", class: "small", onclick: () => copyLink(made.url, shown, said).then((ok) => ok && ((made.copied = true), render())) }, "Copy"),
    ]);
  }

  async function revokeInstall(c) {
    if (!confirm("Revoke this install command? It downloads nothing after this.")) return;
    try {
      downloads = await api("DELETE", `/api/downloads/${encodeURIComponent(c.id)}`);
      if (installCommand?.id === c.id) installCommand = null;
      toast("Install command revoked.");
    } catch (error) {
      toast(error.message, true);
    }
    render();
  }

  function servicesPanel() {
    return h("div", { class: "panel stack" }, [
      h("p", { class: "note" }, "Apps that file tasks for you. Each token files tasks and does nothing else."),
      h("ul", { class: "list" }, services.map((svc) => h("li", {}, [
        h("div", { class: "grow" }, [
          h("span", { class: "rank-name" }, svc.name),
          h("span", { class: "note" }, svc.revokedAt ? `Revoked ${ago(svc.revokedAt)}` : `${svc.lastUsedAt ? `Filed ${ago(svc.lastUsedAt)}` : "Nothing filed yet"} · made ${new Date(svc.createdAt).toLocaleDateString()}${svc.createdBy ? ` by ${svc.createdBy}` : ""}`),
        ]),
        svc.revokedAt ? null : h("button", { type: "button", class: "small danger", onclick: () => revokeService(svc) }, "Revoke"),
      ]))),
    ]);
  }

  /** The hub operator's: how many accounts and what each holds, as counts only, and the sign-up links that make new ones. */
  function accountsPanel() {
    const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    const panel = h("div", { class: "panel stack" }, [
      h("p", { class: "note" }, `${operator.accounts} of ${operator.maxAccounts} accounts. Counts only: the hub cannot read what any account holds.`),
      h("ul", { class: "list" }, operator.rows.map((r) => h("li", { "data-account": String(r.account) }, [
        h("div", { class: "grow" }, [
          h("span", { class: "rank-name" }, r.yours ? `Account ${r.account} (yours)` : `Account ${r.account}`),
          h("span", { class: "note" }, `${r.workshops} workshop${r.workshops === 1 ? "" : "s"} (${r.online} online) · ${r.passkeys} passkey${r.passkeys === 1 ? "" : "s"} · ${r.phones} with notifications · ${mb(r.bytes)} · ${r.encryption === "required" ? "" : `older account: encryption ${r.encryption} · `}${r.lastSeenAt ? `seen ${ago(r.lastSeenAt)}` : "not seen yet"} · made ${r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "before accounts"}`),
        ]),
      ]))),
    ]);
    if (signupLink && Date.parse(signupLink.expiresAt) > Date.now()) {
      panel.append(linkRow(signupLink, `Sign-up link${signupLink.copied ? ", copied" : ""}: one new account, one use, until ${new Date(signupLink.expiresAt).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}`, "Sign-up link copied."));
    }
    const links = operator.signups.filter((l) => l.state === "open" || Date.parse(l.usedAt || l.revokedAt || l.expiresAt) > Date.now() - 7 * 864e5);
    if (links.length) {
      panel.append(h("ul", { class: "list" }, links.map((l) => h("li", {}, [
        h("div", { class: "grow" }, [
          h("span", { class: "rank-name" }, `Sign-up link made ${new Date(l.createdAt).toLocaleDateString()}`),
          h("span", { class: "note" }, l.state === "open" ? `Open until ${new Date(l.expiresAt).toLocaleDateString()}` : l.state === "used" ? `Used ${ago(l.usedAt)}` : l.state === "revoked" ? `Revoked ${ago(l.revokedAt)}` : "Expired"),
        ]),
        l.state === "open" ? h("button", { type: "button", class: "small danger", onclick: () => revokeSignup(l) }, "Revoke") : null,
      ]))));
    }
    panel.append(h("div", { class: "row" }, [h("button", { type: "button", class: "small", onclick: newSignup }, "Make a sign-up link")]));
    return panel;
  }

  /** A 7-day, one-use link that makes a new, empty account; the operator sends it to the person it is for. */
  async function newSignup() {
    try {
      const { id, url, expiresAt } = await withFaceId(() => api("POST", "/api/signup-invites"));
      // After the request (and any Face ID check) the tap is spent: iOS refuses this write, so the link's own Copy button does it.
      const copied = await tryCopy(url);
      signupLink = { id, url, expiresAt, copied };
      toast(copied ? "Sign-up link copied." : "Sign-up link made: tap Copy next to it.");
    } catch (error) {
      toast(error.message, true);
    }
    await refreshLists();
    render();
  }

  async function revokeSignup(l) {
    if (!confirm("Revoke this sign-up link? Nobody can make an account with it after this.")) return;
    try {
      await withFaceId(() => api("DELETE", `/api/signup-invites/${encodeURIComponent(l.id)}`));
      if (signupLink?.id === l.id) signupLink = null;
      toast("Sign-up link revoked.");
    } catch (error) {
      toast(error.message, true);
    }
    await refreshLists();
    render();
  }

  async function revokeService(svc) {
    if (!confirm(`Revoke ${svc.name}? It cannot file tasks until a golem makes it a new token.`)) return;
    try {
      await withFaceId(() => api("DELETE", `/api/services/${encodeURIComponent(svc.id)}`));
      toast(`${svc.name} revoked.`);
    } catch (error) {
      toast(error.message, true);
    }
    await refreshLists();
    await load();
  }

  /** Overlords messaging each other through the hub: on with Face ID, off with one tap; the rules each message is checked against. */
  function linkPanel() {
    const panel = h("div", { class: "panel stack link-panel" });
    const names = link.workshops.map((w) => w.overlord).join(" and ");
    panel.append(h("div", { class: "row" }, [
      h("div", { class: "grow" }, [h("span", { class: "rank-name" }, "Overlords message each other"), h("span", { class: "note" }, link.on ? `On${link.changedAt ? ` since ${new Date(link.changedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}: ${names} can message each other, and both threads show it` : `Off: ${names} cannot message each other`)]),
      link.on ? h("button", { type: "button", class: "small danger", onclick: () => setLink(false) }, "Turn off") : h("button", { type: "button", class: "small primary", onclick: () => setLink(true) }, "Turn on"),
    ]));
    panel.append(h("p", { class: "note" }, "To or from a workshop with the work limits on, the hub refuses a message that breaks them:"), h("ul", { class: "rules" }, link.workRules.map((rule) => h("li", {}, rule))));
    panel.append(h("p", { class: "note" }, `Always: ${link.alwaysRules.join("; ").toLowerCase()}.`));
    panel.append(h("ul", { class: "list" }, link.workshops.map((w) => h("li", {}, [
      h("div", { class: "grow" }, [h("span", { class: "rank-name" }, w.name), h("span", { class: "note" }, `${w.overlord} · work limits ${w.limited ? "on" : "off"}`)]),
      h("button", { type: "button", class: `small${w.limited ? " danger" : ""}`, "aria-label": `${w.limited ? "Turn off" : "Turn on"} the work limits for ${w.name}`, onclick: () => setWorkLimits(w, !w.limited) }, w.limited ? "Lift limits" : "Limit"),
    ]))));
    return panel;
  }

  async function setLink(on) {
    try {
      // On takes a fresh Face ID; off goes at once, whatever the phone's Face ID.
      link = on ? await withFaceId(() => api("PUT", "/api/link", { on: true })) : await api("PUT", "/api/link", { on: false });
      toast(on ? "Workshop link on." : "Workshop link off: nothing more crosses, and what waited is dropped.");
    } catch (error) {
      toast(error.message, true);
    }
    render();
  }

  async function setWorkLimits(w, limited) {
    if (!limited && !confirm(`Lift the work limits for ${w.name}? Messages to and from it are then checked only for pairing codes, unless the other workshop keeps its limits.`)) return;
    try {
      link = limited ? await api("PUT", `/api/link/limits/${w.id}`, { limited: true }) : await withFaceId(() => api("PUT", `/api/link/limits/${w.id}`, { limited: false }));
    } catch (error) {
      toast(error.message, true);
    }
    render();
  }

  /** A workshop's version and what its last automatic update did, on one line. */
  function versionLine(info) {
    const v = info?.version;
    const parts = [v ? `Version ${v.commit}${v.date ? `, ${new Date(v.date).toLocaleDateString([], { month: "short", day: "numeric" })}` : ""}` : "Version unknown"];
    const u = info?.update;
    if (u?.failed) parts.push(`Update to ${u.failed.commit} failed`);
    else if (u?.state === "updating") parts.push("Updating now");
    else if (u?.last?.state === "updated" && u.last.at) parts.push(`Updated${u.last.to ? ` to ${u.last.to}` : ""} ${ago(u.last.at)}`);
    else if (u?.auto && u.state === "skipped" && u.note) parts.push(`Not updating: ${u.note}`);
    return parts.join(" · ");
  }

  /** Update automatically for one workshop: Face ID, then golemd flips its own setting. Off when the workshop is offline or too old to know it. */
  function autoUpdateSwitch(w, info) {
    const box = h("input", { type: "checkbox", disabled: !info?.update || info.online === false });
    box.checked = info?.update?.auto === true;
    box.addEventListener("change", async () => {
      const on = box.checked;
      box.disabled = true;
      try {
        const out = await withFaceId(() => api("POST", `/api/workshops/${encodeURIComponent(w.id)}/auto-update`, { on }));
        toast(out.unconfirmed ? "Sent; the workshop has not confirmed it yet" : `Update automatically is ${on ? "on" : "off"} for ${w.name}`);
      } catch (error) {
        box.checked = !on;
        toast(error.message, true);
      }
      await load();
    });
    return h("label", { class: "note auto-update" }, [box, " Update automatically"]);
  }

  /** Names and steps only, per workspace of a workshop: on at once, off with a passkey check; golemd flips its own setting. None from a golemd too old to take it. */
  function namesOnlySwitches(w, info) {
    if (!info?.workspaces?.length) return null;
    return h("div", { class: "names-only" }, [
      h("span", { class: "note" }, "Names and steps only (no status lines or ask text leave the PC):"),
      ...info.workspaces.map((space) => {
        const box = h("input", { type: "checkbox", disabled: info.online === false });
        box.checked = space.namesOnly;
        box.addEventListener("change", () => {
          const on = box.checked;
          box.disabled = true;
          const send = () => api("POST", `/api/workshops/${encodeURIComponent(w.id)}/names-only`, { workspace: space.name, on });
          // Off takes the passkey check, started inside this tap; on goes at once.
          (on ? send() : withFaceId(send))
            .then((out) => toast(out.unconfirmed ? "Sent; the workshop has not confirmed it yet" : `${space.name}: names and steps only ${on ? "on" : "off"}`))
            .catch((error) => {
              box.checked = !on;
              toast(error.message, true);
            })
            .then(load);
        });
        return h("label", { class: "note auto-update" }, [box, ` ${space.name}`]);
      }),
    ]);
  }

  /** A failed automatic update: what failed, that the workshop went back, and Got it. */
  function updateFailedItem(w) {
    const f = w.update.failed;
    return h("article", { class: "item ask attention kind-update", "data-state": "blocked" }, [
      h("div", { class: "item-head" }, [h("span", { class: "kind ask" }, "Update failed"), h("span", { class: "who" }, w.name), f.at ? h("span", {}, ago(f.at)) : null]),
      h("div", { class: "item-text" }, `Update to ${f.commit} failed: ${f.reason}`),
      h("div", { class: "item-does" }, "The workshop went back to the version it had and skips this commit. A newer one is tried on its own."),
      w.online === false ? h("div", { class: "item-foot" }, "Workshop offline") : h("div", { class: "answer-foot" }, [h("button", { type: "button", class: "small", onclick: async (e) => {
        e.target.disabled = true;
        try {
          await api("POST", `/api/workshops/${encodeURIComponent(w.id)}/update-ack`);
        } catch (error) {
          toast(error.message, true);
        }
        await load();
      } }, "Got it")]),
    ]);
  }

  async function newCode() {
    try {
      const before = (workshops || []).map((w) => w.id);
      pairing = { ...(await withFaceId(() => api("POST", "/api/pairing-codes"))), before };
    } catch (error) {
      toast(error.message, true);
    }
    render();
  }

  async function revoke(w) {
    if (!confirm(`Revoke ${w.name}? It stops sending until it is paired again.`)) return;
    try {
      await withFaceId(() => api("DELETE", `/api/workshops/${w.id}`));
      toast(`${w.name} revoked.`);
    } catch (error) {
      toast(error.message, true);
    }
    await refreshLists();
    await load();
  }

  async function refreshLists() {
    [workshops, passkeys, securityLog, link, services, operator, downloads] = await Promise.all([api("GET", "/api/workshops").catch(() => null), api("GET", "/api/passkeys").catch(() => null), api("GET", "/api/security-log").catch(() => null), api("GET", "/api/link").catch(() => null), api("GET", "/api/services").catch(() => null), me?.operator && !DESKTOP ? api("GET", "/api/operator").catch(() => null) : null, DESKTOP ? null : api("GET", "/api/downloads").catch(() => null)]);
    if (securityLog?.some((e) => e.sealed)) securityLog = Acts.openLog(await openerOrNull(), securityLog);
    // A code works once: a workshop that was not there when it was made used it, so the card goes back to Pair a workshop.
    if (pairing && workshops?.some((w) => !pairing.before.includes(w.id))) pairing = null;
  }

  /** Notifications for this phone: on, off or why not. */
  function pushRow() {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    const canPush = "serviceWorker" in navigator && "PushManager" in window;
    if (!me?.pushKey) return h("p", { class: "note" }, "Push is off on the hub (no VAPID keys).");
    if (!canPush) return h("p", { class: "note" }, standalone ? "This browser cannot receive pushes." : "To get pushes on iPhone: Share > Add to Home Screen, then open Golemworks from the Home Screen.");
    // On only with permission and a live subscription: the hub drops one the push service says is gone.
    const state = Notification.permission === "granted" && subscribed === false ? "default" : Notification.permission;
    return h("div", { class: "row" }, [
      h("div", { class: "grow" }, [h("span", { class: "rank-name" }, "Notifications"), h("span", { class: "note" }, state === "granted" ? "On for this device" : state === "denied" ? "Blocked in iOS Settings > Notifications" : "Off")]),
      state === "granted" ? h("button", { type: "button", class: "small", onclick: testPush }, "Send test") : h("button", { type: "button", class: "small primary", disabled: state === "denied", onclick: enablePush }, "Turn on"),
    ]);
  }

  function phonePanel() {
    const panel = h("div", { class: "panel stack" });
    // Notifications are the phone's; the desktop app shows its own.
    if (!DESKTOP) panel.append(pushRow());
    const theme = h("select", { "aria-label": "Theme", onchange: (e) => setTheme(e.target.value) }, [h("option", { value: "" }, "System"), h("option", { value: "light" }, "Light"), h("option", { value: "dark" }, "Dark")]);
    theme.value = document.documentElement.dataset.theme || "";
    panel.append(h("div", { class: "row" }, [h("div", { class: "grow" }, [h("span", { class: "rank-name" }, "Theme")]), theme]));
    if (passkeys) {
      const signing = passkeys.filter((p) => !p.pending).length;
      panel.append(h("ul", { class: "list" }, passkeys.map((p) => h("li", {}, [
        h("div", { class: "grow" }, [
          h("span", { class: "rank-name" }, p.name),
          h("span", { class: "note" }, p.pending ? `Waiting for approval · code ${p.pending.code}` : `Passkey · ${p.lastUsedAt ? `used ${ago(p.lastUsedAt)}` : `added ${new Date(p.createdAt).toLocaleDateString()}`}`),
        ]),
        // Approving a computer is the phone's: only if that computer shows the same code.
        p.pending && !DESKTOP ? h("button", { type: "button", class: "small primary", onclick: () => approvePasskey(p) }, "Approve") : null,
        p.pending || signing > 1 ? h("button", { type: "button", class: "small danger", onclick: () => removePasskey(p) }, p.pending ? "Refuse" : "Remove") : null,
      ]))));
    }
    if (invite && Date.parse(invite.expiresAt) > Date.now()) {
      panel.append(linkRow(invite, `Invite link for another device${invite.copied ? ", copied" : ""}: one use, until ${new Date(invite.expiresAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`, "Invite link copied."));
    }
    // Invite links come from the phone: on a computer a golem could read one.
    panel.append(h("div", { class: "row" }, [h("button", { type: "button", class: "small", onclick: () => registerPasskey() }, "Add a passkey"), DESKTOP ? null : h("button", { type: "button", class: "small", onclick: newInvite }, "Invite a device"), h("button", { type: "button", class: "small", onclick: signOut }, "Sign out")]));
    return panel;
  }

  /** Whether the hub refuses unencrypted writes (feed.encryption), Require or Stop requiring, the unencrypted copies held for deletion, and the phone's encryption devices. */
  function encryptionPanel() {
    // Set up, Stop requiring and Delete are the phone's: the hub refuses a computer's session for them.
    const said = typeof Enroll !== "undefined" ? Enroll.status(feed?.encryption, { phone: !DESKTOP && Boolean(enroll) }) : null;
    // Encryption devices are the phone's (public/enroll.js): remove a lost one, or reset when all are lost.
    const required = feed?.encryption?.state === "required";
    const devices = !DESKTOP ? enroll?.panel(render, { label: !required }) : null;
    // Required: only the devices list; Require, Stop requiring, Delete and the steps are for an older account not yet required.
    if (required) {
      // Copies the hub held from before encryption stay deletable, in plain words (a phone's own passkey and Face ID, as before).
      const older = !DESKTOP && said?.canDelete ? Enroll.older(feed.encryption) : null;
      if (!devices && !older) return null;
      const panel = h("div", { class: "panel stack", "data-encryption": "required" }, devices ? [devices] : []);
      if (older) panel.append(h("p", { class: "note" }, older), h("div", { class: "row" }, [h("button", { type: "button", class: "small danger", onclick: confirmDeletePlaintext }, "Delete older copies")]));
      return panel;
    }
    if (!said && !devices) return null;
    // Each workshop not enrolled yet gets the steps in order, done and current marked; the phone's sheets do the work.
    const guide = !DESKTOP && typeof EncryptionGuide !== "undefined" ? EncryptionGuide.notEnrolled(feed?.encryption) : [];
    const panel = h("div", { class: "panel stack", "data-encryption": said?.state || null });
    if (said) {
      panel.append(h("p", { class: "encryption-state" }, said.line));
      const buttons = [];
      if (said.canSetUp && !guide.length) buttons.push(h("button", { type: "button", class: "small primary", onclick: startEncryption }, "Set up encryption"));
      if (said.canRequire) buttons.push(h("button", { type: "button", class: "small primary", onclick: () => setRequired(true) }, "Require encryption"));
      if (said.canStop) buttons.push(h("button", { type: "button", class: "small", onclick: () => setRequired(false) }, "Stop requiring"));
      if (buttons.length) panel.append(h("div", { class: "row" }, buttons));
      if (said.held) panel.append(h("p", { class: "note" }, said.held));
      if (said.canDelete) panel.append(h("div", { class: "row" }, [h("button", { type: "button", class: "small danger", onclick: confirmDeletePlaintext }, "Delete unencrypted copies")]));
    }
    for (const name of guide) panel.append(stepsList(name, said?.canSetUp));
    if (devices) panel.append(devices);
    return panel;
  }

  /** One workshop's enrollment steps (public/encryption-guide.js); Set up encryption sits in step 1 while the account is off. */
  function stepsList(name, canSetUp) {
    const steps = EncryptionGuide.steps(feed.encryption, enroll?.view(), name);
    return h("div", { class: "stack", "data-steps": name }, [
      h("span", { class: "rank-name" }, `Set up ${name}`),
      h("ol", { class: "encryption-steps" }, steps.map((s) => h("li", { "data-step": s.state, "aria-current": s.state === "current" ? "step" : null }, [
        s.text,
        s.state === "todo" ? null : h("span", { class: "step-mark" }, s.state === "done" ? "Done" : "Now"),
        s.key === "account" && canSetUp ? h("button", { type: "button", class: "small primary", onclick: startEncryption }, "Set up encryption") : null,
      ]))),
    ]);
  }

  async function startEncryption() {
    // A fresh passkey check before any await, so Safari opens the passkey sheet from this tap.
    const sent = withFaceId(() => api("POST", "/api/encryption/start", {}));
    try {
      const encryption = await sent;
      if (feed && encryption && typeof encryption === "object") feed.encryption = encryption;
      toast("Encryption is on: Mobile here is making the account key");
    } catch (error) {
      toast(error.message, true);
      return render();
    }
    render();
    // The next sync sees encryption on and no device yet, so this phone makes the first key (public/enroll.js); no reload needed.
    await enroll?.refresh();
    load();
  }

  async function setRequired(on) {
    // A fresh passkey check before any await, so Safari opens the passkey sheet from this tap.
    const sent = withFaceId(async () => {
      if (on) return api("POST", "/api/encryption/required", { on });
      // Off is signed with the account key, so every device can tell this Stop requiring from the hub's own claim.
      const acts = await sealer();
      if (!acts) throw new Error("Mobile here has no encryption key for this account, so it cannot stop requiring encryption; nothing was sent");
      const stop = acts.seal("tasks", "encryption-stop", "stop", { at: new Date().toISOString(), required: false });
      return api("POST", "/api/encryption/required", { on: false, stop });
    });
    try {
      const encryption = await sent;
      if (feed && encryption && typeof encryption === "object") feed.encryption = encryption;
      // This phone's own Stop requiring: unencrypted tasks from the hub are expected again.
      if (!on) taskReader?.stopRequiring(myAccount());
      toast(on ? "Encryption is now required" : "Encryption is no longer required");
    } catch (error) {
      toast(error.message, true);
    }
    render();
    load();
  }

  function confirmDeletePlaintext() {
    const required = feed?.encryption?.state === "required";
    const body = showSheet([
      h("h2", { id: "sheet-title" }, required ? "Delete the older copies?" : "Delete the unencrypted copies?"),
      h("p", {}, required ? `${Enroll.older(feed.encryption) || ""} The hub deletes them for good; nothing else is touched. This cannot be undone.` : `${Enroll.status(feed?.encryption)?.held || ""} The hub deletes them for good; nothing encrypted is touched. This cannot be undone.`),
      h("div", { class: "row" }, [
        h("button", { type: "button", class: "sheet-close", onclick: closeSheet }, "Cancel"),
        h("button", { type: "button", class: "primary danger-fill", onclick: deletePlaintext }, "Delete them"),
      ]),
    ]);
    body.querySelector(".sheet-close")?.focus({ preventScroll: true });
  }

  async function deletePlaintext() {
    // A fresh passkey check before any await, so Safari opens the passkey sheet from this tap.
    const sent = withFaceId(() => api("POST", "/api/encryption/plaintext/delete", {}));
    closeSheet();
    try {
      const out = await sent;
      const items = out?.deleted?.items || 0;
      toast(`Deleted ${items} ${feed?.encryption?.state === "required" ? "older" : "unencrypted"} ${items === 1 ? "copy" : "copies"}`);
    } catch (error) {
      toast(error.message, true);
    }
    load();
  }

  function setTheme(value) {
    try {
      if (value) localStorage.setItem("gwh-theme", value);
      else localStorage.removeItem("gwh-theme");
    } catch {}
    if (value) document.documentElement.dataset.theme = value;
    else delete document.documentElement.dataset.theme;
  }

  function urlKey(base64) {
    const pad = "=".repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function enablePush() {
    try {
      // Permission already given: Face ID (when stale) opens inside this tap. Asked for the first time, iOS's prompt takes the tap.
      if (Notification.permission === "granted") await withFaceId(subscribePush);
      else {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") throw new Error("Notifications were not allowed.");
        await subscribePush();
      }
    } catch (error) {
      toast(error.status === 428 ? `Confirm with ${CHECK}: tap Turn on again` : error.message, true);
    }
    render();
  }

  async function subscribePush() {
    const registration = await navigator.serviceWorker.ready;
    const subscription = (await registration.pushManager.getSubscription()) || (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(me.pushKey) }));
    await api("POST", "/api/push/subscribe", subscription.toJSON());
    subscribed = true;
    toast("Notifications are on for this device.");
  }

  /** At each start: hand the hub this phone's subscription again (it is an upsert), or learn there is none. */
  async function syncPush() {
    if (!me?.pushKey || !("serviceWorker" in navigator) || !("PushManager" in window) || Notification.permission !== "granted") return;
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) await api("POST", "/api/push/subscribe", subscription.toJSON());
      subscribed = Boolean(subscription);
    } catch {
      subscribed = false;
    }
  }

  /** A one-day, one-use link that lets another phone add its own passkey. */
  async function newInvite() {
    try {
      const { url, expiresAt } = await withFaceId(() => api("POST", "/api/passkey-invites"));
      const copied = await tryCopy(url); // refused on iOS once the tap is spent, as in newSignup
      invite = { url, expiresAt, copied };
      toast(copied ? "Invite link copied." : "Invite link made: tap Copy next to it.");
    } catch (error) {
      toast(error.message, true);
    }
    render();
  }

  async function testPush() {
    try {
      const out = await api("POST", "/api/push/test");
      toast(out.sent ? `Test sent to ${out.sent} device${out.sent === 1 ? "" : "s"}.` : "No device is subscribed yet.");
    } catch (error) {
      toast(error.message, true);
    }
    render();
  }

  async function approvePasskey(p) {
    if (!confirm(`Approve "${p.name}"? Only if that computer shows the code ${p.pending.code}.`)) return;
    try {
      await withFaceId(() => api("POST", `/api/passkeys/${encodeURIComponent(p.id)}/approve`));
      toast(`${p.name} can sign in now.`);
    } catch (error) {
      toast(error.message, true);
    }
    await refreshLists();
    render();
  }

  async function removePasskey(p) {
    if (!confirm(`Remove the passkey "${p.name}"?`)) return;
    try {
      await withFaceId(() => api("DELETE", `/api/passkeys/${encodeURIComponent(p.id)}`));
    } catch (error) {
      toast(error.message, true);
    }
    await refreshLists();
    render();
  }

  async function signOut() {
    events?.close();
    await api("POST", "/api/auth/logout").catch(() => {});
    location.hash = "";
    location.reload();
  }

  // ---------- sign in ----------

  /** A sign-up, setup or invite link in the address (#signup=..., #setup=... or #invite=...): what lets this device add its first passkey. */
  function linkGrant() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    if (params.get("signup")) return { signup: params.get("signup") };
    if (params.get("invite")) return { invite: params.get("invite") };
    if (params.get("setup")) return { setupToken: params.get("setup") };
    return null;
  }

  function deviceName() {
    const ua = navigator.userAgent;
    if (DESKTOP) return MAC ? "Mac (desktop app)" : /Windows/.test(ua) ? "Windows PC (desktop app)" : "Computer (desktop app)";
    if (/iPhone/.test(ua)) return "iPhone";
    if (/iPad/.test(ua)) return "iPad";
    if (/Android/.test(ua)) return "Android phone";
    return "Browser";
  }

  async function registerPasskey(grant = null) {
    try {
      // A signed-in phone adding a passkey confirms with Face ID first; an invite or the setup link needs no session.
      const ask = () => api("POST", "/api/auth/register/options", { ...grant });
      const { options, challengeId } = await (grant ? ask() : withFaceId(ask));
      const response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });
      const verify = () => api("POST", "/api/auth/register/verify", { challengeId, response, name: deviceName(), ...grant, ...(DESKTOP ? { surface: "desktop" } : {}) });
      // A desktop's check is for this one registration, so it comes after the new passkey is made.
      await (!grant && me?.strict ? withFaceId(verify) : verify());
      if (grant) {
        // ?surface=desktop stays: a reload must still be the desktop's page.
        // A new account has no workshop yet: it lands where its install command is shown (README "Downloads").
        history.replaceState(null, "", `/${location.search}${grant.signup && !DESKTOP ? "#overlords" : "#fleet"}`);
        await start();
        return toast(grant.signup ? "Your account is ready. Install Golemworks on your computer next." : "Passkey added.");
      }
      toast("Passkey added.");
      await refreshLists();
    } catch (error) {
      const note = main.querySelector(".signin .error");
      if (note) note.textContent = error.message;
      else toast(error.message, true);
    }
    render();
  }

  async function signIn() {
    const note = main.querySelector(".signin .error");
    try {
      const { options, challengeId } = await api("POST", "/api/auth/login/options", DESKTOP ? { surface: "desktop", ...door } : undefined);
      const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });
      await api("POST", "/api/auth/login/verify", { challengeId, response, ...(DESKTOP ? { surface: "desktop" } : {}) });
      start();
    } catch (error) {
      if (note) note.textContent = error.message;
    }
  }

  function signInView() {
    tabs.hidden = true;
    title.textContent = "Golemworks";
    const grant = linkGrant();
    const button = grant
      ? h("button", { type: "button", class: "primary", onclick: () => registerPasskey(grant) }, grant.signup ? "Create my account" : DESKTOP ? "Create a passkey for this computer" : "Create a passkey for this device")
      : h("button", { type: "button", class: "primary", onclick: signIn }, "Sign in with passkey");
    const welcome = grant?.signup
      ? `You were invited to Golemworks. ${DESKTOP ? CHECK : "Face ID"} saves a passkey for your new account: no password or email. The link works once.`
      : null;
    main.replaceChildren(h("div", { class: "signin" }, [
      h("img", { src: "/icons/icon-192.png", alt: "" }),
      h("h2", {}, "Golemworks"),
      h("p", {}, welcome || (DESKTOP
        ? grant ? `Set up this computer: ${CHECK} saves a passkey that signs you in from now on.` : `Your Golemworks account: the same settings as Mobile. Sign in with ${CHECK} on this computer, or with another device.`
        : grant ? "Set up this device: Face ID saves a passkey that signs you in from now on." : "Your workshops' overlords and golems, and what they need from you.")),
      button,
      DESKTOP && !grant ? h("button", { type: "button", onclick: addComputer }, "Add this computer") : null,
      DESKTOP && !grant ? h("p", { class: "note" }, `No passkey on this computer yet? Add this computer: ${CHECK} makes one here, and Mobile approves it.`) : null,
      h("p", { class: "error", role: "status" }),
    ]));
  }

  /** The desktop's first passkey: made here, then waiting until the phone approves it (Face ID) against the code shown here. No invite link crosses this computer. */
  async function addComputer() {
    const note = main.querySelector(".signin .error");
    try {
      const { options, challengeId } = await api("POST", "/api/auth/desktop/options", door);
      const response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });
      const { code, expiresAt } = await api("POST", "/api/auth/desktop/verify", { challengeId, response, name: deviceName(), ...door });
      main.querySelector(".signin").replaceChildren(
        h("h2", {}, "Approve in Mobile"),
        h("div", { class: "code", "aria-label": `Code ${code.split("").join(" ")}` }, code),
        h("p", {}, `In Mobile: Settings > This device, approve the passkey with this code (until ${new Date(expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}). Then sign in here.`),
        h("button", { type: "button", class: "primary", onclick: signIn }, "Sign in with passkey"),
        h("p", { class: "error", role: "status" }),
      );
    } catch (error) {
      if (note) note.textContent = error.message;
    }
  }

  // ---------- start ----------

  // ---------- artifacts ----------

  let artifacts = null; // { workshops: [{ id, name, online, items }] }
  const artifactFilters = { workshop: "", kind: "" };
  const ARTIFACT_STATE = { marked: "Marked for deletion", deleting: "Deleting", deleted: "Deleted", failed: "Delete failed" };
  let markdown = null;

  async function loadArtifacts() {
    try {
      artifacts = await opened("artifacts", await api("GET", "/api/artifacts"));
    } catch (error) {
      if (error.status === 401) return start();
    }
    // Typing in the search box holds quiet renders; the cards under it still take the new list.
    if (screen === "artifacts") document.activeElement === artifactSearch ? showArtifacts() : quietRender();
  }

  // Search runs here, over the list this device opened (public/artifact-list.js); the box and the cards' holder outlive a render, so typing keeps focus.
  let artifactQuery = "";
  let artifactSearch = null;
  let artifactCards = null;

  function artifactsView() {
    if (!artifacts) return loading();
    const select = (label, key, options) => {
      const node = h("select", { "aria-label": label, onchange: (e) => { artifactFilters[key] = e.target.value; render(); } }, [h("option", { value: "" }, "All"), ...options.map(([value, text]) => h("option", { value }, text))]);
      node.value = artifactFilters[key];
      return h("label", {}, [label, node]);
    };
    const bar = h("div", { class: "filters" }, [select("Workshop", "workshop", artifacts.workshops.map((w) => [w.id, w.name])), select("Kind", "kind", [["claude", "Claude artifacts"], ["file", "Markdown files"]])]);
    artifactSearch ||= h("input", { type: "search", class: "artifact-search", placeholder: "Search titles, golems, workspaces", "aria-label": "Search artifacts", enterkeyhint: "search", oninput: (e) => { artifactQuery = e.target.value; showArtifacts(); } });
    if (artifactSearch.value !== artifactQuery) artifactSearch.value = artifactQuery;
    artifactCards ||= h("div", { class: "artifact-cards" });
    showArtifacts();
    return h("div", { class: "cards" }, [artifactSearch, bar, artifactCards]);
  }

  function showArtifacts() {
    if (!artifactCards || !artifacts) return;
    const { groups, shown, total, searching } = ArtifactList.groups(artifacts, { ...artifactFilters, query: artifactQuery });
    const nodes = groups.flatMap(({ w, entries }) => [h("h2", { class: "group" }, `${w.name} · ${entries.length}${w.online ? "" : " · offline"}`), ...entries.map(({ item, snippet }) => artifactCard(w, item, snippet))]);
    const none = searching ? `No artifacts match “${artifactQuery.trim()}”${artifactFilters.workshop || artifactFilters.kind ? " with these filters" : ""}.` : total ? "Nothing matches these filters." : "Claude artifacts your golems publish and the Markdown they write show here.";
    if (!shown) nodes.push(h("div", { class: "empty" }, [h("strong", {}, "No artifacts"), none]));
    artifactCards.replaceChildren(...nodes);
  }

  /** text with the searched words in <mark>, as nodes. */
  const searchMarked = (text) => (artifactQuery.trim() ? ArtifactSearch.pieces(text, artifactQuery).map((p) => (p.hit ? h("mark", {}, p.text) : p.text)) : [text]);

  const SNIPPET_FIELD = { url: "Link", path: "Path", description: "Description", body: "Text" };

  function artifactCard(w, item, snippet = null) {
    const parts = [item.kind === "claude" ? "Claude artifact" : "Markdown", ago(item.at), item.golem, item.workspace].filter(Boolean);
    const meta = parts.flatMap((part, index) => [...(index ? [" · "] : []), ...(part === item.golem || part === item.workspace ? searchMarked(part) : [part])]);
    const gone = item.state === "deleted";
    const title = searchMarked(item.title);
    return h("div", { class: `card artifact${gone ? " gone" : ""}`, "data-kind": item.kind, "data-state": item.state || "" }, [
      h("div", { class: "card-top" }, [
        item.url && !gone ? h("a", { class: "card-name artifact-title", href: item.url, target: "_blank", rel: "noopener noreferrer" }, title) : item.readable ? h("button", { type: "button", class: "card-name artifact-title link", onclick: () => openArtifact(w, item) }, title) : h("span", { class: "card-name artifact-title" }, title),
        item.state ? h("span", { class: "tag artifact-state", "data-state": item.state }, ARTIFACT_STATE[item.state]) : null,
      ]),
      h("div", { class: "card-meta" }, meta),
      snippet ? h("div", { class: "card-meta artifact-snippet" }, [h("span", { class: "artifact-snippet-field" }, SNIPPET_FIELD[snippet.field] || snippet.field), " ", ...searchMarked(snippet.text)]) : null,
      item.namesOnly ? h("div", { class: "card-status" }, "Names only: open it on the desktop") : null,
      item.state === "failed" && item.error ? h("div", { class: "card-attention" }, item.error) : null,
      !item.state || item.state === "failed"
        ? h("div", { class: "row artifact-actions" }, [h("button", { type: "button", class: "small danger", onclick: () => confirmMark(w, item) }, item.state === "failed" ? "Try again" : "Mark for deletion")])
        : item.state === "marked"
          ? h("div", { class: "row artifact-actions" }, [h("button", { type: "button", class: "small", onclick: () => unmark(w, item) }, "Unmark")])
          : null,
    ]);
  }

  function showSheet(children) {
    const body = h("div", { class: "sheet-body" }, [h("div", { class: "sheet-head" }, [h("div", { class: "sheet-grip", "aria-hidden": "true" }), children[0]]), ...children.slice(1)]);
    sheet.replaceChildren(body);
    sheet.hidden = false;
    sheet.onclick = (e) => {
      if (e.target === sheet) closeSheet();
    };
    if (typeof SheetDrag !== "undefined") SheetDrag.attach({ body, handles: [body.querySelector(".sheet-head")], onClose: closeSheet, reducedMotion: () => matchMedia("(prefers-reduced-motion: reduce)").matches });
    return body;
  }

  async function openArtifact(w, item) {
    const content = h("div", { class: "markdown" }, h("p", { class: "note" }, "Loading"));
    const body = showSheet([h("div", {}, [h("h2", { id: "sheet-title" }, item.title), h("div", { class: "card-meta" }, [w.name, item.golem, "read only"].filter(Boolean).join(" · "))]), content, h("p", {}, h("button", { type: "button", class: "sheet-close", onclick: closeSheet }, "Close"))]);
    body.querySelector(".sheet-close")?.focus({ preventScroll: true });
    try {
      const got = await opened("artifactText", artifacts?.accountId, w.id, item.id, await api("GET", `/api/artifacts/${encodeURIComponent(w.id)}/${item.id}/text`));
      markdown ||= markdownit({ html: false, linkify: true }); // "<title>" in a golem's prose is text, not a tag that swallows the rest
      content.innerHTML = DOMPurify.sanitize(markdown.render(got.text));
      for (const link of content.querySelectorAll("a[href]")) Object.assign(link, { target: "_blank", rel: "noopener noreferrer" });
      // Images would load from the PC's folders, which the phone cannot reach: their alt text stands in.
      for (const img of content.querySelectorAll("img")) img.replaceWith(h("span", { class: "note" }, `[${img.alt || "image"}]`));
      if (got.truncated) content.append(h("p", { class: "note" }, "Only the first 200 KB is shown. The rest is on the desktop."));
    } catch (error) {
      content.replaceChildren(h("p", { class: "card-attention" }, error.message));
    }
  }

  function confirmMark(w, item) {
    const what = item.kind === "claude" ? "A golem deletes this Claude artifact from claude.ai in about 2 minutes; Claude asks you to confirm each one when it runs. Its link stops working for everyone." : "Your PC moves this file to the Recycle Bin in about 2 minutes.";
    const body = showSheet([
      h("h2", { id: "sheet-title" }, "Delete this artifact?"),
      h("p", { class: "artifact-confirm-title" }, item.title),
      h("p", {}, `${what} This cannot be undone once it runs; until then you can unmark it.`),
      h("div", { class: "row" }, [
        h("button", { type: "button", class: "sheet-close", onclick: closeSheet }, "Cancel"),
        h("button", { type: "button", class: "primary danger-fill", onclick: () => mark(w, item) }, "Mark for deletion"),
      ]),
    ]);
    body.querySelector(".sheet-close")?.focus({ preventScroll: true });
  }

  async function mark(w, item) {
    // Face ID before any await, so Safari opens the passkey sheet from this tap.
    const sent = withFaceId(() => api("POST", `/api/artifacts/${encodeURIComponent(w.id)}/${item.id}/mark`, {}));
    closeSheet();
    try {
      const out = await sent;
      item.state = out.state;
      toast("Marked for deletion");
    } catch (error) {
      toast(error.message, true);
    }
    render();
    loadArtifacts();
  }

  async function unmark(w, item) {
    try {
      const out = await api("POST", `/api/artifacts/${encodeURIComponent(w.id)}/${item.id}/unmark`, {});
      item.state = out.state;
      toast("Mark taken back");
    } catch (error) {
      toast(error.message, true);
    }
    render();
    loadArtifacts();
  }

  // ---------- waiting on you ----------

  let waiting = null; // { now, people, later }
  const KIND_TEXT = { stopped: "Stopped", paused: "Paused", gate: "Gate", permission: "Approval", plan: "Plan", question: "Question", dialog: "Dialog", ask: "Question", needs: "Needs you", proposed: "Says done", task: "Task", followup: "Follow-up", pr: "PR", draft: "Draft", other: "Ask" };

  async function loadWaiting() {
    try {
      const view = await api("GET", `/api/waiting?today=${localDay()}&tz=${new Date().getTimezoneOffset()}`);
      let next = sealed ? sealed.waiting(view, feed) : view;
      // Sealed tasks (or ones this phone has seen sealed): the hub cannot pick the ones that need you, so this device does from its merged list.
      if ((feed?.encryption?.tasksSealed || taskReader?.sticky(myAccount())) && typeof GolemworksSealed !== "undefined") {
        tasks = await openTasks(await api("GET", "/api/tasks"));
        next = { ...GolemworksSealed.withTasks(next, tasks?.tasks || [], localDay()), note: tasks?.warning || tasks?.problem || null };
      }
      waiting = next;
    } catch (error) {
      if (error.status === 401) return start();
    }
    if (screen === "waiting") quietRender();
  }

  function waitingView() {
    if (!waiting) return loading();
    const list = h("div", { class: "cards" });
    if (waiting.note) list.append(h("p", { class: "note" }, waiting.note));
    const section = (title, items) => {
      if (!items.length) return;
      list.append(h("h2", { class: "group" }, `${title} · ${items.length}`), ...items.map(waitingCard));
    };
    section("Now", waiting.now);
    for (const group of waiting.people) section(`Waiting on ${group.person}`, group.items);
    section("Later", waiting.later);
    if (!waiting.now.length && !waiting.people.length && !waiting.later.length) list.append(h("div", { class: "empty" }, [h("strong", {}, "Nothing is waiting on you"), "Golems' needs, held gates, PRs and drafts for your go, and tasks due soon show here."]));
    return list;
  }

  function waitingCard(item) {
    const meta = [item.workshop, item.workspace, item.golem && item.golem !== item.title ? item.golem : null].filter(Boolean).join(" · ");
    const actions = [];
    if (item.paneId && item.workshopId) actions.push(h("a", { class: "button small", href: `#fleet&golem=${encodeURIComponent(`${item.workshopId}/${item.paneId}`)}&sheet=1` }, item.kind === "gate" ? "Approve or hold" : "Answer"));
    if (item.kind === "task" || item.kind === "proposed") actions.push(h("button", { type: "button", class: "small", onclick: () => waitingTask(item, { status: "done" }, "Done") }, item.kind === "proposed" ? "Confirm done" : "Done"));
    if (item.kind === "followup") {
      actions.push(h("button", { type: "button", class: "small", onclick: () => waitingTask(item, { status: "done" }, "Done") }, "Done"));
      actions.push(h("button", { type: "button", class: "small", onclick: () => waitingTask(item, { waitingOn: { person: item.person, followUp: plusDays(3) } }, "Snoozed 3 days") }, "Snooze 3 days"));
    }
    if (item.postId) {
      for (const [i, option] of item.options.entries()) actions.push(h("button", { type: "button", class: "small", onclick: () => answerPost(item, { option: i }) }, option));
      actions.push(h("button", { type: "button", class: "small", onclick: () => replyPost(item) }, "Reply"));
      actions.push(h("button", { type: "button", class: "small", onclick: () => answerPost(item, { decision: "dismiss" }) }, "Dismiss"));
    }
    return h("div", { class: `card waiting${item.priority === "urgent" ? " attention" : ""}`, "data-kind": item.kind }, [
      h("div", { class: "card-top" }, [h("span", { class: "card-name" }, item.title), h("span", { class: "tag waiting-kind", "data-kind": item.kind }, KIND_TEXT[item.kind] || item.kind)]),
      h("div", { class: "waiting-ask" }, item.ask || "needs you"),
      item.unblocks ? h("div", { class: "card-meta waiting-unblocks" }, item.unblocks) : null,
      item.detail ? h("div", { class: "waiting-detail" }, item.detail) : null,
      item.url ? h("a", { class: "waiting-link", href: item.url, target: "_blank", rel: "noopener noreferrer" }, "Open the PR") : null,
      meta ? h("div", { class: "card-meta" }, meta) : null,
      actions.length ? h("div", { class: "row waiting-actions" }, actions) : null,
    ]);
  }

  const plusDays = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString("en-CA");

  async function waitingTask(item, set, said) {
    try {
      await saveTask(item.taskId, { set });
      toast(said);
    } catch (error) {
      toast(error.message, true);
    }
    loadWaiting();
  }

  async function answerPost(item, body) {
    // Face ID before any await, so Safari opens the passkey sheet from this tap.
    const sent = withFaceId(async () => {
      const acts = await sealerFor(item.workshopId);
      const id = acts?.uuid();
      const payload = acts ? { id, sealed: acts.seal(item.workshopId, "waiting", id, { postId: item.postId, ...body }) } : body;
      return api("POST", `/api/waiting/${encodeURIComponent(item.workshopId)}/${item.postId}/answer`, payload);
    });
    closeSheet();
    try {
      await sent;
      toast(body.decision === "dismiss" ? "Dismissed" : `Sent to ${item.golem || "its overlord"}`);
    } catch (error) {
      toast(error.message, true);
    }
    loadWaiting();
  }

  function replyPost(item) {
    const box = h("textarea", { rows: "4", maxlength: "2000", "aria-label": "Your answer" });
    const body = showSheet([
      h("h2", { id: "sheet-title" }, item.title),
      h("p", {}, item.ask),
      box,
      h("div", { class: "row" }, [h("button", { type: "button", class: "sheet-close", onclick: closeSheet }, "Cancel"), h("button", { type: "button", class: "primary", onclick: () => box.value.trim() && answerPost(item, { text: box.value.trim() }) }, "Send")]),
    ]);
    body.querySelector("textarea")?.focus({ preventScroll: true });
  }

  // ---------- tasks ----------

  let tasks = null; // { tasks, workshops: [{ id, name, online, workspaces }] }
  // Today first, as Life Ops opened on the phone: what is due today, overdue, or urgent.
  const taskFilters = { workspace: "", status: "today" };
  const PRIORITY_TEXT = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };
  const STATUS_TEXT = { todo: "To do", doing: "Doing", waiting: "Waiting", done: "Done", canceled: "Canceled" };
  const CLOSED = ["done", "canceled"];
  const localDay = () => new Date().toLocaleDateString("en-CA");

  async function loadTasks() {
    try {
      tasks = await openTasks(await api("GET", "/api/tasks"));
    } catch (error) {
      if (error.status === 401) return start();
    }
    if (screen === "tasks") quietRender();
  }

  // Sealed tasks (README "Encryption required"): the hub keeps a snapshot and ops it cannot read; this device opens and merges them (public/task-merge.js).
  const tasksSealed = () => Boolean((tasks?.sealed && !tasks?.untrusted) || feed?.encryption?.tasksSealed);
  // Per account: tasks once seen sealed stay sealed here, and the newest list merged (public/task-merge.js reader).
  const taskReader = typeof TaskReader !== "undefined" ? TaskReader.reader({ storage: localStorage }) : null;
  const myAccount = () => (typeof Acts !== "undefined" ? Acts.localMemo(localStorage).get("account") : null);

  /** The Tasks view from GET /api/tasks: plaintext as sent (unless this phone has seen them sealed); sealed, opened with the account key and merged as every reader merges them. */
  async function openTasks(got) {
    let acts = null;
    try {
      acts = await sealer();
    } catch (error) {
      if (got?.sealed) return { tasks: [], workshops: got.workshops || [], sealed: true, problem: `Tasks did not open here: ${error.message}` };
    }
    return taskReader ? taskReader.view(got, { acts }) : got;
  }

  /** A create or an edit: sealed as a task op for an account whose tasks are encrypted, else the hub's plaintext routes; never plaintext once this phone has seen them sealed. */
  async function saveTask(taskId, change) {
    const acts = await sealer();
    if (!tasksSealed()) {
      if (taskReader?.sticky(acts?.accountId())) throw new Error("The hub says tasks are no longer protected. Mobile here does not trust that, so it sent nothing");
      return api("POST", change.create ? "/api/tasks" : `/api/tasks/${encodeURIComponent(taskId)}`, change.create ? { task: change.create } : { set: change.set });
    }
    if (!acts) throw new Error("This device isn't approved yet: approve it from another device. Nothing was sent.");
    const op = { opId: crypto.randomUUID(), taskId: taskId || crypto.randomUUID(), at: new Date().toISOString(), by: "you", operator: true, ...change };
    return api("POST", "/api/tasks/sealed", { opId: op.opId, sealed: acts.seal("tasks", "task-op", op.opId, op) });
  }

  /** A workshop's workspace names: the hub's list, or the opened summary's for a sealed workshop the hub cannot read. */
  function workspacesOf(w) {
    if (w.workspaces?.length) return w.workspaces;
    const opened = feed?.workshops.find((f) => f.id === w.id)?.workspaces;
    return Array.isArray(opened) ? opened.map((space) => (typeof space === "string" ? space : space?.name)).filter((name) => typeof name === "string") : [];
  }

  /** Workshops online with this workspace: Start golem goes to the first. General is every workshop's default. */
  function starters(task) {
    const want = (task.workspace || "General").toLowerCase();
    return (tasks?.workshops || []).filter((w) => w.online && (want === "general" || workspacesOf(w).some((label) => label.toLowerCase() === want)));
  }

  function taskMeta(task) {
    const bits = task.area ? [task.area] : [];
    if (task.due) bits.push(task.due < localDay() && !CLOSED.includes(task.status) ? `overdue ${task.due}` : task.due === localDay() ? "due today" : `due ${task.due}`);
    if (task.status !== "todo") bits.push(STATUS_TEXT[task.status]);
    if (task.waitingOn) bits.push(`waiting on ${task.waitingOn.person}${task.waitingOn.followUp ? `, follow up ${task.waitingOn.followUp}` : ""}`);
    if (task.assignee && task.assignee !== "you") bits.push(`for ${task.assignee}`);
    if (task.golem) bits.push(`golem ${task.golem.name}`);
    return bits.join(" · ");
  }

  function tasksView() {
    if (!tasks) return loading();
    const labels = [...new Set(tasks.tasks.map((t) => t.workspace).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const select = (label, key, options) => {
      const node = h("select", { "aria-label": label, onchange: (e) => { taskFilters[key] = e.target.value; render(); } }, options.map(([value, text]) => h("option", { value }, text)));
      node.value = taskFilters[key];
      return h("label", {}, [label, node]);
    };
    const bar = h("div", { class: "filters" }, [select("Workspace", "workspace", [["", "All"], ...labels.map((w) => [w, w])]), select("Show", "status", [["today", "Today"], ["open", "Open"], ["waiting", "Waiting"], ["done", "Done"], ["all", "All"]])]);
    const list = h("div", { class: "cards" }, [h("button", { type: "button", class: "primary task-new", disabled: Boolean(tasks.problem), onclick: () => editTask(null) }, "New task"), bar]);
    if (tasks.problem) list.append(h("p", { class: "note" }, tasks.problem));
    if (tasks.warning) list.append(h("p", { class: "note" }, tasks.warning));
    if (tasks.seeding) list.append(h("p", { class: "note" }, "A workshop is sending the task list now."));
    if (tasks.skipped) list.append(h("p", { class: "note" }, `${tasks.skipped} task record${tasks.skipped === 1 ? "" : "s"} did not open here (changed, moved or under another key).`));
    if (taskFilters.status === "today") return todayView(list);
    const shown = tasks.tasks.filter((t) => {
      if (taskFilters.workspace && (t.workspace || "") !== taskFilters.workspace) return false;
      if (taskFilters.status === "open") return !CLOSED.includes(t.status);
      if (taskFilters.status === "done") return CLOSED.includes(t.status);
      if (taskFilters.status === "waiting") return t.status === "waiting";
      return true;
    });
    // Priority, then due date (none last), as the desktop orders them.
    const rank = { urgent: 0, high: 1, normal: 2, low: 3 };
    shown.sort((a, b) => Number(CLOSED.includes(a.status)) - Number(CLOSED.includes(b.status)) || rank[a.priority] - rank[b.priority] || (a.due || "9").localeCompare(b.due || "9"));
    const groups = new Map();
    for (const t of shown) {
      const key = t.workspace || "No workspace";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    for (const [name, items] of [...groups].sort(([a], [b]) => a.localeCompare(b))) list.append(h("h2", { class: "group" }, `${name} · ${items.length}`), ...items.map(taskCard));
    // While a workshop seals the list, an empty one is not "no tasks": the note above says what is happening.
    if (!shown.length && !tasks.seeding) list.append(h("div", { class: "empty" }, [h("strong", {}, "No tasks"), tasks.tasks.length ? "Nothing matches these filters." : "Add one here, on either desktop, or with gw task add."]));
    return list;
  }

  /** Today: the operator's open tasks due today, then overdue, then urgent ones not yet due, each highest priority first. */
  function todayView(list) {
    const today = localDay();
    const rank = { urgent: 0, high: 1, normal: 2, low: 3 };
    // A task waiting on someone is a follow-up (Waiting on you, People), not one of today's to-dos.
    const mine = tasks.tasks.filter((t) => !CLOSED.includes(t.status) && t.status !== "waiting" && t.assignee === "you" && (!taskFilters.workspace || (t.workspace || "") === taskFilters.workspace));
    const groups = [
      ["Due today", mine.filter((t) => t.due === today)],
      // Overdue: the most recently missed first, since an old backlog matters less than this week's.
      ["Overdue", mine.filter((t) => t.due && t.due < today).sort((a, b) => b.due.localeCompare(a.due))],
      ["Urgent", mine.filter((t) => t.priority === "urgent" && (!t.due || t.due > today)).sort((a, b) => (a.due || "9").localeCompare(b.due || "9"))],
    ];
    for (const [name, items] of groups) {
      if (!items.length) continue;
      items.sort((a, b) => rank[a.priority] - rank[b.priority]);
      list.append(h("h2", { class: "group" }, `${name} · ${items.length}`), ...items.map(taskCard));
    }
    if (!groups.some(([, items]) => items.length) && !tasks.seeding) list.append(h("div", { class: "empty" }, [h("strong", {}, "Nothing due today"), "Nothing of yours is due today, overdue or urgent. Show: Open lists the rest."]));
    return list;
  }

  function taskCard(task) {
    const closed = CLOSED.includes(task.status);
    return h("div", { class: `card task${closed ? " gone" : ""}`, "data-task": task.key, "data-priority": task.priority }, [
      h("button", { type: "button", class: "card-open", onclick: () => editTask(task) }, [
        h("div", { class: "card-top" }, [h("span", { class: "card-name" }, task.title), task.priority === "urgent" || task.priority === "high" ? h("span", { class: "tag task-priority", "data-priority": task.priority }, PRIORITY_TEXT[task.priority]) : null]),
        taskMeta(task) ? h("div", { class: "card-meta" }, taskMeta(task)) : null,
        task.proposedDone ? h("div", { class: "card-status" }, `${task.proposedDone.by} says done`) : null,
      ]),
      closed && !mailLink(task) ? null : h("div", { class: "row task-actions" }, [closed ? null : h("button", { type: "button", class: "small", onclick: () => setTask(task, { status: "done" }, "Done") }, task.proposedDone ? "Confirm done" : "Done"), mailLink(task)]),
    ]);
  }

  /** Open email: the Gmail thread a task came from (public/task-merge.js mailUrl), or null. */
  function mailLink(task) {
    const url = typeof TaskMerge !== "undefined" ? TaskMerge.mailUrl(task.source) : null;
    return url ? h("a", { class: "button small task-email", href: url, target: "_blank", rel: "noopener" }, "Open email") : null;
  }

  async function setTask(task, set, said) {
    try {
      await saveTask(task.id, { set });
      toast(said);
    } catch (error) {
      toast(error.message, true);
    }
    loadTasks();
  }

  /** The sheet for a new task (task null) or an existing one: every field, Save, and Start golem when a workshop can. */
  function editTask(task) {
    const field = (label, input) => h("label", { class: "task-field" }, [label, input]);
    const pick = (name, values, current) => {
      const node = h("select", { name }, values.map(([value, text]) => h("option", { value }, text)));
      node.value = current;
      return node;
    };
    const form = h("form", { class: "task-form" }, [
      field("Title", h("input", { name: "title", value: task?.title || "", required: true, maxlength: "200" })),
      field("Workspace", h("input", { name: "workspace", value: task?.workspace || taskFilters.workspace || "", list: "task-workspaces" })),
      h("datalist", { id: "task-workspaces" }, [...new Set([...(tasks?.workshops || []).flatMap(workspacesOf),...(tasks?.tasks || []).map((t) => t.workspace).filter(Boolean)])].map((w) => h("option", { value: w }))),
      field("Priority", pick("priority", Object.entries(PRIORITY_TEXT), task?.priority || "normal")),
      field("Due", h("input", { name: "due", type: "date", value: task?.due || "" })),
      task ? field("Status", pick("status", Object.entries(STATUS_TEXT), task.status)) : null,
      field("Waiting on", h("input", { name: "person", value: task?.waitingOn?.person || "", placeholder: "nobody" })),
      field("Follow up", h("input", { name: "followUp", type: "date", value: task?.waitingOn?.followUp || "" })),
      field("Notes", h("textarea", { name: "notes", rows: "6" }, task?.notes || "")),
      h("div", { class: "row" }, [h("button", { type: "button", class: "sheet-close", onclick: closeSheet }, "Cancel"), h("button", { type: "submit", class: "primary" }, task ? "Save" : "Add")]),
    ]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const f = new FormData(form);
      const value = (name) => String(f.get(name) || "").trim();
      const fields = { title: value("title"), workspace: value("workspace") || null, priority: value("priority"), due: value("due") || null, notes: String(f.get("notes") || "") || null };
      fields.waitingOn = value("person") ? { person: value("person"), followUp: value("followUp") || null } : null;
      if (task) {
        fields.status = value("status");
        if (fields.status === "todo" && fields.waitingOn) fields.status = "waiting";
        if (fields.status === "waiting" && !fields.waitingOn && task.status === "waiting") fields.status = "todo"; // the person cleared
      } else if (fields.waitingOn) fields.status = "waiting";
      // An edit sends only what changed, so a save never reopens, re-closes or overwrites what it did not touch.
      const set = task ? Object.fromEntries(Object.entries(fields).filter(([k, v]) => JSON.stringify(v ?? null) !== JSON.stringify(task[k] ?? null))) : null;
      if (task && !Object.keys(set).length) return closeSheet();
      try {
        await saveTask(task?.id || null, task ? { set } : { create: fields });
        closeSheet();
        toast(task ? "Saved" : "Added");
      } catch (error) {
        toast(error.message, true);
      }
      loadTasks();
    });
    const shops = task && !CLOSED.includes(task.status) ? starters(task) : [];
    const head = h("div", {}, [h("h2", { id: "sheet-title" }, task ? `${task.key} · ${task.title}` : "New task"), task ? h("div", { class: "card-meta" }, `made by ${task.createdBy || "?"}${task.source?.kind === "import" ? `, imported from ${task.source.key}` : ""}`) : null]);
    const extra = [];
    if (task && mailLink(task)) extra.push(h("div", { class: "row" }, [mailLink(task)]));
    if (task?.proposedDone) extra.push(h("p", { class: "task-proposal" }, `${task.proposedDone.by} says it is done: ${task.proposedDone.evidence}`));
    if (task && !task.golem && shops.length) extra.push(h("button", { type: "button", class: "primary task-start", onclick: () => startTask(task) }, `Start golem on ${shops[0].name}`));
    else if (task && !task.golem && !CLOSED.includes(task.status)) extra.push(h("p", { class: "note" }, `No online workshop has the ${task.workspace || "General"} workspace to start a golem in.`));
    showSheet([head, ...extra, form]);
  }

  async function startTask(task) {
    // Face ID before any await, so Safari opens the passkey sheet from this tap.
    // Sealed, the hub cannot read the task: the workshop to start on goes along, and golemd checks the task and its workspace.
    const body = tasksSealed() ? { workshopId: starters(task)[0]?.id || null } : {};
    const sent = withFaceId(() => api("POST", `/api/tasks/${encodeURIComponent(task.id)}/start`, body));
    closeSheet();
    try {
      const out = await sent;
      toast(out.golem ? `Started ${out.golem} on ${out.workshop}` : `Sent to ${out.workshop}`);
    } catch (error) {
      toast(error.message, true);
    }
    loadTasks();
  }

  // #inbox (an older push or bookmark) lands on Fleet; #overlords (older links, pushes, docs) opens Settings; the desktop shows only Settings.
  const screenOf = (name) => (DESKTOP || name === "settings" ? "overlords" : ["overlords", "artifacts", "tasks", "waiting"].includes(name) ? name : "fleet");

  function route() {
    const hash = location.hash.replace(/^#/, "");
    const name = hash.split(/[?&=]/)[0];
    screen = screenOf(name);
    const params = new URLSearchParams(hash.slice(name.length).replace(/^[?&]/, ""));
    if (params.get("golem")) focus = { key: params.get("golem"), sheet: params.get("sheet") === "1", ask: params.get("ask"), said: params.get("said") };
    closeSheet();
    if (screen === "overlords") refreshLists().then(render);
    if (screen === "artifacts") loadArtifacts();
    if (screen === "tasks") loadTasks();
    if (screen === "waiting") loadWaiting();
    render();
    main.focus({ preventScroll: true });
    if (toEncryption && screen === "overlords") {
      main.querySelector("#encryption")?.scrollIntoView({ block: "start" });
      enroll?.reopen();
    }
    toEncryption = false;
  }

  async function start() {
    try {
      me = await api("GET", "/api/me");
    } catch {
      me = null;
    }
    if (!me?.signedIn || linkGrant()) return signInView();
    freshUntil = Date.parse(me.freshUntil || "") || 0; // signing in counts as the check
    prepareConfirm();
    // The desktop's golem motion: one-off effects re-render the Fleet; nothing moves while the app is hidden.
    if (hasGolems() && !golemsStarted) {
      golemsStarted = true;
      Golems.start({ render: () => screen !== "overlords" && quietRender(), t: (key) => key });
    }
    tabs.hidden = DESKTOP;
    route();
    // This phone's encryption keys (public/enroll.js); the desktop's Account view enrolls nothing.
    if (!DESKTOP && typeof Enroll !== "undefined") enroll ||= Enroll.mount({ api, h, showSheet, closeSheet, withFaceId, toast, skip: () => Boolean(me?.strict), onReset: () => taskReader?.reset(myAccount()), onView: () => screen === "fleet" && feed && !overlordRows().length && quietRender() });
    enroll?.refresh();
    if (!DESKTOP) syncPush().then(() => screen === "overlords" && render());
    listen();
    landingUntil = Date.now() + LANDING_MS;
    await load();
    schedule();
  }

  // A change on any surface (this page, the phone, the desktop) shows on the others at once: the hub says what to fetch again.
  let events = null;
  let enroll = null;
  function listen() {
    if (events || typeof EventSource === "undefined") return;
    events = new EventSource(`${HUB}/api/events`, { withCredentials: Boolean(HUB) });
    let timer = null;
    let lists = false;
    const again = (account) => {
      lists ||= account;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const withLists = lists;
        lists = false;
        if (withLists && screen === "overlords") await refreshLists();
        await load();
      }, 150);
    };
    events.addEventListener("account", () => (again(true), enroll?.refresh()));
    // A reconnect after the stream dropped (a phone asleep, a network change) catches up on what it missed.
    let opened = false;
    events.addEventListener("open", () => {
      if (opened) (again(true), enroll?.refresh());
      opened = true;
    });
    events.addEventListener("feed", () => again(false));
    // The Orchestrator's Quiet feed changed: only an open chat fetches it.
    events.addEventListener("quiet", () => quietArrived().catch(() => {}));
  }

  // Signed out, an invite or setup link arriving in the address offers its passkey at once.
  window.addEventListener("hashchange", () => (me?.signedIn ? route() : linkGrant() && signInView()));
  navigator.serviceWorker?.addEventListener("message", (event) => {
    if (event.data?.type !== "open" || typeof event.data.url !== "string") return;
    const hash = new URL(event.data.url, location.href).hash;
    // The same link again fires no hashchange, so it routes here.
    if (hash === location.hash) me?.signedIn && route();
    else location.hash = hash;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !me?.signedIn) return;
    (landingUntil = Date.now() + LANDING_MS), load().then(schedule);
    // A device step whose live event came while the page was away shows on return, not only after a reload.
    enroll?.refresh();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const viewer = document.querySelector(".viewer");
    if (viewer) viewer.remove();
    else if (!sheet.hidden) closeSheet();
  });
  pruneKept();
  if (!DESKTOP && "serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  if (!DESKTOP && typeof Frame !== "undefined") Frame.start({ header: document.querySelector(".top"), onOverlords: () => screen === "overlords" && Boolean(me?.signedIn) });
  start();
})();
