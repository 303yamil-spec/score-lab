import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenFixtures } from "../src/normalizers.js";
import { validateSelections, validateSelection } from "../src/validation.js";
import type { RawTournament } from "../src/rawTypes.js";
import type { SportyBetFixture, SportyBetSelection } from "../src/types.js";

const fixtureFile = (name: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures", name), "utf8"));
const capturedFixtures = flattenFixtures((fixtureFile("fixtures.json") as { data: { tournaments: RawTournament[] } }).data.tournaments);
const fixtures = capturedFixtures.map((fixture, index) => ({
  ...fixture,
  startTimeMs: Date.now() + (index + 1) * 60_000,
  startTime: new Date(Date.now() + (index + 1) * 60_000).toISOString(),
  matchStatus: "Not start",
}));
const first = fixtures.find((f) => f.markets.some((m) => m.marketId === "1"))!;

function validSelection(overrides: Partial<SportyBetSelection> = {}): SportyBetSelection {
  return { eventId: first.eventId, marketId: "1", outcomeId: "1", specifier: null, ...overrides };
}

test("valid selection passes", () => {
  const r = validateSelection(validSelection(), first);
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test("invalid event handling: unknown event fails", () => {
  const r = validateSelection(validSelection({ eventId: "sr:match:nonexistent" }), first);
  assert.equal(r.valid, false);
  assert.ok(r.errors[0]!.toLowerCase().includes("not in sportybet"));
});

test("invalid market handling: unknown market fails and lists available", () => {
  const r = validateSelection(validSelection({ marketId: "99999" }), first);
  assert.equal(r.valid, false);
  assert.ok(r.errors[0]!.includes("not offered"));
  assert.ok(r.errors[0]!.includes("Available market ids"));
});

test("invalid outcome handling: unknown outcome fails and lists available", () => {
  const r = validateSelection(validSelection({ marketId: "1", outcomeId: "424242" }), first);
  assert.equal(r.valid, false);
  assert.ok(r.errors[0]!.includes("does not exist"));
  assert.ok(r.errors[0]!.includes("Available outcome ids"));
});

test("inactive outcome fails", () => {
  const inactive: SportyBetFixture = {
    ...first,
    markets: first.markets.map((m) =>
      m.marketId === "1"
        ? { ...m, outcomes: m.outcomes.map((o) => (o.outcomeId === "1" ? { ...o, isActive: false } : o)) }
        : m,
    ),
  };
  const r = validateSelection(validSelection(), inactive);
  assert.equal(r.valid, false);
  assert.ok(r.errors[0]!.includes("no longer available"));
});

test("expired/started event handling: past start time fails", () => {
  const started: SportyBetFixture = { ...first, startTimeMs: Date.now() - 60_000, startTime: new Date(Date.now() - 60_000).toISOString(), matchStatus: "In play" };
  const r = validateSelection(validSelection(), started);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.toLowerCase().includes("started")));
});

test("specifier mismatch fails", () => {
  const ou = first.markets.find((m) => m.marketId === "18");
  if (!ou) return;
  const r = validateSelection({ eventId: first.eventId, marketId: "18", outcomeId: ou.outcomes[0]!.outcomeId, specifier: "total=1.5" }, first);
  assert.equal(r.valid, false);
  assert.ok(r.errors[0]!.includes("Specifier"));
});

test("duplicate selections are rejected", () => {
  const sel = validSelection();
  const v = validateSelections([sel, { ...sel }], [first]);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.toLowerCase().includes("duplicate")));
});

test("odds drift produces a warning, not a failure", () => {
  const r = validateSelection(validSelection({ odds: 99 }), first);
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some((w) => w.startsWith("Odds for")));
});

test("validateSelections aggregates errors and warnings", () => {
  const v = validateSelections(
    [validSelection(), validSelection({ eventId: "sr:match:gone" })],
    [first],
  );
  assert.equal(v.valid, false);
  assert.equal(v.errors.length, 1);
  assert.equal(v.warnings.length, 0);
});
