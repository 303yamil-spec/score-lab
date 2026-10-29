import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenFixtures, fixtureToOdds, normalizeBooking, normalizeFixture, normalizeMarket } from "../src/normalizers.js";
import type { RawBookingData, RawEvent, RawMarket, RawTournament } from "../src/rawTypes.js";

const fixtureFile = (name: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures", name), "utf8"));

test("normalizeFixture produces clean, typed fields", () => {
  const raw = fixtureFile("fixtures.json") as { data: { tournaments: RawTournament[] } };
  const fixtures = flattenFixtures(raw.data.tournaments);
  assert.ok(fixtures.length > 0);
  const f = fixtures[0]!;
  assert.match(f.eventId, /^sr:match:/);
  assert.ok(f.homeTeam.length > 0);
  assert.ok(f.awayTeam.length > 0);
  assert.ok(f.league.length > 0);
  assert.ok(f.category.length > 0);
  assert.ok(f.startTimeMs > 0);
  assert.ok(!Number.isNaN(Date.parse(f.startTime)));
  assert.equal(f.matchStatus, "Not start");
  assert.ok(Array.isArray(f.markets));
});

test("normalizeMarket converts string odds to numbers and keeps specifier", () => {
  const rawEvent = fixtureFile("fixtures.json").data.tournaments[0].events[0] as RawEvent;
  const rawMarket = rawEvent.markets![0]! as RawMarket;
  const market = normalizeMarket(rawMarket, rawEvent.eventId!);
  assert.equal(market.marketId, "1");
  assert.equal(market.marketName, "1X2");
  assert.ok(market.outcomes.length >= 3 || market.outcomes.length >= 1);
  const o = market.outcomes[0]!;
  assert.equal(typeof o.odds, "number");
  assert.ok(o.odds > 1);
  assert.equal(typeof o.isActive, "boolean");
  assert.ok("specifier" in market);
});

test("fixtureToOdds emits timestamped, normalized odds lines", () => {
  const raw = fixtureFile("fixtures.json") as { data: { tournaments: RawTournament[] } };
  const fixture = flattenFixtures(raw.data.tournaments)[0]!;
  const odds = fixtureToOdds(fixture);
  assert.ok(odds.length > 0);
  for (const line of odds) {
    assert.ok(line.eventId && line.marketId && line.outcomeId);
    assert.ok(line.event.length > 0);
    assert.ok(line.odds > 0);
    assert.ok(!Number.isNaN(Date.parse(line.timestamp)));
  }
});

test("normalizeBooking parses shareCode, deadline and legs", () => {
  const raw = fixtureFile("booking.json") as { data: RawBookingData };
  raw.data!.deadline = Date.now() + 60 * 60 * 1000;
  const booking = normalizeBooking(raw.data!);
  assert.match(booking.shareCode, /^[A-Z0-9]+$/);
  assert.ok(booking.shareURL.includes("shareCode="));
  assert.ok(booking.deadlineMs! > Date.now() - 1e9);
  assert.ok(booking.expiresAt);
  assert.ok(booking.legs.length >= 1);
  const leg = booking.legs[0]!;
  assert.ok(leg.homeTeam.length > 0 && leg.awayTeam.length > 0);
  assert.ok(leg.outcome.odds > 1);
  assert.equal(leg.market.marketName.length > 0, true);
});
