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
import {
  readImageBase64,
  runAdeProofShot,
  runAdeProofStop,
  type ShotResult,
} from "./run-ade-proof.js";

// Module-level per-session at-most-once guard (catalog §5.D).
const gateBySession = new Map<string, SessionProofGateState>();

// Workspaces this extension auto-started a proof session in, per engine
// session. `ade_proof_shot` starts a session on demand and nothing else would
// ever finish it, so the bundle would never get a SUMMARY and the lock would
// linger. Sealed at session_stop.
const shotCwdsBySession = new Map<string, Set<string>>();

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

function gatherWritePath(event: ToolResultEvent): string | undefined {
  const input: unknown = event.input;
  if (
    typeof input === "object" &&
    input !== null &&
    "path" in input &&
    typeof input.path === "string" &&
    input.path
  ) {
    return input.path;
  }

  const details: unknown = event.details;
  if (
    typeof details === "object" &&
    details !== null &&
    "resolvedPath" in details &&
    typeof details.resolvedPath === "string"
  ) {
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
      const command: unknown = bash.input.command;
      if (typeof command === "string" && isSuccessfulGitCommitCommand(command)) {
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

/** Mirrors the zod schema registered below; `execute` receives it untyped. */
interface ProofShotParams {
  readonly target: "web" | "macos";
  readonly label: string;
  readonly url?: string;
  readonly selector?: string;
  readonly fullPage?: boolean;
  readonly windowTitle?: string;
  readonly cwd?: string;
}

/** The engine types `parameters` as TypeBox `TSchema`. */
type ToolParametersSchema = Parameters<ExtensionAPI["registerTool"]>[0]["parameters"];

export default function adeProofExtension(pi: ExtensionAPI): void {
  const { z } = pi.zod;

  // Zod schemas are accepted at runtime (the engine unwraps both), but letting
  // TS unify this zod object with TypeBox's TSchema blows the instantiation
  // depth (TS2589). Widen once here; `ProofShotParams` keeps `execute` typed.
  const parameters = z.object({
    target: z.enum(["web", "macos"]),
    label: z.string(),
    url: z.string().optional(),
    selector: z.string().optional(),
    fullPage: z.boolean().optional(),
    windowTitle: z.string().optional(),
    cwd: z
      .string()
      .optional()
      .describe(
        "Workspace to capture proof for. Defaults to this session's workspace; pass it only when proving work in a different repository.",
      ),
  }) as unknown as ToolParametersSchema;

  pi.registerTool({
    name: PROOF_CAPTURE_TOOL,
    label: "ADE Proof Shot",
    description:
      "Capture a screenshot or window shot as proof of the current UI state. Returns a workspace-relative image path.",
    parameters,

    approval: "exec",

    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as ProofShotParams;
      const cwd = params.cwd ?? ctx.cwd;
      const shot = await runAdeProofShot({
        target: params.target,
        label: params.label,
        // exactOptionalPropertyTypes: an absent option must be ABSENT, not
        // present-and-undefined.
        ...(params.url === undefined ? {} : { url: params.url }),
        ...(params.selector === undefined ? {} : { selector: params.selector }),
        ...(params.fullPage === undefined ? {} : { fullPage: params.fullPage }),
        ...(params.windowTitle === undefined ? {} : { windowTitle: params.windowTitle }),
        cwd,
        exec: pi.exec,
      });

      const sessionId = getSessionId(ctx);
      if (sessionId) {
        const cwds = shotCwdsBySession.get(sessionId) ?? new Set<string>();
        cwds.add(cwd);
        shotCwdsBySession.set(sessionId, cwds);
      }

      const imageData = await readImageBase64(shot.absPath);
      // A relative path only renders when it is relative to the READER's
      // workspace. Proof captured for another repo must be absolute — the
      // server serves any `<git-root>/.ade/proof/**` image.
      const markdownPath = cwd === ctx.cwd ? shot.relPath : shot.absPath;

      const content: (TextContent | ImageContent)[] = [
        { type: "text", text: `![${params.label}](${markdownPath})` } as TextContent,
        {
          type: "text",
          text: `Captured \`${params.label}\` at \`${shot.absPath}\`.`,
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

    // Asking for one more turn is not the end of the session: keep the proof
    // session open so the capture the agent is about to take lands in it.
    if (result.continue === true) return result;

    // Seal every bundle this session opened: SUMMARY.md, log scan, lock
    // released. Failures must not block the engine from stopping.
    const cwds = shotCwdsBySession.get(sessionId);
    if (cwds) {
      shotCwdsBySession.delete(sessionId);
      await Promise.all(
        Array.from(cwds, (cwd) => runAdeProofStop({ cwd, exec: pi.exec }).catch(() => undefined)),
      );
    }
    gateBySession.delete(sessionId);

    return result;
  });
}
