const state = {
  matches: [],
  history: [],
  metrics: null,
  status: null,
  selectedId: localStorage.getItem("scorelab.selectedMatch") || "",
  selectedDetail: null,
  view: "dashboard",
  search: "",
  maxGoals: 10,
  minimumProbability: 0,
  scoreSort: "high",
  scoreSearch: "",
};

const viewTitles = {
  dashboard: "Dashboard",
  upcoming: "Upcoming matches",
  analysis: "Match analysis",
  scores: "All correct scores",
  rankings: "Probability rankings",
  history: "Historical predictions",
  accuracy: "Prediction accuracy",
  settings: "Settings",
};

const $ = selector => document.querySelector(selector);
const make = (tag, className, content) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined && content !== null) element.textContent = String(content);
  return element;
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
    ...options,
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`The application returned an invalid response (${response.status}).`);
  }
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

function showMessage(message, isError = false) {
  const banner = $("#globalMessage");
  banner.hidden = !message;
  banner.textContent = message || "";
  banner.classList.toggle("error-message", isError);
}

function formatPercent(value, digits = 1) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "—";
}

function formatDate(value, options = {}) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    ...options,
  }).format(date);
}

function relativeTime(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "Not scheduled";
  const minutes = Math.round((time - Date.now()) / 60_000);
  if (minutes < 0) return "Started";
  if (minutes < 60) return `In ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `In ${hours}h ${minutes % 60}m`;
  return `In ${Math.floor(hours / 24)}d`;
}

function bestScore(prediction) {
  return prediction?.scores.slice().sort((a, b) => b.probability - a.probability)[0] || null;
}

function estimatedMatches() {
  return state.matches.filter(match => match.prediction);
}

function sourceLabel(prediction) {
  return prediction?.dataSource === "football-data.org"
    ? "Historical stats model"
    : prediction?.dataSource === "sportybet-market-implied"
      ? "SportyBet market-implied"
      : "No estimate";
}

function noMatches(container, title, detail) {
  const empty = make("div", "empty-state");
  empty.append(make("strong", "", title), make("span", "", detail));
  container.replaceChildren(empty);
}

function metricCard(label, value, note) {
  const card = make("article", "metric-card");
  card.append(make("span", "metric-label", label), make("strong", "", value), make("small", "", note));
  return card;
}

function renderStatus() {
  const badge = $("#connectionBadge");
  const connected = state.status?.mcp?.connected;
  badge.replaceChildren(make("span", "live-dot"));
  badge.append(document.createTextNode(connected ? "SportyBet MCP connected" : "MCP unavailable"));
  badge.style.color = connected ? "var(--green)" : "var(--red)";
  if (!connected && state.status?.mcp?.error) {
    badge.title = state.status.mcp.error;
  }
}

function matchCard(match) {
  const button = make("button", "match-card");
  button.type = "button";
  button.setAttribute("aria-label", `Analyze ${match.homeTeam} versus ${match.awayTeam}`);
  const head = make("div", "match-card-head");
  head.append(make("span", "match-league", [match.category, match.league].filter(Boolean).join(" · ")));
  head.append(make("span", "", relativeTime(match.startTime)));
  const teams = make("div", "match-teams");
  teams.append(make("span", "", match.homeTeam), make("span", "versus", "VS"), make("span", "", match.awayTeam));
  const bottom = make("div", "match-card-bottom");
  bottom.append(make("span", "", formatDate(match.startTime)));
  const prediction = match.prediction;
  const mostLikely = bestScore(prediction);
  if (mostLikely) {
    const pill = make("span", `prediction-pill${prediction.confidence === "low" ? " low" : ""}`,
      `${mostLikely.score} · ${formatPercent(mostLikely.probability)}`);
    pill.title = `${sourceLabel(prediction)} · ${prediction.confidence} confidence`;
    bottom.append(pill);
  } else {
    bottom.append(make("span", "quality-pill low", "No estimate"));
  }
  button.append(head, teams, bottom);
  button.addEventListener("click", () => selectMatch(match.eventId, "analysis"));
  return button;
}

function renderMatchCards(container, matches, emptyText) {
  if (!matches.length) {
    noMatches(container, "No upcoming matches loaded", emptyText);
    return;
  }
  container.replaceChildren(...matches.map(matchCard));
}

function renderDashboard() {
  const matches = estimatedMatches();
  $("#dashboardMetrics").replaceChildren(
    metricCard("FIXTURES LOADED", (state.status?.lastRefresh?.fixtures ?? state.status?.matchCount ?? state.matches.length).toLocaleString(), "From SportyBet MCP"),
    metricCard("MATCHES WITH ESTIMATES", matches.length.toLocaleString(), "Only shown matches have a prediction"),
    metricCard("HISTORY SCORED", state.metrics?.overall?.matches?.toLocaleString() ?? "0", "Only completed, matched results"),
    metricCard("STATISTICS SOURCE", state.status?.statistics?.configured ? "Connected" : "Optional", state.status?.statistics?.configured ? "football-data.org" : "Market-implied fallback"),
  );
  renderMatchCards($("#dashboardMatches"), matches.slice(0, 6),
    "No upcoming fixtures currently have estimates. Refresh to check the latest data.");
}

function renderUpcoming() {
  const query = state.search.toLowerCase().trim();
  const matches = estimatedMatches().filter(match =>
    `${match.homeTeam} ${match.awayTeam} ${match.category} ${match.league}`.toLowerCase().includes(query));
  renderMatchCards($("#upcomingMatches"), matches,
    "No matches with estimates match this search. Refresh to fetch the latest fixtures.");
}

function syncMatchSelects() {
  const selects = document.querySelectorAll(".match-select");
  const prior = state.selectedId;
  const matches = estimatedMatches();
  for (const select of selects) {
    const options = matches.map(match => {
      const option = document.createElement("option");
      option.value = match.eventId;
      option.textContent = `${match.homeTeam} vs ${match.awayTeam} · ${match.league}`;
      return option;
    });
    select.replaceChildren(...options);
    if (matches.some(match => match.eventId === prior)) select.value = prior;
    else if (matches.length) select.value = matches[0].eventId;
  }
  if (!matches.some(match => match.eventId === prior) && matches.length) {
    state.selectedId = matches[0].eventId;
    localStorage.setItem("scorelab.selectedMatch", state.selectedId);
  }
  if (!matches.length) {
    for (const select of selects) {
      const option = make("option", "", "No matches with estimates");
      option.value = "";
      select.replaceChildren(option);
    }
  }
}

function appendList(container, values, className = "warning-list") {
  if (!values?.length) return;
  const list = make("ul", className);
  values.forEach(value => list.append(make("li", "", value)));
  container.append(list);
}

function addTeamForm(parent, title, team) {
  const panel = make("div", "panel");
  panel.append(make("h2", "", `${title} recent form`));
  const records = team?.recentResults || [];
  if (!records.length) {
    panel.append(make("p", "muted", "No recent results were available for this team."));
  } else {
    const row = make("div", "form-row");
    records.slice(0, 5).forEach(item => {
      const token = make("span", `form-token ${item.result.toLowerCase()}`, item.result);
      token.title = `${item.date.slice(0, 10)} vs ${item.opponent}: ${item.score}`;
      row.append(token);
    });
    panel.append(row);
    const list = make("ul", "form-list");
    records.slice(0, 5).forEach(item => {
      list.append(make("li", "", `${item.date.slice(0, 10)} · ${item.result} ${item.score} vs ${item.opponent}`));
    });
    panel.append(list);
  }
  panel.append(make("p", "muted", `${team?.matches ?? 0} recent matches · ${Number(team?.goalsForPerMatch || 0).toFixed(2)} goals for · ${Number(team?.goalsAgainstPerMatch || 0).toFixed(2)} conceded per match.`));
  parent.append(panel);
}

function renderAnalysis(match) {
  const container = $("#analysisContent");
  container.replaceChildren();
  if (!match) {
    noMatches(container, "Select a match", "Refresh SportyBet fixtures to start an analysis.");
    return;
  }
  const header = make("div", "detail-header");
  const title = make("div");
  title.append(make("h2", "detail-title", `${match.homeTeam} vs ${match.awayTeam}`));
  title.append(make("div", "detail-meta", `${[match.category, match.league].filter(Boolean).join(" · ")} · ${formatDate(match.startTime)}`));
  header.append(title);
  header.append(make("span", `quality-pill${match.prediction?.confidence === "low" ? " low" : ""}`,
    match.prediction ? `${match.prediction.confidence} confidence` : "Estimate unavailable"));
  container.append(header);
  if (!match.prediction) {
    const note = make("div", "source-note market", "A score estimate is unavailable because neither historical statistics nor complete 1X2 prices were available. No unsupported estimate was generated.");
    container.append(note);
    return;
  }

  const prediction = match.prediction;
  const stats = prediction.statistics;
  const mostLikely = bestScore(prediction);
  const metrics = make("div", "detail-stats");
  metrics.append(
    detailStat("EXPECTED HOME GOALS", prediction.expectedHomeGoals.toFixed(2)),
    detailStat("EXPECTED AWAY GOALS", prediction.expectedAwayGoals.toFixed(2)),
    detailStat("MOST PROBABLE SCORE", mostLikely ? `${mostLikely.score} · ${formatPercent(mostLikely.probability)}` : "—"),
  );
  container.append(metrics);
  const source = make("div", `source-note${prediction.dataSource === "sportybet-market-implied" ? " market" : ""}`,
    `${sourceLabel(prediction)} · ${prediction.dataQuality} · ${prediction.scores.length} scorelines displayed at maximum ${prediction.maxGoals} goals per team; ${formatPercent(prediction.overflowProbability)} is above range.`);
  container.append(source);
  appendList(container, prediction.warnings, "warning-list");

  if (stats) {
    const explanation = make("div", "panel");
    explanation.append(make("h2", "", "Why the model estimates these goals"));
    explanation.append(make("p", "muted",
      `${match.homeTeam}: ${stats.home.matches} previous matches, averaging ${Number(stats.home.goalsForPerMatch).toFixed(2)} scored and ${Number(stats.home.goalsAgainstPerMatch).toFixed(2)} conceded. ${match.awayTeam}: ${stats.away.matches} previous matches, averaging ${Number(stats.away.goalsForPerMatch).toFixed(2)} scored and ${Number(stats.away.goalsAgainstPerMatch).toFixed(2)} conceded. The estimate blends venue-specific attack/defence rates with competition home (${Number(stats.leagueHomeGoals).toFixed(2)}) and away (${Number(stats.leagueAwayGoals).toFixed(2)}) scoring averages.`));
    explanation.append(make("p", "muted",
      `The displayed probability distribution uses an independent Poisson model${prediction.rho ? ` with a Dixon–Coles low-score correction (ρ=${prediction.rho.toFixed(2)})` : ""}. It does not use player availability, which is not supplied by these data sources.`));
    container.append(explanation);
    addTeamForm(container, match.homeTeam, stats.home);
    addTeamForm(container, match.awayTeam, stats.away);
  } else {
    container.append(make("div", "source-note market",
      "The expected goals were inferred by fitting a Poisson score model to the normalized implied probabilities from SportyBet’s current 1X2 prices. This fallback does not include historical team form."));
  }

  renderOddsPanel(container, match);
  renderMiniTopScores(container, prediction);
}

function detailStat(label, value) {
  const element = make("div", "detail-stat");
  element.append(make("span", "", label), make("strong", "", value));
  return element;
}

function renderOddsPanel(container, match) {
  const lines = match.odds || [];
  const panel = make("div", "panel");
  panel.append(make("h2", "", "Available SportyBet markets"));
  if (!lines.length) {
    panel.append(make("p", "muted", "No current odds were returned for this match."));
    container.append(panel);
    return;
  }
  const table = make("div", "table-wrap");
  const element = make("table", "data-table");
  const head = make("thead");
  const headerRow = make("tr");
  ["Market", "Outcome", "Decimal odds", "Raw implied"].forEach(value => headerRow.append(make("th", "", value)));
  head.append(headerRow);
  const body = make("tbody");
  lines.filter(line => ["1", "18", "29", "45"].includes(line.marketId)).forEach(line => {
    const row = make("tr");
    row.append(make("td", "", line.market), make("td", "", line.outcome),
      make("td", "", Number(line.odds).toFixed(2)), make("td", "", formatPercent(1 / line.odds)));
    body.append(row);
  });
  element.append(head, body);
  table.append(element);
  panel.append(table);
  panel.append(make("p", "muted", "Raw implied probability is 1 ÷ decimal odds. It is not margin-adjusted."));
  container.append(panel);
}

function renderMiniTopScores(container, prediction) {
  const panel = make("div", "panel");
  panel.append(make("h2", "", "Top 10 score probabilities"));
  const table = make("div", "table-wrap");
  const element = make("table", "data-table");
  const body = make("tbody");
  prediction.scores.slice().sort((a, b) => b.probability - a.probability).slice(0, 10)
    .forEach((score, index) => {
      const row = make("tr");
      row.append(make("td", "", `#${index + 1}`), make("td", "", score.score), make("td", "", formatPercent(score.probability, 2)));
      body.append(row);
    });
  element.append(body);
  table.append(element);
  panel.append(table);
  container.append(panel);
}

function correctScorePrice(match, score) {
  const price = (match?.odds || []).find(line => line.marketId === "45"
    && (line.outcome.match(/\d+\s*[:\-]\s*\d+/)?.[0] || line.outcomeId).replace(/\s/g, "").replace(":", "-") === score);
  return price ? Number(price.odds) : null;
}

function renderScores(match) {
  const rows = $("#scoreRows");
  const summary = $("#scoreSummary");
  rows.replaceChildren();
  if (!match?.prediction) {
    summary.replaceChildren(make("p", "source-note market", "No score probabilities are available for this match."));
    return;
  }
  const prediction = match.prediction;
  const query = state.scoreSearch.trim().toLowerCase();
  let scores = prediction.scores.filter(item =>
    item.score.toLowerCase().includes(query) && item.probability * 100 >= state.minimumProbability);
  if (state.scoreSort === "high") scores.sort((a, b) => b.probability - a.probability);
  else if (state.scoreSort === "low") scores.sort((a, b) => a.probability - b.probability);
  else scores.sort((a, b) => a.homeGoals - b.homeGoals || a.awayGoals - b.awayGoals);
  summary.replaceChildren(make("p", "summary-row",
    `${scores.length} of ${prediction.scores.length} scorelines shown · ${formatPercent(prediction.scores.reduce((sum, score) => sum + score.probability, 0))} probability in selected range · ${formatPercent(prediction.overflowProbability)} above range · ${sourceLabel(prediction)}.`));
  scores.forEach(score => {
    const tr = make("tr");
    const price = correctScorePrice(match, score.score);
    const probability = make("td");
    const scoreWrap = make("div", "score-prob");
    scoreWrap.append(make("span", "", formatPercent(score.probability, 2)));
    const track = make("span", "prob-track");
    const fill = document.createElement("i");
    fill.style.width = `${Math.max(0, Math.min(100, score.probability * 100))}%`;
    track.append(fill);
    scoreWrap.append(track);
    probability.append(scoreWrap);
    if (score === bestScore(prediction)) tr.className = "highlight-row";
    tr.append(make("td", "", score.score), probability,
      make("td", "", price ? price.toFixed(2) : "—"),
      make("td", "", price ? formatPercent(1 / price, 2) : "—"));
    rows.append(tr);
  });
  const overflow = make("tr", "overflow-row");
  overflow.append(make("td", "", `Above ${prediction.maxGoals} goals for either team`),
    make("td", "", formatPercent(prediction.overflowProbability, 3)),
    make("td", "", "—"), make("td", "", "—"));
  rows.append(overflow);
}

function renderRankings(match) {
  const container = $("#rankingContent");
  container.replaceChildren();
  if (!match?.prediction) {
    noMatches(container, "No ranking available", "A model estimate is needed to rank scorelines.");
    return;
  }
  const sorted = match.prediction.scores.slice().sort((a, b) => b.probability - a.probability);
  const sections = [
    { title: "Most probable", count: 1 },
    { title: "Top 3", count: 3 },
    { title: "Top 5", count: 5 },
    { title: "Top 10", count: 10 },
  ];
  const grid = make("div", "rank-grid");
  sections.forEach(section => {
    const card = make("div", "rank-card");
    card.append(make("h3", "", section.title));
    const list = make("ol");
    sorted.slice(0, section.count).forEach(score => {
      const item = make("li");
      item.append(make("strong", "", score.score), document.createTextNode(` · ${formatPercent(score.probability, 2)}`));
      list.append(item);
    });
    card.append(list);
    grid.append(card);
  });
  container.append(make("p", "muted", `${match.homeTeam} vs ${match.awayTeam} · ${sourceLabel(match.prediction)} · Rankings are generated from the displayed full probability distribution.`), grid);
}

function renderHistory() {
  const body = $("#historyRows");
  body.replaceChildren();
  const history = state.history;
  const overall = state.metrics?.overall;
  $("#historyMetrics").replaceChildren(
    metricCard("SAVED PREDICTIONS", history.length.toLocaleString(), "Estimates saved for later review"),
    metricCard("COMPLETED RESULTS", overall?.matches?.toLocaleString() ?? "0", "Matched final scores"),
    metricCard("TOP 1 EXACT", formatPercent(overall?.top1), "Most likely score matched"),
    metricCard("TOP 3 COVERAGE", formatPercent(overall?.top3), "Actual score ranked in top 3"),
    metricCard("MEAN BRIER SCORE", Number.isFinite(overall?.meanBrier) ? overall.meanBrier.toFixed(4) : "—", "Completed results only · lower is better"),
  );
  if (!history.length) {
    const row = make("tr");
    const cell = make("td", "muted", "No estimates have been saved yet. Refresh live data to save available predictions.");
    cell.colSpan = 6;
    row.append(cell);
    body.append(row);
    return;
  }
  history.forEach(item => {
    const top = bestScore(item.prediction);
    const row = make("tr");
    row.append(make("td", "", `${item.homeTeam} vs ${item.awayTeam}`),
      make("td", "", formatDate(item.kickoff)),
      make("td", "", top ? `${top.score} (${formatPercent(top.probability)})` : "—"),
      make("td", "", item.actualScore ?? "Pending"),
      make("td", "", item.actualScore === null ? "—" : item.rank ? `#${item.rank}` : "Overflow"),
      make("td", "", sourceLabel(item.prediction)));
    body.append(row);
  });
}

function renderAccuracy() {
  const metrics = state.metrics;
  const body = $("#accuracyMetrics");
  const overall = metrics?.overall;
  body.replaceChildren(
    metricCard("TOP 1 ACCURACY", formatPercent(overall?.top1), `${overall?.matches ?? 0} completed matches`),
    metricCard("TOP 3 ACCURACY", formatPercent(overall?.top3), "Actual result among top 3"),
    metricCard("TOP 5 ACCURACY", formatPercent(overall?.top5), "Actual result among top 5"),
    metricCard("TOP 10 ACCURACY", formatPercent(overall?.top10), "Actual result among top 10"),
    metricCard("BRIER SCORE", Number.isFinite(overall?.meanBrier) ? overall.meanBrier.toFixed(4) : "—", "All scorelines + overflow"),
    metricCard("LOG LOSS", Number.isFinite(overall?.meanLogLoss) ? overall.meanLogLoss.toFixed(4) : "—", "Penalizes confident misses"),
    metricCard("LAST 100", formatPercent(metrics?.last100?.top3), `${metrics?.last100?.matches ?? 0} matches with results`),
    metricCard("LAST 500", formatPercent(metrics?.last500?.top3), `${metrics?.last500?.matches ?? 0} matches with results`),
    metricCard("LAST 1,000", formatPercent(metrics?.last1000?.top3), `${metrics?.last1000?.matches ?? 0} matches with results`),
  );
  const calibration = $("#calibrationRows");
  calibration.replaceChildren();
  const groups = metrics?.calibrationGroups || [];
  groups.forEach(group => {
    const row = make("tr");
    row.append(make("td", "", group.range),
      make("td", "", group.predictions),
      make("td", "", formatPercent(group.predictedRate, 2)),
      make("td", "", formatPercent(group.observedRate, 2)));
    calibration.append(row);
  });
  if (!groups.some(group => group.predictions)) {
    const row = make("tr");
    const cell = make("td", "muted", "Calibration will be shown after verified match results arrive.");
    cell.colSpan = 4;
    row.append(cell);
    calibration.append(row);
  }
  const leagues = $("#leagueAccuracyRows");
  leagues.replaceChildren();
  (metrics?.byLeague || []).forEach(item => {
    const row = make("tr");
    row.append(make("td", "", item.league), make("td", "", item.matches),
      make("td", "", formatPercent(item.top1)), make("td", "", formatPercent(item.top3)),
      make("td", "", formatPercent(item.top5)), make("td", "", formatPercent(item.top10)));
    leagues.append(row);
  });
  if (!metrics?.byLeague?.length) {
    const row = make("tr");
    const cell = make("td", "muted", "No completed results are available yet.");
    cell.colSpan = 6;
    row.append(cell);
    leagues.append(row);
  }
}

function renderSettings() {
  const content = $("#settingsContent");
  content.replaceChildren();
  const mcp = state.status?.mcp;
  const stats = state.status?.statistics;
  const grid = make("div", "settings-grid");
  const mcpCard = make("div", "settings-card");
  mcpCard.append(make("h3", "", "SportyBet MCP"));
  mcpCard.append(make("p", "", `Connection: ${mcp?.connected ? "Connected" : "Not connected"}`));
  mcpCard.append(make("p", "", "Used tools: sportybet_get_fixtures and sportybet_get_odds. The other existing MCP tools remain available to their current clients."));
  if (mcp?.tools?.length) mcpCard.append(make("p", "", `Discovered tools: ${mcp.tools.join(", ")}`));
  if (mcp?.error) mcpCard.append(make("p", "", mcp.error));
  const statsCard = make("div", "settings-card");
  statsCard.append(make("h3", "", "Historical statistics"));
  statsCard.append(make("p", "", `Provider: ${stats?.provider || "football-data.org"}`));
  statsCard.append(make("p", "", `Token configured: ${stats?.configured ? "Yes" : "No"}`));
  statsCard.append(make("p", "", stats?.note || "No provider status available."));
  const modelCard = make("div", "settings-card");
  modelCard.append(make("h3", "", "Prediction model"));
  modelCard.append(make("p", "", `Scoreline range: 0–${$("#goalRange").value || 10} goals per team, plus explicit overflow probability.`));
  modelCard.append(make("p", "", "Expected goals are calculated from historical team/competition rates where available. Otherwise, a Poisson fit is derived from margin-adjusted 1X2 prices and marked low-confidence."));
  const fetchCard = make("div", "settings-card");
  fetchCard.append(make("h3", "", "Data refresh"));
  fetchCard.append(make("p", "", `Last refresh: ${state.status?.lastRefresh?.refreshedAt ? formatDate(state.status.lastRefresh.refreshedAt) : "Not completed yet"}`));
  fetchCard.append(make("p", "", "Automatic refresh runs every 15 minutes while the backend is running; use the top-right button for a manual refresh."));
  grid.append(mcpCard, statsCard, modelCard, fetchCard);
  content.append(grid);
}

async function loadSelectedDetail() {
  if (!state.selectedId) {
    state.selectedDetail = null;
    renderCurrentView();
    return;
  }
  try {
    const result = await api(`/api/matches/${encodeURIComponent(state.selectedId)}?maxGoals=${state.maxGoals}`);
    if (result.match.eventId !== state.selectedId) return;
    state.selectedDetail = result.match;
  } catch (error) {
    state.selectedDetail = null;
    showMessage(error.message, true);
  }
  renderCurrentView();
}

function renderCurrentView() {
  const match = state.selectedDetail;
  if (state.view === "dashboard") renderDashboard();
  if (state.view === "upcoming") renderUpcoming();
  if (state.view === "analysis") renderAnalysis(match);
  if (state.view === "scores") renderScores(match);
  if (state.view === "rankings") renderRankings(match);
  if (state.view === "history") renderHistory();
  if (state.view === "accuracy") renderAccuracy();
  if (state.view === "settings") renderSettings();
}

async function selectMatch(eventId, view = state.view) {
  if (!eventId) return;
  state.selectedId = eventId;
  localStorage.setItem("scorelab.selectedMatch", eventId);
  syncMatchSelects();
  setView(view);
  await loadSelectedDetail();
}

function setView(view) {
  if (!viewTitles[view]) return;
  state.view = view;
  $("#pageTitle").textContent = viewTitles[view];
  document.querySelectorAll(".view").forEach(section => section.classList.toggle("active", section.id === `view-${view}`));
  document.querySelectorAll(".nav-button").forEach(button => button.classList.toggle("active", button.dataset.view === view));
  if (["analysis", "scores", "rankings"].includes(view) && state.selectedId) {
    void loadSelectedDetail();
  } else {
    renderCurrentView();
  }
}

async function loadDashboardData() {
  try {
    const [status, matches, history] = await Promise.all([
      api("/api/status"),
      api("/api/matches"),
      api("/api/history"),
    ]);
    state.status = status;
    state.matches = matches.matches || [];
    state.history = history.history || [];
    state.metrics = history.metrics || null;
    if (Number.isInteger(status.defaultMaxGoals) && status.defaultMaxGoals >= 0
      && status.defaultMaxGoals <= 20) {
      state.maxGoals = status.defaultMaxGoals;
      $("#goalRange").value = String(state.maxGoals);
    }
    renderStatus();
    syncMatchSelects();
    renderCurrentView();
    if (state.selectedId && ["analysis", "scores", "rankings"].includes(state.view)
      && state.selectedDetail?.eventId !== state.selectedId) {
      void loadSelectedDetail();
    }
    if (matches.warnings?.length) showMessage(matches.warnings.join(" "), true);
    else if (status.lastRefreshError) showMessage(status.lastRefreshError, true);
    else showMessage("");
  } catch (error) {
    showMessage(error.message, true);
    renderStatus();
  }
}

async function manualRefresh() {
  const button = $("#refreshButton");
  button.disabled = true;
  button.lastChild.textContent = " Refreshing…";
  showMessage("Fetching live fixtures and available match data…");
  try {
    const result = await api("/api/refresh", { method: "POST" });
    await loadDashboardData();
    if (state.selectedId) await loadSelectedDetail();
    const summary = `Updated ${result.fixtures} upcoming fixtures and saved ${result.savedPredictions} pre-match estimates.`;
    showMessage(result.warnings?.length ? `${summary} ${result.warnings.join(" ")}` : summary);
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    button.disabled = false;
    button.lastChild.textContent = " Refresh data";
  }
}

document.querySelectorAll(".nav-button").forEach(button => {
  button.addEventListener("click", () => setView(button.dataset.view));
});
document.querySelectorAll("[data-go]").forEach(button => {
  button.addEventListener("click", () => setView(button.dataset.go));
});
$("#refreshButton").addEventListener("click", manualRefresh);
$("#matchSearch").addEventListener("input", event => {
  state.search = event.target.value;
  renderUpcoming();
});
document.querySelectorAll(".match-select").forEach(select => {
  select.addEventListener("change", () => {
    state.selectedId = select.value;
    localStorage.setItem("scorelab.selectedMatch", select.value);
    syncMatchSelects();
    void loadSelectedDetail();
  });
});
$("#goalRange").replaceChildren(...Array.from({ length: 21 }, (_, goals) => {
  const option = make("option", "", `${goals} goals per team`);
  option.value = String(goals);
  if (goals === state.maxGoals) option.selected = true;
  return option;
}));
$("#goalRange").addEventListener("change", event => {
  state.maxGoals = Number(event.target.value);
  void loadSelectedDetail();
});
$("#scoreSort").addEventListener("change", event => {
  state.scoreSort = event.target.value;
  renderScores(state.selectedDetail);
});
$("#minimumProbability").addEventListener("input", event => {
  state.minimumProbability = Math.max(0, Math.min(100, Number(event.target.value) || 0));
  renderScores(state.selectedDetail);
});
$("#scoreSearch").addEventListener("input", event => {
  state.scoreSearch = event.target.value;
  renderScores(state.selectedDetail);
});

void loadDashboardData();
window.setInterval(() => { void loadDashboardData(); }, 60_000);
