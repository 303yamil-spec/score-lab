/**
 * Selection validation for booking. Ensures every selection maps to a live,
 * currently available outcome on an upcoming event before a booking code is
 * requested. If any hard validation fails, the booking must NOT be created.
 */
import { oddsDrift } from "./odds.js";
import type { SportyBetFixture, SportyBetMarket, SportyBetOutcome, SportyBetSelection } from "./types.js";

export interface ValidationResult {
  selection: SportyBetSelection;
  valid: boolean;
  errors: string[];
  warnings: string[];
  event?: SportyBetFixture;
  market?: SportyBetMarket;
  outcome?: SportyBetOutcome;
}

const DRIFT_ABS_THRESHOLD = 0.05;
const DRIFT_REL_THRESHOLD = 0.15;

export function validateSelection(
  selection: SportyBetSelection,
  fixture: SportyBetFixture | undefined,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!selection.eventId || !selection.marketId || !selection.outcomeId) {
    errors.push("Every selection needs eventId, marketId and outcomeId.");
    return { selection, valid: false, errors, warnings };
  }

  if (!fixture) {
    errors.push(
      `Event ${selection.eventId} is not in SportyBet's upcoming list. It may have kicked off, markets may not be open yet, or the event id is wrong.`,
    );
    return { selection, valid: false, errors, warnings };
  }

  if (fixture.eventId !== selection.eventId) {
    errors.push(
      `Event ${selection.eventId} is not in SportyBet's upcoming list (closest event found: ${fixture.homeTeam} vs ${fixture.awayTeam}). Refresh fixtures and use the eventId returned by the server.`,
    );
    return { selection, valid: false, errors, warnings };
  }

  if (fixture.startTimeMs && fixture.startTimeMs <= Date.now()) {
    errors.push(`Event ${selection.eventId} (${fixture.homeTeam} vs ${fixture.awayTeam}) has already started or kicked off.`);
  }
  if (fixture.matchStatus && fixture.matchStatus !== "Not start") {
    errors.push(`Event ${selection.eventId} has match status "${fixture.matchStatus}" and is not open for pre-match booking.`);
  }

  // A single marketId can span several specifier lines (e.g. Over/Under has
  // separate markets per "total=N"). Match on marketId AND specifier together
  // so a "total=1.5" selection resolves to the 1.5 line, not the first one.
  const market = fixture.markets.find(
    (m) =>
      m.marketId === selection.marketId &&
      (selection.specifier == null || m.specifier === selection.specifier),
  );
  if (!market) {
    const sameId = fixture.markets.filter((m) => m.marketId === selection.marketId);
    if (sameId.length > 0 && selection.specifier != null) {
      const specs = [...new Set(sameId.map((m) => m.specifier).filter(Boolean))];
      errors.push(
        `Market "${selection.marketId}" with specifier "${selection.specifier}" is not offered on ${fixture.homeTeam} vs ${fixture.awayTeam}. ` +
          `Available specifiers: ${specs.join(", ") || "none"}.`,
      );
    } else {
      errors.push(
        `Market "${selection.marketId}" is not offered on ${fixture.homeTeam} vs ${fixture.awayTeam}. ` +
          `Available market ids: ${[...new Set(fixture.markets.map((m) => m.marketId))].join(", ") || "none"}.`,
      );
    }
  } else {
    const outcome = market.outcomes.find((o) => o.outcomeId === selection.outcomeId);
    if (!outcome) {
      errors.push(
        `Outcome "${selection.outcomeId}" does not exist on market "${market.marketName}" (${market.marketId}). ` +
          `Available outcome ids: ${market.outcomes.map((o) => o.outcomeId).join(", ") || "none"}.`,
      );
    } else if (!outcome.isActive) {
      errors.push(`Outcome "${outcome.outcomeName}" (${outcome.outcomeId}) on ${fixture.homeTeam} vs ${fixture.awayTeam} is no longer available.`);
    } else {
      if (market.specifier && selection.specifier != null && selection.specifier !== market.specifier) {
        errors.push(
          `Specifier "${selection.specifier}" does not match the required specifier "${market.specifier}" for market "${market.marketName}".`,
        );
      }
      if (selection.odds != null && Number.isFinite(outcome.odds) && outcome.odds > 0) {
        const drift = oddsDrift(selection.odds, outcome.odds);
        const rel = Math.abs(outcome.odds - selection.odds) / outcome.odds;
        if (drift != null && (drift >= DRIFT_ABS_THRESHOLD || rel >= DRIFT_REL_THRESHOLD)) {
          warnings.push(
            `Odds for ${fixture.homeTeam} vs ${fixture.awayTeam} (${market.marketName}, ${outcome.outcomeName}) ` +
              `changed from ${selection.odds} to ${outcome.odds}. The booking code will reflect the live odds.`,
          );
        }
      }
      return { selection, valid: errors.length === 0, errors, warnings, event: fixture, market, outcome };
    }
  }

  return { selection, valid: errors.length === 0, errors, warnings, event: fixture, market, outcome: market?.outcomes.find((o) => o.outcomeId === selection.outcomeId) };
}

export interface SelectionsValidation {
  results: ValidationResult[];
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateSelections(
  selections: SportyBetSelection[],
  fixtures: SportyBetFixture[],
): SelectionsValidation {
  const byId = new Map(fixtures.map((f) => [f.eventId, f]));
  const results = selections.map((s) => validateSelection(s, byId.get(s.eventId)));

  const key = (s: SportyBetSelection) => `${s.eventId}|${s.marketId}|${s.outcomeId}`;
  const seen = new Set<string>();
  for (const r of results) {
    const k = key(r.selection);
    if (seen.has(k)) {
      r.valid = false;
      r.errors.push("Duplicate selection: the same event/market/outcome combination appears more than once.");
    }
    seen.add(k);
  }

  const errors = results.flatMap((r) => r.errors);
  const warnings = results.flatMap((r) => r.warnings);
  return { results, valid: errors.length === 0, errors, warnings };
}