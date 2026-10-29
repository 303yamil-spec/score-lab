import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface LiveFixture {
  eventId: string;
  league: string;
  leagueId: string;
  category: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  matchStatus: string;
  marketCount: number;
}

export interface LiveOdds {
  eventId: string;
  marketId: string;
  market: string;
  outcome: string;
  outcomeId: string;
  odds: number;
  isActive: boolean;
  timestamp: string;
}

interface ToolPayload {
  success?: boolean;
  fixtures?: LiveFixture[];
  odds?: Array<Omit<LiveOdds, "timestamp">>;
  oddsTimestamp?: string;
  count?: number;
  error?: { message?: string; action?: string };
}

export class SportyBetMcpGateway {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connecting: Promise<Client> | null = null;
  private toolNames: string[] = [];

  async listTools(): Promise<string[]> {
    const client = await this.getClient();
    return this.toolNames.length ? this.toolNames : (await client.listTools()).tools.map(tool => tool.name);
  }

  async getFixtures(): Promise<LiveFixture[]> {
    const result = await this.call<ToolPayload>("sportybet_get_fixtures", {
      limit: 2_000,
      timelineHours: 720,
    });
    if (!Array.isArray(result.fixtures)) throw new Error("SportyBet MCP returned no fixtures list.");
    return result.fixtures.filter(fixture =>
      fixture.eventId && fixture.homeTeam && fixture.awayTeam && Number.isFinite(Date.parse(fixture.startTime)));
  }

  async getOdds(eventIds: string[]): Promise<LiveOdds[]> {
    const odds: LiveOdds[] = [];
    for (let offset = 0; offset < eventIds.length; offset += 50) {
      const batch = eventIds.slice(offset, offset + 50);
      const result = await this.call<ToolPayload>("sportybet_get_odds", {
        eventIds: batch,
        marketIds: ["1", "18", "29", "45"],
      });
      if (!Array.isArray(result.odds)) throw new Error("SportyBet MCP returned no odds list.");
      const timestamp = typeof result.oddsTimestamp === "string"
        ? result.oddsTimestamp : new Date().toISOString();
      odds.push(...result.odds.filter(line => Number.isFinite(line.odds) && line.odds > 1)
        .map(line => ({ ...line, timestamp })));
    }
    return odds;
  }

  async close(): Promise<void> {
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    if (transport) await transport.close();
  }

  private async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const client = await this.getClient();
    const result = await client.callTool({ name, arguments: args }) as CallToolResult;
    const text = result.content.find(item => item.type === "text")?.text;
    if (result.isError || !text) throw new Error(`SportyBet MCP tool ${name} failed: ${text ?? "empty response"}`);
    const payload = JSON.parse(text) as ToolPayload;
    if (payload.success === false || payload.error) {
      const message = payload.error?.message ?? `SportyBet MCP tool ${name} reported failure.`;
      throw new Error(payload.error?.action ? `${message} ${payload.error.action}` : message);
    }
    return payload as T;
  }

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
      const builtServer = resolve(projectRoot, "dist", "index.js");
      if (!existsSync(builtServer)) {
        throw new Error("SportyBet MCP build is missing. Run `npm run build` before starting the website.");
      }
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [builtServer],
        cwd: projectRoot,
        stderr: "pipe",
      });
      const client = new Client({ name: "sportybet-prediction-dashboard", version: "1.0.0" });
      await client.connect(transport);
      const tools = await client.listTools();
      this.toolNames = tools.tools.map(tool => tool.name);
      for (const required of ["sportybet_get_fixtures", "sportybet_get_odds"]) {
        if (!this.toolNames.includes(required)) {
          await transport.close();
          throw new Error(`The configured SportyBet MCP server does not expose ${required}.`);
        }
      }
      this.transport = transport;
      this.client = client;
      return client;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }
}
