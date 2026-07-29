import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { recordWeb } from "../../capture/index.js";
import { findSession, resolveWorkspaceRoot, setVideo } from "../../core/index.js";
import { errorResult, okText } from "../result.js";

const inputSchema = z.object({
  cwd: z.string(),
  url: z.string(),
  duration: z.number().int(),
  storageState: z.string().optional(),
  session: z.string().optional(),
});

export function registerRecordTool(server: McpServer): void {
  server.registerTool(
    "proof_record",
    {
      description: "Record a short web video for the active proof session.",
      inputSchema,
    },
    async (args) => {
      const root = await resolveWorkspaceRoot(args.cwd);
      if (!root.ok) return errorResult(root.error);

      const session = await findSession(root.value, args.session);
      if (!session.ok) return errorResult(session.error);

      const durationMs = args.duration * 1000;
      if (durationMs > 120_000) {
        return errorResult({
          code: "record-too-long",
          message: `Requested duration ${args.duration}s exceeds the 120s cap.`,
          details: { requestedSeconds: args.duration, maxSeconds: 120 },
        });
      }

      const relPath = `.ade/proof/${session.value.id}/session.webm`;
      const outFile = `${session.value.dir}/session.webm`;

      const record = await recordWeb({
        url: args.url,
        durationMs,
        outFile,
        ...(args.storageState ? { storageStatePath: args.storageState } : {}),
      });
      if (!record.ok) return errorResult(record.error);

      const set = await setVideo(session.value, relPath);
      if (!set.ok) return errorResult(set.error);

      return okText(`Recorded video for session ${session.value.id} at \`${relPath}\`.`);
    },
  );
}
