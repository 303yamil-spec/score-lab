import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HistoricalMatch } from "../src/footballData.js";
import { predictCorrectScores } from "../src/predictionEngine.js";
import { PredictionStore, type StoredFixture, type StoredPrediction } from "../src/predictionStore.js";

function fixture(kickoff: string): StoredFixture {
  return {
    eventId: "sr:match:store-test",
    league: "Test League",
    category: "Test",
    homeTeam: "Home FC",
    awayTeam: "Away FC",
    startTime: kickoff,
    matchStatus: "Not start",
    marketCount: 4,
  };
}

function prediction(now: Date, expectedHomeGoals = 1.5): StoredPrediction {
  return {
    ...predictCorrectScores(expectedHomeGoals, 1.1, 10),
    createdAt: now.toISOString(),
    dataSource: "sportybet-market-implied",
    confidence: "low",
    dataQuality: "test data",
    warnings: [],
    statistics: null,
    rho: 0,
  };
}

test("SQLite store persists fixtures, odds, and every score probability", t => {
  const directory = mkdtempSync(join(tmpdir(), "scorelab-store-"));
  const store = new PredictionStore(join(directory, "test.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const now = new Date();
  const game = fixture(new Date(now.getTime() + 60 * 60 * 1000).toISOString());
  const odds = [{
    eventId: game.eventId,
    marketId: "1",
    market: "1X2",
    outcome: "Home",
    outcomeId: "1",
    odds: 2,
    isActive: true,
    timestamp: now.toISOString(),
  }];
  store.saveFixture(game, odds, now);
  assert.equal(store.savePrediction(game, prediction(now), now), true);

  const loaded = store.getMatch(game.eventId);
  assert.equal(loaded?.odds[0]?.odds, 2);
  assert.equal(loaded?.prediction?.scores.length, 121);
  assert.ok(Math.abs((loaded?.prediction?.totalProbability ?? 0) - 1) < 1e-12);
});

test("match history API can return the expanded upcoming fixture set", t => {
  const directory = mkdtempSync(join(tmpdir(), "scorelab-many-fixtures-"));
  const store = new PredictionStore(join(directory, "test.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const now = new Date();
  for (let index = 0; index < 501; index++) {
    store.saveFixture({
      ...fixture(new Date(now.getTime() + (index + 1) * 60_000).toISOString()),
      eventId: `sr:match:store-test-${index}`,
    }, [], now);
  }
  assert.equal(store.getMatches({ now }).length, 501);
});

test("predictions freeze at kickoff and are not rewritten afterward", t => {
  const directory = mkdtempSync(join(tmpdir(), "scorelab-freeze-"));
  const store = new PredictionStore(join(directory, "test.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const created = new Date();
  const kickoff = new Date(created.getTime() + 1000);
  const game = fixture(kickoff.toISOString());
  store.saveFixture(game, [], created);
  store.savePrediction(game, prediction(created, 1.5), created);
  store.saveFixture({ ...game, matchStatus: "In play" }, [], new Date(kickoff.getTime() + 1));
  assert.equal(store.savePrediction(game, prediction(new Date(kickoff.getTime() + 2), 3), new Date(kickoff.getTime() + 2)), false);
  assert.equal(store.getMatch(game.eventId)?.prediction?.expectedHomeGoals, 1.5);
});

test("saved predictions appear in history by kickoff date from earliest to latest", t => {
  const directory = mkdtempSync(join(tmpdir(), "scorelab-prediction-history-"));
  const store = new PredictionStore(join(directory, "test.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const created = new Date();
  const games = [3, 1, 2].map((hours, index) => ({
    ...fixture(new Date(created.getTime() + hours * 60 * 60 * 1000).toISOString()),
    eventId: `sr:match:prediction-history-${index}`,
  }));
  for (const game of games) {
    store.saveFixture(game, [], created);
    store.savePrediction(game, prediction(created), created);
  }

  const history = store.getHistory();
  assert.equal(history.length, 3);
  assert.deepEqual(history.map(item => item.eventId), [
    "sr:match:prediction-history-1",
    "sr:match:prediction-history-2",
    "sr:match:prediction-history-0",
  ]);
  assert.equal(history[0]?.actualScore, null);
  assert.equal(history[0]?.rank, null);
  assert.equal(history[0]?.brierScore, null);
  assert.equal(history[0]?.prediction.expectedHomeGoals, 1.5);
});

test("completed results are matched to saved fixtures and scored against frozen predictions", t => {
  const directory = mkdtempSync(join(tmpdir(), "scorelab-results-"));
  const store = new PredictionStore(join(directory, "test.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const created = new Date();
  const kickoff = new Date(created.getTime() + 1000);
  const game = fixture(kickoff.toISOString());
  store.saveFixture(game, [], created);
  store.savePrediction(game, prediction(created), created);

  const final: HistoricalMatch = {
    id: 8,
    utcDate: new Date(kickoff.getTime() + 30 * 60 * 1000).toISOString(),
    status: "FINISHED",
    homeTeam: { name: "Home FC" },
    awayTeam: { name: "Away FC" },
    score: { fullTime: { home: 1, away: 1 } },
  };
  assert.equal(store.saveResults([final], "test", new Date(kickoff.getTime() + 2 * 60 * 60 * 1000)), 1);
  const history = store.getHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0]?.actualScore, "1-1");
  assert.ok(history[0]?.rank !== null);
});
