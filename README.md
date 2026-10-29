# SportyBet MCP Server

A local **Model Context Protocol (MCP)** server for **OpenCode** that exposes
SportyBet (Nigeria) football fixtures, markets, odds and **non-staking
booking-code preparation** to AI agents.

The AI agent can analyze fixtures, select markets, validate selections, and
obtain a SportyBet **booking code** — but **this system cannot and does not
place, submit, or stake any wager**. The human always performs the final
betting action manually.

---

## 1. What it does

| Capability | Tool | Live |
| --- | --- | --- |
| Upcoming football fixtures | `sportybet_get_fixtures` | ✔ verified |
| Markets + outcomes + IDs for an event | `sportybet_get_markets` | ✔ verified |
| Timestamped odds for many events | `sportybet_get_odds` | ✔ verified |
| Search fixtures by team/league/date | `sportybet_search_fixtures` | ✔ verified |
| Combined odds math (pure, no prediction) | `sportybet_calculate_combined_odds` | ✔ verified |
| Validate selections + create booking code | `sportybet_book_bet` | ✔ verified |
| Read an existing booking code | `sportybet_get_booking_status` | ✔ verified |

All seven tools were verified live against SportyBet on 2026-08-14
(a real booking code was created and read back). Nothing is fabricated.

## 2. Architecture

```
opencode (AI agent)  <--stdio MCP-->  src/index.ts  (McpServer, zod schemas)
                                        ├── src/tools.ts        (7 tool handlers)
                                        ├── src/validation.ts   (pre-booking checks)
                                        ├── src/client.ts       (HTTP, rate limit, retry, cache)
                                        ├── src/normalizers.ts  (raw → typed, internal only)
                                        ├── src/odds.ts         (combined odds math)
                                        └── src/config.ts, logger.ts, marketCatalogue.ts
```

- **Node.js 24+ / TypeScript / `@modelcontextprotocol/sdk` / zod / native fetch**
- MCP runs over **stdio**; logs go to stderr as structured JSON
- Every external response is normalized into internal types
  (`SportyBetFixture`, `SportyBetMarket`, `SportyBetOutcome`,
  `SportyBetSelection`, `SportyBetOdds`, `SportyBetBooking`) before reaching
  the agent
- Provider is behind a single class (`SportyBetClient`) so a different
  verified provider can be substituted without touching the tools

## 3. API source — IMPORTANT

SportyBet has **no official public developer API**. This server uses
SportyBet's **own web API** (the endpoints the sportybet.com website and
mobile apps use). These endpoints are **undocumented, unauthenticated and
subject to change**. They are *not* an officially supported integration.

Endpoints used (region `ng`):

| Purpose | Endpoint | Method |
| --- | --- | --- |
| Upcoming fixtures + markets + odds | `/api/{region}/factsCenter/pcUpcomingEvents` | GET |
| Create booking code (anonymous, non-staking) | `/api/{region}/orders/share` | POST |
| Read booking code | `/api/{region}/orders/share/{code}` | GET |

Documented details:

- **Base URL**: `https://www.sportybet.com` (env `SPORTYBET_API_BASE_URL`)
- **Headers**: `Accept: application/json`, `Content-Type: application/json`,
  `Current-Country: NG` (region-scoped; uppercase region code)
- **Fixtures params**: `sportId=sr:sport:1` (football), `marketId` (comma
  list, e.g. `1,18,10,29,11,26,36,14,60100`), `pageSize` (max 100),
  `pageNum`, `todayGames=false`, `timeline` (hours ahead, max 720),
  `_t` (cache-busting epoch ms)
- **Fixture payload**: `bizCode` (10000 = success), `data.totalNum`,
  `data.tournaments[]` → `{ id, name, categoryName, events[] }`; each event:
  `eventId` (e.g. `sr:match:67015328`), `homeTeamName`, `awayTeamName`,
  `estimateStartTime` (epoch ms), `matchStatus`, `markets[]` → `{ id, desc,
  specifier?, status, outcomes[] }`; each outcome: `{ id, desc, odds
  (string!), isActive }`
- **Booking payload**: `{ selections: [{ eventId, marketId, specifier,
  outcomeId }] }` → response `data.shareCode`, `data.shareURL`,
  `data.deadline` (expiry epoch ms), `data.outcomes[]` (legs with live odds),
  `data.unavailableOutcomes`
- **Booking is anonymous**: no login, no API key, no credentials
- **1X2 outcome ids**: 1 = Home, 2 = Draw, 3 = Away
- **Rate limits**: none published. This server self-limits: min 250 ms between
  requests, max 4 concurrent, short 90 s cache, exponential backoff on
  429/5xx (max 3 retries), 15 s timeout. The booking POST is **never**
  auto-retried.

Verified reference implementations (for cross-checking, not bundled):
- https://github.com/mosesaye1-jael/sportybet-booking (region-scoped endpoints, booking flow)

## 4. Safety boundary

- The only write operation is `POST /api/ng/orders/share`, which creates a
  shareable booking code and **stakes nothing**.
- There is **no code path** that places, submits, confirms, or stakes a
  wager, and no code that requests passwords, OTPs, PINs, or payment
  credentials.
- `sportybet_book_bet` validates every selection (event exists, not started,
  market exists, outcome active, specifier correct, no duplicates) against
  live data **before** calling the booking endpoint; validation failure ⇒ no
  booking.
- Booking codes are only ever values returned by SportyBet — never
  fabricated.

## 5. Installation

```bash
cd C:\Users\user\Desktop\sportybet-mcp
npm install
npm run build      # compiles TypeScript to dist/
npm test           # 33 unit tests (offline, mocked HTTP)
npm run dev        # run server in dev mode (tsx)
npm run smoke      # end-to-end check against live SportyBet (tools + booking)
```

Requirements: Node.js 24+.

## 6. Environment variables

Copy `.env.example` to `.env` (optional — everything has a working default):

| Variable | Default | Purpose |
| --- | --- | --- |
| `SPORTYBET_REGION` | `ng` | Country code used in the API path + `Current-Country` header |
| `SPORTYBET_API_BASE_URL` | `https://www.sportybet.com` | Base URL of the SportyBet web API |
| `SPORTYBET_TIMEOUT_MS` | `15000` | Per-request timeout |
| `SPORTYBET_API_KEY` | *(empty)* | Reserved for a future third-party provider that requires one. The current service needs no key. |
| `SPORTYBET_MIN_INTERVAL_MS` | `250` | Minimum spacing between requests |
| `SPORTYBET_MAX_CONCURRENCY` | `4` | Max parallel requests |
| `SPORTYBET_MAX_RETRIES` | `3` | Retries for GET requests (never for booking POST) |
| `SPORTYBET_CACHE_TTL_MS` | `90000` | Fixture cache lifetime |
| `SPORTYBET_TZ_OFFSET_MIN` | `60` | Local timezone offset (WAT) used for date filtering |

`.env` is git-ignored. No credentials are required or hard-coded.

## 7. OpenCode configuration

Added to the global config `~/.config/opencode/opencode.jsonc` (OpenCode
1.18.18) **without touching the existing Supabase / Vercel / Resend servers**:

```jsonc
"mcp": {
  "supabase": { "type": "remote", "url": "https://mcp.supabase.com/mcp?project_ref=..." },
  "vercel":   { "type": "remote", "url": "https://mcp.vercel.com" },
  "resend":   { "type": "remote", "url": "https://mcp.resend.com" },
  "sportybet": {
    "type": "local",
    "command": ["node", "C:/Users/user/Desktop/sportybet-mcp/dist/index.js"],
    "enabled": true
  }
}
```

The command runs the compiled server so it works from any working directory.
After changing `src/`, run `npm run build` again.

Verify:

```bash
opencode mcp list
# sportybet should appear as connected
```

Restart OpenCode after config changes.

## 8. Agent

A purpose-built agent is installed globally:

```
~/.config/opencode/agent/sportybet.md
```

It encodes the workflow and the hard safety rules (PREPARE = allowed, BOOK =
allowed, PLACE BET = never). Select it with `/agent` or start opencode and
use it for sportybet sessions.

## 9. Example prompts

```
Analyze tomorrow's football fixtures and find 5 conservative selections.
```

```
Target combined odds between 5 and 10.
```

```
Find today's SportyBet games, analyze them, and give me your top 5 selections.
```

```
Prepare the betslip and return the SportyBet booking code.
```

The agent will refuse (politely) if you ask it to:
`place the bet` / `stake ₦5,000` / `confirm the wager` / `bet now` —
it only prepares betslips and booking codes.

## 10. MCP tools

| Tool | Input | Output highlights |
| --- | --- | --- |
| `sportybet_get_fixtures` | `{ date?, league?, limit?, timelineHours? }` | `fixtures[]` with `eventId`, `league`, `homeTeam`, `awayTeam`, `startTime`, `matchStatus`; up to 2,000 fixtures and 720 hours ahead |
| `sportybet_get_markets` | `{ eventId, marketIds? }` | `markets[]` with `marketId`, `marketName`, `specifier`, `outcomes[]` (`outcomeId`, `outcomeName`, `odds`, `isActive`) |
| `sportybet_get_odds` | `{ eventIds[], marketIds? }` | timestamped `odds[]` lines (`event`, `market`, `outcome`, `odds`, ids); suspended or unpriced outcomes are listed separately |
| `sportybet_search_fixtures` | `{ query, date?, limit }` | matching `fixtures[]` |
| `sportybet_calculate_combined_odds` | `{ selections: [{odds}] }` | `combinedOdds`, `selectionCount` (math only, no guarantee) |
| `sportybet_book_bet` | `{ selections: [{eventId, marketId, outcomeId, specifier?, odds?}] }` | `bookingCode`, `shareURL`, `expiresAt`, `combinedOdds`, per-leg odds, warnings; validation failure ⇒ error, no booking |
| `sportybet_get_booking_status` | `{ bookingCode }` | legs, odds, expiry (read-only) |

For full-time Correct Score, pass `marketIds: ["45"]` to
`sportybet_get_markets` or `sportybet_get_odds`. Market ID `"41"` requests the
separate `"Correct Score [0:0]"` market. When `marketIds` is omitted, both tools
continue to use the existing modest default market set; explicitly passing IDs
requests only those markets. Prices are returned only when SportyBet supplies
a positive numeric price. `sportybet_get_markets` also retains each outcome's
active status, while `sportybet_get_odds` places suspended or unpriced
outcomes in `unavailableOutcomes` rather than representing them as available
prices.

## 11. Error handling

Errors are returned as structured JSON with `code`, `message`, `action`:

| Code | Meaning | Action |
| --- | --- | --- |
| `VALIDATION_FAILED` | Selections don't map to live, available outcomes | Refresh odds, rebuild selection |
| `EVENT_NOT_FOUND` | Event not in upcoming list (started/removed) | Refresh fixtures |
| `TIMEOUT` / `NETWORK` | Upstream unreachable | Retry later |
| `RATE_LIMITED` (429) | Backed off, still limited | Wait and reduce volume |
| `BAD_REQUEST`/`UNAUTHORIZED`/`FORBIDDEN`/`NOT_FOUND`/`SERVER_ERROR` | HTTP status mapping | See message |
| `MALFORMED_RESPONSE` | Unparseable payload | Retry later |
| `UPSTREAM` | SportyBet rejected the request (`bizCode` ≠ 10000) | Verify inputs |
| `NO_BOOKING_CODE` | Share endpoint returned no code | Refresh and rebuild |
| `INVALID_BOOKING_CODE` / `BOOKING_NOT_FOUND` | Status lookup problems | Check the code |

Dangerous operations are never silently retried: the booking POST is
single-attempt only.

## 12. Testing

```bash
npm test     # 33 offline tests: normalization, odds math, validation,
             # error mapping, booking parsing, and the NO-STAKE guarantee
```

The no-stake guarantee tests assert:

1. `src/client.ts` contains no wagering endpoint, payload key, or credential
   handling (`/orders/place|bet|stake|confirm`, `stakeAmount`, `amount:`,
   `wallet`, `password`, `otp`, …).
2. The booking flow's only POST goes to `/orders/share`, and no payload
   contains `amount`/`stake`/`wager`/`currency`/`payment`.
3. The booking POST is never retried.
4. Booking-status lookup issues GET requests only.

Fixtures for tests are captured live SportyBet responses under `test/fixtures/`.

## 13. Security considerations

- Zod-validated inputs on every tool; strict limits on counts/sizes.
- Secrets are never logged; the server stores no credentials at all
  (`SPORTYBET_API_KEY` is only forwarded if a future provider needs it).
- Structured logs (stderr only — stdout is reserved for MCP protocol) contain
  tool name, request id, timestamp, success/failure and latency; never
  tokens, OTPs, or account data.
- Polite rate limiting + caching instead of hammering; no anti-bot evasion.
- This project has no mechanism to place a wager. Even a compromised agent
  cannot stake money through it.

## 14. Correct-score website

The same project can run a local read-only prediction dashboard. It connects
to this MCP server through the MCP SDK over stdio and uses the existing
`sportybet_get_fixtures` and `sportybet_get_odds` tools; it does not duplicate
the SportyBet API integration. The website requests up to 2,000 fixtures over
a 720-hour horizon; existing fixture-tool callers retain the seven-day default.

### Start it

Requirements: Node.js 24 or later.

```powershell
cd C:\Users\user\Desktop\Sportybet-mcp-main
npm install
Copy-Item .env.example .env
npm run website
```

Open **http://127.0.0.1:4173**. The first start builds the existing MCP server
and launches the website backend. SportyBet fixture/odds data does not require
an API key. The backend refreshes automatically every 15 minutes while running;
use **Refresh data** for a manual refresh. Copying `.env.example` is optional
unless you want to configure the football-data.org token or change defaults.

### Host on Render

The website must run as a **Web Service**, not a Static Site: its Node backend
serves the page, starts the MCP child process, fetches live data, and stores
predictions.

1. Push this project folder to a GitHub repository. This project directory
   needs to be the repository root (the `package.json` must be at its root).
2. In Render, choose **New → Web Service** and connect that repository. Do not
   replace or change an unrelated existing Static Site.
3. Configure the service:
   - **Language/runtime:** Node
   - **Build Command:** `npm ci && npm run build`
   - **Start Command:** `npm run website:start`
   - **Health Check Path:** `/`
4. Add environment variables:
   - `NODE_VERSION` = `24.18.0`
   - `APP_HOST` = `0.0.0.0`
   - `APP_REFRESH_MINUTES` = `15`
   - Optional: `FOOTBALL_DATA_API_KEY` = your football-data.org token
5. To preserve saved prediction history across deploys and restarts, attach a
   persistent disk to the Web Service, mount it at `/var/data`, then set
   `PREDICTIONS_DB_PATH` = `/var/data/predictions.sqlite`. Without a persistent
   disk, the service can run but its local SQLite history may be lost when
   Render replaces the instance. Persistent disks may require a paid Render
   plan.
6. Deploy and open the `onrender.com` URL shown by Render. Render supplies
   `PORT` automatically; the server listens on that port. The free instance
   may sleep when idle, so the first visit or refresh can take longer.

The existing local `.env` file is ignored by Git; add any needed secrets in
Render's Environment settings instead. Never commit API tokens.

### Data and estimates

- Upcoming fixtures, markets, and prices come from the actual SportyBet MCP
  tools. The dashboard discovers the running MCP tool list at startup.
- The MCP does **not** supply past team results, final scores, player
  availability, or historical statistics. To enable supported competition
  history, obtain a token from [football-data.org](https://www.football-data.org/client/register)
  and set `FOOTBALL_DATA_API_KEY=...` in the local `.env`, then restart the
  website. The token stays on the backend. The currently mapped competitions
  are Premier League, Championship, La Liga, Bundesliga, Serie A, Ligue 1,
  Eredivisie, Primeira Liga, UEFA Champions League, and Brazilian Serie A.
  Coverage depends on the provider plan and team-name matching.
- When historical stats are available, the model uses completed pre-kickoff
  league/team results, venue-specific attack/defence rates, and a Poisson
  score distribution. Dixon-Coles low-score adjustment is estimated only
  when at least 100 completed league matches are available.
- Without sufficient historical stats, the app may fit expected goals to
  actual SportyBet 1X2 prices. Such estimates are explicitly labelled
  **low-confidence, market-implied**; they are not historical-statistics
  forecasts. If neither source is available, no estimate is shown.
- The default score grid has all 121 combinations from 0-0 through 10-10.
  The range can be adjusted from 0 to 20 goals per team. Probability for any
  score above that grid is shown separately as **overflow**, not discarded.
  Correct-score prices appear only where SportyBet actually offers them.
- Predictions are stored in the local SQLite database at
  `data/predictions.sqlite`. Every fixture with an estimate appears in
  Prediction history before kickoff; its estimate is frozen after kickoff.
  The page shows a pending result until a configured statistics provider
  supplies a matching final score, and only completed results count toward
  accuracy metrics.
- The website includes dashboard, upcoming matches, match analysis, the full
  correct-score table, probability rankings, historical predictions,
  accuracy/calibration reports, and data-source settings.

No sample fixtures are displayed as live data. The prediction site has no bet
placement, wallet, or booking-code actions. All percentages are uncertain
model estimates, not guarantees or betting advice.

## 15. Disclaimer

Sports outcomes are uncertain and betting can cause financial loss. This
software provides estimates and the existing MCP also supports non-staking
booking-code preparation, but it does not place wagers, access wallets, make
guarantees, or provide financial advice. Use responsibly.