/**
 * Internal normalized types for SportyBet data.
 * Raw API responses are never passed to the AI directly.
 */

export interface SportyBetFixture {
  eventId: string;
  gameId?: string;
  league: string;
  leagueId: string;
  category: string;
  categoryId: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  startTimeMs: number;
  matchStatus: string;
  sport: string;
  markets: SportyBetMarket[];
}

export interface SportyBetMarket {
  eventId: string;
  marketId: string;
  marketName: string;
  specifier: string | null;
  status: number;
  group?: string;
  lastOddsChangeTime?: number;
  outcomes: SportyBetOutcome[];
}

export interface SportyBetOutcome {
  outcomeId: string;
  outcomeName: string;
  odds: number;
  rawOdds: string;
  isActive: boolean;
  probability?: number;
}

export interface SportyBetSelection {
  eventId: string;
  marketId: string;
  outcomeId: string;
  specifier?: string | null;
  odds?: number;
}

export interface SportyBetOdds {
  eventId: string;
  marketId: string;
  outcomeId: string;
  event: string;
  market: string;
  specifier: string | null;
  outcome: string;
  odds: number;
  timestamp: string;
}

export interface SportyBetBookingLeg {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string | null;
  startTimeMs: number | null;
  matchStatus: string;
  market: SportyBetMarket;
  outcome: SportyBetOutcome;
}

export interface SportyBetBooking {
  shareCode: string;
  shareURL: string;
  deadlineMs: number | null;
  expiresAt: string | null;
  betType?: string;
  legs: SportyBetBookingLeg[];
  unavailableOutcomes: unknown[];
}

export interface FixtureQuery {
  date?: string;
  league?: string;
  limit: number;
}

export interface SearchQuery {
  query: string;
  date?: string;
  limit: number;
}