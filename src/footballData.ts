import { poissonProbability } from "./predictionEngine.js";

export interface HistoricalMatch {
  id: number;
  utcDate: string;
  status: string;
  homeTeam: { id?: number; name: string };
  awayTeam: { id?: number; name: string };
  score: { fullTime: { home: number | null; away: number | null } };
}

export interface TeamForm {
  name: string;
  matches: number;
  homeMatches: number;
  awayMatches: number;
  goalsForPerMatch: number;
  goalsAgainstPerMatch: number;
  recentResults: Array<{ date: string; opponent: string; score: string; result: "W" | "D" | "L" }>;
}

export interface HistoricalProjection {
  source: "football-data.org";
  competitionCode: string;
  leagueMatches: number;
  leagueHomeGoals: number;
  leagueAwayGoals: number;
  expectedHomeGoals: number;
  expectedAwayGoals: number;
  home: TeamForm;
  away: TeamForm;
  rho: number;
  warnings: string[];
  quality: "high" | "medium" | "low" | "insufficient";
}

interface ApiResponse {
  matches?: HistoricalMatch[];
}

const COMPETITIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/premier league|england.*premier/i, "PL"],
  [/championship|england.*championship/i, "ELC"],
  [/la liga|primera division|spain.*primera/i, "PD"],
  [/bundesliga|germany.*bundesliga/i, "BL1"],
  [/serie a|italy.*serie a/i, "SA"],
  [/ligue 1|france.*ligue 1/i, "FL1"],
  [/eredivisie|netherlands.*eredivisie/i, "DED"],
  [/primeira liga|portugal.*primeira/i, "PPL"],
  [/champions league|uefa champions/i, "CL"],
  [/brasileirao|brazil.*serie a/i, "BSA"],
];

const TEAM_SUFFIX = /\b(fc|cf|sc|afc|club|football|sporting|calcio|sv|vfb|ac|as|fk)\b/g;
const cache = new Map<string, { expiresAt: number; matches: HistoricalMatch[] }>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export function competitionCodeFor(competition: string): string | null {
  return COMPETITIONS.find(([pattern]) => pattern.test(competition))?.[1] ?? null;
}

export function normalizeTeamName(name: string): string {
  return name.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(TEAM_SUFFIX, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isSameTeam(first: string, second: string): boolean {
  const a = normalizeTeamName(first);
  const b = normalizeTeamName(second);
  return a === b || (a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a)));
}

export class FootballDataClient {
  constructor(private readonly apiKey: string | null) {}

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async getFinishedCompetitionMatches(
    competition: string,
    before: Date,
  ): Promise<{ code: string; matches: HistoricalMatch[] } | null> {
    if (!this.apiKey) return null;
    const code = competitionCodeFor(competition);
    if (!code) return null;
    const dateTo = new Date(before.getTime() - 1).toISOString().slice(0, 10);
    const dateFrom = new Date(before.getTime() - 365 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const key = `${code}:${dateFrom}:${dateTo}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return { code, matches: cached.matches };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const url = new URL(`https://api.football-data.org/v4/competitions/${code}/matches`);
      url.searchParams.set("dateFrom", dateFrom);
      url.searchParams.set("dateTo", dateTo);
      url.searchParams.set("status", "FINISHED");
      const response = await fetch(url, {
        headers: { "X-Auth-Token": this.apiKey, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`football-data.org returned HTTP ${response.status} for ${code}.`);
      }
      const body = await response.json() as ApiResponse;
      const matches = Array.isArray(body.matches) ? body.matches.filter(isCompletedMatch) : [];
      cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, matches });
      return { code, matches };
    } finally {
      clearTimeout(timer);
    }
  }
}

function isCompletedMatch(match: HistoricalMatch): boolean {
  return match.status === "FINISHED"
    && Number.isInteger(match.score?.fullTime?.home)
    && Number.isInteger(match.score?.fullTime?.away)
    && Boolean(match.homeTeam?.name && match.awayTeam?.name && match.utcDate);
}

function weightedAverage(values: number[]): number {
  if (!values.length) return 0;
  let weightedTotal = 0;
  let weightTotal = 0;
  values.forEach((value, index) => {
    const weight = 0.9 ** index;
    weightedTotal += value * weight;
    weightTotal += weight;
  });
  return weightedTotal / weightTotal;
}

function formFor(team: string, matches: HistoricalMatch[], before: number): TeamForm {
  const teamMatches = matches
    .filter(match => new Date(match.utcDate).getTime() < before
      && (isSameTeam(match.homeTeam.name, team) || isSameTeam(match.awayTeam.name, team)))
    .sort((a, b) => Date.parse(b.utcDate) - Date.parse(a.utcDate))
    .slice(0, 10);
  let homeMatches = 0;
  let awayMatches = 0;
  const goalsFor: number[] = [];
  const goalsAgainst: number[] = [];
  const recentResults = teamMatches.slice(0, 10).map(match => {
    const isHome = isSameTeam(match.homeTeam.name, team);
    if (isHome) homeMatches++;
    else awayMatches++;
    const ownGoals = Number(isHome ? match.score.fullTime.home : match.score.fullTime.away);
    const opponentGoals = Number(isHome ? match.score.fullTime.away : match.score.fullTime.home);
    goalsFor.push(ownGoals);
    goalsAgainst.push(opponentGoals);
    return {
      date: match.utcDate,
      opponent: isHome ? match.awayTeam.name : match.homeTeam.name,
      score: isHome ? `${ownGoals}-${opponentGoals}` : `${opponentGoals}-${ownGoals}`,
      result: ownGoals > opponentGoals ? "W" as const : ownGoals === opponentGoals ? "D" as const : "L" as const,
    };
  });
  return {
    name: team,
    matches: goalsFor.length,
    homeMatches,
    awayMatches,
    goalsForPerMatch: weightedAverage(goalsFor),
    goalsAgainstPerMatch: weightedAverage(goalsAgainst),
    recentResults,
  };
}

export function estimateDixonColesRho(matches: HistoricalMatch[]): number {
  if (matches.length < 100) return 0;
  const homeAverage = matches.reduce((sum, match) => sum + Number(match.score.fullTime.home), 0) / matches.length;
  const awayAverage = matches.reduce((sum, match) => sum + Number(match.score.fullTime.away), 0) / matches.length;
  let bestRho = 0;
  let bestLikelihood = Number.NEGATIVE_INFINITY;
  for (let step = -20; step <= 20; step++) {
    const rho = step / 100;
    let likelihood = 0;
    let valid = true;
    for (const match of matches) {
      const homeGoals = Number(match.score.fullTime.home);
      const awayGoals = Number(match.score.fullTime.away);
      const adjustment = homeGoals === 0 && awayGoals === 0
        ? 1 - homeAverage * awayAverage * rho
        : homeGoals === 0 && awayGoals === 1
          ? 1 + homeAverage * rho
          : homeGoals === 1 && awayGoals === 0
            ? 1 + awayAverage * rho
            : homeGoals === 1 && awayGoals === 1 ? 1 - rho : 1;
      const probability = poissonProbability(homeAverage, homeGoals)
        * poissonProbability(awayAverage, awayGoals) * adjustment;
      if (probability <= 0) {
        valid = false;
        break;
      }
      likelihood += Math.log(probability);
    }
    if (valid && likelihood > bestLikelihood) {
      bestLikelihood = likelihood;
      bestRho = rho;
    }
  }
  return bestRho;
}

export function projectFromHistoricalMatches(
  competition: string,
  competitionCode: string,
  allMatches: HistoricalMatch[],
  homeTeam: string,
  awayTeam: string,
  kickoff: string,
): HistoricalProjection {
  const before = Date.parse(kickoff);
  const matches = allMatches.filter(match => Date.parse(match.utcDate) < before);
  const home = formFor(homeTeam, matches, before);
  const away = formFor(awayTeam, matches, before);
  const warnings: string[] = [];

  if (matches.length < 30) {
    warnings.push(`Only ${matches.length} completed ${competition} matches were available; at least 30 are preferred.`);
  }
  if (home.matches < 5 || away.matches < 5) {
    warnings.push("At least five recent completed matches for each team are required for a statistical estimate.");
  }

  const leagueHomeGoals = matches.length
    ? matches.reduce((sum, match) => sum + Number(match.score.fullTime.home), 0) / matches.length
    : 0;
  const leagueAwayGoals = matches.length
    ? matches.reduce((sum, match) => sum + Number(match.score.fullTime.away), 0) / matches.length
    : 0;
  const homeVenue = matches.filter(match => isSameTeam(match.homeTeam.name, homeTeam));
  const awayVenue = matches.filter(match => isSameTeam(match.awayTeam.name, awayTeam));

  let expectedHomeGoals = 0;
  let expectedAwayGoals = 0;
  if (leagueHomeGoals > 0 && leagueAwayGoals > 0 && home.matches >= 5 && away.matches >= 5) {
    const homeScored = homeVenue.length
      ? homeVenue.reduce((sum, match) => sum + Number(match.score.fullTime.home), 0) / homeVenue.length
      : home.goalsForPerMatch;
    const homeConceded = homeVenue.length
      ? homeVenue.reduce((sum, match) => sum + Number(match.score.fullTime.away), 0) / homeVenue.length
      : home.goalsAgainstPerMatch;
    const awayScored = awayVenue.length
      ? awayVenue.reduce((sum, match) => sum + Number(match.score.fullTime.away), 0) / awayVenue.length
      : away.goalsForPerMatch;
    const awayConceded = awayVenue.length
      ? awayVenue.reduce((sum, match) => sum + Number(match.score.fullTime.home), 0) / awayVenue.length
      : away.goalsAgainstPerMatch;
    const homeAttack = 0.65 * (homeScored / leagueHomeGoals)
      + 0.35 * (home.goalsForPerMatch / ((leagueHomeGoals + leagueAwayGoals) / 2));
    const awayDefense = 0.65 * (awayConceded / leagueHomeGoals)
      + 0.35 * (away.goalsAgainstPerMatch / ((leagueHomeGoals + leagueAwayGoals) / 2));
    const awayAttack = 0.65 * (awayScored / leagueAwayGoals)
      + 0.35 * (away.goalsForPerMatch / ((leagueHomeGoals + leagueAwayGoals) / 2));
    const homeDefense = 0.65 * (homeConceded / leagueAwayGoals)
      + 0.35 * (home.goalsAgainstPerMatch / ((leagueHomeGoals + leagueAwayGoals) / 2));
    expectedHomeGoals = Math.max(0.05, Math.min(5, leagueHomeGoals * homeAttack * awayDefense));
    expectedAwayGoals = Math.max(0.05, Math.min(5, leagueAwayGoals * awayAttack * homeDefense));
  } else {
    warnings.push("League goal averages are unavailable; statistical expected goals could not be calculated.");
  }

  if (homeVenue.length < 3 || awayVenue.length < 3) {
    warnings.push("One or both teams have fewer than three venue-specific league matches; overall form is blended into the estimate.");
  }
  const rho = matches.length >= 100 ? estimateDixonColesRho(matches) : 0;
  if (rho === 0) warnings.push("Dixon-Coles low-score correction is not enabled because sufficient calibration history was unavailable.");
  const quality = matches.length >= 100 && home.matches >= 8 && away.matches >= 8
    ? "high"
    : matches.length >= 30 && home.matches >= 5 && away.matches >= 5
      ? "medium"
      : home.matches >= 5 && away.matches >= 5 ? "low" : "insufficient";

  return {
    source: "football-data.org",
    competitionCode,
    leagueMatches: matches.length,
    leagueHomeGoals,
    leagueAwayGoals,
    expectedHomeGoals,
    expectedAwayGoals,
    home,
    away,
    rho,
    warnings,
    quality,
  };
}
