import { test } from "node:test";
import assert from "node:assert/strict";
import { calcCombinedOdds, OddsError, oddsDrift, roundOdds } from "../src/odds.js";

test("combined odds multiply decimal odds", () => {
  assert.equal(calcCombinedOdds([1.5, 1.8]), 2.7);
  assert.equal(calcCombinedOdds([2, 2, 2]), 8);
  assert.equal(calcCombinedOdds([1.5]), 1.5);
});

test("combined odds rounds to two decimals", () => {
  assert.equal(calcCombinedOdds([1.234, 2.345]), roundOdds(1.234 * 2.345));
});

test("empty selection yields zero", () => {
  assert.equal(calcCombinedOdds([]), 0);
});

test("invalid odds throw OddsError", () => {
  assert.throws(() => calcCombinedOdds([0]), OddsError);
  assert.throws(() => calcCombinedOdds([-1.5, 2]), OddsError);
  assert.throws(() => calcCombinedOdds([NaN, 2]), OddsError);
  assert.throws(() => calcCombinedOdds([Infinity]), OddsError);
});

test("oddsDrift returns absolute price difference", () => {
  assert.equal(oddsDrift(1.5, 1.6), 0.1);
  assert.equal(oddsDrift(undefined, 1.6), null);
  assert.equal(oddsDrift(2, 2), 0);
});
