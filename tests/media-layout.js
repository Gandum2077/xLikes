"use strict";

var assert = require("assert");
var layout = require("../public/media-layout");

function media(ratios) {
  return ratios.map(function (ratio) { return { width: ratio, height: 1 }; });
}

function near(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) < (tolerance || 0.00001), actual + " != " + expected);
}

// Measurements from the two X posts inspected in Chrome, at a 566px content width.
var first = layout(media([2730 / 4096, 2730 / 4096, 2730 / 4096, 9 / 16]));
near(first.height * 566 + first.offset, 504.906, 0.03);
var second = layout(media([0.75, 0.562799, 0.744154, 2 / 3]));
near(second.height * 566 + second.offset, 498.635, 0.03);

// Portrait pairs fit together; landscape sets leave an obvious scrollable continuation.
var pair = layout(media([2 / 3, 2 / 3]));
near(pair.height * 360 + pair.offset, 267);
near(pair.aspects[0] * (pair.height * 360 + pair.offset) * 2 + 4, 360);
var landscape = layout(media([16 / 9, 16 / 9, 1]));
near(landscape.height, 0.68);
assert.ok(landscape.aspects[0] < 16 / 9);

// Extreme ratios and missing metadata must never produce invalid CSS dimensions.
[[0.05, 0.1, 3], [4, 0.2], [1, 1], [1, 1, 1, 1], [null, 1, 2], [Infinity, -1, NaN]].forEach(function (ratios) {
  var result = layout(media(ratios));
  [292, 362, 668].forEach(function (width) {
    var height = result.height * width + result.offset;
    assert.ok(isFinite(height) && height > 0);
    assert.ok(result.height <= 1.24446);
    result.aspects.forEach(function (aspect) {
      assert.ok(isFinite(aspect) && aspect > 0);
      assert.ok(aspect * height <= width + 0.01);
    });
  });
});
console.log("PASS: X reference dimensions, portrait pair fitting, landscape cropping, extreme ratios and missing metadata");
