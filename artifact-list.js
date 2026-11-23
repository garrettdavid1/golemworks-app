// The phone's Artifacts list, by workshop, through its filters and search (public/artifact-search.js, Golemworks' own copy byte for byte). It runs on what this device opened: the hub never sees the words.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./artifact-search"));
  else root.ArtifactList = factory(root.ArtifactSearch);
})(typeof self !== "undefined" ? self : this, (ArtifactSearch) => {
  "use strict";

  /** The opened list ({ workshops: [{ id, name, online, items }] }) by workshop, title hits first; items carry no path or text, so those are never searched. */
  function groups(view, { workshop = "", kind = "", query = "" } = {}) {
    const out = [];
    let shown = 0;
    let total = 0;
    for (const w of view?.workshops || []) {
      total += (w.items || []).length;
      if (workshop && w.id !== workshop) continue;
      const items = (w.items || []).filter((item) => !kind || item.kind === kind);
      const entries = ArtifactSearch.search(items, query).map(({ item, snippet }) => ({ item, snippet }));
      if (!entries.length) continue;
      shown += entries.length;
      out.push({ w, entries });
    }
    return { groups: out, shown, total, searching: ArtifactSearch.compile(query).words.length > 0 };
  }

  return { groups };
});
