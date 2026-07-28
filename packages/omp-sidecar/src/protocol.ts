// FILE: protocol.ts
// Purpose: Wire contract between NuncioADE's Node server and the Bun sidecar that
//          hosts the OMP SDK. NDJSON over stdio: one JSON object per line.
// Layer: Shared protocol (imported as types by both sides)
//
// This module must stay free of engine imports: the Node server type-imports it,
// and pulling `@oh-my-pi/*` in here would drag a Bun-only package into Node's
// resolution graph. Only `@nuncio/contracts` is allowed.

import type {
  ProviderListCommandsResult,
  ProviderListModelsResult,
  ProviderListSkillsResult,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderUserInputAnswers,
} from "@nuncio/contracts";

/**
 * Structural mirror of the server's `ProviderThreadSnapshot`
 * (`apps/server/src/provider/Services/ProviderAdapter.ts`). Declared here rather
 * than imported because a package may not depend on an app — and rather than
 * added to `@nuncio/contracts`, which would duplicate an existing definition in
 * upstream ground. Field-compatible, so the client passes it straight through.
 */
export interface OmpSidecarThreadSnapshot {
  readonly threadId: string;
  readonly turns: ReadonlyArray<{ readonly id: string; readonly items: ReadonlyArray<unknown> }>;
  readonly cwd?: string | null;
}

/** Bumped only for breaking wire changes; the server refuses anything else. */
export const OMP_SIDECAR_PROTOCOL_VERSION = 1;

/** Frames larger than this are a bug: payloads travel by path, not inline. */
export const OMP_SIDECAR_MAX_FRAME_BYTES = 1024 * 1024;

/** Overrides the resolved sidecar executable (local debugging). */
export const OMP_SIDECAR_PATH_ENV = "NUNCIO_OMP_SIDECAR_PATH";

export interface OmpSidecarStartSessionParams {
  readonly threadId: string;
  /** Mirrors `ProviderSession.runtimeMode`; the sidecar echoes it back. */
  readonly runtimeMode: "approval-required" | "full-access";
  readonly cwd?: string;
  readonly resumeCursor?: unknown;
  readonly lifecycleGeneration?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly agentDir?: string;
  /** Thread-scoped NuncioADE MCP endpoint; absent when the gateway is unavailable. */
  readonly gateway?: { readonly url: string; readonly bearerToken: string };
}

export interface OmpSidecarSendTurnParams {
  readonly threadId: string;
  readonly input: string;
  /** Absolute paths only — never inline bytes, so frames stay small. */
  readonly attachmentPaths?: ReadonlyArray<string>;
  readonly harnessPolicy?: string;
}

export interface OmpSidecarSendTurnResult {
  readonly turnId: string;
  readonly resumeCursor?: string;
}

/**
 * One entry per `OmpAdapterShape` method, so the adapter stays a pass-through
 * and the sidecar owns every engine decision.
 */
export interface OmpSidecarMethods {
  "session/start": { params: OmpSidecarStartSessionParams; result: ProviderSession };
  "session/stop": { params: { threadId: string }; result: null };
  "session/stop-all": { params: Record<string, never>; result: null };
  "session/list": { params: Record<string, never>; result: ReadonlyArray<ProviderSession> };
  "session/has": { params: { threadId: string }; result: boolean };
  "turn/send": { params: OmpSidecarSendTurnParams; result: OmpSidecarSendTurnResult };
  "turn/steer": { params: OmpSidecarSendTurnParams; result: OmpSidecarSendTurnResult };
  "turn/interrupt": { params: { threadId: string }; result: null };
  "task/stop": { params: { threadId: string; taskId: string }; result: null };
  "user-input/respond": {
    params: { threadId: string; requestId: string; answers: ProviderUserInputAnswers };
    result: null;
  };
  "thread/read": { params: { threadId: string }; result: OmpSidecarThreadSnapshot };
  "thread/rollback": {
    params: { threadId: string; numTurns: number };
    result: OmpSidecarThreadSnapshot;
  };
  "thread/compact": { params: { threadId: string }; result: null };
  "model/list": {
    params: { agentDir?: string; refresh?: boolean };
    result: ProviderListModelsResult;
  };
  "skill/list": { params: { cwd: string; agentDir?: string }; result: ProviderListSkillsResult };
  "command/list": {
    params: { cwd: string; agentDir?: string; threadId?: string };
    result: ProviderListCommandsResult;
  };
}

export type OmpSidecarMethod = keyof OmpSidecarMethods;

export interface OmpSidecarHelloFrame {
  readonly type: "hello";
  readonly protocolVersion: number;
  readonly engineVersion: string;
  readonly pid: number;
}

export interface OmpSidecarRequestFrame<M extends OmpSidecarMethod = OmpSidecarMethod> {
  readonly type: "request";
  readonly id: string;
  readonly method: M;
  readonly params: OmpSidecarMethods[M]["params"];
}

export interface OmpSidecarErrorPayload {
  readonly method: string;
  readonly detail: string;
  /** True when the thread has no live session, so the caller can restart it. */
  readonly sessionMissing?: boolean;
}

export type OmpSidecarResponseFrame<M extends OmpSidecarMethod = OmpSidecarMethod> =
  | {
      readonly type: "response";
      readonly id: string;
      readonly ok: true;
      readonly result: OmpSidecarMethods[M]["result"];
    }
  | {
      readonly type: "response";
      readonly id: string;
      readonly ok: false;
      readonly error: OmpSidecarErrorPayload;
    };

export interface OmpSidecarEventFrame {
  readonly type: "event";
  readonly threadId: string;
  readonly event: ProviderRuntimeEvent;
}

/** Sidecar-level trouble that belongs in the provider log, not a thread. */
export interface OmpSidecarLogFrame {
  readonly type: "log";
  readonly level: "info" | "warning" | "error";
  readonly message: string;
  readonly detail?: Record<string, unknown>;
}

export type OmpSidecarOutboundFrame =
  | OmpSidecarHelloFrame
  | OmpSidecarResponseFrame
  | OmpSidecarEventFrame
  | OmpSidecarLogFrame;

export type OmpSidecarInboundFrame = OmpSidecarRequestFrame;

export function encodeSidecarFrame(
  frame: OmpSidecarOutboundFrame | OmpSidecarInboundFrame,
): string {
  return `${JSON.stringify(frame)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parses one NDJSON line. Returns `null` for anything unrecognizable so a
 * stray write on the channel degrades to a dropped line instead of a crash.
 */
export function decodeSidecarFrame(line: string): OmpSidecarOutboundFrame | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return null;
  switch (parsed.type) {
    case "hello":
    case "response":
    case "event":
    case "log":
      return parsed as unknown as OmpSidecarOutboundFrame;
    default:
      return null;
  }
}

/** Splits a stdout chunk stream into complete lines, keeping the remainder. */
export function makeLineSplitter(): (chunk: string) => ReadonlyArray<string> {
  let buffered = "";
  return (chunk: string) => {
    buffered += chunk;
    const lines: string[] = [];
    let index = buffered.indexOf("\n");
    while (index >= 0) {
      lines.push(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
      index = buffered.indexOf("\n");
    }
    return lines;
  };
}
