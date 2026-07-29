import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeBrowser } from "../capture/web-shared.js";
import { PassThrough } from "node:stream";

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
  // Under Bun, the SDK's default `process.stdin.on("data")` path delivers a
  // chunk only when the NEXT chunk (or EOF) arrives, and Readable.fromWeb
  // over Bun.stdin.stream() stalls after the first read. Pump manually:
  // async iteration over Bun.stdin is the one reliable path.
  const stdin = typeof Bun !== "undefined" ? bunStdinReadable() : process.stdin;
  const transport = new StdioServerTransport(stdin, process.stdout);
  // The host closing stdin is the shutdown signal for a stdio MCP server.
  // Exit explicitly: a lingering headless Chrome (browser reuse in the
  // shot/record backends) would otherwise keep the event loop alive, and the
  // bridged stream does not propagate into `transport.onclose` reliably.
  const shutdown = () => {
    void closeBrowser().finally(() => process.exit(0));
  };
  stdin.once("end", shutdown);
  stdin.once("close", shutdown);
  transport.onclose = shutdown;
  await server.connect(transport);
}

function bunStdinReadable(): NodeJS.ReadStream {
  const stream = new PassThrough();
  void (async () => {
    try {
      for await (const chunk of Bun.stdin.stream()) stream.write(chunk);
    } catch {
      // treat a broken stdin like EOF
    } finally {
      stream.end();
    }
  })();
  return stream as unknown as NodeJS.ReadStream;
}
