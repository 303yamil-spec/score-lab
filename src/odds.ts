/**
 * Combined odds mathematics. Pure functions, no I/O.
 * These compute decimal odds multiplication only — they make NO claim about
 * probability of winning, expected value, or payout guarantee.
 */

export function roundOdds(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export class OddsError extends Error {}

export function calcCombinedOdds(odds: number[]): number {
  if (odds.length === 0) return 0;
  for (const o of odds) {
    if (!Number.isFinite(o) || o <= 0) {
      throw new OddsError(`Invalid odds value: ${String(o)}. Odds must be finite positive numbers.`);
    }
  }
  const product = odds.reduce((acc, o) => acc * o, 1);
  return roundOdds(product);
}

/** Absolute price drift between the odds an agent selected and the live odds. */
export function oddsDrift(selected: number | undefined, live: number): number | null {
  if (selected == null || !Number.isFinite(selected)) return null;
  return roundOdds(Math.abs(selected - live), 3);
}