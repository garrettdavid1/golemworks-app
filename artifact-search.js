// Artifacts search, the same on the desktop and the phone (docs/architecture.md "Artifacts"): every word must match, title hits first, then golem, workspace, path or link, then description or body text.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ArtifactSearch = factory();
})(typeof self !== "undefined" ? self : this, () => {
  "use strict";
  const MAX_TERMS = 8;
  const MAX_TERM = 64;
  const SNIPPET = 160;
  const META = ["golem", "workspace", "path", "url"]; // tier 1
  const TEXT = ["description", "body"]; // tier 2
  const SHOWN = ["title", "golem", "workspace"]; // what a row shows, so a word found there needs no snippet

  const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** The query's words, lowercased and once each, with a case-blind pattern for each (one copy of a body is kept, never a lowercased second). */
  function compile(query) {
    const words = [];
    for (const word of String(query || "").toLowerCase().split(/\s+/)) {
      const term = word.slice(0, MAX_TERM);
      if (term && !words.includes(term)) words.push(term);
      if (words.length === MAX_TERMS) break;
    }
    return { words, patterns: words.map((word) => new RegExp(escape(word), "i")) };
  }

  /** About SNIPPET characters of text around index, whitespace collapsed, with an ellipsis where it was cut. */
  function snippetAt(text, index, length) {
    const start = Math.max(0, index - 50);
    const end = Math.min(text.length, Math.max(index + length, start + SNIPPET));
    const piece = text.slice(start, end).replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
    return `${start > 0 ? "…" : ""}${piece}${end < text.length ? "…" : ""}`;
  }

  // A path matches below its .claude reports or artifacts folder and a link by its id, so "report" or "claude" is not a hit on every row.
  const SHELF = /^.*[\\/]\.claude[\\/](?:reports|artifacts)[\\/]/i;
  const LINK = /^https:\/\/claude\.ai\/(?:code\/)?artifact\//i;
  const searched = (field, value) => (field === "path" ? value.replace(SHELF, "") : field === "url" ? value.replace(LINK, "") : value).replace(/[\u0000-\u001f\u007f]+/g, " ");

  /** { tier (0 title, 1 meta, 2 description or body), snippet: { field, text } for a word only an unshown field holds }, or null when a word is missing everywhere. */
  function match(item, query, body = null) {
    const { words, patterns } = typeof query === "string" ? compile(query) : query;
    if (!words.length) return { tier: 0, snippet: null };
    const fields = { body: body || "" };
    for (const field of ["title", ...META, "description"]) fields[field] = item[field] ? searched(field, String(item[field])) : "";
    const text = (field) => fields[field];
    let tier = 0;
    for (const pattern of patterns) {
      if (pattern.test(text("title"))) continue;
      if (META.some((field) => pattern.test(text(field)))) tier = Math.max(tier, 1);
      else if (TEXT.some((field) => pattern.test(text(field)))) tier = 2;
      else return null;
    }
    const hidden = patterns.findIndex((pattern) => !SHOWN.some((field) => pattern.test(text(field))));
    if (hidden < 0) return { tier, snippet: null };
    for (const field of ["path", "url", ...TEXT]) {
      const value = text(field);
      const index = value.search(patterns[hidden]);
      if (index >= 0) return { tier, snippet: { field, text: field === "path" || field === "url" ? value : snippetAt(value, index, words[hidden].length) } };
    }
    return { tier, snippet: null };
  }

  /** The items that match, title hits first, then meta, then text; each tier keeps the order the items came in. bodyOf(item) gives a file's text or null. */
  function search(items, query, { bodyOf = () => null } = {}) {
    const compiled = compile(query);
    const tiers = [[], [], []];
    for (const item of items) {
      const found = match(item, compiled, compiled.words.length ? bodyOf(item) : null);
      if (found) tiers[found.tier].push({ item, tier: found.tier, snippet: found.snippet });
    }
    return tiers.flat();
  }

  /** text cut into [{ text, hit }] pieces at each word, for a renderer to mark the hits as text, never HTML. */
  function pieces(text, query) {
    const source = String(text ?? "");
    const { words } = typeof query === "string" ? compile(query) : query;
    if (!words.length || !source) return source ? [{ text: source, hit: false }] : [];
    // Longest first, so "artifacts" wins over "art" where both start.
    const any = new RegExp([...words].sort((a, b) => b.length - a.length).map(escape).join("|"), "gi");
    const out = [];
    let last = 0;
    for (const m of source.matchAll(any)) {
      if (m.index > last) out.push({ text: source.slice(last, m.index), hit: false });
      out.push({ text: m[0], hit: true });
      last = m.index + m[0].length;
    }
    if (last < source.length) out.push({ text: source.slice(last), hit: false });
    return out;
  }

  return { compile, match, search, pieces, snippetAt, MAX_TERMS };
});
