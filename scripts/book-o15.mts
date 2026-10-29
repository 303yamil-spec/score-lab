/**
 * Book Over 1.5 Goals for every match where Under 1.5 odds >= 6.0 (today, WAT).
 * Uses the same code path as the MCP sportybet_book_bet tool (validate +
 * anonymous non-staking POST /orders/share). No wager is placed.
 */
import { SportyBetClient } from "../src/client.js";
import { validateSelections } from "../src/validation.js";

const TZ = 60;
const startMs = Date.UTC(2026, 7, 15, 0, 0) - TZ * 60000;
const endMs = Date.UTC(2026, 7, 16, 0, 0) - TZ * 60000;

const client = new SportyBetClient();
const fixtures = await client.getFixtures({ timelineHours: 48, pageSize: 100, maxPages: 20 });
const today = fixtures.filter((f) => f.startTimeMs >= startMs && f.startTimeMs < endMs);

const quals: { eventId: string; homeTeam: string; awayTeam: string; league: string; startTime: string; under15: number; over15: number }[] = [];
for (const f of today) {
  const m = f.markets.find((mm) => mm.marketId === "18" && mm.specifier === "total=1.5");
  if (!m) continue;
  const under = m.outcomes.find((o) => o.outcomeId === "13");
  const over = m.outcomes.find((o) => o.outcomeId === "12");
  if (!under || !over) continue;
  if (under.odds >= 6.0) {
    quals.push({ eventId: f.eventId, homeTeam: f.homeTeam, awayTeam: f.awayTeam, league: f.league, startTime: f.startTime, under15: under.odds, over15: over.odds });
  }
}

if (!quals.length) {
  console.log("NO_QUALIFIERS");
  process.exit(0);
}

const selectionFor = (q: (typeof quals)[number]) => ({
  eventId: q.eventId,
  marketId: "18",
  specifier: "total=1.5",
  outcomeId: "12",
  odds: q.over15,
});

// Validate all first (whole-catalogue validation like the MCP tool).
const allSelections = quals.map(selectionFor);
const v = validateSelections(allSelections, fixtures);
console.log("QUALIFIERS", quals.length);
console.log("VALID_ALL", v.valid, "ERRORS", v.errors.length, "WARNINGS", v.warnings.length);
for (const e of v.errors) console.log("ERR", e);

// Book in batches of max 20.
const batches: typeof quals[] = [];
for (let i = 0; i < quals.length; i += 20) batches.push(quals.slice(i, i + 20));

for (const batch of batches) {
  const selections = batch.map(selectionFor);
  const booking = await client.createBooking(selections);
  console.log("---BOOKING---");
  console.log(JSON.stringify({
    bookingCode: booking.shareCode,
    shareURL: booking.shareURL,
    legs: booking.legs.length,
    expiresAt: booking.expiresAt,
    betType: booking.betType ?? "Multiple",
    legsList: booking.legs.map((l) => ({
      eventId: l.eventId,
      event: `${l.homeTeam} vs ${l.awayTeam}`,
      startTime: l.startTime,
      market: l.market.marketName,
      specifier: l.market.specifier,
      outcome: l.outcome.outcomeName,
      odds: l.outcome.odds,
    })),
  }, null, 2));
}
