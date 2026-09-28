(function (root) {
  "use strict";

  var GAP = 4;
  var MAX_WIDTH = 0.8;
  var MAX_HEIGHT = 1.24446;

  // X carousel behavior inspected on 2026-09-27: baseline height 68%, item width
  // capped at 80%, with the first two items controlling the continuation cue.

  function sum(values) {
    return values.reduce(function (total, value) { return total + value; }, 0);
  }

  // Solve H * sum(aspects) + gaps = W, accounting for the 80% width cap.
  function fitRow(ratios) {
    if (ratios.some(function (ratio) { return ratio === null; })) {
      return null;
    }
    var remaining = ratios.slice();
    var cappedCount = 0;
    while (remaining.length) {
      var total = sum(remaining);
      var height = (1 - MAX_WIDTH * cappedCount) / total;
      if (height <= 0) { return null; }
      var uncapped = remaining.filter(function (ratio) { return height * ratio <= MAX_WIDTH; });
      if (uncapped.length === remaining.length) {
        return { height: height, offset: -GAP * (ratios.length - 1) / total };
      }
      cappedCount += remaining.length - uncapped.length;
      remaining = uncapped;
    }
    return null;
  }

  function widthAt(height, ratio) {
    return ratio === null ? height : Math.min(MAX_WIDTH, height * ratio);
  }

  function layout(media) {
    var ratios = media.map(function (item) {
      var width = Number(item.width);
      var height = Number(item.height);
      var ratio = width / height;
      return width > 0 && height > 0 && isFinite(ratio) && ratio > 0 ? ratio : null;
    });
    var fit = ratios.length > 1 ? fitRow(ratios) : null;
    var result = { height: 0.68, offset: 0 };
    if (fit && fit.height >= result.height) {
      result = fit.height <= MAX_HEIGHT ? fit : { height: MAX_HEIGHT, offset: 0 };
    }

    if (ratios.length > 1) {
      var first = widthAt(result.height, ratios[0]);
      var second = widthAt(result.height, ratios[1]);
      var visibleSecond = Math.min(Math.max(1 - first, 0), second) / second;
      if (ratios.length === 2) {
        // Two items may fit together when at least one third of item two is visible.
        if (fit && fit.height < result.height && visibleSecond >= 0.33) { result = fit; }
      } else if (visibleSecond > 0.67) {
        // For longer rows, leave a third of item two offscreen as a scrolling cue.
        var a = ratios[0] === null ? 1 : ratios[0];
        var b = ratios[1] === null ? 1 : ratios[1];
        var candidates = [];
        function candidate(numerator, denominator, firstCapped, secondCapped) {
          var height = numerator / denominator;
          if (height <= 0 || !isFinite(height)) { return; }
          var validFirst = ratios[0] === null || (firstCapped ? height * a >= MAX_WIDTH : height * a <= MAX_WIDTH);
          var validSecond = ratios[1] === null || (secondCapped ? height * b >= MAX_WIDTH : height * b <= MAX_WIDTH);
          if (validFirst && validSecond) { candidates.push({ height: height, offset: -GAP / denominator }); }
        }
        candidate(1, a + 0.67 * b, false, false);
        if (ratios[0] !== null) { candidate(0.2, 0.67 * b, true, false); }
        if (ratios[1] !== null) { candidate(0.464, a, false, true); }
        if (candidates.length) {
          var next = candidates.reduce(function (best, value) { return value.height < best.height ? value : best; });
          if (next.height > MAX_HEIGHT) { next = { height: MAX_HEIGHT, offset: 0 }; }
          var known = ratios.slice(0, 2).filter(function (ratio) { return ratio !== null; });
          if (known.length) {
            var cropLimit = Math.max(result.height, Math.min.apply(null, known.map(function (ratio) { return MAX_WIDTH / ratio; })));
            if (next.height > cropLimit) { next = { height: cropLimit, offset: 0 }; }
          }
          if (next.height > result.height) { result = next; }
        }
      }
    }
    return {
      height: result.height,
      offset: result.offset,
      aspects: ratios.map(function (ratio) { return widthAt(result.height, ratio) / result.height; })
    };
  }

  if (typeof module !== "undefined" && module.exports) { module.exports = layout; }
  else { root.mediaCarouselLayout = layout; }
}(this));
