// Play on a Chat reply: the workshop's ElevenLabs audio, fetched in pieces and started on the first one.
"use strict";

const VoicePlay = (() => {
  const TYPE = "audio/mpeg";
  const KEPT = 20; // replies whose audio stays in this page for an instant replay
  const EMPTY_LIMIT = 15; // pieces in a row with no audio yet (each waited 7 s on the workshop) before giving up
  const FAILED = "Could not play the audio.";

  const bytes = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

  /** deps: { piece(workshopId, seq, from): { next, done, data }, root(): where the buttons are, makeAudio, Source: MediaSource or null, log }. */
  function create({ piece, root, makeAudio = () => new Audio(), Source = globalThis.ManagedMediaSource || globalThis.MediaSource || null, log = (line) => console.log(line), pause = () => new Promise((resolve) => setTimeout(resolve, 300)) }) {
    let audio = null;
    let url = null;
    let now = { key: null, state: null, error: "" };
    let tap = 0; // a later tap or Stop makes an earlier one's pieces stale
    let live = false; // pieces are still coming into the audio element
    const cache = new Map(); // key -> the whole clip's pieces
    const streams = () => Boolean(Source && Source.isTypeSupported?.(TYPE));

    function paint() {
      for (const row of root().querySelectorAll("[data-play]")) {
        const mine = row.dataset.play === now.key;
        const state = mine ? now.state : null;
        const button = row.querySelector("button");
        button.dataset.state = state || "";
        button.textContent = state === "loading" ? "Loading" : state === "playing" ? "■ Stop" : "▶ Play";
        row.querySelector(".play-error").textContent = mine ? now.error : "";
      }
    }

    const set = (key, state, error = "") => {
      now = { key, state, error };
      paint();
    };

    function release() {
      live = false;
      if (!audio) return;
      audio.onplaying = audio.onended = audio.onerror = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      if (url) URL.revokeObjectURL(url);
      url = null;
    }

    function stop() {
      tap++;
      release();
      set(null, null);
    }

    const keep = (key, parts) => {
      cache.delete(key);
      cache.set(key, parts);
      if (cache.size > KEPT) cache.delete(cache.keys().next().value);
    };

    /** Every piece in order, handed to take as it arrives; stops once a later tap took over. */
    async function fetchAll(workshopId, seq, mine, take) {
      const parts = [];
      for (let from = 0, done = false, empty = 0; !done; ) {
        const got = await piece(workshopId, seq, from);
        if (mine !== tap) return null;
        const part = bytes(got.data);
        ({ next: from, done } = got);
        if (part.length) {
          empty = 0;
          parts.push(part);
          await take(part, parts);
        } else if (!done) {
          if (++empty >= EMPTY_LIMIT) throw new Error("The audio is taking too long. Try again.");
          await pause();
        }
        if (mine !== tap) return null;
      }
      return parts;
    }

    const appended = (buffer, part) =>
      new Promise((resolve, reject) => {
        buffer.addEventListener("updateend", () => resolve(), { once: true });
        buffer.addEventListener("error", () => reject(new Error(FAILED)), { once: true });
        buffer.appendBuffer(part);
      });

    async function play(workshopId, seq) {
      const key = `${workshopId}:${seq}`;
      // Refused while pieces were still coming: this tap starts the same audio, nothing is fetched again.
      if (now.key === key && now.state === "refused") return start(tap, key);
      if (now.key === key && now.state) return stop();
      stop();
      const mine = ++tap;
      const started = Date.now();
      set(key, "loading");
      audio ||= makeAudio();
      audio.onplaying = () => {
        if (mine !== tap) return;
        log(`speech: first sound ${Date.now() - started} ms after the tap`);
        set(key, "playing");
      };
      audio.onended = () => mine === tap && set(null, null);
      const whole = (parts, at = 0) => {
        live = false;
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(new Blob(parts, { type: TYPE }));
        audio.src = url;
        if (at) audio.currentTime = at;
        audio.onerror = () => mine === tap && set(key, null, FAILED);
        return start(mine, key);
      };
      try {
        const kept = cache.get(key);
        if (kept) return await whole(kept);
        // Streaming that fails (no room left in the buffer, a decode error) falls back to the whole clip.
        let broken = !streams();
        let buffer = null;
        let source = null;
        let opened = null;
        if (!broken) {
          try {
            source = new Source();
            // ManagedMediaSource (iPhone) opens only with remote playback off.
            audio.disableRemotePlayback = true;
            url = URL.createObjectURL(source);
            audio.src = url;
            live = true;
            opened = new Promise((resolve) => {
              source.addEventListener("sourceopen", () => resolve(true), { once: true });
              audio.onerror = () => {
                broken = true;
                resolve(false);
              };
            });
            // Called inside the tap, so the phone lets it sound once the first piece is in.
            start(mine, key);
          } catch {
            broken = true;
          }
        }
        const parts = await fetchAll(workshopId, seq, mine, async (part, all) => {
          if (broken) return;
          try {
            if (!buffer) {
              if (!(await opened)) return;
              buffer = source.addSourceBuffer(TYPE);
              for (const earlier of all) await appended(buffer, earlier);
              return;
            }
            await appended(buffer, part);
          } catch {
            broken = true;
          }
        });
        if (!parts) return;
        keep(key, parts);
        live = false;
        if (broken) return await whole(parts, source ? audio.currentTime || 0 : 0);
        if (source.readyState === "open") source.endOfStream();
      } catch (error) {
        if (mine !== tap) return;
        release();
        set(key, null, error.message || FAILED);
      }
    }

    function start(mine, key) {
      return audio.play().catch((error) => {
        if (mine !== tap) return;
        if (error.name !== "NotAllowedError") return set(key, null, FAILED);
        // The phone wants a fresh tap: while pieces are coming it plays what is here, afterwards the kept clip.
        set(key, live ? "refused" : null, "Tap Play again.");
      });
    }

    return { play, stop, paint };
  }

  return { create };
})();

if (typeof module !== "undefined") module.exports = VoicePlay;
