/**
 * OmpAdapter - NDJSON stdio client + supervisor for the Bun omp-sidecar.
 *
 * The engine (session creation, event mapping, watchdog, UI context, gateway
 * tool projection, turn-failure classification) lives in the sidecar; this
 * adapter owns the Effect layer, request/response correlation, event ingress,
 * process supervision, and the ProviderAdapterShape surface.
 *
 * @module OmpAdapter
 */
import crypto from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  ApprovalRequestId,
  type ChatAttachment,
  EventId,
  type ProviderComposerCapabilities,
  type ProviderListCommandsResult,
  type ProviderListModelsResult,
  type ProviderListSkillsResult,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Effect, Layer, Option, Queue, Stream } from "effect";
import {
  encodeSidecarFrame,
  decodeSidecarFrame,
  makeLineSplitter,
  OMP_SIDECAR_PROTOCOL_VERSION,
  OMP_SIDECAR_PATH_ENV,
  type OmpSidecarErrorPayload,
  type OmpSidecarEventFrame,
  type OmpSidecarLogFrame,
  type OmpSidecarMethod,
  type OmpSidecarMethods,
  type OmpSidecarOutboundFrame,
  type OmpSidecarRequestFrame,
  type OmpSidecarResponseFrame,
  type OmpSidecarSendTurnResult,
  type OmpSidecarStartSessionParams,
  type OmpSidecarThreadSnapshot,
} from "@nuncio/omp-sidecar/protocol";

import { takeSynaraHarnessPolicyForProviderSession } from "../../agentGateway/harnessPolicy.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import {
  acquireAgentGatewaySessionLease,
  releaseAgentGatewaySessionLeaseOnInterrupt,
  type AgentGatewaySessionLease,
} from "../../agentGateway/sessionLease.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { OmpAdapter, type OmpAdapterShape } from "../Services/OmpAdapter.ts";
import { PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY } from "../Services/ProviderAdapter.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { makeBoundedCallbackIngress } from "../boundedCallbackIngress.ts";
import { resolveProviderAttachmentPath } from "../providerAttachmentPaths.ts";
import {
  compactProviderRuntimeEventForIngress,
  isTerminalProviderRuntimeEvent,
  PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES,
  PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE,
  providerRuntimeEventBytes,
} from "../providerRuntimeEventIngress.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "omp" as const;
const OMP_GLOBAL_THREAD_ID = ThreadId.makeUnsafe("omp");
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RESTART_BACKOFF_MS = 1_000;
const MAX_RESTART_BACKOFF_MS = 30_000;

/**
 * OMP thinking levels are the pi-catalog `Effort` const-enum members plus
 * "off"/"inherit"; at runtime every member is exactly its lowercase name
 * (pi-catalog/src/effort.ts), so the checked cast below re-tags safely without
 * a value import that would defeat the lazy-load. "max" and "inherit" stay
 * unadvertised until the contracts widen beyond pi's six levels.
 */
const OMP_THINKING_LEVEL_NAMES = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export interface OmpSidecarProcess {
  readonly pid: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly kill: (signal?: string) => void;
  readonly exit: Promise<number | null>;
}

export interface OmpAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Test seam. Returns a process with stdin/stdout/stderr streams, a kill()
   * method, and an exit promise. Defaults to a real child process resolved from
   * the packaged binary, env override, or dev Bun source.
   */
  readonly spawnSidecar?: () => Promise<OmpSidecarProcess>;
  readonly requestTimeoutMs?: number;
  readonly restartBackoffMs?: number;
}

interface OmpSessionContext {
  readonly threadId: ThreadId;
  readonly lifecycleGeneration: string | undefined;
  readonly startParams: OmpSidecarStartSessionParams;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  stopped: boolean;
  gatewayControlAvailable: boolean;
  gatewaySessionLease: AgentGatewaySessionLease | undefined;
  harnessPolicyDelivered?: boolean;
  lastResumedGeneration: number;
}

type OmpSessionOrError =
  | OmpSessionContext
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterSessionClosedError;

interface PendingRequest {
  readonly method: string;
  readonly threadId: ThreadId | undefined;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: ProviderAdapterError) => void;
  readonly timer: NodeJS.Timeout;
}

interface SidecarState {
  process: OmpSidecarProcess | undefined;
  hello: boolean;
  unavailable: boolean;
  unavailableReason: string | undefined;
  pendingRequests: Map<string, PendingRequest>;
  starting: Promise<void> | undefined;
  pendingRestart: NodeJS.Timeout | undefined;
  restartGeneration: number;
  consecutiveRestarts: number;
  disposing: boolean;
}

const toOmpThinkingLevel = (value: string | null | undefined): string | undefined =>
  value && (OMP_THINKING_LEVEL_NAMES as readonly string[]).includes(value) ? value : undefined;

const toMessage = (cause: unknown, fallback: string): string => {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return fallback;
};

const toProviderThreadSnapshot = (snapshot: OmpSidecarThreadSnapshot): ProviderThreadSnapshot => ({
  threadId: ThreadId.makeUnsafe(snapshot.threadId),
  turns: snapshot.turns.map((turn) => ({
    id: TurnId.makeUnsafe(turn.id),
    items: turn.items,
  })),
  cwd: snapshot.cwd ?? null,
});

const trimToUndefined = (value: string | null | undefined): string | undefined => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
};

const runtimeErrorDetail = (cause: unknown): unknown => {
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
      ...(cause.stack ? { stack: cause.stack } : {}),
    };
  }
  return cause;
};

const isProviderAdapterError = (cause: unknown): cause is ProviderAdapterError =>
  cause instanceof ProviderAdapterRequestError ||
  cause instanceof ProviderAdapterProcessError ||
  cause instanceof ProviderAdapterSessionNotFoundError ||
  cause instanceof ProviderAdapterSessionClosedError ||
  cause instanceof ProviderAdapterValidationError;

const makeOmpRuntimeEventBase = (
  context: {
    readonly lifecycleGeneration?: string | undefined;
    readonly session: { readonly threadId: ThreadId };
    readonly activeTurnId?: TurnId | undefined;
  },
  options?: { readonly includeTurnId?: boolean },
) => ({
  eventId: EventId.makeUnsafe(crypto.randomUUID()),
  provider: PROVIDER,
  threadId: context.session.threadId,
  createdAt: new Date().toISOString(),
  ...(context.lifecycleGeneration !== undefined
    ? { lifecycleGeneration: context.lifecycleGeneration }
    : {}),
  ...(options?.includeTurnId !== false && context.activeTurnId
    ? { turnId: context.activeTurnId }
    : {}),
});

async function defaultSpawnSidecar(serverConfig: ServerConfigShape): Promise<OmpSidecarProcess> {
  const envPath = process.env[OMP_SIDECAR_PATH_ENV]?.trim();
  let command: string;
  let args: string[] = [];
  let cwd: string | undefined;

  if (envPath) {
    command = envPath;
  } else {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (typeof resourcesPath === "string") {
      const sidecarDir = path.join(resourcesPath, "omp-sidecar");
      const ext = process.platform === "win32" ? ".exe" : "";
      command = path.join(sidecarDir, `omp-sidecar${ext}`);
      cwd = sidecarDir;
    } else {
      // Dev: the server itself runs under Bun, so reuse that runtime. Resolve
      // from this module rather than from config — `baseDir` is the state dir
      // (`.ade-dev`), not the repo root.
      command = process.execPath;
      const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
      args = ["run", path.join(repoRoot, "packages", "omp-sidecar", "src", "main.ts")];
      cwd = repoRoot;
    }
  }

  await access(command);

  const child = spawn(command, args, {
    cwd,
    env: buildProviderChildEnvironment({ provider: "omp" }),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const { promise: exit, resolve: resolveExit } = Promise.withResolvers<number | null>();
  child.on("close", (code) => resolveExit(code));

  return {
    pid: child.pid,
    stdin: child.stdin!,
    stdout: child.stdout!,
    stderr: child.stderr!,
    kill: (signal) => {
      if (signal) {
        child.kill(signal as NodeJS.Signals);
      } else {
        child.kill();
      }
    },
    exit,
  };
}

const makeOmpAdapter = (options?: OmpAdapterLiveOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const agentGatewayCredentials = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayCredentials),
    );
    const requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const restartBackoffMs = options?.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
    const runtimeEventQueue = yield* Queue.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );
    const ownsNativeEventLogger = options?.nativeEventLogger === undefined;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const runtimeEventIngress = yield* makeBoundedCallbackIngress<
      ProviderRuntimeEvent,
      never,
      never
    >(
      (event) =>
        (nativeEventLogger && event.raw
          ? nativeEventLogger.write(event.raw, event.threadId).pipe(Effect.ignore)
          : Effect.void
        ).pipe(Effect.andThen(Queue.offer(runtimeEventQueue, event)), Effect.asVoid),
      {
        capacity: PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
        maxBufferedBytes: PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES,
        terminalReserve: PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE,
        isTerminal: isTerminalProviderRuntimeEvent,
        sizeOf: providerRuntimeEventBytes,
      },
    );

    const sessions = new Map<ThreadId, OmpSessionContext>();
    const sidecarState: SidecarState = {
      process: undefined,
      hello: false,
      unavailable: false,
      unavailableReason: undefined,
      pendingRequests: new Map(),
      starting: undefined,
      pendingRestart: undefined,
      restartGeneration: 0,
      consecutiveRestarts: 0,
      disposing: false,
    };

    const spawnSidecarFn = options?.spawnSidecar ?? (() => defaultSpawnSidecar(serverConfig));

    const makeEventBase = makeOmpRuntimeEventBase;

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) => {
      runtimeEventIngress.offer(compactProviderRuntimeEventForIngress(event));
    };

    const offerRuntimeWarning = (message: string, detail?: Record<string, unknown>) => {
      offerRuntimeEvent({
        ...makeEventBase({ session: { threadId: OMP_GLOBAL_THREAD_ID } }, { includeTurnId: false }),
        type: "runtime.warning",
        payload: { message, ...(detail ? { detail } : {}) },
        raw: {
          source: "omp.sdk.event",
          method: "sidecar/unavailable",
          payload: { message, detail },
        },
      } satisfies ProviderRuntimeEvent);
    };

    const logSidecar = (
      level: OmpSidecarLogFrame["level"],
      message: string,
      detail?: Record<string, unknown>,
    ) => {
      const effect =
        level === "error"
          ? Effect.logError(message, detail)
          : level === "warning"
            ? Effect.logWarning(message, detail)
            : Effect.log(message, detail);
      Effect.runSync(effect);
    };

    const mapSidecarError = (
      error: OmpSidecarErrorPayload,
      method: string,
      threadId: ThreadId | undefined,
    ): ProviderAdapterError => {
      if (error.sessionMissing && threadId) {
        return new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      return new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: error.detail,
      });
    };

    const updateRuntimeState = (context: OmpSessionContext, event: ProviderRuntimeEvent) => {
      if (event.type === "turn.started") {
        if (!context.activeTurnId && event.turnId) {
          context.activeTurnId = event.turnId;
        }
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: context.activeTurnId,
          updatedAt: new Date().toISOString(),
        };
      }
      if (event.type === "turn.completed") {
        if (!event.turnId || event.turnId === context.activeTurnId) {
          context.activeTurnId = undefined;
        }
        context.session = {
          ...context.session,
          status: context.stopped ? "closed" : "ready",
          activeTurnId: context.activeTurnId,
          updatedAt: new Date().toISOString(),
        };
      }
      if (event.type === "session.exited") {
        context.stopped = true;
        context.activeTurnId = undefined;
        context.session = {
          ...context.session,
          status: "closed",
          activeTurnId: undefined,
          updatedAt: new Date().toISOString(),
        };
      }
      if (event.type === "runtime.warning") {
        const raw = event.raw;
        if (raw?.method === "mcp/gateway-unavailable") {
          context.gatewayControlAvailable = false;
        } else {
          const payload = event.payload;
          if (
            typeof payload === "object" &&
            payload !== null &&
            "reason" in payload &&
            typeof (payload as { reason?: unknown }).reason === "string" &&
            (payload as { reason: string }).reason.includes("gateway")
          ) {
            context.gatewayControlAvailable = false;
          }
        }
      }
    };

    const handleResponse = (frame: OmpSidecarResponseFrame) => {
      const pending = sidecarState.pendingRequests.get(frame.id);
      if (!pending) return;
      sidecarState.pendingRequests.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.ok) {
        pending.resolve(frame.result);
      } else {
        pending.reject(mapSidecarError(frame.error, pending.method, pending.threadId));
      }
    };

    const handleEvent = (frame: OmpSidecarEventFrame) => {
      const threadId = ThreadId.makeUnsafe(frame.threadId);
      const context = sessions.get(threadId);
      if (context) {
        updateRuntimeState(context, frame.event);
      }
      offerRuntimeEvent(frame.event);
    };

    const sendRequest = <M extends OmpSidecarMethod>(
      method: M,
      params: OmpSidecarMethods[M]["params"],
      threadId: ThreadId | undefined,
    ): Promise<OmpSidecarMethods[M]["result"]> => {
      return new Promise((resolve, reject) => {
        const process = sidecarState.process;
        if (!process || !sidecarState.hello) {
          reject(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: "OMP sidecar is not connected.",
            }),
          );
          return;
        }
        const id = crypto.randomUUID();
        const frame: OmpSidecarRequestFrame<M> = { type: "request", id, method, params };
        const line = encodeSidecarFrame(frame);
        const timer = setTimeout(() => {
          sidecarState.pendingRequests.delete(id);
          reject(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: `OMP sidecar request to ${method} timed out after ${String(requestTimeoutMs)} ms.`,
            }),
          );
        }, requestTimeoutMs);
        sidecarState.pendingRequests.set(id, {
          method,
          threadId,
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
        });
        try {
          process.stdin.write(line, (err) => {
            if (err) {
              clearTimeout(timer);
              sidecarState.pendingRequests.delete(id);
              reject(
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: threadId ?? OMP_GLOBAL_THREAD_ID,
                  detail: `Failed to write to OMP sidecar stdin: ${err.message}`,
                }),
              );
            }
          });
        } catch (cause) {
          clearTimeout(timer);
          sidecarState.pendingRequests.delete(id);
          reject(
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: threadId ?? OMP_GLOBAL_THREAD_ID,
              detail: toMessage(cause, "Failed to write to OMP sidecar stdin."),
            }),
          );
        }
      });
    };

    const sidecarRequest = <M extends OmpSidecarMethod>(
      method: M,
      params: OmpSidecarMethods[M]["params"],
      threadId: ThreadId | undefined,
    ): Effect.Effect<OmpSidecarMethods[M]["result"], ProviderAdapterError, never> =>
      Effect.tryPromise({
        try: () => sendRequest(method, params, threadId),
        catch: (cause): ProviderAdapterError =>
          isProviderAdapterError(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method,
                detail: toMessage(cause, `OMP ${method} failed.`),
                cause,
              }),
      });

    const rejectPendingRequests = (exitCode: number | null) => {
      for (const [id, pending] of sidecarState.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: pending.threadId ?? OMP_GLOBAL_THREAD_ID,
            detail: `OMP sidecar process exited with code ${exitCode ?? "null"}.`,
          }),
        );
      }
      sidecarState.pendingRequests.clear();
    };

    const failActiveTurns = (exitCode: number | null) => {
      const detail = `OMP sidecar process exited unexpectedly (code ${exitCode ?? "null"}).`;
      for (const [threadId, context] of sessions) {
        if (context.stopped || !context.activeTurnId) continue;
        const turnId = context.activeTurnId;
        const base = makeEventBase({
          session: { threadId },
          activeTurnId: turnId,
          lifecycleGeneration: context.lifecycleGeneration,
        });
        offerRuntimeEvent({
          ...base,
          type: "runtime.error",
          payload: { message: detail, class: "provider_error" },
          raw: { source: "omp.sdk.event", method: "process/exit", payload: { exitCode } },
        } satisfies ProviderRuntimeEvent);
        offerRuntimeEvent({
          ...base,
          type: "turn.completed",
          payload: { state: "failed", stopReason: "error", errorMessage: detail },
          raw: { source: "omp.sdk.event", method: "process/exit", payload: { exitCode } },
        } satisfies ProviderRuntimeEvent);
        context.activeTurnId = undefined;
        context.session = {
          ...context.session,
          activeTurnId: undefined,
          status: "ready",
          updatedAt: new Date().toISOString(),
        };
      }
    };

    const scheduleRestart = () => {
      if (sidecarState.disposing || sidecarState.unavailable || sidecarState.pendingRestart) return;
      sidecarState.consecutiveRestarts += 1;
      const delay = Math.min(
        MAX_RESTART_BACKOFF_MS,
        restartBackoffMs * Math.pow(2, sidecarState.consecutiveRestarts - 1),
      );
      sidecarState.pendingRestart = setTimeout(() => {
        sidecarState.pendingRestart = undefined;
        startSidecar().catch(() => undefined);
      }, delay);
    };

    const resumeSession = (context: OmpSessionContext) =>
      sidecarRequest("session/start", context.startParams, context.threadId).pipe(
        Effect.map((session) => {
          context.session = session;
          context.lastResumedGeneration = sidecarState.restartGeneration;
          return session;
        }),
      );

    const startSidecar = async (): Promise<void> => {
      if (sidecarState.unavailable) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "sidecar",
          detail: sidecarState.unavailableReason ?? "OMP sidecar is unavailable.",
        });
      }
      if (sidecarState.process && sidecarState.hello) return;

      if (sidecarState.pendingRestart) {
        clearTimeout(sidecarState.pendingRestart);
        sidecarState.pendingRestart = undefined;
      }
      sidecarState.process?.kill();
      sidecarState.process = undefined;
      sidecarState.hello = false;
      sidecarState.restartGeneration += 1;

      let process: OmpSidecarProcess;
      try {
        process = await spawnSidecarFn();
      } catch (cause) {
        const detail = toMessage(cause, "No OMP sidecar resolved or executable.");
        sidecarState.unavailable = true;
        sidecarState.unavailableReason = detail;
        offerRuntimeWarning(detail, { cause: runtimeErrorDetail(cause) });
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "sidecar",
          detail,
          cause,
        });
      }

      sidecarState.process = process;

      const {
        promise: helloPromise,
        resolve: helloResolve,
        reject: helloReject,
      } = Promise.withResolvers<void>();
      let helloResolved = false;

      const helloTimeout = setTimeout(() => {
        if (helloResolved) return;
        process.kill();
        helloReject(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sidecar/hello",
            detail: "OMP sidecar did not send a hello frame in time.",
          }),
        );
      }, requestTimeoutMs);

      const lineSplitter = makeLineSplitter();

      const onLine = (line: string) => {
        const frame = decodeSidecarFrame(line);
        if (!frame) return;

        if (frame.type === "hello") {
          if (helloResolved) return;
          if (frame.protocolVersion !== OMP_SIDECAR_PROTOCOL_VERSION) {
            const detail = `OMP sidecar protocol version ${String(frame.protocolVersion)} is not supported. Expected ${String(OMP_SIDECAR_PROTOCOL_VERSION)}.`;
            sidecarState.unavailable = true;
            sidecarState.unavailableReason = detail;
            offerRuntimeWarning(detail, {
              protocolVersion: frame.protocolVersion,
              expected: OMP_SIDECAR_PROTOCOL_VERSION,
            });
            process.kill();
            helloReject(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "sidecar/hello",
                detail,
              }),
            );
            return;
          }
          helloResolved = true;
          sidecarState.hello = true;
          sidecarState.consecutiveRestarts = 0;
          clearTimeout(helloTimeout);
          helloResolve();
          return;
        }

        if (frame.type === "response") {
          handleResponse(frame);
          return;
        }

        if (frame.type === "event") {
          handleEvent(frame);
          return;
        }

        if (frame.type === "log") {
          logSidecar(frame.level, frame.message, frame.detail);
        }
      };

      process.stdout.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        for (const line of lineSplitter(text)) onLine(line);
      });

      process.stderr.on("data", (chunk: Buffer | string) => {
        const text = (typeof chunk === "string" ? chunk : chunk.toString("utf8")).trim();
        if (text.length === 0) return;
        for (const line of text.split(/\r?\n/u)) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          Effect.runSync(
            Effect.logWarning(`[omp sidecar stderr] ${trimmed}`, { provider: PROVIDER }),
          );
        }
      });

      process.exit.then((exitCode) => {
        if (sidecarState.process === process) {
          sidecarState.process = undefined;
          sidecarState.hello = false;
        }
        process.stdout.removeAllListeners("data");
        process.stderr.removeAllListeners("data");
        rejectPendingRequests(exitCode);
        if (!sidecarState.disposing && !sidecarState.unavailable) {
          failActiveTurns(exitCode);
          scheduleRestart();
        }
      });

      await helloPromise;

      for (const [threadId, context] of sessions) {
        if (context.stopped) continue;
        if (context.lastResumedGeneration === sidecarState.restartGeneration) continue;
        try {
          await Effect.runPromise(resumeSession(context));
        } catch (cause) {
          Effect.runSync(
            Effect.logWarning(
              `Failed to resume OMP session for thread ${threadId} after sidecar restart.`,
              { cause: runtimeErrorDetail(cause) },
            ),
          );
        }
      }
    };

    const ensureSidecar = Effect.tryPromise({
      try: async () => {
        if (sidecarState.unavailable) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sidecar",
            detail: sidecarState.unavailableReason ?? "OMP sidecar is unavailable.",
          });
        }
        if (sidecarState.process && sidecarState.hello) return;
        if (sidecarState.starting) {
          await sidecarState.starting;
          return;
        }
        const start = startSidecar();
        sidecarState.starting = start.finally(() => {
          sidecarState.starting = undefined;
        });
        await sidecarState.starting;
      },
      catch: (cause) =>
        isProviderAdapterError(cause)
          ? cause
          : new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sidecar",
              detail: toMessage(cause, "Failed to start OMP sidecar."),
              cause,
            }),
    });

    const buildPromptText = (input: {
      readonly input?: string | undefined;
      readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
    }) =>
      appendFileAttachmentsPromptBlock({
        text: input.input,
        attachments: input.attachments,
        attachmentsDir: serverConfig.attachmentsDir,
        include: "all-files",
      }) ?? "";

    const buildAttachmentPaths = (
      attachments: ReadonlyArray<ChatAttachment> | undefined,
    ): string[] => {
      const paths: string[] = [];
      for (const attachment of attachments ?? []) {
        const resolved = resolveProviderAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (resolved) paths.push(resolved);
      }
      return paths;
    };

    const requireSession = (threadId: ThreadId): OmpSessionOrError => {
      const context = sessions.get(threadId);
      if (!context) {
        return new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
      }
      if (context.stopped) {
        return new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
      }
      return context;
    };

    const startSession: OmpAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        yield* ensureSidecar;

        const cwd = trimToUndefined(input.cwd) ?? serverConfig.cwd;
        const agentDir = trimToUndefined(input.providerOptions?.omp?.agentDir);
        const requestedModelSlug =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined;
        const requestedThinkingLevel =
          input.modelSelection?.provider === PROVIDER
            ? toOmpThinkingLevel(input.modelSelection.options?.thinkingLevel)
            : undefined;

        const lease = acquireAgentGatewaySessionLease(
          agentGatewayCredentials,
          input.threadId,
          PROVIDER,
        );

        const startParams: OmpSidecarStartSessionParams = {
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          cwd,
          ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
          ...(input.lifecycleGeneration !== undefined
            ? { lifecycleGeneration: input.lifecycleGeneration }
            : {}),
          ...(requestedModelSlug !== undefined ? { model: requestedModelSlug } : {}),
          ...(requestedThinkingLevel !== undefined
            ? { thinkingLevel: requestedThinkingLevel }
            : {}),
          ...(agentDir !== undefined ? { agentDir } : {}),
          ...(lease
            ? {
                gateway: {
                  url: lease.connection.url,
                  bearerToken: lease.connection.bearerToken,
                },
              }
            : {}),
        };

        const context: OmpSessionContext = {
          threadId: input.threadId,
          lifecycleGeneration: input.lifecycleGeneration,
          startParams,
          session: {} as ProviderSession,
          activeTurnId: undefined,
          stopped: false,
          gatewayControlAvailable: lease !== undefined,
          gatewaySessionLease: lease,
          lastResumedGeneration: 0,
        };

        const session = yield* releaseAgentGatewaySessionLeaseOnInterrupt(
          lease,
          sidecarRequest("session/start", startParams, input.threadId).pipe(
            Effect.mapError((error) =>
              isProviderAdapterError(error)
                ? error
                : new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/start",
                    detail: toMessage(error, "Failed to start OMP session."),
                    cause: error,
                  }),
            ),
          ),
        );

        context.session = session;
        context.lastResumedGeneration = sidecarState.restartGeneration;
        sessions.set(input.threadId, context);

        return session;
      });

    const ensureSessionResumed = (context: OmpSessionContext) =>
      Effect.gen(function* () {
        if (context.lastResumedGeneration === sidecarState.restartGeneration) return;
        const session = yield* resumeSession(context);
        context.session = session;
      });

    const sendTurn: OmpAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        yield* ensureSidecar;

        const contextOrError = requireSession(input.threadId);
        if (
          contextOrError instanceof ProviderAdapterSessionNotFoundError ||
          contextOrError instanceof ProviderAdapterSessionClosedError
        ) {
          return yield* Effect.fail(contextOrError);
        }
        const context = contextOrError;

        if (context.activeTurnId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "An OMP turn is already active for this thread.",
          });
        }
        yield* ensureSessionResumed(context);

        const text = buildPromptText(input);
        const attachmentPaths = buildAttachmentPaths(input.attachments);
        const harnessPolicy = takeSynaraHarnessPolicyForProviderSession(context, {
          provider: PROVIDER,
          scopedGatewayConnectionAvailable: context.gatewayControlAvailable,
        });

        const result = yield* sidecarRequest(
          "turn/send",
          {
            threadId: input.threadId,
            input: text,
            attachmentPaths,
            ...(harnessPolicy ? { harnessPolicy } : {}),
          },
          input.threadId,
        ).pipe(
          Effect.mapError((error) =>
            isProviderAdapterError(error)
              ? error
              : new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "turn/send",
                  detail: toMessage(error, "Failed to send OMP turn."),
                  cause: error,
                }),
          ),
        );

        const turnId = TurnId.makeUnsafe(result.turnId);
        context.activeTurnId = turnId;
        context.session = {
          ...context.session,
          activeTurnId: turnId,
          status: "running",
          updatedAt: new Date().toISOString(),
        };

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: result.resumeCursor,
        } satisfies ProviderTurnStartResult;
      });

    const steerTurn: NonNullable<OmpAdapterShape["steerTurn"]> = (input) =>
      Effect.gen(function* () {
        yield* ensureSidecar;

        const contextOrError = requireSession(input.threadId);
        if (
          contextOrError instanceof ProviderAdapterSessionNotFoundError ||
          contextOrError instanceof ProviderAdapterSessionClosedError
        ) {
          return yield* Effect.fail(contextOrError);
        }
        const context = contextOrError;

        yield* ensureSessionResumed(context);

        const text = buildPromptText(input);
        const attachmentPaths = buildAttachmentPaths(input.attachments);
        const harnessPolicy = takeSynaraHarnessPolicyForProviderSession(context, {
          provider: PROVIDER,
          scopedGatewayConnectionAvailable: context.gatewayControlAvailable,
        });

        const result = yield* sidecarRequest(
          "turn/steer",
          {
            threadId: input.threadId,
            input: text,
            attachmentPaths,
            ...(harnessPolicy ? { harnessPolicy } : {}),
          },
          input.threadId,
        ).pipe(
          Effect.mapError((error) =>
            isProviderAdapterError(error)
              ? error
              : new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "turn/steer",
                  detail: toMessage(error, "Failed to steer OMP turn."),
                  cause: error,
                }),
          ),
        );

        const turnId = TurnId.makeUnsafe(result.turnId);
        if (!context.activeTurnId) {
          context.activeTurnId = turnId;
          context.session = {
            ...context.session,
            activeTurnId: turnId,
            status: "running",
            updatedAt: new Date().toISOString(),
          };
        }

        return {
          threadId: input.threadId,
          turnId: context.activeTurnId,
          resumeCursor: result.resumeCursor,
        } satisfies ProviderTurnStartResult;
      });

    const interruptTurn: OmpAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        yield* ensureSidecar;
        const contextOrError = requireSession(threadId);
        if (
          contextOrError instanceof ProviderAdapterSessionNotFoundError ||
          contextOrError instanceof ProviderAdapterSessionClosedError
        ) {
          return yield* Effect.fail(contextOrError);
        }
        yield* sidecarRequest("turn/interrupt", { threadId }, threadId).pipe(
          Effect.mapError((error) =>
            isProviderAdapterError(error)
              ? error
              : new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "turn/interrupt",
                  detail: toMessage(error, "Failed to interrupt OMP turn."),
                  cause: error,
                }),
          ),
        );
      }).pipe(Effect.asVoid);

    const respondUnsupported = (threadId: ThreadId, method: string) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: `OMP does not expose Synara approval/user-input requests for thread ${threadId}.`,
        }),
      );

    const respondToUserInput: OmpAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        yield* ensureSidecar;
        const contextOrError = requireSession(threadId);
        if (
          contextOrError instanceof ProviderAdapterSessionNotFoundError ||
          contextOrError instanceof ProviderAdapterSessionClosedError
        ) {
          return yield* Effect.fail(contextOrError);
        }
        yield* sidecarRequest(
          "user-input/respond",
          {
            threadId,
            requestId,
            answers,
          },
          threadId,
        ).pipe(
          Effect.mapError((error) =>
            isProviderAdapterError(error)
              ? error
              : new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "user-input/respond",
                  detail: toMessage(error, "Failed to respond to OMP user input."),
                  cause: error,
                }),
          ),
        );
      });

    const stopSession: OmpAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (!context) return;
        if (sidecarState.hello) {
          yield* sidecarRequest("session/stop", { threadId }, threadId).pipe(Effect.ignore);
        }
        context.gatewaySessionLease?.release();
        context.stopped = true;
        context.activeTurnId = undefined;
        context.session = {
          ...context.session,
          status: "closed",
          activeTurnId: undefined,
          updatedAt: new Date().toISOString(),
        };
        sessions.delete(threadId);
      });

    const stopTask: NonNullable<OmpAdapterShape["stopTask"]> = (threadId, taskId) =>
      Effect.gen(function* () {
        yield* ensureSidecar;
        const contextOrError = requireSession(threadId);
        if (
          contextOrError instanceof ProviderAdapterSessionNotFoundError ||
          contextOrError instanceof ProviderAdapterSessionClosedError
        ) {
          return yield* Effect.fail(contextOrError);
        }
        yield* sidecarRequest("task/stop", { threadId, taskId }, threadId).pipe(
          Effect.mapError((error) =>
            isProviderAdapterError(error)
              ? error
              : new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "task/stop",
                  detail: toMessage(error, "Failed to stop OMP task."),
                  cause: error,
                }),
          ),
        );
      });

    const listSessions: OmpAdapterShape["listSessions"] = () =>
      Effect.gen(function* () {
        if (sidecarState.hello) {
          const result = yield* sidecarRequest("session/list", {}, undefined).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          if (result !== undefined) return result;
        }
        return Array.from(sessions.values()).map((context) => context.session);
      });

    const hasSession: OmpAdapterShape["hasSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (!context || context.stopped) return false;
        if (!sidecarState.hello) return true;
        return yield* sidecarRequest("session/has", { threadId }, threadId).pipe(
          Effect.orElseSucceed(() => false),
        );
      });

    const readThread: OmpAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        yield* ensureSidecar;
        const contextOrError = requireSession(threadId);
        if (
          contextOrError instanceof ProviderAdapterSessionNotFoundError ||
          contextOrError instanceof ProviderAdapterSessionClosedError
        ) {
          return yield* Effect.fail(contextOrError);
        }
        return yield* sidecarRequest("thread/read", { threadId }, threadId).pipe(
          Effect.mapError((error) =>
            isProviderAdapterError(error)
              ? error
              : new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "thread/read",
                  detail: toMessage(error, "Failed to read OMP thread."),
                  cause: error,
                }),
          ),
          Effect.map(toProviderThreadSnapshot),
        );
      });

    const rollbackThread: OmpAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* ensureSidecar;
        const contextOrError = requireSession(threadId);
        if (
          contextOrError instanceof ProviderAdapterSessionNotFoundError ||
          contextOrError instanceof ProviderAdapterSessionClosedError
        ) {
          return yield* Effect.fail(contextOrError);
        }
        const result = yield* sidecarRequest(
          "thread/rollback",
          { threadId, numTurns },
          threadId,
        ).pipe(
          Effect.mapError((error) =>
            isProviderAdapterError(error)
              ? error
              : new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "thread/rollback",
                  detail: toMessage(error, "Failed to roll back OMP thread."),
                  cause: error,
                }),
          ),
        );
        return toProviderThreadSnapshot(result);
      });

    const compactThread: NonNullable<OmpAdapterShape["compactThread"]> = (threadId) =>
      Effect.gen(function* () {
        yield* ensureSidecar;
        const contextOrError = requireSession(threadId);
        if (
          contextOrError instanceof ProviderAdapterSessionNotFoundError ||
          contextOrError instanceof ProviderAdapterSessionClosedError
        ) {
          return yield* Effect.fail(contextOrError);
        }
        yield* sidecarRequest("thread/compact", { threadId }, threadId).pipe(
          Effect.mapError((error) =>
            isProviderAdapterError(error)
              ? error
              : new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "thread/compact",
                  detail: toMessage(error, "Failed to compact OMP thread."),
                  cause: error,
                }),
          ),
          Effect.asVoid,
        );
      });

    const listModels: NonNullable<OmpAdapterShape["listModels"]> = (input) =>
      Effect.gen(function* () {
        yield* ensureSidecar;
        return yield* sidecarRequest(
          "model/list",
          { ...(input.agentDir !== undefined ? { agentDir: input.agentDir } : {}), refresh: true },
          undefined,
        ).pipe(
          Effect.mapError((error) =>
            isProviderAdapterError(error)
              ? error
              : new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "model/list",
                  detail: toMessage(error, "Failed to list OMP models."),
                  cause: error,
                }),
          ),
        );
      });

    const listSkills: NonNullable<OmpAdapterShape["listSkills"]> = (input) =>
      Effect.gen(function* () {
        yield* ensureSidecar;
        return yield* sidecarRequest(
          "skill/list",
          {
            cwd: input.cwd,
            ...(input.agentDir !== undefined ? { agentDir: input.agentDir } : {}),
          },
          undefined,
        ).pipe(
          Effect.mapError((error) =>
            isProviderAdapterError(error)
              ? error
              : new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "skill/list",
                  detail: toMessage(error, "Failed to list OMP skills."),
                  cause: error,
                }),
          ),
        );
      });

    const listCommands: NonNullable<OmpAdapterShape["listCommands"]> = (input) =>
      Effect.gen(function* () {
        yield* ensureSidecar;
        return yield* sidecarRequest(
          "command/list",
          { cwd: input.cwd, ...(input.threadId !== undefined ? { threadId: input.threadId } : {}) },
          undefined,
        ).pipe(
          Effect.mapError((error) =>
            isProviderAdapterError(error)
              ? error
              : new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "command/list",
                  detail: toMessage(error, "Failed to list OMP commands."),
                  cause: error,
                }),
          ),
        );
      });

    const getComposerCapabilities: NonNullable<OmpAdapterShape["getComposerCapabilities"]> = () =>
      Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsThreadCompaction: true,
        supportsThreadImport: false,
      } satisfies ProviderComposerCapabilities);

    const stopAll: OmpAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        if (sidecarState.hello) {
          yield* sidecarRequest("session/stop-all", {}, undefined).pipe(Effect.ignore);
        }
        for (const context of sessions.values()) {
          context.gatewaySessionLease?.release();
        }
        sessions.clear();
      });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        sidecarState.disposing = true;
        sidecarState.unavailable = true;
        if (sidecarState.pendingRestart) {
          clearTimeout(sidecarState.pendingRestart);
          sidecarState.pendingRestart = undefined;
        }
        if (sidecarState.process) {
          sidecarState.process.kill();
          sidecarState.process = undefined;
          sidecarState.hello = false;
        }
        for (const context of sessions.values()) {
          context.gatewaySessionLease?.release();
        }
        sessions.clear();
        yield* runtimeEventIngress.stop;
        if (ownsNativeEventLogger && nativeEventLogger) {
          yield* nativeEventLogger.close().pipe(Effect.ignore);
        }
        yield* Queue.shutdown(runtimeEventQueue);
      }).pipe(Effect.orDie),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsTurnSteering: true,
      },
      startSession,
      sendTurn,
      steerTurn,
      interruptTurn,
      respondToRequest: (threadId) => respondUnsupported(threadId, "request/respond"),
      respondToUserInput,
      stopSession,
      stopTask,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      compactThread,
      stopAll,
      listModels,
      listSkills,
      listCommands,
      getComposerCapabilities,
      get streamEvents() {
        return Stream.fromQueue(runtimeEventQueue);
      },
    } satisfies OmpAdapterShape;
  });

export const OmpAdapterLive = Layer.effect(OmpAdapter, makeOmpAdapter());

export function makeOmpAdapterLive(options?: OmpAdapterLiveOptions) {
  return Layer.effect(OmpAdapter, makeOmpAdapter(options));
}
