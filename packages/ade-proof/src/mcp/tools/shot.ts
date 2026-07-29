import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getBackend } from "../../capture/index.js";
import { addStep, findSession, nextStepFile, resolveWorkspaceRoot } from "../../core/index.js";
import type { ProofTarget } from "../../core/types.js";
import { errorResult, okText } from "../result.js";

const inputSchema = z.object({
  cwd: z.string(),
  target: z.enum(["web", "macos"]),
  label: z.string(),
  url: z.string().optional(),
  selector: z.string().optional(),
  fullPage: z.boolean().optional(),
  windowTitle: z.string().optional(),
  storageState: z.string().optional(),
  session: z.string().optional(),
});

export function registerShotTool(server: McpServer): void {
  server.registerTool(
    "proof_shot",
    {
      description: "Capture a screenshot or window shot and attach it to the active proof session.",
      inputSchema,
    },
    async (args) => {
      const root = await resolveWorkspaceRoot(args.cwd);
      if (!root.ok) return errorResult(root.error);

      const session = await findSession(root.value, args.session);
      if (!session.ok) return errorResult(session.error);

      const backend = getBackend(args.target);
      if (!backend) {
        return errorResult({
          code: "unsupported-target",
          message: `Target ${args.target} is not supported by this backend.`,
        });
      }

      const file = await nextStepFile(session.value, args.label);
      if (!file.ok) return errorResult(file.error);

      const capture = await backend.capture({
        target: args.target as ProofTarget,
        label: args.label,
        outFile: file.value.absPath,
        ...(args.url ? { url: args.url } : {}),
        ...(args.selector ? { selector: args.selector } : {}),
        ...(args.fullPage ? { fullPage: args.fullPage } : {}),
        ...(args.windowTitle ? { windowTitle: args.windowTitle } : {}),
        ...(args.storageState ? { storageStatePath: args.storageState } : {}),
      });
      if (!capture.ok) return errorResult(capture.error);

      const meta = capture.value;
      const step = await addStep(session.value, {
        label: args.label,
        target: args.target as ProofTarget,
        file: file.value.relPath,
        ...(args.url ? { url: args.url } : {}),
        ...(meta.finalUrl ? { finalUrl: meta.finalUrl } : {}),
        ...(meta.httpStatus ? { httpStatus: meta.httpStatus } : {}),
        ...(meta.truncated ? { truncated: meta.truncated } : {}),
        ...(args.windowTitle ? { windowTitle: args.windowTitle } : {}),
      });
      if (!step.ok) return errorResult(step.error);

      return okText(
        `![${args.label}](${file.value.relPath})`,
        `Captured ${args.target} shot for \`${args.label}\` at \`${file.value.relPath}\`.`,
      );
    },
  );
}
