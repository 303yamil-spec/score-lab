import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeTeamName, type HistoricalMatch } from "./footballData.js";
import type { ScorePrediction } from "./predictionEngine.js";

export interface StoredFixture {
  eventId: string;
  league: string;
  category: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  matchStatus: string;
  marketCount?: number;
}

export interface StoredOdds {
  eventId: string;
  marketId: string;
  market: string;
  outcome: string;
  outcomeId: string;
  odds: number;
  isActive: boolean;
  timestamp: string;
}

export interface StoredPrediction extends ScorePrediction {
  dataSource: "football-data.org" | "sportybet-market-implied";
  confidence: "high" | "medium" | "low";
  dataQuality: string;
  warnings: string[];
  statistics: unknown | null;
  rho: number;
  createdAt: string;
}

export interface MatchRecord extends StoredFixture {
  odds: StoredOdds[];
  prediction: StoredPrediction | null;
  result: { homeGoals: number; awayGoals: number; finishedAt: string } | null;
}

export class PredictionStore {
  private readonly db: DatabaseSync;

  constructor(filePath = resolve(process.cwd(), "data", "predictions.sqlite")) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS fixtures (
        event_id TEXT PRIMARY KEY,
        league TEXT NOT NULL,
        category TEXT NOT NULL,
        home_team TEXT NOT NULL,
        away_team TEXT NOT NULL,
        start_time TEXT NOT NULL,
        match_status TEXT NOT NULL,
        market_count INTEGER NOT NULL DEFAULT 0,
        odds_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS predictions (
        event_id TEXT PRIMARY KEY REFERENCES fixtures(event_id),
        created_at TEXT NOT NULL,
        kickoff TEXT NOT NULL,
        model_version TEXT NOT NULL,
        data_source TEXT NOT NULL,
        confidence TEXT NOT NULL,
        data_quality TEXT NOT NULL,
        expected_home REAL NOT NULL,
        expected_away REAL NOT NULL,
        max_goals INTEGER NOT NULL,
        scores_json TEXT NOT NULL,
        overflow_probability REAL NOT NULL,
        total_probability REAL NOT NULL,
        rho REAL NOT NULL,
        warnings_json TEXT NOT NULL,
        statistics_json TEXT,
        frozen INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS results (
        event_id TEXT PRIMARY KEY REFERENCES fixtures(event_id),
        home_goals INTEGER NOT NULL,
        away_goals INTEGER NOT NULL,
        finished_at TEXT NOT NULL,
        provider TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS fixtures_kickoff_idx ON fixtures(start_time);
      CREATE INDEX IF NOT EXISTS results_finished_idx ON results(finished_at);
    `);
  }

  saveFixture(fixture: StoredFixture, odds: StoredOdds[], now = new Date()): void {
    const updatedAt = now.toISOString();
    this.db.prepare(`
      INSERT INTO fixtures (
        event_id, league, category, home_team, away_team, start_time, match_status,
        market_count, odds_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        league = excluded.league,
        category = excluded.category,
        home_team = excluded.home_team,
        away_team = excluded.away_team,
        start_time = excluded.start_time,
        match_status = excluded.match_status,
        market_count = excluded.market_count,
        odds_json = excluded.odds_json,
        updated_at = excluded.updated_at
    `).run(
      fixture.eventId,
      fixture.league,
      fixture.category,
      fixture.homeTeam,
      fixture.awayTeam,
      fixture.startTime,
      fixture.matchStatus,
      fixture.marketCount ?? 0,
      JSON.stringify(odds),
      updatedAt,
    );
    this.db.prepare("UPDATE predictions SET frozen = 1 WHERE event_id = ? AND kickoff <= ?")
      .run(fixture.eventId, updatedAt);
  }

  savePrediction(fixture: StoredFixture, prediction: StoredPrediction, now = new Date()): boolean {
    const kickoff = Date.parse(fixture.startTime);
    if (!Number.isFinite(kickoff) || kickoff <= now.getTime()) return false;
    const existing = this.db.prepare("SELECT kickoff, frozen FROM predictions WHERE event_id = ?")
      .get(fixture.eventId) as { kickoff?: string; frozen?: number } | undefined;
    if (existing && (existing.frozen === 1 || Date.parse(existing.kickoff ?? "") <= now.getTime())) {
      this.db.prepare("UPDATE predictions SET frozen = 1 WHERE event_id = ?").run(fixture.eventId);
      return false;
    }

    this.db.prepare(`
      INSERT INTO predictions (
        event_id, created_at, kickoff, model_version, data_source, confidence, data_quality,
        expected_home, expected_away, max_goals, scores_json, overflow_probability,
        total_probability, rho, warnings_json, statistics_json, frozen
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(event_id) DO UPDATE SET
        created_at = excluded.created_at,
        kickoff = excluded.kickoff,
        model_version = excluded.model_version,
        data_source = excluded.data_source,
        confidence = excluded.confidence,
        data_quality = excluded.data_quality,
        expected_home = excluded.expected_home,
        expected_away = excluded.expected_away,
        max_goals = excluded.max_goals,
        scores_json = excluded.scores_json,
        overflow_probability = excluded.overflow_probability,
        total_probability = excluded.total_probability,
        rho = excluded.rho,
        warnings_json = excluded.warnings_json,
        statistics_json = excluded.statistics_json
      WHERE predictions.frozen = 0 AND predictions.kickoff > excluded.created_at
    `).run(
      fixture.eventId,
      prediction.createdAt,
      fixture.startTime,
      prediction.modelVersion,
      prediction.dataSource,
      prediction.confidence,
      prediction.dataQuality,
      prediction.expectedHomeGoals,
      prediction.expectedAwayGoals,
      prediction.maxGoals,
      JSON.stringify(prediction.scores),
      prediction.overflowProbability,
      prediction.totalProbability,
      prediction.rho,
      JSON.stringify(prediction.warnings),
      prediction.statistics === null ? null : JSON.stringify(prediction.statistics),
    );
    return true;
  }

  getMatches(options: { search?: string; limit?: number; now?: Date } = {}): MatchRecord[] {
    const now = (options.now ?? new Date()).toISOString();
    const limit = Math.max(1, Math.min(options.limit ?? 2_000, 2_000));
    const search = options.search?.trim().toLowerCase() ?? "";
    const rows = this.db.prepare(`
      SELECT f.*, p.created_at AS prediction_created_at, p.model_version, p.data_source,
        p.confidence, p.data_quality, p.expected_home, p.expected_away, p.max_goals,
        p.scores_json, p.overflow_probability, p.total_probability, p.rho,
        p.warnings_json, p.statistics_json, r.home_goals AS result_home,
        r.away_goals AS result_away, r.finished_at AS result_finished
      FROM fixtures f
      LEFT JOIN predictions p ON p.event_id = f.event_id
      LEFT JOIN results r ON r.event_id = f.event_id
      WHERE f.start_time > ?
      ORDER BY f.start_time ASC
      LIMIT ?
    `).all(now, limit) as Array<Record<string, unknown>>;
    return rows.filter(row => !search
      || `${row.home_team} ${row.away_team} ${row.league} ${row.category}`.toString().toLowerCase().includes(search))
      .map(row => this.mapMatch(row));
  }

  getMatch(eventId: string): MatchRecord | null {
    const row = this.db.prepare(`
      SELECT f.*, p.created_at AS prediction_created_at, p.model_version, p.data_source,
        p.confidence, p.data_quality, p.expected_home, p.expected_away, p.max_goals,
        p.scores_json, p.overflow_probability, p.total_probability, p.rho,
        p.warnings_json, p.statistics_json, r.home_goals AS result_home,
        r.away_goals AS result_away, r.finished_at AS result_finished
      FROM fixtures f
      LEFT JOIN predictions p ON p.event_id = f.event_id
      LEFT JOIN results r ON r.event_id = f.event_id
      WHERE f.event_id = ?
    `).get(eventId) as Record<string, unknown> | undefined;
    return row ? this.mapMatch(row) : null;
  }

  getPendingResultFixtures(now = new Date()): StoredFixture[] {
    const rows = this.db.prepare(`
      SELECT f.event_id, f.league, f.category, f.home_team, f.away_team,
        f.start_time, f.match_status, f.market_count
      FROM fixtures f
      JOIN predictions p ON p.event_id = f.event_id
      LEFT JOIN results r ON r.event_id = f.event_id
      WHERE r.event_id IS NULL AND p.kickoff <= ?
    `).all(now.toISOString()) as Array<Record<string, unknown>>;
    return rows.map(row => ({
      eventId: String(row.event_id),
      league: String(row.league),
      category: String(row.category),
      homeTeam: String(row.home_team),
      awayTeam: String(row.away_team),
      startTime: String(row.start_time),
      matchStatus: String(row.match_status),
      marketCount: Number(row.market_count),
    }));
  }

  saveResults(matches: HistoricalMatch[], provider: string, now = new Date()): number {
    let saved = 0;
    const fixtures = this.db.prepare(`
      SELECT f.event_id, f.home_team, f.away_team, f.start_time, p.kickoff
      FROM fixtures f JOIN predictions p ON p.event_id = f.event_id
      LEFT JOIN results r ON r.event_id = f.event_id
      WHERE r.event_id IS NULL AND p.kickoff <= ?
    `).all(now.toISOString()) as Array<Record<string, unknown>>;
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO results (event_id, home_goals, away_goals, finished_at, provider)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const fixture of fixtures) {
      const kickoff = Date.parse(String(fixture.kickoff));
      const result = matches.find(match => {
        const date = Date.parse(match.utcDate);
        return Math.abs(date - kickoff) < 36 * 60 * 60 * 1000
          && normalizeTeamName(match.homeTeam.name) === normalizeTeamName(String(fixture.home_team))
          && normalizeTeamName(match.awayTeam.name) === normalizeTeamName(String(fixture.away_team));
      });
      if (!result) continue;
      const homeGoals = result.score.fullTime.home;
      const awayGoals = result.score.fullTime.away;
      if (typeof homeGoals !== "number" || !Number.isInteger(homeGoals)
        || typeof awayGoals !== "number" || !Number.isInteger(awayGoals)) continue;
      const outcome = insert.run(
        String(fixture.event_id),
        homeGoals,
        awayGoals,
        result.utcDate,
        provider,
      );
      if (outcome.changes) saved++;
    }
    return saved;
  }

  getHistory(): Array<{
    eventId: string;
    league: string;
    homeTeam: string;
    awayTeam: string;
    kickoff: string;
    actualScore: string | null;
    prediction: StoredPrediction;
    exact: boolean | null;
    rank: number | null;
    brierScore: number | null;
    logLoss: number | null;
  }> {
    const rows = this.db.prepare(`
      SELECT f.event_id, f.league, f.home_team, f.away_team, p.kickoff,
        p.model_version, p.created_at, p.data_source, p.confidence, p.data_quality,
        p.expected_home, p.expected_away, p.max_goals, p.scores_json,
        p.overflow_probability, p.total_probability, p.rho, p.warnings_json,
        p.statistics_json, r.home_goals, r.away_goals
      FROM predictions p
      JOIN fixtures f ON f.event_id = p.event_id
      LEFT JOIN results r ON r.event_id = p.event_id
      ORDER BY p.kickoff ASC, p.created_at ASC
    `).all() as Array<Record<string, unknown>>;
    return rows.map(row => {
      const scores = JSON.parse(String(row.scores_json)) as ScorePrediction["scores"];
      const hasResult = row.home_goals !== null && row.home_goals !== undefined
        && row.away_goals !== null && row.away_goals !== undefined;
      const actual = hasResult ? `${Number(row.home_goals)}-${Number(row.away_goals)}` : null;
      if (actual === null) {
        return {
          eventId: String(row.event_id),
          league: String(row.league),
          homeTeam: String(row.home_team),
          awayTeam: String(row.away_team),
          kickoff: String(row.kickoff),
          actualScore: null,
          prediction: this.mapPrediction(row),
          exact: null,
          rank: null,
          brierScore: null,
          logLoss: null,
        };
      }
      const actualProbability = scores.find(score => score.score === actual)?.probability
        ?? Number(row.overflow_probability);
      const brierScore = scores.reduce((sum, score) => sum + (
        (score.probability - (score.score === actual ? 1 : 0)) ** 2
      ), 0) + (
        Number(row.overflow_probability) - (scores.some(score => score.score === actual) ? 0 : 1)
      ) ** 2;
      const rank = scores.slice().sort((a, b) => b.probability - a.probability)
        .findIndex(score => score.score === actual);
      return {
        eventId: String(row.event_id),
        league: String(row.league),
        homeTeam: String(row.home_team),
        awayTeam: String(row.away_team),
        kickoff: String(row.kickoff),
        actualScore: actual,
        prediction: this.mapPrediction(row),
        exact: scores.some(score => score.score === actual && rank === 0),
        rank: rank < 0 ? null : rank + 1,
        brierScore,
        logLoss: -Math.log(Math.max(actualProbability, 1e-15)),
      };
    });
  }

  close(): void {
    this.db.close();
  }

  private mapMatch(row: Record<string, unknown>): MatchRecord {
    const hasPrediction = row.model_version !== null && row.model_version !== undefined;
    const hasResult = row.result_home !== null && row.result_home !== undefined;
    return {
      eventId: String(row.event_id),
      league: String(row.league),
      category: String(row.category),
      homeTeam: String(row.home_team),
      awayTeam: String(row.away_team),
      startTime: String(row.start_time),
      matchStatus: String(row.match_status),
      marketCount: Number(row.market_count),
      odds: JSON.parse(String(row.odds_json)) as StoredOdds[],
      prediction: hasPrediction ? this.mapPrediction({
        model_version: row.model_version,
        prediction_created_at: row.prediction_created_at,
        data_source: row.data_source,
        confidence: row.confidence,
        data_quality: row.data_quality,
        expected_home: row.expected_home,
        expected_away: row.expected_away,
        max_goals: row.max_goals,
        scores_json: row.scores_json,
        overflow_probability: row.overflow_probability,
        total_probability: row.total_probability,
        rho: row.rho,
        warnings_json: row.warnings_json,
        statistics_json: row.statistics_json,
      }) : null,
      result: hasResult ? {
        homeGoals: Number(row.result_home),
        awayGoals: Number(row.result_away),
        finishedAt: String(row.result_finished),
      } : null,
    };
  }

  private mapPrediction(row: Record<string, unknown>): StoredPrediction {
    return {
      modelVersion: String(row.model_version),
      createdAt: String(row.created_at ?? row.prediction_created_at),
      dataSource: String(row.data_source) as StoredPrediction["dataSource"],
      confidence: String(row.confidence) as StoredPrediction["confidence"],
      dataQuality: String(row.data_quality),
      expectedHomeGoals: Number(row.expected_home),
      expectedAwayGoals: Number(row.expected_away),
      maxGoals: Number(row.max_goals),
      scores: JSON.parse(String(row.scores_json)) as ScorePrediction["scores"],
      overflowProbability: Number(row.overflow_probability),
      totalProbability: Number(row.total_probability),
      rho: Number(row.rho),
      warnings: JSON.parse(String(row.warnings_json)) as string[],
      statistics: row.statistics_json ? JSON.parse(String(row.statistics_json)) as unknown : null,
    };
  }
}
