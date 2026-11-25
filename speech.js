// Read aloud: a golem's reply as the phone's own voice says it (Web Speech), links and paths named, never spelled out.
"use strict";

const Speech = (() => {
  // Novelty and robotic voices iOS and macOS list beside the natural ones.
  const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|fred|good news|jester|junior|kathy|organ|ralph|superstar|trinoids|whisper|wobble|zarvox|eloquence|grandma|grandpa|rocko|shelley|flo|reed|sandy)\b/i;

  /** What a reply sounds like: a URL is "a link", a file path "a path", code marks and markdown dropped. */
  function sayable(text) {
    return String(text || "")
      .replace(/https?:\/\/\S+?([.,;:!?)]*)(?=\s|$)/g, " a link$1 ")
      .replace(/`([^`]*)`/g, (_, inside) => (/[\\/]/.test(inside) ? " a path " : inside))
      .replace(/(?:\b[A-Za-z]:[\\/]|\\\\)[^\s,;:)"'`]+/g, " a path ")
      .replace(/(^|[\s(])(?:~|\.{1,2})?\/[\w.@~+-]+(?:\/[\w.@~+-]+)+\/?/g, "$1a path ")
      .replace(/[*_#>]+/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Sentences, joined up to about 200 characters a piece: one long utterance can stop part way on some phones. */
  function pieces(text, max = 200) {
    const out = [];
    for (const sentence of text.match(/[^.!?]+[.!?]*/g) || []) {
      const s = sentence.trim();
      if (!s) continue;
      if (out.length && (out[out.length - 1] + " " + s).length <= max) out[out.length - 1] += " " + s;
      else out.push(s);
    }
    return out;
  }

  /** Every voice the phone has ever listed this session, by name: iOS can list fewer after the first read, and a voice once seen stays on offer. */
  function voiceBook() {
    const seen = new Map();
    return {
      note(list) {
        for (const v of list || []) if (v && v.name) seen.set(v.name, v);
        return list;
      },
      all: () => [...seen.values()],
      /** The voice picked by name (the phone's fresh object when it lists it); null for iPhone default: set no voice and no lang, and iOS uses its own. */
      resolve(fresh, saved) {
        this.note(fresh);
        return (saved && ([...(fresh || [])].find((v) => v.name === saved) || seen.get(saved))) || null;
      },
    };
  }

  /** One snapshot of what the phone reports, English entries in full, as lines for Settings. */
  function describeVoices(when, list) {
    const all = [...(list || [])];
    const en = all.filter((v) => String(v.lang || "").toLowerCase().startsWith("en"));
    return [`${when}: ${all.length} voices, ${en.length} English`, ...en.map((v) => `  ${v.name} | ${v.lang} | ${v.voiceURI} | ${v.localService ? "local" : "network"}${v.default ? " | default" : ""}`)].join("\n");
  }

  /** Voices for the Settings picker: English first, novelty voices out, the rest by name. */
  function pickerVoices(voices) {
    return [...(voices || [])]
      .filter((v) => String(v.lang || "").toLowerCase().startsWith("en") && !NOVELTY.test(v.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  return { sayable, pieces, voiceBook, describeVoices, pickerVoices };
})();

if (typeof module !== "undefined") module.exports = Speech;
