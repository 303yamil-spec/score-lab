/**
 * SportyBet MCP Server — entry point.
 *
 * Exposes SportyBet football fixtures, markets, odds, combined-odds math,
 * and NON-STAKING booking-code preparation to AI agents over MCP stdio.
 *
 * Safety boundary: this server can ONLY prepare betslips and create shareable
 * booking codes. It has no code path that places, submits, or stakes a wager,
 * and it never requests credentials.
 * Yup
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { SportyBetClient, SportyBetError } from "./client.js";
import { logger } from "./logger.js";
import {
  sportybetBookBet,
  sportybetCalculateCombinedOdds,
  sportybetGetBookingStatus,
  sportybetGetFixtures,
  sportybetGetMarkets,
  sportybetGetOdds,
  sportybetSearchFixtures,
  type ToolResult,
} from "./tools.js";

const config = loadConfig();
const client = new SportyBetClient(config);

const server = new McpServer({
  name: "sportybet",
  version: "1.0.0",
});

type ToolFn = (args: any, requestId: string) => Promise<ToolResult> | ToolResult;

function wrap(toolName: string, fn: ToolFn) {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const started = Date.now();
    try {
      const result = await fn(args, requestId);
      logger.info({
        tool: toolName,
        requestId,
        success: !result.isError,
        latencyMs: Date.now() - started,
      });
      return result;
    } catch (err) {
      const latencyMs = Date.now() - started;
      if (err instanceof SportyBetError) {
        logger.error({ tool: toolName, requestId, success: false, latencyMs, errorCode: err.code });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { success: false, error: { code: err.code, message: err.message, action: err.action } },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ tool: toolName, requestId, success: false, latencyMs, errorCode: "INTERNAL", message });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { success: false, error: { code: "INTERNAL", message, action: "Retry the request." } },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
  };
}

const NO_STAKE = " This tool NEVER places, submits, or stakes a wager.";

server.registerTool(
  "sportybet_get_fixtures",
  {
    title: "Get upcoming SportyBet football fixtures",
    description:
      "Retrieve upcoming football fixtures from SportyBet (Nigeria region). Optionally filter by date (YYYY-MM-DD, West Africa Time) and/or league, and set a timeline from 12 to 720 hours ahead. Returns eventId, league, teams, start time and status — no raw API data. Odds are fetched separately with sportybet_get_markets.",
    inputSchema: {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Local date YYYY-MM-DD to filter fixtures (WAT). Omit for all upcoming."),
      league: z.string().optional().describe("League or country name substring, e.g. 'Premier League' or 'England'."),
      limit: z.number().int().min(1).max(2000).default(50).describe("Maximum number of fixtures to return."),
      timelineHours: z.number().int().min(12).max(720).optional().describe("How far ahead to search. Defaults to 168 hours (7 days)."),
    },
  },
  wrap("sportybet_get_fixtures", (args) => sportybetGetFixtures(client, args, config.tzOffsetMinutes)),
);

server.registerTool(
  "sportybet_get_markets",
  {
    title: "Get markets and odds for a SportyBet event",
    description:
      "Retrieve available markets and outcomes for a specific SportyBet eventId (from sportybet_get_fixtures). Optionally pass marketIds to request only those market IDs; use ['45'] for full-time Correct Score or ['41'] for Correct Score [0:0]. When omitted, the existing default market set is used. Returns SportyBet's supplied outcome IDs, activity status and prices; unavailable markets return no odds." + NO_STAKE,
    inputSchema: {
      eventId: z.string().min(1).describe("SportyBet eventId, e.g. 'sr:match:67015328'."),
      marketIds: z.array(z.string().regex(/^\d+$/)).min(1).max(50).optional()
        .describe("Optional exact market IDs to request instead of the default set. Correct Score is market '45'; market '41' is Correct Score [0:0]."),
    },
  },
  wrap("sportybet_get_markets", (args) => sportybetGetMarkets(client, args)),
);

server.registerTool(
  "sportybet_get_odds",
  {
    title: "Get current odds for one, or more events",
    description:
      "Return normalized current odds (event, market, outcome, odds, eventId, marketId, outcomeId) for up to 50 events, each line stamped with a fetch timestamp. Optionally pass marketIds to request only those market IDs; use ['45'] for full-time Correct Score or ['41'] for Correct Score [0:0]. When omitted, the existing default market set is used. Suspended and unpriced outcomes are listed separately and are not presented as available prices." + NO_STAKE,
    inputSchema: {
      eventIds: z.array(z.string().min(1)).min(1).max(50).describe("List of SportyBet eventIds."),
      marketIds: z.array(z.string().regex(/^\d+$/)).min(1).max(50).optional()
        .describe("Optional exact market IDs to request instead of the default set. Correct Score is market '45'; market '41' is Correct Score [0:0]."),
    },
  },
  wrap("sportybet_get_odds", (args) => sportybetGetOdds(client, args)),
);

server.registerTool(
  "sportybet_search_fixtures",
  {
    title: "Search SportyBet fixtures",
    description:
      "Search upcoming SportyBet football fixtures by team, league, or country name substring, optionally restricted to a date (YYYY-MM-DD, WAT). Returns matching fixtures with eventIds." + NO_STAKE,
    inputSchema: {
      query: z.string().min(1).describe("Search text: team name, league, or country."),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Local date YYYY-MM-DD (WAT)."),
      limit: z.number().int().min(1).max(500).default(50).describe("Maximum number of matches to return."),
    },
  },
  wrap("sportybet_search_fixtures", (args) => sportybetSearchFixtures(client, args, config.tzOffsetMinutes)),
);

server.registerTool(
  "sportybet_calculate_combined_odds",
  {
    title: "Calculate combined odds",
    description:
      "Pure mathematics: multiply decimal odds of selected outcomes into a combined price. Returns combinedOdds and selectionCount. This is NOT a probability estimate and guarantees nothing about any payout." + NO_STAKE,
    inputSchema: {
      selections: z.array(z.object({ odds: z.number().positive() })).min(1).max(20).describe("The decimal odds of each selection."),
    },
  },
  wrap("sportybet_calculate_combined_odds", (args) => sportybetCalculateCombinedOdds(args)),
);

server.registerTool(
  "sportybet_book_bet",
  {
    title: "Prepare a SportyBet betslip and create a booking code",
    description:
      "Validate every selection against live SportyBet data (event exists, not started, market exists, outcome active, specifier correct), then create a shareable SportyBet booking code. The SportyBet share endpoint is anonymous and NON-STAKING: it returns a booking code but does not place, submit, or stake any wager. If any validation fails, no booking is created. Never returns a fabricated code — only codes actually returned by SportyBet.",
    inputSchema: {
      selections: z
        .array(
          z.object({
            eventId: z.string().min(1),
            marketId: z.string().min(1).describe("Market id, e.g. '1' for 1X2, '18' for Over/Under."),
            outcomeId: z.string().min(1).describe("Outcome id, e.g. '1' Home, '2' Draw, '3' Away for 1X2."),
            specifier: z.string().nullish().describe("Market specifier, e.g. 'total=2.5'. Optional for 1X2."),
            odds: z.number().positive().optional().describe("Odds observed when selecting; used to detect price movement."),
          }),
        )
        .min(1)
        .max(20),
    },
  },
  wrap("sportybet_book_bet", (args) => sportybetBookBet(client, args)),
);

server.registerTool(
  "sportybet_get_booking_status",
  {
    title: "Check a SportyBet booking code",
    description:
      "Read information about an existing SportyBet booking code: fixtures, markets, outcomes, odds and expiry. Read-only — it does not place, modify, or stake any wager." + NO_STAKE,
    inputSchema: {
      bookingCode: z.string().min(4).max(12).describe("SportyBet booking code, e.g. 'HW8EM8'."),
    },
  },
  wrap("sportybet_get_booking_status", (args) => sportybetGetBookingStatus(client, args)),
);

const transport = new StdioServerTransport();
await server.connect(transport);

logger.info({ message: `sportybet-mcp ready (region=${config.region})` });