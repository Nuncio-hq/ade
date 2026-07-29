import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { findSession, resolveWorkspaceRoot, stopSession } from "../../core/index.js";
import { errorResult, okText } from "../result.js";

const inputSchema = z.object({
  cwd: z.string(),
  session: z.string().optional(),
  consoleLines: z.array(z.string()).optional(),
});

export function registerStopTool(
  server: McpServer,
  devServerStops: Map<string, () => Promise<void>>,
): void {
  server.registerTool(
    "proof_stop",
    {
      description: "Stop the active proof session, scan logs, and write SUMMARY.md.",
      inputSchema,
    },
    async (args) => {
      const root = await resolveWorkspaceRoot(args.cwd);
      if (!root.ok) return errorResult(root.error);

      const session = await findSession(root.value, args.session);
      if (!session.ok) return errorResult(session.error);

      const stopFn = devServerStops.get(session.value.id);
      if (stopFn) {
        await stopFn();
        devServerStops.delete(session.value.id);
      }

      const stopped = await stopSession(session.value, {
        ...(args.consoleLines ? { consoleLines: args.consoleLines } : {}),
      });
      if (!stopped.ok) return errorResult(stopped.error);

      return okText(
        `Stopped session ${stopped.value.manifest.id}.`,
        `Summary written to \`${stopped.value.summaryAbsPath}\`.`,
      );
    },
  );
}
