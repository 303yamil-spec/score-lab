import assert from "node:assert/strict";
import { test } from "node:test";
import {
  competitionCodeFor,
  estimateDixonColesRho,
  normalizeTeamName,
  projectFromHistoricalMatches,
  type HistoricalMatch,
} from "../src/footballData.js";

function historicalMatches(count: number): HistoricalMatch[] {
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(Date.UTC(2026, 0, 1 + index));
    const home = index % 2 === 0;
    const homeGoals = index % 4 === 0 ? 0 : 1 + index % 3;
    const awayGoals = index % 5 === 0 ? 0 : index % 2;
    return {
      id: index + 1,
      utcDate: day.toISOString(),
      status: "FINISHED",
      homeTeam: { name: home ? "Home City FC" : "Another Club" },
      awayTeam: { name: home ? "Rival Town" : "Away City" },
      score: { fullTime: { home: home ? homeGoals : 2, away: home ? awayGoals : 1 } },
    };
  });
}

test("known competition names map to the football-data.org catalogue", () => {
  assert.equal(competitionCodeFor("England Premier League"), "PL");
  assert.equal(competitionCodeFor("UEFA Champions League"), "CL");
  assert.equal(competitionCodeFor("Unknown invitational cup"), null);
});

test("team matching normalizes accents and club suffixes", () => {
  assert.equal(normalizeTeamName("Atlético Madrid FC"), "atletico madrid");
});

test("historical projection uses only pre-kickoff results and exposes sample warnings", () => {
  const matches = historicalMatches(60);
  const kickoff = new Date(Date.UTC(2026, 1, 1)).toISOString();
  const projection = projectFromHistoricalMatches(
    "Test League",
    "TST",
    matches,
    "Home City",
    "Away City",
    kickoff,
  );
  assert.ok(projection.leagueMatches < matches.length);
  assert.ok(projection.expectedHomeGoals > 0);
  assert.ok(projection.expectedAwayGoals > 0);
  assert.ok(projection.home.matches >= 5);
  assert.ok(projection.away.matches >= 5);
});

test("Dixon-Coles correction remains off until 100 actual completed matches", () => {
  assert.equal(estimateDixonColesRho(historicalMatches(99)), 0);
  assert.ok(Math.abs(estimateDixonColesRho(historicalMatches(120))) <= 0.2);
});
