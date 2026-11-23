// End-to-end encryption core (Node, Electron, phone page, service worker): libsodium high-level calls only; docs/architecture.md "End-to-end encryption".
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory(node ? require("libsodium-wrappers") : root.sodium, node ? require : null);
  if (node) module.exports = api;
  else root.GolemworksE2E = api;
})(typeof self !== "undefined" ? self : this, (sodium, nodeRequire) => {
  const VERSION = 1;
  const PAD_STEP = 1024;
  const FILE_CHUNK = 64 * 1024;
  const SAFETY_CODE_LENGTH = 12;
  // Crockford base32: no I, L, O or U, so a code read aloud or typed has no look-alikes.
  const SAFETY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const FILE_PREFIX = 1 + 4;
  let ready = false;

  class E2EError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "E2EError";
      this.code = code;
    }
  }

  /** Resolves once libsodium's WASM is loaded; every other call needs it first. */
  async function init() {
    if (!sodium) throw new E2EError("no-sodium", "libsodium-wrappers is not loaded (the page loads libsodium.js and libsodium-wrappers.js before e2e.js)");
    await sodium.ready;
    ready = true;
    return api;
  }

  function need() {
    if (!ready) throw new E2EError("not-ready", "call init() and wait for it before using e2e");
  }

  function bytes(value, length, what) {
    if (!(value instanceof Uint8Array) || (length != null && value.length !== length)) throw new E2EError("bad-key", `${what} must be a Uint8Array${length != null ? ` of ${length} bytes` : ""}`);
    return value;
  }

  function text(value, what) {
    if (typeof value !== "string" || !value) throw new E2EError("malformed", `${what} must be a non-empty string`);
    return value;
  }

  function epochOf(value) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new E2EError("malformed", "epoch must be an integer from 0 to 2^32-1");
    return value;
  }

  const fromBase64 = (value, what) => {
    try {
      return sodium.from_base64(text(value, what));
    } catch (error) {
      if (error instanceof E2EError) throw error;
      throw new E2EError("malformed", `${what} is not base64`);
    }
  };

  /** A new 256-bit account data key (ADK). */
  function newAccountKey() {
    need();
    return sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  }

  /** A new X25519 key pair for this device: { publicKey, privateKey }. */
  function newDeviceKeyPair() {
    need();
    const { publicKey, privateKey } = sodium.crypto_box_keypair();
    return { publicKey, privateKey };
  }

  // A boxed or sealed account key carries its epoch inside (4 bytes, big-endian, then the key): a relay cannot relabel an old key as a newer epoch.
  function keyWithEpoch(accountKey, epoch) {
    bytes(accountKey, sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES, "account key");
    const out = new Uint8Array(4 + accountKey.length);
    new DataView(out.buffer).setUint32(0, epochOf(epoch));
    out.set(accountKey, 4);
    return out;
  }

  function keyOfEpoch(inside, epoch, what) {
    if (inside.length !== 4 + sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES) throw new E2EError("forged", `the ${what} has the wrong length`);
    const held = new DataView(inside.buffer, inside.byteOffset, 4).getUint32(0);
    if (held !== epochOf(epoch)) throw new E2EError("forged", `the ${what} is for epoch ${held}, not ${epoch}`);
    return inside.slice(4);
  }

  /** The ADK for epoch, sealed to a device's public key (crypto_box_seal): only that device's private key opens it. */
  function sealAccountKey(accountKey, devicePublicKey, { epoch } = {}) {
    need();
    return sodium.crypto_box_seal(keyWithEpoch(accountKey, epoch), bytes(devicePublicKey, sodium.crypto_box_PUBLICKEYBYTES, "device public key"));
  }

  /** Opens a sealed ADK with this device's key pair; throws forged if it was not sealed to this device, was changed, or is for another epoch. */
  function openAccountKey(sealed, deviceKeyPair, { epoch } = {}) {
    need();
    bytes(sealed, null, "sealed account key");
    const { publicKey, privateKey } = checkKeyPair(deviceKeyPair);
    let inside;
    try {
      inside = sodium.crypto_box_seal_open(sealed, publicKey, privateKey);
    } catch {
      throw new E2EError("forged", "the sealed account key does not open with this device's key");
    }
    return keyOfEpoch(inside, epoch, "sealed account key");
  }

  function checkKeyPair(pair) {
    const publicKey = bytes(pair?.publicKey, sodium.crypto_box_PUBLICKEYBYTES, "device public key");
    const privateKey = bytes(pair?.privateKey, sodium.crypto_box_SECRETKEYBYTES, "device private key");
    if (!sodium.memcmp(sodium.crypto_scalarmult_base(privateKey), publicKey)) throw new E2EError("bad-key", "the device public key does not belong to its private key");
    return { publicKey, privateKey };
  }

  /** The 12-character code both screens show when a device joins: BLAKE2b over the account id and both public keys, in either order. */
  function safetyCode(publicKeyA, publicKeyB, accountId) {
    need();
    const keys = [bytes(publicKeyA, sodium.crypto_box_PUBLICKEYBYTES, "public key"), bytes(publicKeyB, sodium.crypto_box_PUBLICKEYBYTES, "public key")];
    keys.sort((a, b) => sodium.compare(a, b));
    const id = sodium.from_string(text(accountId, "account id"));
    const label = sodium.from_string("golemworks-safety-code-v1\0");
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, id.length);
    const digest = sodium.crypto_generichash(8, concat([label, length, id, keys[0], keys[1]]));
    let bits = 0n;
    for (const byte of digest) bits = (bits << 8n) | BigInt(byte);
    let code = "";
    for (let i = 0; i < SAFETY_CODE_LENGTH; i++) code += SAFETY_ALPHABET[Number((bits >> BigInt(59 - i * 5)) & 31n)];
    return code;
  }

  function concat(parts) {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  /** The associated data a ciphertext is bound to: version, epoch and its place (account, workshop, kind, id). */
  function associatedData(label, epoch, context) {
    const place = [text(context?.accountId, "accountId"), text(context?.workshopId, "workshopId"), text(context?.kind, "kind"), text(context?.id, "id")];
    return sodium.from_string(JSON.stringify([label, VERSION, epoch, ...place]));
  }

  function keyFor(keyring, epoch) {
    const key = keyring instanceof Uint8Array ? keyring : typeof keyring === "function" ? keyring(epoch) : keyring instanceof Map ? keyring.get(epoch) : keyring?.[epoch];
    if (!key) throw new E2EError("unknown-epoch", `no account key for epoch ${epoch}`);
    return bytes(key, sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES, "account key");
  }

  /** Encrypts body (any JSON value) for its place: { v, epoch, nonce, ciphertext }, with seq (the workshop's counter) inside and the plaintext padded to 1 KB steps. */
  function encryptRecord(accountKey, context, body, { epoch, seq }) {
    need();
    epochOf(epoch);
    if (!Number.isSafeInteger(seq) || seq < 1) throw new E2EError("malformed", "seq must be a positive integer");
    bytes(accountKey, sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES, "account key");
    const plain = sodium.pad(sodium.from_string(JSON.stringify({ seq, body })), PAD_STEP);
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, associatedData("golemworks-record", epoch, context), null, nonce, accountKey);
    return { v: VERSION, epoch, nonce: sodium.to_base64(nonce), ciphertext: sodium.to_base64(ciphertext) };
  }

  /** Decrypts an envelope for its place: { body, seq, epoch }. Throws forged when changed or moved; with a guard, replayed or rolled-back when its seq is not newer. */
  function decryptRecord(keyring, context, envelope, { guard } = {}) {
    need();
    if (!envelope || typeof envelope !== "object") throw new E2EError("malformed", "the record is not an envelope");
    if (envelope.v !== VERSION) throw new E2EError("unsupported-version", `envelope version ${envelope.v} is not ${VERSION}`);
    const epoch = epochOf(envelope.epoch);
    const nonce = fromBase64(envelope.nonce, "nonce");
    const ciphertext = fromBase64(envelope.ciphertext, "ciphertext");
    if (nonce.length !== sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES) throw new E2EError("malformed", "the nonce has the wrong length");
    const key = keyFor(keyring, epoch);
    let padded;
    try {
      padded = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, associatedData("golemworks-record", epoch, context), nonce, key);
    } catch {
      throw new E2EError("forged", "the record was changed, moved or made with another key");
    }
    let inside;
    try {
      inside = JSON.parse(sodium.to_string(sodium.unpad(padded, PAD_STEP)));
    } catch {
      throw new E2EError("malformed", "the record decrypted but its contents are not a padded record");
    }
    const { seq, body } = inside || {};
    if (!Number.isSafeInteger(seq) || seq < 1) throw new E2EError("malformed", "the record has no valid seq");
    if (guard) guard.check(context, seq, epoch);
    return { body, seq, epoch };
  }

  /** Refuses a seq not newer than its record's last (per: "workshop": the workshop's) and an epoch older than the workshop's newest; a re-fetch counts as replayed. */
  function createSequenceGuard({ per = "record", seen = {} } = {}) {
    if (per !== "workshop" && per !== "record") throw new E2EError("malformed", 'per must be "workshop" or "record"');
    const seqs = new Map(Object.entries(seen.seq || {}));
    const epochs = new Map(Object.entries(seen.epoch || {}));
    const workshop = (context) => JSON.stringify([context.accountId, context.workshopId]);
    const scope = (context) => (per === "workshop" ? workshop(context) : JSON.stringify([context.accountId, context.workshopId, context.kind, context.id]));
    return {
      check(context, seq, epoch = 0) {
        const key = scope(context);
        const before = seqs.get(key);
        const newestEpoch = epochs.get(workshop(context));
        if (newestEpoch > epoch) throw new E2EError("rolled-back", `epoch ${epoch} is older than ${newestEpoch}`);
        if (before === seq) throw new E2EError("replayed", `seq ${seq} was already accepted`);
        if (before > seq) throw new E2EError("rolled-back", `seq ${seq} is older than ${before}`);
        seqs.set(key, seq);
        if (!(newestEpoch >= epoch)) epochs.set(workshop(context), epoch);
      },
      toJSON: () => ({ seq: Object.fromEntries(seqs), epoch: Object.fromEntries(epochs) }),
    };
  }

  /** A hash of a device's public key, sent before the key itself so a relay cannot pick its keys after seeing the other side's (commit, then reveal). */
  function keyCommitment(publicKey, accountId) {
    need();
    const key = bytes(publicKey, sodium.crypto_box_PUBLICKEYBYTES, "public key");
    return sodium.to_base64(sodium.crypto_generichash(32, concat([sodium.from_string(`golemworks-key-commitment-v1\0${text(accountId, "account id")}\0`), key])));
  }

  /** True when publicKey is the one keyCommitment promised. */
  function checkKeyCommitment(commitment, publicKey, accountId) {
    const expected = sodium.from_base64(keyCommitment(publicKey, accountId));
    const given = fromBase64(commitment, "commitment");
    return given.length === expected.length && sodium.memcmp(given, expected);
  }

  /** The ADK for a new device from a sender whose key the safety code verified (crypto_box): unlike a sealed box, the receiver knows who sent it. */
  function boxAccountKey(accountKey, recipientPublicKey, senderKeyPair, { epoch } = {}) {
    need();
    const inside = keyWithEpoch(accountKey, epoch);
    const recipient = bytes(recipientPublicKey, sodium.crypto_box_PUBLICKEYBYTES, "recipient public key");
    const { privateKey } = checkKeyPair(senderKeyPair);
    const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
    return concat([nonce, sodium.crypto_box_easy(inside, nonce, recipient, privateKey)]);
  }

  /** Opens boxAccountKey's output; throws forged unless it came from senderPublicKey to this device unchanged, for epoch. */
  function openBoxedAccountKey(boxed, senderPublicKey, deviceKeyPair, { epoch } = {}) {
    need();
    bytes(boxed, null, "boxed account key");
    const sender = bytes(senderPublicKey, sodium.crypto_box_PUBLICKEYBYTES, "sender public key");
    const { privateKey } = checkKeyPair(deviceKeyPair);
    const size = sodium.crypto_box_NONCEBYTES;
    let inside;
    try {
      inside = sodium.crypto_box_open_easy(boxed.subarray(size), boxed.subarray(0, size), sender, privateKey);
    } catch {
      throw new E2EError("forged", "the account key did not come from that sender or was changed");
    }
    return keyOfEpoch(inside, epoch, "boxed account key");
  }

  // Rotation (slice E6): the proof names the sender of the next epoch's key, under a key the recipient already holds.
  const rotationPlace = (accountId, epoch) => ({ accountId: text(accountId, "account id"), workshopId: "*", kind: "rotation", id: String(epochOf(epoch)) });

  /** The proof for a rotation to epoch, from the sender's public key, under an account key the recipient holds (heldKey for heldEpoch). */
  function rotationProof(heldKey, { accountId, heldEpoch, epoch, from }) {
    if (!(epochOf(epoch) > epochOf(heldEpoch))) throw new E2EError("malformed", "a rotation goes to a newer epoch");
    return encryptRecord(heldKey, rotationPlace(accountId, epoch), { from: sodium.to_base64(bytes(from, sodium.crypto_box_PUBLICKEYBYTES, "sender public key")) }, { epoch: heldEpoch, seq: epoch });
  }

  /** Checks a rotation proof against this device's keyring: the sender's public key, when the proof is under this device's newest epoch for a newer one. */
  function checkRotationProof(keyring, proof, { accountId, epoch }) {
    const held = Object.keys(keyring || {}).map(Number);
    const newest = held.length ? Math.max(...held) : null;
    if (newest === null) throw new E2EError("unknown-epoch", "this device holds no account key to check a rotation with");
    if (!(epochOf(epoch) > newest)) throw new E2EError("rolled-back", `epoch ${epoch} is not newer than ${newest}`);
    if (proof?.epoch !== newest) throw new E2EError("forged", `the rotation proof is under epoch ${proof?.epoch}, not this device's newest (${newest})`);
    const { body, seq } = decryptRecord(keyring, rotationPlace(accountId, epoch), proof);
    if (seq !== epoch) throw new E2EError("forged", "the rotation proof is for another epoch");
    return fromBase64(body?.from, "sender public key");
  }

  /** Encrypts a file with crypto_secretstream in 64 KiB chunks, the last padded to 1 KB steps: version byte, epoch (4 bytes), header, chunks. */
  function encryptFile(accountKey, context, data, { epoch }) {
    need();
    epochOf(epoch);
    bytes(accountKey, sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES, "account key");
    bytes(data, null, "file");
    const ad = associatedData("golemworks-file", epoch, context);
    const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(accountKey);
    const prefix = new Uint8Array(FILE_PREFIX);
    prefix[0] = VERSION;
    new DataView(prefix.buffer).setUint32(1, epoch);
    const parts = [prefix, header];
    let at = 0;
    for (;;) {
      // Strictly under a chunk, so the padded last chunk never outgrows FILE_CHUNK and decryptFile can split by size.
      const last = data.length - at < FILE_CHUNK;
      const chunk = last ? sodium.pad(data.subarray(at), PAD_STEP) : data.subarray(at, at + FILE_CHUNK);
      const tag = last ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
      parts.push(sodium.crypto_secretstream_xchacha20poly1305_push(state, chunk, ad, tag));
      if (last) break;
      at += FILE_CHUNK;
    }
    return concat(parts);
  }

  /** Decrypts encryptFile's output for its place; throws forged when changed, moved, reordered, cut short or extended. */
  function decryptFile(keyring, context, blob) {
    need();
    bytes(blob, null, "encrypted file");
    const headerBytes = sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES;
    const extra = sodium.crypto_secretstream_xchacha20poly1305_ABYTES;
    if (blob.length < FILE_PREFIX + headerBytes + extra) throw new E2EError("malformed", "the encrypted file is too short");
    if (blob[0] !== VERSION) throw new E2EError("unsupported-version", `file version ${blob[0]} is not ${VERSION}`);
    const epoch = new DataView(blob.buffer, blob.byteOffset).getUint32(1);
    const key = keyFor(keyring, epoch);
    const ad = associatedData("golemworks-file", epoch, context);
    let state;
    try {
      state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(blob.subarray(FILE_PREFIX, FILE_PREFIX + headerBytes), key);
    } catch {
      throw new E2EError("forged", "the file header is not valid");
    }
    const parts = [];
    let at = FILE_PREFIX + headerBytes;
    for (;;) {
      const size = Math.min(FILE_CHUNK + extra, blob.length - at);
      if (size < extra) throw new E2EError("forged", "the file was cut short");
      let out;
      try {
        out = sodium.crypto_secretstream_xchacha20poly1305_pull(state, blob.subarray(at, at + size), ad);
      } catch {
        out = null;
      }
      if (!out) throw new E2EError("forged", "the file was changed, moved or made with another key");
      at += size;
      if (out.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL) {
        if (at !== blob.length) throw new E2EError("forged", "the file has data after its end");
        parts.push(sodium.unpad(out.message, PAD_STEP));
        return concat(parts);
      }
      if (at >= blob.length) throw new E2EError("forged", "the file was cut short");
      parts.push(out.message);
    }
  }

  // Key storage: { device: { publicKey, privateKey }, accountKeys: { [epoch]: key } }.

  function checkKeys(keys) {
    const device = checkKeyPair(keys?.device);
    const accountKeys = {};
    for (const [epoch, key] of Object.entries(keys?.accountKeys || {})) accountKeys[epochOf(Number(epoch))] = bytes(key, sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES, "account key");
    return { device, accountKeys };
  }

  function keysToJSON(keys) {
    const { device, accountKeys } = checkKeys(keys);
    const encoded = Object.fromEntries(Object.entries(accountKeys).map(([epoch, key]) => [epoch, sodium.to_base64(key)]));
    return { v: VERSION, device: { publicKey: sodium.to_base64(device.publicKey), privateKey: sodium.to_base64(device.privateKey) }, accountKeys: encoded };
  }

  function keysFromJSON(saved) {
    if (saved?.v !== VERSION) throw new E2EError("unsupported-version", `key file version ${saved?.v} is not ${VERSION}`);
    const accountKeys = Object.fromEntries(Object.entries(saved.accountKeys || {}).map(([epoch, key]) => [epoch, fromBase64(key, "account key")]));
    return checkKeys({ device: { publicKey: fromBase64(saved.device?.publicKey, "public key"), privateKey: fromBase64(saved.device?.privateKey, "private key") }, accountKeys });
  }

  /** Desktop: the keys in one file only this OS user can read (0600; on Windows an ACL for the user alone). protect/unprotect: optional Buffer wrappers such as Electron's safeStorage. */
  function desktopKeyStore(file, { protect = null, unprotect = null } = {}) {
    if (!nodeRequire) throw new E2EError("not-node", "desktopKeyStore runs in Node or Electron only");
    const fs = nodeRequire("node:fs");
    const path = nodeRequire("node:path");
    return {
      file,
      load() {
        need();
        let raw;
        try {
          raw = fs.readFileSync(file);
        } catch (error) {
          if (error.code === "ENOENT") return null;
          throw error;
        }
        return keysFromJSON(JSON.parse((unprotect ? unprotect(raw) : raw).toString("utf8")));
      },
      save(keys) {
        need();
        const plain = Buffer.from(`${JSON.stringify(keysToJSON(keys))}\n`, "utf8");
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const temp = `${file}.${process.pid}.tmp`;
        // Made empty and locked down first, so the key is never on disk under the folder's wider access.
        const fd = fs.openSync(temp, "wx", 0o600);
        try {
          ownerOnly(temp);
          fs.writeSync(fd, protect ? protect(plain) : plain);
          fs.fsyncSync(fd);
          fs.closeSync(fd);
          fs.renameSync(temp, file);
          if (!isOwnerOnly(file)) throw new E2EError("not-private", `${file} is readable by others after saving`);
        } catch (error) {
          try {
            fs.closeSync(fd);
          } catch {}
          fs.rmSync(temp, { force: true });
          throw error;
        }
      },
    };
  }

  /** Leaves file readable by the current OS user alone: chmod 0600, and on Windows an ACL with only that user's SID (no inherited entries). */
  function ownerOnly(file) {
    const fs = nodeRequire("node:fs");
    fs.chmodSync(file, 0o600);
    if (process.platform !== "win32") return;
    const { execFileSync } = nodeRequire("node:child_process");
    const sid = currentSid(execFileSync);
    execFileSync(system32("icacls.exe"), [file, "/inheritance:r", "/grant:r", `*${sid}:F`], { stdio: "ignore", windowsHide: true });
  }

  /** Reads the file's access back: mode 0600, or on Windows one ACL entry, the current user's. */
  function isOwnerOnly(file) {
    if (process.platform !== "win32") return (nodeRequire("node:fs").statSync(file).mode & 0o077) === 0;
    const { execFileSync } = nodeRequire("node:child_process");
    const sid = currentSid(execFileSync);
    // /save writes the ACL as SDDL: protected (P), one allow entry, for this SID.
    const out = nodeRequire("node:path").join(nodeRequire("node:os").tmpdir(), `gw-e2e-acl-${process.pid}-${Date.now()}.txt`);
    try {
      execFileSync(system32("icacls.exe"), [file, "/save", out], { stdio: "ignore", windowsHide: true });
      const sddl = nodeRequire("node:fs").readFileSync(out, "utf16le");
      const entries = sddl.match(/\([^)]*\)/g) || [];
      return /D:P/.test(sddl) && entries.length === 1 && entries[0].endsWith(`;${sid})`);
    } finally {
      nodeRequire("node:fs").rmSync(out, { force: true });
    }
  }

  // By full path: a Git or MSYS whoami earlier on PATH takes no /user.
  const system32 = (exe) => nodeRequire("node:path").win32.join(process.env.SystemRoot || "C:\\Windows", "System32", exe);

  let sidCache = null;
  function currentSid(execFileSync) {
    if (sidCache) return sidCache;
    const line = execFileSync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
    const sid = /"(S-1-[0-9-]+)"/.exec(line)?.[1];
    if (!sid) throw new E2EError("no-user", "could not read this user's SID from whoami");
    sidCache = sid;
    return sid;
  }

  /** Phone: the keys in IndexedDB on the app's origin, as raw bytes (never sent anywhere). */
  function phoneKeyStore({ indexedDB = globalThis.indexedDB, name = "golemworks-e2e" } = {}) {
    if (!indexedDB) throw new E2EError("no-indexeddb", "IndexedDB is not available here");
    const STORE = "keys";
    const open = () => new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const run = async (mode, act) => {
      const db = await open();
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, mode);
          const request = act(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(request.result);
          // tx.error is still null when the error event fires; the failed request's error is the one to report.
          tx.onerror = (event) => reject(event.target.error);
          tx.onabort = () => reject(tx.error || new E2EError("aborted", "the key store transaction was aborted"));
        });
      } finally {
        db.close();
      }
    };
    return {
      async load() {
        need();
        const saved = await run("readonly", (store) => store.get("current"));
        return saved ? checkKeys(saved) : null;
      },
      async save(keys) {
        need();
        const { device, accountKeys } = checkKeys(keys);
        await run("readwrite", (store) => store.put({ v: VERSION, device, accountKeys }, "current"));
      },
    };
  }

  const api = {
    VERSION,
    PAD_STEP,
    FILE_CHUNK,
    SAFETY_CODE_LENGTH,
    E2EError,
    init,
    newAccountKey,
    newDeviceKeyPair,
    sealAccountKey,
    openAccountKey,
    safetyCode,
    encryptRecord,
    decryptRecord,
    createSequenceGuard,
    keyCommitment,
    checkKeyCommitment,
    boxAccountKey,
    openBoxedAccountKey,
    rotationProof,
    checkRotationProof,
    encryptFile,
    decryptFile,
    desktopKeyStore,
    phoneKeyStore,
  };
  return api;
});
