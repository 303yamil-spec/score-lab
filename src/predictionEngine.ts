export const MODEL_VERSION = "poisson-market-v1";

export interface ScoreProbability {
  homeGoals: number;
  awayGoals: number;
  score: string;
  probability: number;
}

export interface ScorePrediction {
  modelVersion: string;
  expectedHomeGoals: number;
  expectedAwayGoals: number;
  maxGoals: number;
  scores: ScoreProbability[];
  overflowProbability: number;
  totalProbability: number;
}

export interface OneXTwoOdds {
  home: number;
  draw: number;
  away: number;
}

export function poissonProbability(lambda: number, goals: number): number {
  if (!Number.isFinite(lambda) || lambda < 0 || !Number.isInteger(goals) || goals < 0) {
    throw new RangeError("Poisson lambda and goal count must be non-negative.");
  }
  if (lambda === 0) return goals === 0 ? 1 : 0;
  let probability = Math.exp(-lambda);
  for (let count = 1; count <= goals; count++) probability *= lambda / count;
  return probability;
}

export function predictCorrectScores(
  expectedHomeGoals: number,
  expectedAwayGoals: number,
  maxGoals = 10,
  rho = 0,
): ScorePrediction {
  if (!Number.isFinite(expectedHomeGoals) || expectedHomeGoals < 0 || expectedHomeGoals > 15
    || !Number.isFinite(expectedAwayGoals) || expectedAwayGoals < 0 || expectedAwayGoals > 15) {
    throw new RangeError("Expected goals must be between 0 and 15.");
  }
  if (!Number.isInteger(maxGoals) || maxGoals < 0 || maxGoals > 20) {
    throw new RangeError("Maximum goals must be an integer between 0 and 20.");
  }
  if (!Number.isFinite(rho) || Math.abs(rho) > 0.2) {
    throw new RangeError("Dixon-Coles rho must be between -0.2 and 0.2.");
  }

  const home = Array.from({ length: maxGoals + 1 }, (_, goals) =>
    poissonProbability(expectedHomeGoals, goals));
  const away = Array.from({ length: maxGoals + 1 }, (_, goals) =>
    poissonProbability(expectedAwayGoals, goals));
  const scores: ScoreProbability[] = [];

  for (let homeGoals = 0; homeGoals <= maxGoals; homeGoals++) {
    for (let awayGoals = 0; awayGoals <= maxGoals; awayGoals++) {
      let probability = home[homeGoals]! * away[awayGoals]!;
      if (rho !== 0) {
        const adjustment = homeGoals === 0 && awayGoals === 0
          ? 1 - expectedHomeGoals * expectedAwayGoals * rho
          : homeGoals === 0 && awayGoals === 1
            ? 1 + expectedHomeGoals * rho
            : homeGoals === 1 && awayGoals === 0
              ? 1 + expectedAwayGoals * rho
              : homeGoals === 1 && awayGoals === 1
                ? 1 - rho
                : 1;
        probability *= adjustment;
      }
      if (!Number.isFinite(probability) || probability < 0) {
        throw new RangeError("The score model produced an invalid probability.");
      }
      scores.push({
        homeGoals,
        awayGoals,
        score: `${homeGoals}-${awayGoals}`,
        probability,
      });
    }
  }

  const inRangeProbability = scores.reduce((sum, item) => sum + item.probability, 0);
  const overflowProbability = Math.max(0, 1 - inRangeProbability);
  return {
    modelVersion: MODEL_VERSION,
    expectedHomeGoals,
    expectedAwayGoals,
    maxGoals,
    scores,
    overflowProbability,
    totalProbability: inRangeProbability + overflowProbability,
  };
}

const OUTCOME_LIMIT = 30;
const outcomeCache = new Map<number, { probabilities: number[]; cumulative: number[] }>();
const OUTCOME_CACHE_LIMIT = 512;

function outcomeDistribution(lambda: number): { probabilities: number[]; cumulative: number[] } {
  const key = Math.round(lambda * 10_000);
  const cached = outcomeCache.get(key);
  if (cached) {
    outcomeCache.delete(key);
    outcomeCache.set(key, cached);
    return cached;
  }
  const probabilities = Array.from({ length: OUTCOME_LIMIT + 1 }, (_, goals) =>
    poissonProbability(lambda, goals));
  const cumulative = new Array<number>(OUTCOME_LIMIT + 1);
  let total = 0;
  probabilities.forEach((probability, index) => {
    total += probability;
    cumulative[index] = total;
  });
  const result = { probabilities, cumulative };
  outcomeCache.set(key, result);
  if (outcomeCache.size > OUTCOME_CACHE_LIMIT) {
    const oldestKey = outcomeCache.keys().next().value;
    if (oldestKey !== undefined) outcomeCache.delete(oldestKey);
  }
  return result;
}

function outcomeProbabilities(lambdaHome: number, lambdaAway: number): OneXTwoOdds {
  const home = outcomeDistribution(lambdaHome).probabilities;
  const { probabilities: away, cumulative: awayCumulative } = outcomeDistribution(lambdaAway);
  let homeWin = 0;
  let draw = 0;
  for (let homeGoals = 0; homeGoals <= OUTCOME_LIMIT; homeGoals++) {
    const homeProbability = home[homeGoals]!;
    if (homeGoals > 0) homeWin += homeProbability * awayCumulative[homeGoals - 1]!;
    draw += homeProbability * away[homeGoals]!;
  }
  const awayWin = Math.max(0, 1 - homeWin - draw);
  const total = homeWin + draw + awayWin;
  return { home: homeWin / total, draw: draw / total, away: awayWin / total };
}

export function expectedGoalsFromOneXTwo(odds: OneXTwoOdds): {
  expectedHomeGoals: number;
  expectedAwayGoals: number;
  marketProbabilities: OneXTwoOdds;
} {
  const prices = [odds.home, odds.draw, odds.away];
  if (prices.some(price => !Number.isFinite(price) || price <= 1)) {
    throw new RangeError("All 1X2 prices must be finite decimal odds above 1.");
  }
  const raw = prices.map(price => 1 / price);
  const margin = raw.reduce((sum, value) => sum + value, 0);
  const marketProbabilities = {
    home: raw[0]! / margin,
    draw: raw[1]! / margin,
    away: raw[2]! / margin,
  };

  let best = { home: 1.35, away: 1.1, error: Number.POSITIVE_INFINITY };
  const evaluate = (home: number, away: number) => {
      const predicted = outcomeProbabilities(home, away);
      const error = (predicted.home - marketProbabilities.home) ** 2
        + (predicted.draw - marketProbabilities.draw) ** 2
        + (predicted.away - marketProbabilities.away) ** 2;
      if (error < best.error) best = { home, away, error };
  };
  for (let home = 0.1; home <= 5; home += 0.1) {
    for (let away = 0.1; away <= 5; away += 0.1) {
      evaluate(home, away);
    }
  }
  const coarseBest = best;
  for (let home = Math.max(0.05, coarseBest.home - 0.1); home <= Math.min(5, coarseBest.home + 0.1); home += 0.01) {
    for (let away = Math.max(0.05, coarseBest.away - 0.1); away <= Math.min(5, coarseBest.away + 0.1); away += 0.01) {
      evaluate(Number(home.toFixed(2)), Number(away.toFixed(2)));
    }
  }

  return {
    expectedHomeGoals: best.home,
    expectedAwayGoals: best.away,
    marketProbabilities,
  };
}
