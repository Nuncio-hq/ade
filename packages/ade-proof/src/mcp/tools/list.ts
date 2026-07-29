import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { listSessions, resolveWorkspaceRoot } from "../../core/index.js";
import { errorResult, okText } from "../result.js";

const inputSchema = z.object({
  cwd: z.string(),
});

export function registerListTool(server: McpServer): void {
  server.registerTool(
    "proof_list",
    {
      description: "List proof sessions for the workspace.",
      inputSchema,
    },
    async (args) => {
      const root = await resolveWorkspaceRoot(args.cwd);
      if (!root.ok) return errorResult(root.error);

      const sessions = await listSessions(root.value);
      if (!sessions.length) {
        return okText("No proof sessions found.");
      }

      const lines = sessions.map((s) => `- ${s.id} (${s.state})`);
      return okText(`Proof sessions in ${root.value}:`, ...lines);
    },
  );
}
