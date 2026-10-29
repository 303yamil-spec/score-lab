/**
 * MCP tool handlers. Each returns a CallToolResult-shaped object.
 * All responses are normalized JSON — never raw SportyBet payloads.
 */
import type { SportyBetClient } from "./client.js";
import type { SportyBetFixture, SportyBetSelection } from "./types.js";
import { calcCombinedOdds, OddsError } from "./odds.js";
import { validateSelections } from "./validation.js";
import { logger } from "./logger.js";
import { DEFAULT_MARKET_IDS } from "./marketCatalogue.js";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

const HOUR_MS = 3_600_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIMIT = 2_000;

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(code: string, message: string, action?: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ success: false, error: { code, message, action } }, null, 2) }],
    isError: true,
  };
}

function clampLimit(limit: number | undefined, fallback = 50): number {
  const n = Math.floor(limit ?? fallback);
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

/** Day bounds in the configured timezone offset (default West Africa Time, UTC+1). */
function dayBounds(date: string, tzOffsetMinutes: number): { start: number; end: number } | null {
  if (!DATE_RE.test(date)) return null;
  const [y, m, d] = date.split("-").map(Number);
  const utcStart = Date.UTC(y!, m! - 1, d!);
  return {
    start: utcStart - tzOffsetMinutes * 60_000,
    end: utcStart - tzOffsetMinutes * 60_000 + 24 * HOUR_MS,
  };
}

function timelineForDate(
  date: string | undefined,
  tzOffsetMinutes: number,
  timelineHours = 168,
  now = Date.now(),
): number {
  if (!date) return Math.min(Math.max(Math.floor(timelineHours), 12), 720);
  const bounds = dayBounds(date, tzOffsetMinutes);
  if (!bounds) return 168;
  const hours = Math.ceil((bounds.end - now) / HOUR_MS);
  return Math.min(Math.max(hours, 12), 720);
}

function fixtureProjection(f: SportyBetFixture) {
  return {
    eventId: f.eventId,
    league: f.league,
    leagueId: f.leagueId,
    category: f.category,
    homeTeam: f.homeTeam,
    awayTeam: f.awayTeam,
    startTime: f.startTime,
    matchStatus: f.matchStatus,
    marketCount: f.markets.length,
  };
}

function isUpcomingFixture(fixture: SportyBetFixture): boolean {
  return fixture.startTimeMs > Date.now() && fixture.matchStatus === "Not start";
}

export async function sportybetGetFixtures(
  client: SportyBetClient,
  args: { date?: string; league?: string; limit?: number; timelineHours?: number },
  cfgTzOffsetMinutes: number,
): Promise<ToolResult> {
  const limit = clampLimit(args.limit);
  const timeline = timelineForDate(args.date, cfgTzOffsetMinutes, args.timelineHours);
  const fixtures = await client.getFixtures({ timelineHours: timeline, maxPages: Math.ceil(limit / 100) + 1 });

  let filtered = fixtures;
  const bounds = args.date ? dayBounds(args.date, cfgTzOffsetMinutes) : null;
  if (bounds) {
    filtered = filtered.filter((f) => f.startTimeMs >= bounds!.start && f.startTimeMs < bounds!.end);
  }
  if (args.league) {
    const q = args.league.toLowerCase();
    filtered = filtered.filter(
      (f) => f.league.toLowerCase().includes(q) || f.category.toLowerCase().includes(q),
    );
  }

  const result = {
    success: true,
    fetchedAt: new Date().toISOString(),
    date: args.date ?? null,
    league: args.league ?? null,
    count: Math.min(filtered.length, limit),
    fixtures: filtered.slice(0, limit).map(fixtureProjection),
  };
  logger.info({ tool: "sportybet_get_fixtures", success: true, count: result.count });
  return ok(result);
}

export async function sportybetGetMarkets(
  client: SportyBetClient,
  args: { eventId: string; marketIds?: string[] },
): Promise<ToolResult> {
  const requestedMarketIds = args.marketIds;
  const fixture = await client.findEvent(args.eventId, requestedMarketIds ?? DEFAULT_MARKET_IDS);
  if (!fixture) {
    return fail(
      "EVENT_NOT_FOUND",
      `Event ${args.eventId} was not found in SportyBet's upcoming list.`,
      "Refresh the fixtures; the event may have started or been removed.",
    );
  }
  if (!isUpcomingFixture(fixture)) {
    return fail(
      "EVENT_NOT_FOUND",
      `Event ${args.eventId} is no longer an upcoming pre-match fixture.`,
      "Refresh the fixtures and select an event that has not started.",
    );
  }
  const markets = requestedMarketIds
    ? fixture.markets.filter((market) => requestedMarketIds.includes(market.marketId))
    : fixture.markets;
  const result = {
    success: true,
    fetchedAt: new Date().toISOString(),
    eventId: fixture.eventId,
    event: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
    league: fixture.league,
    startTime: fixture.startTime,
    markets: markets.map((m) => ({
      marketId: m.marketId,
      marketName: m.marketName,
      specifier: m.specifier,
      status: m.status,
      lastOddsChangeTime: m.lastOddsChangeTime ?? null,
      outcomes: m.outcomes.map((o) => ({
        outcomeId: o.outcomeId,
        outcomeName: o.outcomeName,
        odds: Number.isFinite(o.odds) && o.odds > 0 ? o.odds : null,
        isActive: o.isActive,
      })),
    })),
  };
  logger.info({ tool: "sportybet_get_markets", success: true, eventId: args.eventId, markets: result.markets.length });
  return ok(result);
}

export async function sportybetGetOdds(
  client: SportyBetClient,
  args: { eventIds: string[]; marketIds?: string[] },
): Promise<ToolResult> {
  const ids = [...new Set(args.eventIds.slice(0, 50))];
  if (!ids.length) return fail("NO_EVENT_IDS", "Provide at least one eventId.", "Call sportybet_get_fixtures first.");
  const fixtures = await client.getFixtures({ marketIds: args.marketIds });
  const byId = new Map(fixtures.map((f) => [f.eventId, f]));
  const found = ids.flatMap((id) => {
    const fixture = byId.get(id);
    return fixture && isUpcomingFixture(fixture) ? [fixture] : [];
  });
  const unavailableEvents = ids.flatMap((id) => {
    const fixture = byId.get(id);
    return fixture && !isUpcomingFixture(fixture)
      ? [{ eventId: id, reason: "expired-or-started" }]
      : [];
  });
  const missing = ids.filter((id) => !byId.has(id));

  const timestamp = new Date().toISOString();
  const oddsLines = found.flatMap((f) =>
    f.markets
      .filter((market) => !args.marketIds || args.marketIds.includes(market.marketId))
      .flatMap((m) =>
        m.outcomes
          .filter((o) => o.isActive && Number.isFinite(o.odds) && o.odds > 0)
          .map((o) => ({
            eventId: f.eventId,
            event: `${f.homeTeam} vs ${f.awayTeam}`,
            league: f.league,
            startTime: f.startTime,
            marketId: m.marketId,
            market: m.marketName,
            specifier: m.specifier,
            outcomeId: o.outcomeId,
            outcome: o.outcomeName,
            odds: o.odds,
            isActive: o.isActive,
          })),
    ),
  );
  const unavailableOutcomes = found.flatMap((f) =>
    f.markets
      .filter((market) => !args.marketIds || args.marketIds.includes(market.marketId))
      .flatMap((m) =>
        m.outcomes
          .filter((o) => !o.isActive || !Number.isFinite(o.odds) || o.odds <= 0)
          .map((o) => ({
            eventId: f.eventId,
            event: `${f.homeTeam} vs ${f.awayTeam}`,
            league: f.league,
            startTime: f.startTime,
            marketId: m.marketId,
            market: m.marketName,
            specifier: m.specifier,
            outcomeId: o.outcomeId,
            outcome: o.outcomeName,
            odds: Number.isFinite(o.odds) && o.odds > 0 ? o.odds : null,
            isActive: o.isActive,
            reason: !o.isActive ? "suspended" : "missing-price",
          })),
    ),
  );

  const result = {
    success: true,
    fetchedAt: timestamp,
    oddsTimestamp: timestamp,
    count: oddsLines.length,
    odds: oddsLines,
    unavailableOutcomes,
    unavailableMarkets: found.flatMap((fixture) =>
      (args.marketIds ?? []).filter((marketId) =>
        !fixture.markets.some((market) => market.marketId === marketId),
      ).map((marketId) => ({
        eventId: fixture.eventId,
        marketId,
        reason: "not-offered",
      })),
    ),
    unavailableEvents,
    missingEvents: missing,
    note: "Odds change frequently. Treat every value as a snapshot taken at oddsTimestamp.",
  };
  logger.info({ tool: "sportybet_get_odds", success: true, events: found.length, lines: oddsLines.length });
  return ok(result);
}

export async function sportybetSearchFixtures(
  client: SportyBetClient,
  args: { query: string; date?: string; limit?: number },
  cfgTzOffsetMinutes: number,
): Promise<ToolResult> {
  const limit = clampLimit(args.limit);
  const query = args.query.trim().toLowerCase();
  if (!query) return fail("EMPTY_QUERY", "Provide a search query.", "Search by team name, league, or country.");
  const timeline = timelineForDate(args.date, cfgTzOffsetMinutes);
  const fixtures = await client.getFixtures({ timelineHours: timeline });

  const bounds = args.date ? dayBounds(args.date, cfgTzOffsetMinutes) : null;
  const matches = fixtures
    .filter((f) => {
      if (bounds && (f.startTimeMs < bounds!.start || f.startTimeMs >= bounds!.end)) return false;
      const haystack = `${f.homeTeam} ${f.awayTeam} ${f.league} ${f.category}`.toLowerCase();
      return haystack.includes(query);
    })
    .slice(0, limit);

  const result = {
    success: true,
    fetchedAt: new Date().toISOString(),
    query: args.query,
    date: args.date ?? null,
    count: matches.length,
    fixtures: matches.map(fixtureProjection),
  };
  logger.info({ tool: "sportybet_search_fixtures", success: true, query: args.query, count: matches.length });
  return ok(result);
}

export function sportybetCalculateCombinedOdds(args: { selections: { odds: number }[] }): ToolResult {
  const odds = args.selections.map((s) => s.odds);
  try {
    const combined = calcCombinedOdds(odds);
    const result = {
      success: true,
      combinedOdds: combined,
      selectionCount: odds.length,
      note: "Combined odds are decimal odds multiplied together. This is not a probability estimate and does not guarantee any payout.",
    };
    logger.info({ tool: "sportybet_calculate_combined_odds", success: true, count: odds.length });
    return ok(result);
  } catch (err) {
    if (err instanceof OddsError) return fail("INVALID_ODDS", err.message, "Provide finite positive decimal odds for every selection.");
    throw err;
  }
}

export async function sportybetBookBet(
  client: SportyBetClient,
  args: { selections: SportyBetSelection[] },
): Promise<ToolResult> {
  const selections = args.selections;
  if (!selections.length) {
    return fail("EMPTY_SELECTION", "No selections provided.", "Provide at least one selection with eventId, marketId and outcomeId.");
  }
  if (selections.length > 20) {
    return fail("TOO_MANY_SELECTIONS", "Maximum 20 selections per betslip.", "Reduce the number of selections.");
  }

  const marketIds = [...new Set([...selections.map((s) => s.marketId), ...DEFAULT_MARKET_IDS])];
  const fixtures = await client.getFixtures({ marketIds, maxPages: 20 });

  const validation = validateSelections(selections, fixtures);
  if (!validation.valid) {
    const detail = validation.results
      .map((r, i) => ({
        selection: i + 1,
        eventId: r.selection.eventId,
        problems: r.errors,
      }))
      .filter((d) => d.problems.length);
    logger.warn({ tool: "sportybet_book_bet", success: false, errorCode: "VALIDATION_FAILED", problems: validation.errors.length });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: false,
              error: {
                code: "VALIDATION_FAILED",
                message: `${validation.errors.length} validation problem(s) found. Booking was NOT created.`,
                action: "Refresh the odds and rebuild the selection.",
                details: detail,
              },
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  const resolved = validation.results.map((r) => ({
    selection: r.selection,
    event: r.event!,
    market: r.market!,
    outcome: r.outcome!,
  }));

  const booking = await client.createBooking(selections);

  const liveOdds = booking.legs.map((l) => l.outcome.odds).filter((o) => Number.isFinite(o) && o > 0);
  const combined = liveOdds.length === booking.legs.length ? calcCombinedOdds(liveOdds) : null;

  const priceMoved = validation.warnings
    .map((w) => w)
    .filter((w) => w.startsWith("Odds for"));
  const dropped = (booking.unavailableOutcomes ?? []).length;

  const result = {
    success: true,
    bookingCode: booking.shareCode,
    shareURL: booking.shareURL,
    selectionCount: booking.legs.length,
    combinedOdds: combined,
    expiresAt: booking.expiresAt,
    betType: booking.betType ?? "Multiple",
    message: "Betslip prepared. No wager was placed.",
    warnings: [...validation.warnings, ...(dropped ? [`${dropped} selection(s) were unavailable and excluded from the code.`] : [])],
    legs: booking.legs.map((l) => ({
      eventId: l.eventId,
      event: `${l.homeTeam} vs ${l.awayTeam}`,
      startTime: l.startTime,
      market: l.market.marketName,
      marketId: l.market.marketId,
      specifier: l.market.specifier,
      outcome: l.outcome.outcomeName,
      outcomeId: l.outcome.outcomeId,
      odds: l.outcome.odds,
    })),
  };
  logger.info({ tool: "sportybet_book_bet", success: true, bookingCode: booking.shareCode, legs: booking.legs.length });
  return ok(result);
}

export async function sportybetGetBookingStatus(
  client: SportyBetClient,
  args: { bookingCode: string },
): Promise<ToolResult> {
  const booking = await client.getBooking(args.bookingCode);
  const result = {
    success: true,
    bookingCode: booking.shareCode,
    shareURL: booking.shareURL,
    expiresAt: booking.expiresAt,
    betType: booking.betType ?? "Multiple",
    selectionCount: booking.legs.length,
    status: "prepared",
    note: "This booking code was prepared but never staked. Checking it does not place or modify any wager.",
    legs: booking.legs.map((l) => ({
      eventId: l.eventId,
      event: `${l.homeTeam} vs ${l.awayTeam}`,
      startTime: l.startTime,
      matchStatus: l.matchStatus,
      market: l.market.marketName,
      outcome: l.outcome.outcomeName,
      odds: l.outcome.odds,
    })),
  };
  logger.info({ tool: "sportybet_get_booking_status", success: true, bookingCode: args.bookingCode });
  return ok(result);
}