import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { join } from "node:path";
import { z } from "zod";

import { startDevServer } from "../../capture/index.js";
import { resolveWorkspaceRoot, startSession } from "../../core/index.js";
import { SERVER_LOG_FILENAME } from "../../core/types.js";
import { errorResult, okText } from "../result.js";

const inputSchema = z.object({
  cwd: z.string(),
  description: z.string().optional(),
  slug: z.string().optional(),
  serverCmd: z.string().optional(),
  port: z.number().int().optional(),
});

export function registerStartTool(
  server: McpServer,
  devServerStops: Map<string, () => Promise<void>>,
): void {
  server.registerTool(
    "proof_start",
    {
      description:
        "Start a new proof-of-work session. Optionally spawn a dev server and tee its logs.",
      inputSchema,
    },
    async (args) => {
      const root = await resolveWorkspaceRoot(args.cwd);
      if (!root.ok) return errorResult(root.error);

      const session = await startSession({
        workspaceRoot: root.value,
        ...(args.description ? { description: args.description } : {}),
        ...(args.slug ? { slug: args.slug } : {}),
        ...(args.serverCmd ? { serverCmd: args.serverCmd } : {}),
      });
      if (!session.ok) return errorResult(session.error);

      if (args.serverCmd) {
        const logFileAbsPath = join(session.value.dir, SERVER_LOG_FILENAME);
        const dev = await startDevServer({
          cmd: args.serverCmd,
          cwd: root.value,
          logFileAbsPath,
          ...(args.port ? { port: args.port } : {}),
        });
        if (!dev.ok) return errorResult(dev.error);
        devServerStops.set(session.value.id, dev.value.stop);
      }

      return okText(
        `Started proof session ${session.value.id} in ${session.value.workspaceRoot}/.ade/proof/.`,
        `Session ID: ${session.value.id}`,
      );
    },
  );
}
