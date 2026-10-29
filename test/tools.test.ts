import assert from "node:assert/strict";
import { test } from "node:test";
import { SportyBetClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { sportybetGetFixtures, sportybetGetMarkets, sportybetGetOdds } from "../src/tools.js";

const eventId = "sr:match:test-correct-score";
const kickoff = Date.now() + 24 * 60 * 60 * 1000;
const rawMarkets = [
  {
    id: "1",
    desc: "1X2",
    status: 0,
    outcomes: [{ id: "1", desc: "Home", odds: "2.5", isActive: 1 }],
  },
  {
    id: "45",
    desc: "Correct Score",
    status: 0,
    outcomes: [
      { id: "0:0", desc: "0:0", odds: "14.00", isActive: 1 },
      { id: "1:0", desc: "1:0", odds: "12.50", isActive: 1 },
      { id: "2:0", desc: "2:0", odds: "18.50", isActive: 1 },
      { id: "1:1", desc: "1:1", odds: "6.70", isActive: 1 },
      { id: "2:1", desc: "2:1", odds: "11.00", isActive: 1 },
      { id: "3:0", desc: "3:0", odds: "25.00", isActive: 0 },
      { id: "4:0", desc: "4:0", odds: "", isActive: 1 },
    ],
  },
  {
    id: "41",
    desc: "Correct Score [0:0]",
    status: 0,
    outcomes: [{ id: "0:0", desc: "0:0", odds: "13.50", isActive: 1 }],
  },
];

const originalFetch = globalThis.fetch;
const requests: string[] = [];

function mockSportyBet(startTime = kickoff, matchStatus = "Not start") {
  requests.length = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url.href);
    const requestedIds = new Set(url.searchParams.get("marketId")?.split(",") ?? []);
    return new Response(JSON.stringify({
      bizCode: 10000,
      data: {
        totalNum: 1,
        tournaments: [{
          id: "sr:tournament:test",
          name: "Test League",
          categoryName: "Test Country",
          events: [{
            eventId,
            estimateStartTime: startTime,
            matchStatus,
            homeTeamName: "Home FC",
            awayTeamName: "Away FC",
            markets: rawMarkets.filter((market) => requestedIds.has(market.id)),
          }],
        }],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

function client(cacheTtlMs = "0") {
  return new SportyBetClient(loadConfig({
    SPORTYBET_MIN_INTERVAL_MS: "0",
    SPORTYBET_CACHE_TTL_MS: cacheTtlMs,
    SPORTYBET_MAX_RETRIES: "0",
  }));
}

test("get fixtures accepts an extended timeline and limit while defaulting to the existing horizon", async () => {
  mockSportyBet();
  try {
    const sportybetClient = client("60000");
    const extended = await sportybetGetFixtures(sportybetClient, {
      limit: 2_000,
      timelineHours: 720,
    }, 60);
    assert.equal(JSON.parse(extended.content[0]!.text).count, 1);
    assert.equal(new URL(requests[0]!).searchParams.get("timeline"), "720");

    await sportybetGetFixtures(sportybetClient, {}, 60);
    assert.equal(new URL(requests[1]!).searchParams.get("timeline"), "168");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("get markets explicitly requests Correct Score and returns SportyBet outcomes", async () => {
  mockSportyBet();
  try {
    const result = await sportybetGetMarkets(client(), { eventId, marketIds: ["45"] });
    const body = JSON.parse(result.content[0]!.text);
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0]!).searchParams.get("marketId"), "45");
    assert.equal(body.eventId, eventId);
    assert.equal(body.league, "Test League");
    assert.equal(body.markets.length, 1);
    assert.equal(body.markets[0].marketId, "45");
    assert.equal(body.markets[0].outcomes.find((outcome: { outcomeId: string }) =>
      outcome.outcomeId === "1:1").odds, 6.7);
    assert.equal(body.markets[0].outcomes.find((outcome: { outcomeId: string }) =>
      outcome.outcomeId === "3:0").isActive, false);
    assert.equal(body.markets[0].outcomes.find((outcome: { outcomeId: string }) =>
      outcome.outcomeId === "4:0").odds, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("get odds explicitly requests Correct Score and separates suspended or unpriced outcomes", async () => {
  mockSportyBet();
  try {
    const result = await sportybetGetOdds(client(), { eventIds: [eventId], marketIds: ["45"] });
    const body = JSON.parse(result.content[0]!.text);
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0]!).searchParams.get("marketId"), "45");
    assert.equal(body.odds.length, 5);
    assert.ok(body.odds.every((line: { marketId: string; isActive: boolean }) =>
      line.marketId === "45" && line.isActive));
    assert.deepEqual(body.odds.map((line: { outcomeId: string; odds: number }) =>
      [line.outcomeId, line.odds]), [
      ["0:0", 14],
      ["1:0", 12.5],
      ["2:0", 18.5],
      ["1:1", 6.7],
      ["2:1", 11],
    ]);
    assert.deepEqual(body.unavailableOutcomes.map((outcome: { outcomeId: string; reason: string; odds: number | null }) =>
      [outcome.outcomeId, outcome.reason, outcome.odds]), [
      ["3:0", "suspended", 25],
      ["4:0", "missing-price", null],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("get markets can explicitly request the separate 0:0 Correct Score market", async () => {
  mockSportyBet();
  try {
    const result = await sportybetGetMarkets(client(), { eventId, marketIds: ["41"] });
    const body = JSON.parse(result.content[0]!.text);
    assert.equal(new URL(requests[0]!).searchParams.get("marketId"), "41");
    assert.deepEqual(body.markets.map((market: { marketId: string }) => market.marketId), ["41"]);
    assert.equal(body.markets[0].marketName, "Correct Score [0:0]");
    assert.equal(body.markets[0].outcomes[0].outcomeId, "0:0");
    assert.equal(body.markets[0].outcomes[0].odds, 13.5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unavailable Correct Score markets are reported without odds", async () => {
  mockSportyBet();
  try {
    const result = await sportybetGetOdds(client(), {
      eventIds: [eventId],
      marketIds: ["999"],
    });
    const body = JSON.parse(result.content[0]!.text);
    assert.equal(body.count, 0);
    assert.deepEqual(body.odds, []);
    assert.deepEqual(body.unavailableMarkets, [{
      eventId,
      marketId: "999",
      reason: "not-offered",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("expired or started fixtures do not return markets or available odds", async () => {
  mockSportyBet(Date.now() - 60_000, "In play");
  try {
    const expiredClient = client();
    const marketsResult = await sportybetGetMarkets(expiredClient, { eventId, marketIds: ["45"] });
    const marketsBody = JSON.parse(marketsResult.content[0]!.text);
    assert.equal(marketsResult.isError, true);
    assert.equal(marketsBody.error.code, "EVENT_NOT_FOUND");
    assert.match(marketsBody.error.message, /no longer an upcoming/);

    const oddsResult = await sportybetGetOdds(expiredClient, { eventIds: [eventId], marketIds: ["45"] });
    const oddsBody = JSON.parse(oddsResult.content[0]!.text);
    assert.deepEqual(oddsBody.odds, []);
    assert.deepEqual(oddsBody.unavailableEvents, [{
      eventId,
      reason: "expired-or-started",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("default market tools continue using the existing market set", async () => {
  mockSportyBet();
  try {
    const result = await sportybetGetMarkets(client(), { eventId });
    const body = JSON.parse(result.content[0]!.text);
    const requestedIds = new URL(requests[0]!).searchParams.get("marketId")?.split(",");
    assert.ok(requestedIds?.includes("1"));
    assert.ok(!requestedIds?.includes("45"));
    assert.deepEqual(body.markets.map((market: { marketId: string }) => market.marketId), ["1"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
