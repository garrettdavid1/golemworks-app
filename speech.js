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

  /** The most natural English voice on offer: Premium, then Enhanced, then Siri, in the phone's own English first. */
  function bestVoice(voices, language = "en-US") {
    const want = String(language).toLowerCase().replace("_", "-");
    const score = (v) => {
      const lang = String(v.lang || "").toLowerCase().replace("_", "-");
      if (!lang.startsWith("en") || NOVELTY.test(v.name)) return -1;
      return (/premium/i.test(v.name) ? 8 : 0) + (/enhanced/i.test(v.name) ? 4 : 0) + (/siri/i.test(v.name) ? 2 : 0) + (lang === want ? 1 : 0) + (v.default ? 0.5 : 0);
    };
    const best = [...(voices || [])].map((v) => [score(v), v]).filter(([s]) => s >= 0).sort((a, b) => b[0] - a[0])[0];
    return best ? best[1] : null;
  }

  return { sayable, pieces, bestVoice };
})();

if (typeof module !== "undefined") module.exports = Speech;
