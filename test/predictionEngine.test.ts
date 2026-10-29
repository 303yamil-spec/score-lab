import assert from "node:assert/strict";
import { test } from "node:test";
import {
  expectedGoalsFromOneXTwo,
  poissonProbability,
  predictCorrectScores,
} from "../src/predictionEngine.js";

test("Poisson probabilities include 0-0, 1-0, 1-1 and high scores", () => {
  assert.equal(poissonProbability(0, 0), 1);
  assert.equal(poissonProbability(0, 1), 0);
  const result = predictCorrectScores(1.5, 1.1, 10);
  const byScore = new Map(result.scores.map(item => [item.score, item.probability]));
  assert.ok(byScore.get("0-0")! > 0);
  assert.ok(byScore.get("1-0")! > 0);
  assert.ok(byScore.get("1-1")! > 0);
  assert.ok(byScore.get("10-10")! > 0);
  assert.equal(result.scores.length, 121);
});

test("probabilities plus above-range overflow sum to one", () => {
  for (const [home, away, max] of [[1.7, 0.9, 10], [6.5, 5.2, 4], [2.4, 2.2, 20]]) {
    const prediction = predictCorrectScores(home, away, max);
    assert.ok(Math.abs(prediction.totalProbability - 1) < 1e-12);
    assert.ok(prediction.overflowProbability >= 0);
  }
});

test("Dixon-Coles adjustment preserves the total distribution", () => {
  const independent = predictCorrectScores(1.4, 1.1, 10);
  const adjusted = predictCorrectScores(1.4, 1.1, 10, -0.08);
  const plain00 = independent.scores.find(item => item.score === "0-0")!.probability;
  const adjusted00 = adjusted.scores.find(item => item.score === "0-0")!.probability;
  assert.notEqual(adjusted00, plain00);
  assert.ok(Math.abs(adjusted.totalProbability - 1) < 1e-12);
});

test("1X2 market prices produce labelled market-implied expected goals", () => {
  const result = expectedGoalsFromOneXTwo({ home: 2.5, draw: 3.2, away: 3 });
  assert.ok(result.expectedHomeGoals > 0);
  assert.ok(result.expectedAwayGoals > 0);
  assert.ok(Math.abs(result.marketProbabilities.home
    + result.marketProbabilities.draw + result.marketProbabilities.away - 1) < 1e-12);
});

test("score range and odds inputs are validated", () => {
  assert.throws(() => predictCorrectScores(1, 1, 21), RangeError);
  assert.throws(() => predictCorrectScores(1, 1, 10, 0.3), RangeError);
  assert.throws(() => expectedGoalsFromOneXTwo({ home: 1, draw: 3, away: 4 }), RangeError);
});
