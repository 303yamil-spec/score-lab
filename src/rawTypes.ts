/**
 * Raw shapes of the SportyBet web API responses (confirmed live, see README).
 * These types are internal only — normalized before leaving this server.
 */

export interface RawOutcome {
  id: string;
  desc: string;
  odds: string;
  probability?: string;
  voidProbability?: string;
  isActive?: number;
}

export interface RawMarket {
  id?: string;
  desc?: string;
  name?: string;
  title?: string;
  specifier?: string;
  status?: number;
  group?: string;
  lastOddsChangeTime?: number;
  outcomes?: RawOutcome[];
}

export interface RawEvent {
  eventId: string;
  gameId?: string;
  estimateStartTime?: number;
  status?: number;
  matchStatus?: string;
  homeTeamName?: string;
  awayTeamName?: string;
  sport?: { id?: string; name?: string };
  markets?: RawMarket[];
}

export interface RawTournament {
  id?: string;
  name?: string;
  categoryId?: string;
  categoryName?: string;
  events?: RawEvent[];
}

export interface RawUpcomingResponse {
  bizCode?: number;
  message?: string;
  data?: {
    totalNum?: number;
    tournaments?: RawTournament[];
  };
}

export interface RawBookingLegMarket {
  id?: string;
  desc?: string;
  name?: string;
  specifier?: string;
  status?: number;
  outcomes?: RawOutcome[];
}

export interface RawBookingLeg {
  eventId?: string;
  estimateStartTime?: number;
  matchStatus?: string;
  homeTeamName?: string;
  awayTeamName?: string;
  markets?: RawBookingLegMarket[];
}

export interface RawBookingData {
  shareCode?: string;
  shareURL?: string;
  ticket?: string;
  userId?: string;
  deadline?: number;
  betType?: string;
  outcomes?: RawBookingLeg[];
  unavailableOutcomes?: unknown[];
}

export interface RawBookingResponse {
  bizCode?: number;
  message?: string;
  data?: RawBookingData;
}