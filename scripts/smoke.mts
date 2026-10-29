import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/index.ts"],
  cwd: process.cwd(),
});
const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const which = process.argv[2];
if (which === "fixtures") {
  const r = await client.callTool({ name: "sportybet_get_fixtures", arguments: { limit: 5 } });
  console.log(String(r.content[0].text).slice(0, 2000));
} else if (which === "markets") {
  const f = await client.callTool({ name: "sportybet_get_fixtures", arguments: { limit: 1 } });
  const parsed = JSON.parse(String(f.content[0].text));
  const eventId = parsed.fixtures[0].eventId;
  const r = await client.callTool({ name: "sportybet_get_markets", arguments: { eventId } });
  console.log(String(r.content[0].text).slice(0, 1500));
} else if (which === "book") {
  const f = await client.callTool({ name: "sportybet_get_fixtures", arguments: { limit: 1 } });
  const parsed = JSON.parse(String(f.content[0].text));
  const eventId = parsed.fixtures[0].eventId;
  const r = await client.callTool({
    name: "sportybet_book_bet",
    arguments: { selections: [{ eventId, marketId: "1", outcomeId: "1", specifier: null }] },
  });
  console.log(String(r.content[0].text).slice(0, 2000));
  if (!r.isError) {
    const b = JSON.parse(String(r.content[0].text));
    const s = await client.callTool({ name: "sportybet_get_booking_status", arguments: { bookingCode: b.bookingCode } });
    console.log("STATUS:", String(s.content[0].text).slice(0, 800));
  }
} else if (which === "odds") {
  const f = await client.callTool({ name: "sportybet_get_fixtures", arguments: { limit: 1 } });
  const parsed = JSON.parse(String(f.content[0].text));
  const r = await client.callTool({ name: "sportybet_get_odds", arguments: { eventIds: [parsed.fixtures[0].eventId] } });
  console.log(String(r.content[0].text).slice(0, 1500));
} else if (which === "combined") {
  const r = await client.callTool({ name: "sportybet_calculate_combined_odds", arguments: { selections: [{ odds: 1.5 }, { odds: 1.8 }] } });
  console.log(String(r.content[0].text));
}

await client.close();