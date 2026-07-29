import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerListTool } from "./tools/list.js";
import { registerRecordTool } from "./tools/record.js";
import { registerShotTool } from "./tools/shot.js";
import { registerStartTool } from "./tools/start.js";
import { registerStopTool } from "./tools/stop.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "ade-proof", version: "0.1.0" });
  const devServerStops = new Map<string, () => Promise<void>>();

  registerStartTool(server, devServerStops);
  registerShotTool(server);
  registerRecordTool(server);
  registerStopTool(server, devServerStops);
  registerListTool(server);

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
