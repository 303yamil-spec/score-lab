import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { SportyBetClient, SportyBetError } from "../src/client.js";
import { loadConfig } from "../src/config.js";

const fixtureFile = (name: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures", name), "utf8"));

function testClient() {
  return new SportyBetClient(
    loadConfig({
      SPORTYBET_MIN_INTERVAL_MS: "0",
      SPORTYBET_MAX_CONCURRENCY: "10",
      SPORTYBET_MAX_RETRIES: "2",
      SPORTYBET_CACHE_TTL_MS: "0",
      SPORTYBET_TIMEOUT_MS: "500",
    }),
  );
}

type FetchCall = { url: string; init?: RequestInit };
const calls: FetchCall[] = [];

function mockFetch(handler: (call: FetchCall) => { status: number; body: unknown }) {
  calls.length = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    const { status, body } = handler(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)),
    } as unknown as Response;
  }) as typeof fetch;
}

test("successful fixture fetch normalizes and caches-free returns data", async () => {
  mockFetch(() => ({ status: 200, body: fixtureFile("fixtures.json") }));
  const client = testClient();
  const fixtures = await client.getFixtures();
  assert.ok(fixtures.length > 0);
  assert.ok(calls.some((c) => c.url.includes("pcUpcomingEvents")));
});

test("HTTP 429 retries then succeeds", async () => {
  let count = 0;
  mockFetch((c) => {
    if (c.url.includes("pcUpcomingEvents")) {
      count++;
      if (count === 1) return { status: 429, body: { message: "slow down" } };
      return { status: 200, body: fixtureFile("fixtures.json") };
    }
    return { status: 200, body: {} };
  });
  const client = testClient();
  const fixtures = await client.getFixtures();
  assert.ok(fixtures.length > 0);
  assert.ok(count >= 2, "expected at least one retry");
});

test("persistent HTTP 500 maps to SERVER_ERROR with useful message", async () => {
  mockFetch(() => ({ status: 500, body: { message: "upstream exploded" } }));
  const client = testClient();
  await assert.rejects(
    () => client.getFixtures(),
    (err: SportyBetError) => {
      assert.equal(err.code, "SERVER_ERROR");
      assert.match(err.message, /upstream exploded|500/);
      assert.ok(err.action && err.action.length > 0);
      return true;
    },
  );
});

test("HTTP 400 maps to BAD_REQUEST", async () => {
  mockFetch(() => ({ status: 400, body: { message: "bad params" } }));
  const client = testClient();
  await assert.rejects(
    () => client.getFixtures(),
    (err: SportyBetError) => err.code === "BAD_REQUEST",
  );
});

test("HTTP 401 / 403 / 404 map to dedicated codes", async () => {
  for (const [status, code] of [[401, "UNAUTHORIZED"], [403, "FORBIDDEN"], [404, "NOT_FOUND"]] as const) {
    mockFetch(() => ({ status, body: {} }));
    const client = testClient();
    await assert.rejects(() => client.getFixtures(), (err: SportyBetError) => err.code === code);
  }
});

test("timeout maps to TIMEOUT after retries", async () => {
  globalThis.fetch = (async () => {
    throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  }) as typeof fetch;
  const client = testClient();
  await assert.rejects(() => client.getFixtures(), (err: SportyBetError) => err.code === "TIMEOUT");
});

test("network error maps to NETWORK", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const client = testClient();
  await assert.rejects(() => client.getFixtures(), (err: SportyBetError) => err.code === "NETWORK");
});

test("malformed JSON response maps to MALFORMED_RESPONSE", async () => {
  mockFetch(() => ({ status: 200, body: "<html>not json</html>" }));
  const client = testClient();
  await assert.rejects(
    () => client.getFixtures(),
    (err: SportyBetError) => err.code === "MALFORMED_RESPONSE",
  );
});

test("upstream bizCode rejection surfaces as UPSTREAM error", async () => {
  mockFetch(() => ({ status: 200, body: { bizCode: 5001, message: "event not open" } }));
  const client = testClient();
  await assert.rejects(
    () => client.getFixtures(),
    (err: SportyBetError) => err.code === "UPSTREAM" && err.message.includes("event not open"),
  );
});
