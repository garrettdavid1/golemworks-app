"use strict";
// Flight paths for the Board's sparks and merge crystals (Node and browser): around the cards in between, never over them.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.GolemPath = api;
})(typeof self !== "undefined" ? self : this, () => {
  /** A point is [x, y]; a rectangle is { left, top, right, bottom }; a path is a list of cubic segments [p0, c1, c2, p3]. */
  const inside = (rect, [x, y]) => x > rect.left && x < rect.right && y > rect.top && y < rect.bottom;

  /** The plain arc: one curve lifted above the higher end. */
  function arc(start, end, lift) {
    const peak = [(start[0] + end[0]) / 2, Math.min(start[1], end[1]) - lift];
    // The quadratic arc through peak's control point, as a cubic segment.
    const c1 = [start[0] + (2 / 3) * (peak[0] - start[0]), start[1] + (2 / 3) * (peak[1] - start[1])];
    const c2 = [end[0] + (2 / 3) * (peak[0] - end[0]), end[1] + (2 / 3) * (peak[1] - end[1])];
    return [[start, c1, c2, end]];
  }

  /** A smooth curve through the points (Catmull-Rom as cubic segments): it leaves the first point toward the second. */
  function through(points) {
    const at = (i) => points[Math.max(0, Math.min(points.length - 1, i))];
    const segments = [];
    for (let i = 0; i < points.length - 1; i++) {
      const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
      segments.push([p1, [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6], p2]);
    }
    return segments;
  }

  /**
   * From start to end around the rectangles in between: past the edge of the box they span (left or right, the shorter
   * way that stays on screen), so the curve stays outside every one of them. No clear way round: the highest arc.
   */
  function route(start, end, rects, { width = Infinity, lift = 30, margin = 12 } = {}) {
    const top = Math.min(start[1], end[1]);
    const bottom = Math.max(start[1], end[1]);
    const between = rects.filter((rect) => rect.bottom > top && rect.top < bottom && !inside(rect, start) && !inside(rect, end));
    const clear = (segments) => sample(segments, 96).every((spot) => !between.some((rect) => inside(rect, spot)));
    const plain = arc(start, end, lift);
    if (clear(plain)) return plain;
    const box = {
      left: Math.min(...between.map((rect) => rect.left)) - margin,
      right: Math.max(...between.map((rect) => rect.right)) + margin,
      top: Math.min(...between.map((rect) => rect.top)) - margin,
      bottom: Math.max(...between.map((rect) => rect.bottom)) + margin,
    };
    const down = start[1] <= end[1];
    const [first, last] = down ? [box.top, box.bottom] : [box.bottom, box.top];
    // The curve's middle bows out past the side line by up to a sixth of the ends' distance from it.
    const bow = (x) => Math.max(Math.abs(start[0] - x), Math.abs(end[0] - x)) / 6;
    const sides = [box.left, box.right]
      .filter((x) => x - bow(x) >= 0 && x + bow(x) <= width)
      .sort((a, b) => Math.abs(start[0] - a) + Math.abs(end[0] - a) - (Math.abs(start[0] - b) + Math.abs(end[0] - b)));
    for (const x of sides) {
      const segments = through([start, [x, first], [x, last], end]);
      if (clear(segments)) return segments;
    }
    return arc(start, end, Math.max(lift, Math.min(start[1], end[1]) - margin));
  }

  const point = ([p0, c1, c2, p3], u) => {
    const v = 1 - u;
    const a = v * v * v;
    const b = 3 * v * v * u;
    const c = 3 * v * u * u;
    const d = u * u * u;
    return [a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0], a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1]];
  };

  /** count + 1 points along the path, evenly spaced by distance so the traveler keeps one speed. */
  function sample(segments, count = 32) {
    const fine = [];
    for (const segment of segments) for (let i = fine.length ? 1 : 0; i <= 24; i++) fine.push(point(segment, i / 24));
    const lengths = [0];
    for (let i = 1; i < fine.length; i++) lengths.push(lengths[i - 1] + Math.hypot(fine[i][0] - fine[i - 1][0], fine[i][1] - fine[i - 1][1]));
    const total = lengths[lengths.length - 1];
    const points = [];
    for (let k = 0, j = 0; k <= count; k++) {
      const want = (total * k) / count;
      while (j < lengths.length - 2 && lengths[j + 1] < want) j++;
      const span = lengths[j + 1] - lengths[j] || 1;
      const u = Math.min(1, Math.max(0, (want - lengths[j]) / span));
      points.push([fine[j][0] + u * (fine[j + 1][0] - fine[j][0]), fine[j][1] + u * (fine[j + 1][1] - fine[j][1])]);
    }
    return points;
  }

  /** The path as an SVG path's d attribute. */
  const svgPath = (segments) => `M${segments[0][0].join(" ")}` + segments.map(([, c1, c2, p3]) => ` C${c1.join(" ")} ${c2.join(" ")} ${p3.join(" ")}`).join("");

  return { route, sample, svgPath, inside };
});
