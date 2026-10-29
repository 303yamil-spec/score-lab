/**
 * Booking parsing + the NO-STAKE guarantee.
 *
 * These tests prove that the only write operation this server performs is
 * POST to the non-staking /orders/share endpoint, that it never attaches a
 * stake/amount to anything, and that booking responses parse correctly.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { SportyBetClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { normalizeBooking } from "../src/normalizers.js";
import type { RawBookingData } from "../src/rawTypes.js";

const fixtureFile = (name: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures", name), "utf8"));

test("booking response parses into a typed SportyBetBooking", () => {
  const raw = fixtureFile("booking.json") as { data: RawBookingData };
  const booking = normalizeBooking(raw.data!);
  assert.match(booking.shareCode, /^[A-Z0-9]{4,12}$/);
  assert.ok(booking.deadlineMs !== null);
  assert.ok(booking.expiresAt);
  assert.ok(booking.legs.length >= 1);
  assert.ok(booking.legs.every((l) => l.outcome.odds > 0));
});

test("no-stake guarantee: source contains no wagering endpoint or payload", async () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "src", "client.ts"), "utf8");
  const forbidden = [
    /\/orders\/(place|bet|stake|confirm|wager)/i,
    /place\s*bet/i,
    /bet\s*now/i,
    /stakeAmount/,
    /betAmount/,
    /stake\s*:/i,
    /amount\s*:/i,
    /wallet/i,
    /password/i,
    /otp/i,
    /card\s*number/i,
    /\/bet\//i,
  ];
  for (const re of forbidden) {
    assert.ok(!re.test(source), `client.ts must not contain a wagering/credential reference matching ${re}`);
  }
});

test("no-stake guarantee: booking flow only calls /orders/share and sends no stake field", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const bookingFixture = fixtureFile("booking.json") as { data: RawBookingData };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    let body: unknown;
    if (u.includes("pcUpcomingEvents")) body = fixtureFile("fixtures.json");
    else if (u.includes("/orders/share")) body = bookingFixture;
    else body = {};
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as typeof fetch;

  const client = new SportyBetClient(
    loadConfig({ SPORTYBET_MIN_INTERVAL_MS: "0", SPORTYBET_MAX_CONCURRENCY: "10", SPORTYBET_CACHE_TTL_MS: "0" }),
  );
  const fixtures = await client.getFixtures();
  const event = fixtures.find((f) => f.markets.some((m) => m.marketId === "1"))!;
  const booking = await client.createBooking([{ eventId: event.eventId, marketId: "1", outcomeId: "1", specifier: null }]);
  assert.match(booking.shareCode, /^[A-Z0-9]+$/);

  const posts = calls.filter((c) => (c.init?.method ?? "GET") === "POST");
  assert.ok(posts.length >= 1, "expected at least one POST");
  for (const p of posts) {
    assert.ok(p.url.endsWith("/orders/share") || p.url.includes("/orders/share?"), `POST went to ${p.url}, expected /orders/share`);
    const payload = JSON.parse(String(p.init!.body)) as { selections: Record<string, unknown>[] };
    assert.ok(Array.isArray(payload.selections));
    for (const sel of payload.selections) {
      for (const forbiddenKey of ["amount", "stake", "wager", "currency", "payment"]) {
        assert.ok(!(forbiddenKey in sel), `selection must not contain "${forbiddenKey}"`);
      }
    }
  }
  for (const c of calls) {
    const path = new URL(c.url).pathname.toLowerCase();
    assert.ok(
      !/(place|wager|stake|confirm|\/bet\/)/.test(path),
      `no call may target a wagering endpoint: ${c.url}`,
    );
  }
});

test("no-stake guarantee: booking POST is never auto-retried", async () => {
  let postCount = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if ((init?.method ?? "GET") === "POST") {
      postCount++;
      return { ok: false, status: 500, text: async () => "{}" } as unknown as Response;
    }
    if (u.includes("pcUpcomingEvents")) return { ok: true, status: 200, text: async () => JSON.stringify(fixtureFile("fixtures.json")) } as unknown as Response;
    return { ok: true, status: 200, text: async () => "{}" } as unknown as Response;
  }) as typeof fetch;
  const client = new SportyBetClient(
    loadConfig({ SPORTYBET_MIN_INTERVAL_MS: "0", SPORTYBET_MAX_CONCURRENCY: "10", SPORTYBET_CACHE_TTL_MS: "0", SPORTYBET_MAX_RETRIES: "3" }),
  );
  await assert.rejects(() =>
    client.createBooking([{ eventId: "sr:match:1", marketId: "1", outcomeId: "1", specifier: null }]),
  );
  assert.equal(postCount, 1, "a non-idempotent POST must not be retried");
});

test("booking status lookup is read-only (GET only)", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes("/orders/share/HW8EM8")) {
      return { ok: true, status: 200, text: async () => JSON.stringify(fixtureFile("bookingStatus.json")) } as unknown as Response;
    }
    return { ok: true, status: 200, text: async () => "{}" } as unknown as Response;
  }) as typeof fetch;
  const client = new SportyBetClient(loadConfig({ SPORTYBET_MIN_INTERVAL_MS: "0" }));
  const booking = await client.getBooking("HW8EM8");
  assert.equal(booking.shareCode, "HW8EM8");
  assert.ok(calls.every((c) => (c.init?.method ?? "GET") === "GET"));
});
