import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import {
  competitionCodeFor,
  FootballDataClient,
  projectFromHistoricalMatches,
  type HistoricalMatch,
  type HistoricalProjection,
} from "./footballData.js";
import { SportyBetMcpGateway, type LiveFixture, type LiveOdds } from "./mcpGateway.js";
import {
  expectedGoalsFromOneXTwo,
  predictCorrectScores,
  type OneXTwoOdds,
} from "./predictionEngine.js";
import { PredictionStore, type StoredFixture, type StoredOdds, type StoredPrediction } from "./predictionStore.js";

const config = loadConfig();
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const webRoot = resolve(projectRoot, "web");
const port = Number(process.env.PORT || process.env.APP_PORT || 4173);
const host = process.env.APP_HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const refreshMinutes = Number(process.env.APP_REFRESH_MINUTES || 15);
const configuredMaxGoals = Number(process.env.PREDICTION_MAX_GOALS || 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT or APP_PORT must be an integer between 1 and 65535.");
}
if (!Number.isInteger(refreshMinutes) || refreshMinutes < 5 || refreshMinutes > 1_440) {
  throw new Error("APP_REFRESH_MINUTES must be an integer between 5 and 1440.");
}
if (!Number.isInteger(configuredMaxGoals) || configuredMaxGoals < 0 || configuredMaxGoals > 20) {
  throw new Error("PREDICTION_MAX_GOALS must be an integer between 0 and 20.");
}
const refreshIntervalMs = refreshMinutes * 60_000;
const defaultMaxGoals = configuredMaxGoals;
const store = new PredictionStore(process.env.PREDICTIONS_DB_PATH || undefined);
const sportybet = new SportyBetMcpGateway();
const footballData = new FootballDataClient(process.env.FOOTBALL_DATA_API_KEY?.trim() || null);
let refreshInProgress: Promise<RefreshResult> | null = null;
let lastRefresh: RefreshResult | null = null;
let lastRefreshError: string | null = null;

interface RefreshResult {
  refreshedAt: string;
  fixtures: number;
  savedPredictions: number;
  completedResults: number;
  statsConfigured: boolean;
  warnings: string[];
}

interface FixtureWithMarkets extends LiveFixture {
  marketCount: number;
}

function log(level: "info" | "error", message: string, detail?: unknown): void {
  const record = { at: new Date().toISOString(), level, message, detail };
  (level === "error" ? console.error : console.log)(JSON.stringify(record));
}

function parseMarketPrices(lines: LiveOdds[]): OneXTwoOdds | null {
  const outcomes = lines.filter(line => line.marketId === "1" && line.isActive);
  const find = (ids: string[], names: string[]) => outcomes.find(line =>
    ids.includes(line.outcomeId) || names.includes(line.outcome.trim().toLowerCase()));
  const home = find(["1"], ["home"]);
  const draw = find(["2"], ["draw"]);
  const away = find(["3"], ["away"]);
  if (!home || !draw || !away) return null;
  return { home: home.odds, draw: draw.odds, away: away.odds };
}

function marketImpliedForecast(
  fixture: FixtureWithMarkets,
  odds: LiveOdds[],
): StoredPrediction | null {
  const prices = parseMarketPrices(odds);
  if (!prices) return null;
  const estimated = expectedGoalsFromOneXTwo(prices);
  const prediction = predictCorrectScores(
    estimated.expectedHomeGoals,
    estimated.expectedAwayGoals,
    defaultMaxGoals,
  );
  return {
    ...prediction,
    dataSource: "sportybet-market-implied",
    confidence: "low",
    dataQuality: "Market-only fallback; team history is not available.",
    warnings: [
      "Expected goals are inferred from current SportyBet 1X2 prices, not from historical team statistics.",
      "This is a low-confidence market-implied estimate, not an independently validated forecast.",
      ...(!footballData.configured
        ? ["Set FOOTBALL_DATA_API_KEY in .env to enable historical team and league statistics."]
        : ["Historical statistics were unavailable for this competition or fixture."]),
    ],
    statistics: null,
    rho: 0,
    createdAt: new Date().toISOString(),
  };
}

function statisticalForecast(
  fixture: FixtureWithMarkets,
  projection: HistoricalProjection,
): StoredPrediction | null {
  if (projection.quality === "insufficient"
    || projection.expectedHomeGoals <= 0 || projection.expectedAwayGoals <= 0) return null;
  const prediction = predictCorrectScores(
    projection.expectedHomeGoals,
    projection.expectedAwayGoals,
    defaultMaxGoals,
    projection.rho,
  );
  return {
    ...prediction,
    dataSource: "football-data.org",
    confidence: projection.quality === "high" ? "high" : projection.quality === "medium" ? "medium" : "low",
    dataQuality: `${projection.quality}; ${projection.leagueMatches} league matches, ${projection.home.matches} ${fixture.homeTeam} matches and ${projection.away.matches} ${fixture.awayTeam} matches.`,
    warnings: projection.warnings,
    statistics: projection,
    rho: projection.rho,
    createdAt: new Date().toISOString(),
  };
}

async function refreshData(): Promise<RefreshResult> {
  if (refreshInProgress) return refreshInProgress;
  refreshInProgress = (async () => {
    const warnings: string[] = [];
    const fixtures = await sportybet.getFixtures() as FixtureWithMarkets[];
    const futureFixtures = fixtures.filter(fixture => Date.parse(fixture.startTime) > Date.now());
    let odds: LiveOdds[] = [];
    try {
      odds = await sportybet.getOdds(futureFixtures.map(fixture => fixture.eventId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`SportyBet market odds could not be loaded: ${message}`);
      log("error", "Could not load SportyBet odds", message);
    }

    const oddsByEvent = new Map<string, LiveOdds[]>();
    for (const line of odds) {
      const current = oddsByEvent.get(line.eventId) ?? [];
      current.push(line);
      oddsByEvent.set(line.eventId, current);
    }

    const now = new Date();
    const pendingResults = store.getPendingResultFixtures(now);
    const competitionRequests = new Map<string, Promise<{ code: string; matches: HistoricalMatch[] } | null>>();
    for (const fixture of [...futureFixtures, ...pendingResults]) {
      const competition = `${fixture.category} ${fixture.league}`;
      const code = competitionCodeFor(competition);
      if (code && footballData.configured && !competitionRequests.has(code)) {
        if (competitionRequests.size >= 8) {
          warnings.push("Historical statistics were limited to eight supported competitions per refresh to respect provider rate limits.");
          continue;
        }
        competitionRequests.set(code, footballData.getFinishedCompetitionMatches(competition, now));
      }
    }

    const historicalByCode = new Map<string, HistoricalMatch[]>();
    let completedResults = 0;
    for (const [code, request] of competitionRequests) {
      try {
        const result = await request;
        if (result) {
          historicalByCode.set(code, result.matches);
          const resultCount = store.saveResults(result.matches, "football-data.org", now);
          completedResults += resultCount;
          if (resultCount) log("info", "Saved completed fixture results", { competition: code, count: resultCount });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`${code} historical statistics are unavailable: ${message}`);
        log("error", "Historical statistics request failed", { competition: code, error: message });
      }
    }

    let savedPredictions = 0;
    for (const fixture of futureFixtures) {
      if (Date.parse(fixture.startTime) <= Date.now()) continue;
      const observedAt = new Date();
      const storedFixture: StoredFixture = {
        eventId: fixture.eventId,
        league: fixture.league,
        category: fixture.category,
        homeTeam: fixture.homeTeam,
        awayTeam: fixture.awayTeam,
        startTime: fixture.startTime,
        matchStatus: fixture.matchStatus,
        marketCount: fixture.marketCount,
      };
      const fixtureOdds = oddsByEvent.get(fixture.eventId) ?? [];
      const storedOdds: StoredOdds[] = fixtureOdds.map(line => ({
        eventId: line.eventId,
        marketId: line.marketId,
        market: line.market,
        outcome: line.outcome,
        outcomeId: line.outcomeId,
        odds: line.odds,
        isActive: line.isActive,
        timestamp: line.timestamp,
      }));
      store.saveFixture(storedFixture, storedOdds, observedAt);

      const code = competitionCodeFor(`${fixture.category} ${fixture.league}`);
      const historical = code ? historicalByCode.get(code) : undefined;
      const projection = code && historical
        ? projectFromHistoricalMatches(
          fixture.league,
          code,
          historical,
          fixture.homeTeam,
          fixture.awayTeam,
          fixture.startTime,
        )
        : null;
      const prediction = projection
        ? statisticalForecast(fixture, projection)
        : marketImpliedForecast(fixture, fixtureOdds);
      if (prediction) {
        prediction.createdAt = observedAt.toISOString();
        if (store.savePrediction(storedFixture, prediction, observedAt)) savedPredictions++;
      }
    }

    const result: RefreshResult = {
      refreshedAt: now.toISOString(),
      fixtures: futureFixtures.length,
      savedPredictions,
      completedResults,
      statsConfigured: footballData.configured,
      warnings: [...new Set(warnings)],
    };
    lastRefresh = result;
    lastRefreshError = null;
    log("info", "Prediction data refresh completed", result);
    return result;
  })();
  try {
    return await refreshInProgress;
  } catch (error) {
    lastRefreshError = error instanceof Error ? error.message : String(error);
    log("error", "Prediction data refresh failed", lastRefreshError);
    throw error;
  } finally {
    refreshInProgress = null;
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function readGoalRange(url: URL): number {
  const raw = url.searchParams.get("maxGoals");
  if (raw === null) return defaultMaxGoals;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 20) {
    throw new RangeError("maxGoals must be an integer between 0 and 20.");
  }
  return value;
}

function metricsFor(history: ReturnType<PredictionStore["getHistory"]>) {
  const completed = history.filter((item): item is typeof item & {
    actualScore: string;
    brierScore: number;
    logLoss: number;
  } => item.actualScore !== null);
  const ratesFor = (items: typeof completed) => ({
    matches: items.length,
    top1: items.length ? items.filter(item => item.rank === 1).length / items.length : null,
    top3: items.length ? items.filter(item => item.rank !== null && item.rank <= 3).length / items.length : null,
    top5: items.length ? items.filter(item => item.rank !== null && item.rank <= 5).length / items.length : null,
    top10: items.length ? items.filter(item => item.rank !== null && item.rank <= 10).length / items.length : null,
    exactScore: items.length ? items.filter(item => item.rank === 1).length / items.length : null,
    meanBrier: items.length ? items.reduce((sum, item) => sum + item.brierScore, 0) / items.length : null,
    meanLogLoss: items.length ? items.reduce((sum, item) => sum + item.logLoss, 0) / items.length : null,
  });
  const byLeague = new Map<string, typeof completed>();
  completed.forEach(item => {
    const current = byLeague.get(item.league) ?? [];
    current.push(item);
    byLeague.set(item.league, current);
  });
  const calibrationGroups = Array.from({ length: 10 }, (_, index) => {
    const lower = index / 10;
    const entries = completed.flatMap(item => [
      ...item.prediction.scores.map(score => ({
        probability: score.probability,
        occurred: score.score === item.actualScore,
      })),
      {
        probability: item.prediction.overflowProbability,
        occurred: !item.prediction.scores.some(score => score.score === item.actualScore),
      },
    ]).filter(entry => entry.probability >= lower
      && (index === 9 ? entry.probability <= 1 : entry.probability < lower + 0.1));
    return {
      range: `${Math.round(lower * 100)}-${index === 9 ? 100 : Math.round((lower + 0.1) * 100)}%`,
      predictions: entries.length,
      predictedRate: entries.length
        ? entries.reduce((sum, entry) => sum + entry.probability, 0) / entries.length : null,
      observedRate: entries.length
        ? entries.filter(entry => entry.occurred).length / entries.length : null,
    };
  });
  return {
    overall: ratesFor(completed),
    last100: ratesFor(completed.slice(0, 100)),
    last500: ratesFor(completed.slice(0, 500)),
    last1000: ratesFor(completed.slice(0, 1000)),
    byLeague: Array.from(byLeague, ([league, items]) => ({ league, ...ratesFor(items) })),
    calibrationGroups,
  };
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === "/api/status" && request.method === "GET") {
    let tools: string[] = [];
    let mcpConnected = false;
    let mcpError: string | null = null;
    try {
      tools = await sportybet.listTools();
      mcpConnected = true;
    } catch (error) {
      mcpError = error instanceof Error ? error.message : String(error);
    }
    json(response, 200, {
      app: "SportyBet Correct-Score Analytics",
      mcp: { connected: mcpConnected, tools, error: mcpError },
      statistics: {
        provider: "football-data.org",
        configured: footballData.configured,
        supportedCompetitions: ["Premier League", "Championship", "La Liga", "Bundesliga", "Serie A", "Ligue 1", "Eredivisie", "Primeira Liga", "UEFA Champions League", "Brazilian Serie A"],
        note: footballData.configured
          ? "Historical statistics are available for supported competitions."
          : "Add FOOTBALL_DATA_API_KEY to .env for historical team results; otherwise predictions use actual SportyBet 1X2 odds and are labelled low-confidence.",
      },
      defaultMaxGoals,
      lastRefresh,
      lastRefreshError,
      matchCount: store.getMatches().length,
    });
    return true;
  }
  if (url.pathname === "/api/matches" && request.method === "GET") {
    json(response, 200, {
      matches: store.getMatches({ search: url.searchParams.get("search") ?? undefined }),
      refreshedAt: lastRefresh?.refreshedAt ?? null,
      warnings: lastRefresh?.warnings ?? [],
    });
    return true;
  }
  if (url.pathname.startsWith("/api/matches/") && request.method === "GET") {
    const eventId = decodeURIComponent(url.pathname.slice("/api/matches/".length));
    if (!eventId || eventId.length > 128) {
      json(response, 400, { error: "Invalid match ID." });
      return true;
    }
    const match = store.getMatch(eventId);
    if (!match) {
      json(response, 404, { error: "Match not found. Refresh upcoming fixtures and try again." });
      return true;
    }
    const maxGoals = readGoalRange(url);
    if (match.prediction) {
      const prediction = predictCorrectScores(
        match.prediction.expectedHomeGoals,
        match.prediction.expectedAwayGoals,
        maxGoals,
        match.prediction.rho,
      );
      match.prediction = { ...match.prediction, ...prediction };
    }
    const correctScoreOdds = match.odds.filter(line => line.marketId === "45");
    const overround = correctScoreOdds.reduce((sum, line) => sum + 1 / line.odds, 0);
    json(response, 200, {
      match,
      correctScoreMarket: {
        odds: correctScoreOdds,
        rawImpliedOverround: correctScoreOdds.length ? overround : null,
        marginAdjusted: false,
        note: "Raw implied probabilities are 1/decimal odds. A margin-adjusted figure is omitted unless a complete market outcome set can be verified.",
      },
    });
    return true;
  }
  if (url.pathname === "/api/history" && request.method === "GET") {
    const history = store.getHistory();
    json(response, 200, { history, metrics: metricsFor(history) });
    return true;
  }
  if (url.pathname === "/api/refresh" && request.method === "POST") {
    try {
      json(response, 200, await refreshData());
    } catch (error) {
      json(response, 502, {
        error: error instanceof Error ? error.message : "Could not refresh data.",
        retryable: true,
      });
    }
    return true;
  }
  return false;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    try {
      if (!await handleApi(request, response, url)) json(response, 404, { error: "API route not found." });
    } catch (error) {
      const status = error instanceof RangeError ? 400 : 500;
      json(response, status, { error: error instanceof Error ? error.message : "Request failed." });
    }
    return;
  }

  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = resolve(webRoot, `.${requestedPath}`);
  if (file !== webRoot && !file.startsWith(`${webRoot}${sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  if (!existsSync(file)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[extname(file)] ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": extname(file) === ".html" ? "no-cache" : "public, max-age=300",
  });
  createReadStream(file).pipe(response);
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch(error => {
    log("error", "Unhandled HTTP request error", error instanceof Error ? error.message : String(error));
    if (!response.headersSent) json(response, 500, { error: "Internal server error." });
    else response.destroy();
  });
});

server.listen(port, host, () => {
  log("info", "Prediction dashboard listening", { url: `http://${host}:${port}` });
  void refreshData().catch(() => undefined);
});
const scheduler = setInterval(() => { void refreshData().catch(() => undefined); }, refreshIntervalMs);

function shutdown(): void {
  clearInterval(scheduler);
  server.close();
  void sportybet.close().finally(() => {
    store.close();
    process.exit(0);
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
