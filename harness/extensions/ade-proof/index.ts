import { readFile } from "node:fs/promises";
import type {
  AgentToolResult,
  BashToolResultEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
  WriteToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";

import {
  decideSessionStopGate,
  initialSessionProofGateState,
  isSuccessfulGitCommitCommand,
  noteCommitWithUiFiles,
  noteShotRan,
  noteUiFilePaths,
  parseGitNameOnly,
  PROOF_CAPTURE_TOOL,
  type SessionProofGateState,
  UI_FILE_RE,
} from "./logic.js";
import { readImageBase64, runAdeProofShot, type ShotResult } from "./run-ade-proof.js";

// Module-level per-session at-most-once guard (catalog §5.D).
const gateBySession = new Map<string, SessionProofGateState>();

function getSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch {
    return undefined;
  }
}

function getCwd(event: ToolResultEvent, ctx: ExtensionContext): string {
  const input = event.input;
  if ("cwd" in input && typeof input.cwd === "string" && input.cwd) {
    return input.cwd;
  }
  return ctx.cwd;
}

async function gatherCommitUiFiles(
  cwd: string,
  exec: ExtensionAPI["exec"],
): Promise<readonly string[]> {
  const result = await exec("git", ["-C", cwd, "log", "-1", "--name-only", "--pretty=format:"]);
  if (result.code !== 0) return [];
  return parseGitNameOnly(result.stdout);
}

function gatherWritePath(event: WriteToolResultEvent): string | undefined {
  const input = event.input;
  if ("path" in input && typeof input.path === "string" && input.path) return input.path;

  const details = event.details;
  if (details && "resolvedPath" in details && typeof details.resolvedPath === "string") {
    return details.resolvedPath;
  }
  return undefined;
}

function gatherAstEditPaths(event: ToolResultEvent): string[] {
  const input = event.input;
  const fromInput: string[] = [];
  if ("paths" in input && Array.isArray(input.paths)) {
    for (const p of input.paths) if (typeof p === "string" && p) fromInput.push(p);
  }

  const fromDetails: string[] = [];
  if ("details" in event && event.details !== undefined && event.details !== null) {
    const details = event.details;
    if (
      typeof details === "object" &&
      "fileReplacements" in details &&
      Array.isArray(details.fileReplacements)
    ) {
      for (const r of details.fileReplacements) {
        if (r && typeof r === "object" && "path" in r && typeof r.path === "string" && r.path) {
          fromDetails.push(r.path);
        }
      }
    }
  }

  return Array.from(new Set([...fromInput, ...fromDetails]));
}

function pathsFromToolResult(event: ToolResultEvent): readonly string[] {
  if (event.toolName === "write") {
    const path = gatherWritePath(event);
    return path ? [path] : [];
  }
  if (event.toolName === "ast_edit") return gatherAstEditPaths(event);
  return [];
}

function sessionHasAnyUiFile(paths: readonly string[]): boolean {
  return paths.some((p) => UI_FILE_RE.test(p));
}

function updateGateFromToolResult(
  sessionId: string,
  event: ToolResultEvent,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): void {
  let state = gateBySession.get(sessionId) ?? initialSessionProofGateState();

  if (event.toolName === PROOF_CAPTURE_TOOL) {
    state = noteShotRan(state);
  } else {
    const paths = pathsFromToolResult(event);
    if (paths.length) {
      state = noteUiFilePaths(state, paths);
    }

    if (event.toolName === "bash" && !event.isError) {
      const bash = event as BashToolResultEvent;
      if (isSuccessfulGitCommitCommand(bash.input.command)) {
        const cwd = getCwd(event, ctx);
        gatherCommitUiFiles(cwd, pi.exec).then((files) => {
          if (!files.length) return;
          const current = gateBySession.get(sessionId) ?? initialSessionProofGateState();
          const next = noteCommitWithUiFiles(current, files);
          gateBySession.set(sessionId, next);

          if (!next.shotRan && sessionHasAnyUiFile(files)) {
            pi.sendMessage(
              {
                customType: "ade_proof_nudge",
                content: [
                  {
                    type: "text",
                    text: `UI files were just committed. Consider running \`${PROOF_CAPTURE_TOOL}\` to capture proof.`,
                  } as TextContent,
                ],
                display: true,
                details: { files },
              },
              { deliverAs: "nextTurn" },
            );
          }
        });
      }
    }
  }

  gateBySession.set(sessionId, state);
}

export default function adeProofExtension(pi: ExtensionAPI): void {
  const { z } = pi.zod;

  pi.registerTool({
    name: PROOF_CAPTURE_TOOL,
    label: "ADE Proof Shot",
    description:
      "Capture a screenshot or window shot as proof of the current UI state. Returns a workspace-relative image path.",
    parameters: z.object({
      target: z.enum(["web", "macos"]),
      label: z.string(),
      url: z.string().optional(),
      selector: z.string().optional(),
      fullPage: z.boolean().optional(),
      windowTitle: z.string().optional(),
    }),

    approval: "exec",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const shot = await runAdeProofShot({
        target: params.target,
        label: params.label,
        url: params.url,
        selector: params.selector,
        fullPage: params.fullPage,
        windowTitle: params.windowTitle,
        cwd: ctx.cwd,
        exec: pi.exec,
      });

      const imageData = await readImageBase64(shot.absPath);

      const content: (TextContent | ImageContent)[] = [
        { type: "text", text: `![${params.label}](${shot.relPath})` } as TextContent,
        {
          type: "text",
          text: `Captured \`${params.label}\` at \`${shot.relPath}\`.`,
        } as TextContent,
        { type: "image", data: imageData, mimeType: "image/png" } as ImageContent,
      ];

      const result: AgentToolResult<ShotResult> = { content, details: shot };
      return result;
    },
  });
  pi.on("tool_result", async (event, ctx) => {
    const sessionId = getSessionId(ctx);
    if (!sessionId) return;
    updateGateFromToolResult(sessionId, event, ctx, pi);
  });

  pi.on("session_stop", async (event, _ctx) => {
    const sessionId = event.session_id;
    if (!sessionId) return undefined;

    const state = gateBySession.get(sessionId) ?? initialSessionProofGateState();
    const { result, nextState } = decideSessionStopGate(state);
    gateBySession.set(sessionId, nextState);

    return result;
  });
}
