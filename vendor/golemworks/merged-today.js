// The sidebar's "Merged today" count (Node and browser): merges since the viewer's local midnight.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MergedToday = api;
})(typeof self !== "undefined" ? self : this, () => {
  const dayKey = (date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

  /** The merges ({ pr, at }) whose time falls on now's local day; skip: PRs not to count yet. */
  function mergedToday(merges, now = new Date(), skip = new Set()) {
    const today = dayKey(now);
    return (merges || []).filter((merge) => {
      const at = new Date(merge?.at);
      return !Number.isNaN(at.getTime()) && dayKey(at) === today && !skip.has(merge.pr);
    });
  }

  /** Milliseconds from now to the next local midnight, when the count starts over. */
  function msToMidnight(now = new Date()) {
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  return { mergedToday, msToMidnight };
});
