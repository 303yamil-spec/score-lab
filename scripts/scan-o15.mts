/**
 * Bulk scan: all fixtures on 2026-08-15 (WAT) → read Over/Under 1.5 market.
 * Outputs qualifying matches where UNDER 1.5 odds >= 5.0, with the OVER 1.5 price.
 * Read-only analysis helper (no booking, no staking).
 */
import { SportyBetClient } from "../src/client.js";

const DAY = "2026-08-15"; // WAT
const TZ = 60; // WAT = UTC+1
const startMs = Date.UTC(2026, 7, 15, 0, 0) - TZ * 60000; // 2026-08-15T00:00 WAT
const endMs = Date.UTC(2026, 7, 16, 0, 0) - TZ * 60000; // 2026-08-16T00:00 WAT

const client = new SportyBetClient();

// Walk the catalogue: many pages so we capture everything the API returns.
const fixtures = await client.getFixtures({
  timelineHours: 48,
  pageSize: 100,
  maxPages: 20,
});

const today = fixtures.filter((f) => f.startTimeMs >= startMs && f.startTimeMs < endMs);

interface Qualifier {
  eventId: string;
  league: string;
  category: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  under15: number | null;
  over15: number | null;
}

const withMarket: Qualifier[] = [];
const noMarket: string[] = [];
const quals: Qualifier[] = [];

for (const f of today) {
  const m = f.markets.find(
    (mm) => mm.marketId === "18" && mm.specifier === "total=1.5",
  );
  if (!m) {
    noMarket.push(`${f.homeTeam} vs ${f.awayTeam} (${f.league})`);
    continue;
  }
  const under = m.outcomes.find((o) => o.outcomeId === "13");
  const over = m.outcomes.find((o) => o.outcomeId === "12");
  if (!under || !over) {
    noMarket.push(`${f.homeTeam} vs ${f.awayTeam} (${f.league}) [missing side]`);
    continue;
  }
  const q: Qualifier = {
    eventId: f.eventId,
    league: f.league,
    category: f.category,
    homeTeam: f.homeTeam,
    awayTeam: f.awayTeam,
    startTime: f.startTime,
    under15: under.odds,
    over15: over.odds,
  };
  withMarket.push(q);
  if (under.odds >= 5.0) quals.push(q);
}

const out = {
  scannedTotal: fixtures.length,
  todayCount: today.length,
  withOUMarket: withMarket.length,
  noOUMarket: noMarket.length,
  qualifiers: quals.length,
  qualifiersList: quals,
};
console.log(JSON.stringify(out, null, 2));
