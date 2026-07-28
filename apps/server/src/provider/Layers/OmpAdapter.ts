/**
 * OmpAdapter - OMP (oh-my-pi) direct SDK implementation of the generic provider
 * adapter contract (M4 phase 2 walking skeleton).
 *
 * Scope: session lifecycle, streaming text turns, model listing. Tool items,
 * turn-failure classification (ompTurnFailure.ts), extension UI bridge, and the
 * gateway MCP injection arrive in later phases (see docs/plans/omp-integration.html).
 *
 * Key semantic difference from pi: OMP has no `agent_settled` event. `agent_end`
 * carries `isTerminal` — a turn is complete only when `isTerminal !== false`;
 * `isTerminal === false` means an async delivery will resume the session with a
 * self-initiated follow-up turn (verified in playground/omp-spike).
 *
 * @module OmpAdapter
 */
import crypto from "node:crypto";

import type * as OmpCodingAgent from "@oh-my-pi/pi-coding-agent";
import type {
  AgentSession as OmpAgentSession,
  AgentSessionEvent,
  ModelRegistry,
  SessionManager,
  SessionStats,
  ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import {
  ApprovalRequestId,
  type ChatAttachment,
  EventId,
  ProviderItemId,
  type ProviderComposerCapabilities,
  type ProviderListCommandsResult,
  type ProviderListModelsResult,
  type ProviderListSkillsResult,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
} from "@synara/contracts";
import { Effect, Layer, Option, Queue, Stream } from "effect";

import { takeSynaraHarnessPolicyForProviderSession } from "../../agentGateway/harnessPolicy.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import {
  acquireAgentGatewaySessionLease,
  releaseAgentGatewaySessionLeaseOnInterrupt,
  type AgentGatewaySessionLease,
} from "../../agentGateway/sessionLease.ts";
import { ServerConfig } from "../../config.ts";
import { lazyModule } from "../../lazyModule.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { OmpAdapter, type OmpAdapterShape } from "../Services/OmpAdapter.ts";
import {
  PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
  type ProviderThreadSnapshot,
} from "../Services/ProviderAdapter.ts";
import {
  type AgentToolItemType,
  toolDetailText,
  toolItemType,
  toolLifecycleData,
  toolTitle,
} from "../agentToolProjection.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { makeBoundedCallbackIngress } from "../boundedCallbackIngress.ts";
import { buildOmpAgentGatewayCustomTools } from "../ompGatewayTools.ts";
import { classifyOmpTurnFailure } from "../ompTurnFailure.ts";
import {
  makeOmpExtensionUiContext,
  type OmpExtensionUiContext,
  type OmpUserInputRequest,
  type OmpUserInputOutcome,
} from "../ompExtensionUiContext.ts";
import {
  compactProviderRuntimeEventForIngress,
  isTerminalProviderRuntimeEvent,
  PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES,
  PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE,
  providerRuntimeEventBytes,
} from "../providerRuntimeEventIngress.ts";
import { makeRuntimeTaskListItem } from "../runtimeTaskList.ts";
import { clampUsagePercent, nonNegativeFiniteNumber, positiveFiniteNumber } from "../tokenUsage.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "omp" as const;
/**
 * OMP thinking levels are the pi-catalog `Effort` const-enum members plus
 * "off"/"inherit"; at runtime every member is exactly its lowercase name
 * (pi-catalog/src/effort.ts), so the checked cast below re-tags safely without
 * a value import that would defeat the SDK lazy-load. "max" and "inherit" stay
 * unadvertised until the contracts widen beyond pi's six levels.
 */
const OMP_THINKING_LEVEL_NAMES = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type OmpThinkingLevelName = (typeof OMP_THINKING_LEVEL_NAMES)[number];
const OMP_THINKING_OPTIONS: ReadonlyArray<{
  readonly value: OmpThinkingLevelName;
  readonly label: string;
  readonly description: string;
}> = [
  { value: "off", label: "Off", description: "No extra reasoning" },
  { value: "minimal", label: "Minimal", description: "Light reasoning" },
  { value: "low", label: "Low", description: "Faster reasoning" },
  { value: "medium", label: "Medium", description: "Balanced reasoning" },
  { value: "high", label: "High", description: "Deeper reasoning" },
  { value: "xhigh", label: "Extra High", description: "Maximum reasoning" },
];

function toOmpThinkingLevel(value: string | null | undefined): ThinkingLevel | undefined {
  return value && (OMP_THINKING_LEVEL_NAMES as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : undefined;
}

/**
 * A turn with no session activity for this long is treated as wedged. OMP has
 * no `agent_settled`: `agent_end.isTerminal` is the only "the run is really
 * over" signal. If it never arrives, `activeTurnId` would stay set and every
 * later prompt would be rejected with "a turn is already active", so the turn
 * is failed explicitly instead. Generous enough for xhigh reasoning and long
 * tool calls; engine-owned async work re-arms it (see `armTurnWatchdog`).
 */
const OMP_TURN_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

interface OmpTrackedToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly itemId: RuntimeItemId;
  readonly itemType: AgentToolItemType;
}

// The reason separates a context-window overflow from a routine threshold pass;
// the action names which compaction strategy the engine picked.
function ompCompactionTitle(
  reason: "threshold" | "overflow" | "idle" | "incomplete",
  action: "context-full" | "handoff" | "shake" | "snapcompact",
): string {
  const suffix = action === "context-full" ? "" : ` (${action})`;
  switch (reason) {
    case "overflow":
      return `Compacting context — context window exceeded${suffix}`;
    case "idle":
      return `Compacting context — idle${suffix}`;
    case "incomplete":
      return `Compacting context — resuming incomplete pass${suffix}`;
    default:
      return `Compacting context${suffix}`;
  }
}

type OmpCodingAgentModule = typeof OmpCodingAgent;

// Loads the OMP SDK only when the provider is actually used. The SDK pulls in
// native modules (@oh-my-pi/pi-natives brush shell, onnxruntime), so importing
// it during Synara startup would bloat the desktop backend before any OMP
// session exists.
const loadOmpCodingAgentModule: () => Promise<OmpCodingAgentModule> = lazyModule(
  () => import("@oh-my-pi/pi-coding-agent"),
);

interface OmpStoredTurn {
  readonly id: TurnId;
  readonly items: unknown[];
  leafId?: string | null;
}

/** Trailing streamed item that consecutive deltas of the same kind append into. */
interface OmpStreamDeltaItem {
  readonly type: "assistant_message" | "reasoning";
  delta: string;
}

interface OmpPendingUserInput {
  readonly resolve: (answers: ProviderUserInputAnswers) => void;
}

interface OmpSessionContext {
  harnessPolicyDelivered?: boolean;
  readonly lifecycleGeneration?: string;
  /** True once the thread-scoped Synara gateway MCP server is connected. */
  readonly gatewayControlAvailable: boolean;
  gatewaySessionLease?: AgentGatewaySessionLease;
  readonly agentSession: OmpAgentSession;
  readonly sessionManager: SessionManager;
  readonly modelRegistry: ModelRegistry;
  session: ProviderSession;
  turns: OmpStoredTurn[];
  activeTurnId: TurnId | undefined;
  /** Cached `turns` entry for `activeTurnId`, so per-delta recording skips a linear scan. */
  activeTurn: OmpStoredTurn | undefined;
  activeAssistantItemId: RuntimeItemId | undefined;
  activeReasoningItemId: RuntimeItemId | undefined;
  activeToolItems: Map<string, OmpTrackedToolCall>;
  /**
   * Set by `agent_end.isTerminal === false`: the engine promised to resume this
   * session with an async-result follow-up turn, so the Synara turn stays open
   * across the gap and the watchdog tolerates the silence.
   */
  pendingAsyncDelivery: boolean;
  turnWatchdog: ReturnType<typeof setTimeout> | undefined;
  turnActivityAt: number;
  stopped: boolean;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  unsubscribe: (() => void) | undefined;
  pendingUserInputs: Map<ApprovalRequestId, OmpPendingUserInput>;
}

export interface OmpAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Test seams. The watchdog window is a 10-minute timer and the SDK boots real
   * native modules, so turn-lifecycle behaviour is only provable with both
   * injected (mirrors PiAdapterLiveOptions' spawn/teardown seams).
   */
  readonly loadSdk?: () => Promise<OmpCodingAgentModule>;
  readonly turnInactivityTimeoutMs?: number;
}

function makeOmpRuntimeEventBase(
  context: {
    readonly lifecycleGeneration?: string;
    readonly session: Pick<ProviderSession, "threadId">;
    readonly activeTurnId: TurnId | undefined;
  },
  options?: { readonly includeTurnId?: boolean },
) {
  return {
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
  };
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return fallback;
}

function trimToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function runtimeErrorDetail(cause: unknown): unknown {
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
      ...(cause.stack ? { stack: cause.stack } : {}),
    };
  }
  return cause;
}

function parseModelReference(
  modelId: string | null | undefined,
): { readonly provider: string; readonly id: string } | undefined {
  const trimmed = trimToUndefined(modelId);
  if (!trimmed || !trimmed.includes("/")) {
    return undefined;
  }
  const [provider, ...rest] = trimmed.split("/");
  const id = rest.join("/");
  return provider && id ? { provider, id } : undefined;
}

function findModelInRegistry(
  registry: ModelRegistry,
  modelId: string | null | undefined,
): Model<Api> | undefined {
  const parsed = parseModelReference(modelId);
  if (parsed) {
    return registry.find(parsed.provider, parsed.id);
  }
  const trimmed = trimToUndefined(modelId);
  if (!trimmed) return undefined;
  return registry.getAll().find((model) => model.id === trimmed);
}

// Mirrors the SDK's own clamping so model discovery does not advertise levels
// the engine would ignore (same policy as getPiSupportedThinkingOptions).
function getOmpSupportedThinkingOptions(
  model: Pick<Model<Api>, "reasoning">,
): ReadonlyArray<(typeof OMP_THINKING_OPTIONS)[number]> {
  return model.reasoning ? OMP_THINKING_OPTIONS : [];
}

function extractResumeSessionFile(resumeCursor: unknown): string | undefined {
  if (typeof resumeCursor === "string" && resumeCursor.trim().length > 0) {
    return resumeCursor;
  }
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const record = resumeCursor as Record<string, unknown>;
  for (const key of ["sessionFile", "sessionFilePath", "nativeHandle", "path"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function getSessionFile(session: OmpAgentSession): string | undefined {
  return session.sessionFile ?? undefined;
}

function makeSessionSnapshot(context: OmpSessionContext): ProviderSession {
  const resumeCursor = getSessionFile(context.agentSession);
  const model = context.agentSession.model;
  return {
    provider: PROVIDER,
    status: context.stopped ? "closed" : context.activeTurnId ? "running" : "ready",
    runtimeMode: context.session.runtimeMode,
    threadId: context.session.threadId,
    createdAt: context.session.createdAt,
    updatedAt: new Date().toISOString(),
    ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
    ...(model ? { model: `${model.provider}/${model.id}` } : {}),
    ...(resumeCursor ? { resumeCursor } : {}),
    ...(context.activeTurnId ? { activeTurnId: context.activeTurnId } : {}),
    ...(context.session.lastError ? { lastError: context.session.lastError } : {}),
  };
}

function normalizeTokenUsage(
  stats: SessionStats,
  contextWindow?: number | null,
): ThreadTokenUsageSnapshot | undefined {
  const inputTokens = stats.tokens.input;
  const cachedInputTokens = stats.tokens.cacheRead;
  const outputTokens = stats.tokens.output;
  const totalProcessedTokens = stats.tokens.total;
  const contextUsage = stats.contextUsage;
  const contextUsageWindowValue = positiveFiniteNumber(contextUsage?.contextWindow);
  const contextUsageWindow =
    contextUsageWindowValue !== undefined ? Math.floor(contextUsageWindowValue) : undefined;
  const fallbackWindowValue = positiveFiniteNumber(contextWindow);
  const fallbackWindow =
    fallbackWindowValue !== undefined ? Math.floor(fallbackWindowValue) : undefined;
  const maxTokens = contextUsageWindow ?? fallbackWindow;
  const contextUsageTokenValue = nonNegativeFiniteNumber(contextUsage?.tokens);
  const contextUsageTokens =
    contextUsageTokenValue !== undefined ? Math.round(contextUsageTokenValue) : undefined;
  const usedPercent = clampUsagePercent(contextUsage?.percent);
  const usedTokensFromPercent =
    contextUsageTokens === undefined && usedPercent !== undefined && maxTokens !== undefined
      ? Math.round((usedPercent / 100) * maxTokens)
      : undefined;
  const usedTokens =
    contextUsageTokens ??
    usedTokensFromPercent ??
    (contextUsage
      ? 0
      : maxTokens !== undefined
        ? Math.min(totalProcessedTokens, maxTokens)
        : totalProcessedTokens);
  if (
    usedTokens <= 0 &&
    inputTokens <= 0 &&
    cachedInputTokens <= 0 &&
    outputTokens <= 0 &&
    maxTokens === undefined &&
    usedPercent === undefined
  ) {
    return undefined;
  }
  return {
    usedTokens,
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
    inputTokens,
    cachedInputTokens,
    outputTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    lastUsedTokens: usedTokens,
    lastInputTokens: inputTokens,
    lastCachedInputTokens: cachedInputTokens,
    lastOutputTokens: outputTokens,
  };
}

const makeOmpAdapter = (options?: OmpAdapterLiveOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const agentGatewayCredentials = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayCredentials),
    );
    const loadSdkModule = options?.loadSdk ?? loadOmpCodingAgentModule;
    const turnInactivityTimeoutMs =
      options?.turnInactivityTimeoutMs ?? OMP_TURN_INACTIVITY_TIMEOUT_MS;
    const runtimeEventQueue = yield* Queue.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );
    const sessions = new Map<ThreadId, OmpSessionContext>();
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

    const loadOmpSdk = (method: string) =>
      Effect.tryPromise({
        try: () => loadSdkModule(),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: toMessage(cause, "Failed to load OMP SDK."),
            cause,
          }),
      });

    const makeEventBase = makeOmpRuntimeEventBase;

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) => {
      runtimeEventIngress.offer(compactProviderRuntimeEventForIngress(event));
    };

    const offerRuntimeError = (
      context: OmpSessionContext,
      input: {
        readonly message: string;
        readonly cause?: unknown;
        readonly method: string;
        readonly messageType?: string;
      },
    ) => {
      offerRuntimeEvent({
        ...makeEventBase(context, { includeTurnId: false }),
        type: "runtime.error",
        payload: {
          message: input.message,
          class: "provider_error",
          ...(input.cause !== undefined ? { detail: runtimeErrorDetail(input.cause) } : {}),
        },
        raw: {
          source: "omp.sdk.event",
          method: input.method,
          ...(input.messageType ? { messageType: input.messageType } : {}),
          payload: input.cause ?? { message: input.message },
        },
      } satisfies ProviderRuntimeEvent);
    };

    const resolveOmpExtensionUserInput = (
      context: OmpSessionContext,
      requestId: ApprovalRequestId,
      answers: ProviderUserInputAnswers,
    ) => {
      const pending = context.pendingUserInputs.get(requestId);
      if (!pending) return false;
      pending.resolve(answers);
      return true;
    };

    /**
     * Opens a Synara dialog for an engine-side question and parks the engine's
     * promise until `respondToUserInput` (or an abort/timeout) settles it. The
     * engine is blocking a tool call on this, so every exit path must resolve —
     * an unresolved request would hang the turn until the watchdog fires.
     */
    const requestOmpExtensionUserInput = (
      context: OmpSessionContext,
      input: OmpUserInputRequest,
    ): Promise<OmpUserInputOutcome> => {
      if (context.stopped || input.opts?.signal?.aborted) {
        return Promise.resolve({ answers: {}, timedOut: false });
      }
      const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
      const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
      const { promise, resolve } = Promise.withResolvers<OmpUserInputOutcome>();
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let abort: () => void = () => undefined;
      const cleanup = () => {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
        input.opts?.signal?.removeEventListener("abort", abort);
      };
      const finish = (answers: ProviderUserInputAnswers, timedOut = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        context.pendingUserInputs.delete(requestId);
        offerRuntimeEvent({
          ...makeEventBase(context),
          type: "user-input.resolved",
          requestId: runtimeRequestId,
          payload: { answers },
          raw: {
            source: "omp.sdk.event",
            method: `${input.method}/answered`,
            payload: { requestId, answers },
          },
        } satisfies ProviderRuntimeEvent);
        resolve({ answers, timedOut });
      };
      abort = () => finish({});

      context.pendingUserInputs.set(requestId, { resolve: finish });
      if (typeof input.opts?.timeout === "number" && input.opts.timeout > 0) {
        timeoutId = setTimeout(() => finish({}, true), input.opts.timeout);
        input.opts.onTimeoutStart?.();
      }
      input.opts?.signal?.addEventListener("abort", abort, { once: true });

      offerRuntimeEvent({
        ...makeEventBase(context),
        type: "user-input.requested",
        requestId: runtimeRequestId,
        payload: { questions: input.questions },
        raw: {
          source: "omp.sdk.event",
          method: input.method,
          payload: input.rawPayload ?? { requestId, questions: input.questions },
        },
      } satisfies ProviderRuntimeEvent);
      return promise;
    };

    const makeUiContextFor = (context: OmpSessionContext): OmpExtensionUiContext => {
      const unsupportedWarnings = new Set<string>();
      return makeOmpExtensionUiContext({
        requestUserInput: (request) => requestOmpExtensionUserInput(context, request),
        warnUnsupported: (method) => {
          // One warning per method per session: extensions call these in loops.
          if (unsupportedWarnings.has(method)) return;
          unsupportedWarnings.add(method);
          offerRuntimeEvent({
            ...makeEventBase(context, { includeTurnId: false }),
            type: "runtime.warning",
            payload: {
              message: `OMP extension UI API '${method}' is not supported in Synara yet.`,
              detail: { method },
            },
            raw: {
              source: "omp.sdk.event",
              method: "extension/ui-unsupported",
              payload: { method },
            },
          } satisfies ProviderRuntimeEvent);
        },
        emitProgress: (summary) => {
          const normalized = trimToUndefined(summary);
          if (!normalized) return;
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "tool.progress",
            payload: { toolName: "OMP extension", summary: normalized },
            raw: {
              source: "omp.sdk.event",
              method: "extension/ui-progress",
              payload: { summary: normalized },
            },
          } satisfies ProviderRuntimeEvent);
        },
        notify: (message, level) => {
          if (level === "error") {
            offerRuntimeError(context, { message, method: "extension/ui/notify" });
            return;
          }
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "runtime.warning",
            payload: { message, detail: { level } },
            raw: {
              source: "omp.sdk.event",
              method: "extension/ui/notify",
              payload: { message, level },
            },
          } satisfies ProviderRuntimeEvent);
        },
      });
    };
    const requireSession = Effect.fn("OmpAdapter.requireSession")(function* (threadId: ThreadId) {
      const context = sessions.get(threadId);
      if (!context) {
        return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
      }
      if (context.stopped) {
        return yield* new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
      }
      return context;
    });

    const disposeSessionContext = async (context: OmpSessionContext) => {
      context.unsubscribe?.();
      context.unsubscribe = undefined;
      context.stopped = true;
      clearTurnWatchdog(context);
      // abort() cancels any in-flight turn and reaps every process the engine's
      // brush shell spawned (kill-on-drop, verified in the spike); dispose()
      // then releases session resources (timers, kernels, watchers).
      try {
        await context.agentSession.abort();
      } catch {
        // Aborting an idle session is a no-op failure; disposal below is what counts.
      }
      // The engine blocks tool calls on these promises; resolving them empty is
      // the documented cancel answer, and skipping it would hang disposal.
      for (const pending of Array.from(context.pendingUserInputs.values())) {
        pending.resolve({});
      }
      context.pendingUserInputs.clear();
      try {
        await context.agentSession.dispose({});
      } finally {
        context.gatewaySessionLease?.release();
        delete context.gatewaySessionLease;
      }
    };

    const activeTurnFor = (context: OmpSessionContext): OmpStoredTurn | undefined => {
      if (context.activeTurn && context.activeTurn.id === context.activeTurnId) {
        return context.activeTurn;
      }
      const turn = context.activeTurnId
        ? context.turns.find((candidate) => candidate.id === context.activeTurnId)
        : context.turns.at(-1);
      context.activeTurn = turn;
      return turn;
    };

    const recordItem = (context: OmpSessionContext, item: unknown) => {
      activeTurnFor(context)?.items.push(item);
    };

    /**
     * Deltas arrive one per streamed token. Appending into the trailing item of
     * the same kind keeps `turns` proportional to the response length instead of
     * allocating one object per token for the lifetime of the thread.
     */
    const recordStreamDelta = (
      context: OmpSessionContext,
      type: OmpStreamDeltaItem["type"],
      delta: string,
    ) => {
      const turn = activeTurnFor(context);
      if (!turn) return;
      const last = turn.items.at(-1) as OmpStreamDeltaItem | undefined;
      if (last && last.type === type && typeof last.delta === "string") {
        last.delta += delta;
        return;
      }
      turn.items.push({ type, delta } satisfies OmpStreamDeltaItem);
    };

    const clearTurnWatchdog = (context: OmpSessionContext) => {
      if (context.turnWatchdog !== undefined) {
        clearTimeout(context.turnWatchdog);
        context.turnWatchdog = undefined;
      }
    };

    /**
     * The engine owns async job lifecycles. While it still reports queued,
     * running, or undelivered work the silence between turns is expected, not a
     * wedge — the watchdog must not fail a turn that OMP is going to resume.
     */
    const hasPendingEngineWork = (context: OmpSessionContext): boolean => {
      const jobs = context.agentSession.asyncJobManager;
      if (!jobs) return false;
      return jobs.getRunningJobs().length > 0 || jobs.hasPendingDeliveries();
    };

    const resetActiveTurnState = (context: OmpSessionContext) => {
      clearTurnWatchdog(context);
      context.activeTurnId = undefined;
      context.activeTurn = undefined;
      context.activeAssistantItemId = undefined;
      context.activeReasoningItemId = undefined;
      context.activeToolItems.clear();
      context.pendingAsyncDelivery = false;
    };

    const failStalledTurn = (context: OmpSessionContext, idleMs: number) => {
      if (!context.activeTurnId) return;
      const message = `OMP produced no session activity for ${String(Math.round(idleMs / 60_000))} minutes and reported no pending async work; failing the turn so the thread accepts new prompts.`;
      const raw = {
        source: "omp.sdk.event",
        method: "turn/watchdog",
        payload: { idleMs },
      } satisfies ProviderRuntimeEvent["raw"];
      const completionBase = makeEventBase(context);
      offerRuntimeError(context, { message, method: "turn/watchdog" });
      closeActiveStreamItems(context, "failed", raw);
      resetActiveTurnState(context);
      context.session = makeSessionSnapshot(context);
      offerRuntimeEvent({
        ...completionBase,
        type: "turn.completed",
        payload: { state: "failed", stopReason: "error", errorMessage: message },
        raw,
      } satisfies ProviderRuntimeEvent);
    };

    const armTurnWatchdog = (
      context: OmpSessionContext,
      delayMs: number = turnInactivityTimeoutMs,
    ) => {
      clearTurnWatchdog(context);
      if (!context.activeTurnId || context.stopped) return;
      const turnId = context.activeTurnId;
      const timer = setTimeout(() => {
        context.turnWatchdog = undefined;
        if (context.stopped || context.activeTurnId !== turnId) return;
        // Session events only stamp `turnActivityAt`; re-arm for the remaining
        // window so the hot path never churns a timer per streamed token.
        const idleMs = Date.now() - context.turnActivityAt;
        if (idleMs < turnInactivityTimeoutMs) {
          armTurnWatchdog(context, turnInactivityTimeoutMs - idleMs);
          return;
        }
        if (hasPendingEngineWork(context)) {
          armTurnWatchdog(context);
          return;
        }
        failStalledTurn(context, idleMs);
      }, delayMs);
      timer.unref?.();
      context.turnWatchdog = timer;
    };

    /**
     * OMP can start a turn Synara never asked for: when an async job finishes,
     * the job manager injects the result as a follow-up prompt. If that lands
     * after the previous turn already settled there is no open Synara turn to
     * attribute the events to, so mint one. Every later event — items and the
     * final `turn.completed` — is keyed off this id, which is what keeps the
     * ingress guard in provider/terminalTurnApplicability.ts from dropping the
     * follow-up as a foreign turn.
     */
    const ensureActiveTurn = (context: OmpSessionContext): TurnId => {
      const existing = context.activeTurnId;
      if (existing) return existing;
      const turnId = TurnId.makeUnsafe(crypto.randomUUID());
      context.activeTurnId = turnId;
      context.activeTurn = undefined;
      context.turns.push({ id: turnId, items: [] });
      context.session = makeSessionSnapshot(context);
      armTurnWatchdog(context);
      return turnId;
    };

    const closeActiveStreamItems = (
      context: OmpSessionContext,
      status: "completed" | "failed",
      raw: ProviderRuntimeEvent["raw"],
    ) => {
      if (context.activeAssistantItemId) {
        offerRuntimeEvent({
          ...makeEventBase(context),
          itemId: context.activeAssistantItemId,
          type: "item.completed",
          payload: { itemType: "assistant_message", status, title: "Assistant" },
          raw,
        } satisfies ProviderRuntimeEvent);
        context.activeAssistantItemId = undefined;
      }
      if (context.activeReasoningItemId) {
        offerRuntimeEvent({
          ...makeEventBase(context),
          itemId: context.activeReasoningItemId,
          type: "item.completed",
          payload: { itemType: "reasoning", status, title: "Reasoning" },
          raw,
        } satisfies ProviderRuntimeEvent);
        context.activeReasoningItemId = undefined;
      }
    };

    const completePromptRejection = (
      context: OmpSessionContext,
      turnId: TurnId,
      cause: unknown,
    ) => {
      if (context.activeTurnId !== turnId) {
        return;
      }
      const message = toMessage(cause, "OMP turn failed.");
      const completionBase = makeEventBase(context);
      offerRuntimeError(context, { message, method: "prompt", cause });
      resetActiveTurnState(context);
      context.session = makeSessionSnapshot(context);
      offerRuntimeEvent({
        ...completionBase,
        type: "turn.completed",
        payload: { state: "failed", stopReason: "error", errorMessage: message },
        raw: { source: "omp.sdk.event", method: "prompt", payload: cause },
      } satisfies ProviderRuntimeEvent);
    };

    const handleMessageUpdate = (
      context: OmpSessionContext,
      event: Extract<AgentSessionEvent, { type: "message_update" }>,
    ) => {
      if (event.message.role !== "assistant") return;
      const update = event.assistantMessageEvent;
      // Only the delta is diagnostic: echoing the accumulated message per token
      // would make raw payload size O(n^2) across a turn.
      const raw = {
        source: "omp.sdk.event",
        messageType: event.type,
        payload: update,
      } satisfies ProviderRuntimeEvent["raw"];
      if (update.type === "text_delta") {
        if (!context.activeAssistantItemId) {
          context.activeAssistantItemId = RuntimeItemId.makeUnsafe(
            `omp-assistant-${crypto.randomUUID()}`,
          );
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId: context.activeAssistantItemId,
            type: "item.started",
            payload: { itemType: "assistant_message", status: "inProgress", title: "Assistant" },
            raw,
          } satisfies ProviderRuntimeEvent);
        }
        recordStreamDelta(context, "assistant_message", update.delta);
        offerRuntimeEvent({
          ...makeEventBase(context),
          itemId: context.activeAssistantItemId,
          type: "content.delta",
          payload: {
            streamKind: "assistant_text",
            delta: update.delta,
            contentIndex: update.contentIndex,
          },
          raw,
        } satisfies ProviderRuntimeEvent);
        return;
      }
      if (update.type === "thinking_delta") {
        if (!context.activeReasoningItemId) {
          context.activeReasoningItemId = RuntimeItemId.makeUnsafe(
            `omp-reasoning-${crypto.randomUUID()}`,
          );
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId: context.activeReasoningItemId,
            type: "item.started",
            payload: { itemType: "reasoning", status: "inProgress", title: "Reasoning" },
            raw,
          } satisfies ProviderRuntimeEvent);
        }
        recordStreamDelta(context, "reasoning", update.delta);
        offerRuntimeEvent({
          ...makeEventBase(context),
          itemId: context.activeReasoningItemId,
          type: "content.delta",
          payload: {
            streamKind: "reasoning_text",
            delta: update.delta,
            contentIndex: update.contentIndex,
          },
          raw,
        } satisfies ProviderRuntimeEvent);
      }
    };

    const handleSessionEvent = (context: OmpSessionContext, event: AgentSessionEvent) => {
      // Cheap liveness stamp read by the turn watchdog; avoids re-arming a timer
      // for every streamed token.
      context.turnActivityAt = Date.now();
      switch (event.type) {
        case "agent_start":
          // A run starting is the moment an async-result follow-up becomes a
          // real turn again; adopt or mint one before anything is attributed.
          context.pendingAsyncDelivery = false;
          ensureActiveTurn(context);
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "thread.state.changed",
            payload: { state: "active" },
            raw: { source: "omp.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
          return;
        case "turn_start":
          ensureActiveTurn(context);
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "turn.started",
            payload: {
              ...(context.agentSession.model
                ? {
                    model: `${context.agentSession.model.provider}/${context.agentSession.model.id}`,
                  }
                : {}),
              effort: context.agentSession.thinkingLevel,
            },
            raw: { source: "omp.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
          return;
        case "message_update":
          handleMessageUpdate(context, event);
          return;
        case "turn_end":
          // One prompt can span several LLM turns (tool loops). Closing the
          // stream items here segments one message item per engine turn.
          closeActiveStreamItems(context, "completed", {
            source: "omp.sdk.event",
            messageType: event.type,
            payload: { type: event.type },
          });
          return;
        case "tool_execution_start": {
          const itemId = RuntimeItemId.makeUnsafe(`omp-tool-${event.toolCallId}`);
          const tracked: OmpTrackedToolCall = {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            itemId,
            itemType: toolItemType(event.toolName),
          };
          context.activeToolItems.set(event.toolCallId, tracked);
          recordItem(context, {
            type: "tool_call",
            status: "started",
            toolName: event.toolName,
            args: event.args,
          });
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId,
            providerRefs: { providerItemId: ProviderItemId.makeUnsafe(event.toolCallId) },
            type: "item.started",
            payload: {
              itemType: tracked.itemType,
              status: "inProgress",
              title: toolTitle(event.toolName, event.args),
              data: toolLifecycleData({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: event.args,
              }),
            },
            raw: { source: "omp.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
          return;
        }
        case "tool_execution_update": {
          const tracked = context.activeToolItems.get(event.toolCallId);
          if (!tracked) return;
          const detail = toolDetailText(event.partialResult);
          recordItem(context, {
            type: "tool_call",
            status: "updated",
            toolName: event.toolName,
            output: detail,
          });
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId: tracked.itemId,
            providerRefs: { providerItemId: ProviderItemId.makeUnsafe(event.toolCallId) },
            type: "item.updated",
            payload: {
              itemType: tracked.itemType,
              status: "inProgress",
              title: toolTitle(event.toolName, tracked.args),
              ...(detail ? { detail } : {}),
              data: toolLifecycleData({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: tracked.args,
                partialResult: event.partialResult,
              }),
            },
            raw: { source: "omp.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
          return;
        }
        case "tool_execution_end": {
          // `tool_execution_end` carries no args, so the tracked entry is the
          // only source left for the title and item type.
          const tracked = context.activeToolItems.get(event.toolCallId) ?? {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: undefined,
            itemId: RuntimeItemId.makeUnsafe(`omp-tool-${event.toolCallId}`),
            itemType: toolItemType(event.toolName),
          };
          context.activeToolItems.delete(event.toolCallId);
          const detail = toolDetailText(event.result);
          recordItem(context, {
            type: "tool_call",
            status: event.isError ? "failed" : "completed",
            toolName: event.toolName,
            output: detail,
            result: event.result,
          });
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId: tracked.itemId,
            providerRefs: { providerItemId: ProviderItemId.makeUnsafe(event.toolCallId) },
            type: "item.completed",
            payload: {
              itemType: tracked.itemType,
              status: event.isError ? "failed" : "completed",
              title: toolTitle(event.toolName, tracked.args),
              ...(detail ? { detail } : {}),
              data: toolLifecycleData({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: tracked.args,
                result: event.result,
                ...(event.isError !== undefined ? { isError: event.isError } : {}),
              }),
            },
            raw: { source: "omp.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
          return;
        }
        case "auto_compaction_start":
          // Activity projection keys compaction by eventId and deliberately
          // skips `item.started`, so each compaction event stands alone.
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId: RuntimeItemId.makeUnsafe(`omp-compaction-${crypto.randomUUID()}`),
            type: "item.updated",
            payload: {
              itemType: "context_compaction",
              status: "inProgress",
              title: ompCompactionTitle(event.reason, event.action),
            },
            raw: { source: "omp.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
          return;
        case "auto_compaction_end": {
          const itemId = RuntimeItemId.makeUnsafe(`omp-compaction-${crypto.randomUUID()}`);
          const detail = trimToUndefined(event.errorMessage);
          const raw = {
            source: "omp.sdk.event",
            messageType: event.type,
            payload: event,
          } satisfies ProviderRuntimeEvent["raw"];
          // A compaction that will be retried is not a terminal failure; keep it
          // in progress so the transcript does not report a dead compaction.
          if (event.willRetry) {
            offerRuntimeEvent({
              ...makeEventBase(context),
              itemId,
              type: "item.updated",
              payload: {
                itemType: "context_compaction",
                status: "inProgress",
                title: "Retrying context compaction",
                ...(detail ? { detail } : {}),
                data: event,
              },
              raw,
            } satisfies ProviderRuntimeEvent);
            return;
          }
          const failed = event.aborted || detail !== undefined;
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId,
            type: "item.completed",
            payload: {
              itemType: "context_compaction",
              status: failed ? "failed" : "completed",
              title: failed
                ? "Context compaction failed"
                : event.skipped
                  ? "Context compaction skipped"
                  : "Context compacted",
              ...(detail ? { detail } : {}),
              data: event,
            },
            raw,
          } satisfies ProviderRuntimeEvent);
          return;
        }
        case "auto_retry_start":
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "runtime.warning",
            payload: {
              message: `OMP is retrying (attempt ${String(event.attempt)}/${String(event.maxAttempts)}, waiting ${String(Math.max(1, Math.round(event.delayMs / 1_000)))}s): ${event.errorMessage}`,
              detail: {
                attempt: event.attempt,
                maxAttempts: event.maxAttempts,
                delayMs: event.delayMs,
              },
            },
            raw: { source: "omp.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
          return;
        case "auto_retry_end":
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "runtime.warning",
            payload: {
              message: event.success
                ? `OMP recovered after ${String(event.attempt)} retry attempt(s).`
                : `OMP gave up after ${String(event.attempt)} retry attempt(s): ${event.finalError ?? "unknown error"}`,
              detail: { success: event.success, attempt: event.attempt },
            },
            raw: { source: "omp.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
          return;
        case "retry_fallback_applied":
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "model.rerouted",
            payload: {
              fromModel: event.from,
              toModel: event.to,
              reason: `OMP retry fallback for role "${event.role}"`,
            },
            raw: { source: "omp.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
          return;
        case "retry_fallback_succeeded":
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "runtime.warning",
            payload: {
              message: `Fallback model ${event.model} succeeded for role "${event.role}".`,
              detail: { model: event.model, role: event.role },
            },
            raw: { source: "omp.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
          return;
        case "notice": {
          const message = trimToUndefined(event.message);
          if (!message) return;
          if (event.level === "error") {
            offerRuntimeError(context, {
              message,
              method: "session/notice",
              messageType: event.type,
            });
            return;
          }
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "runtime.warning",
            payload: {
              message,
              detail: { level: event.level, ...(event.source ? { source: event.source } : {}) },
            },
            raw: { source: "omp.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
          return;
        }
        case "thinking_level_changed":
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "thread.metadata.updated",
            payload: {
              metadata: {
                thinkingLevel: event.thinkingLevel ?? null,
                ...(event.configured !== undefined
                  ? { configuredThinkingLevel: event.configured }
                  : {}),
                ...(event.resolved !== undefined ? { resolvedThinkingLevel: event.resolved } : {}),
              },
            },
            raw: { source: "omp.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
          return;
        case "todo_reminder": {
          const tasks = event.todos.flatMap((todo) => {
            const item = makeRuntimeTaskListItem(todo.content, todo.status);
            return item ? [item] : [];
          });
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "turn.tasks.updated",
            payload: { tasks },
            raw: { source: "omp.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
          return;
        }
        case "todo_auto_clear":
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "turn.tasks.updated",
            payload: { tasks: [] },
            raw: { source: "omp.sdk.event", messageType: event.type, payload: event },
          } satisfies ProviderRuntimeEvent);
          return;
        case "agent_end": {
          const stats = context.agentSession.getSessionStats();
          const usage = normalizeTokenUsage(stats, context.agentSession.model?.contextWindow);
          context.lastKnownTokenUsage = usage;
          const raw = {
            source: "omp.sdk.event",
            messageType: event.type,
            payload: event,
          } satisfies ProviderRuntimeEvent["raw"];
          if (usage) {
            offerRuntimeEvent({
              ...makeEventBase(context),
              type: "thread.token-usage.updated",
              payload: { usage },
              raw,
            } satisfies ProviderRuntimeEvent);
          }
          // OMP has no `agent_settled`: `isTerminal === false` means an async
          // delivery will resume this session with a follow-up turn, so the
          // Synara turn stays open across the gap — same turn id on both sides
          // is what keeps the ingress from dropping the follow-up.
          if (event.isTerminal === false) {
            context.pendingAsyncDelivery = true;
            closeActiveStreamItems(context, "completed", raw);
            armTurnWatchdog(context);
            return;
          }
          const turnId = context.activeTurnId;
          if (!turnId) return;
          const errorMessage = trimToUndefined(context.agentSession.agent.state.error);
          const failure = errorMessage ? classifyOmpTurnFailure(errorMessage) : undefined;
          const turn = context.turns.find((candidate) => candidate.id === turnId);
          if (turn) turn.leafId = context.sessionManager.getLeafId();
          if (errorMessage && failure?.state === "failed") {
            offerRuntimeError(context, {
              message: errorMessage,
              method: "session/event",
              messageType: event.type,
            });
          }
          closeActiveStreamItems(context, errorMessage ? "failed" : "completed", raw);
          const completionBase = makeEventBase(context);
          resetActiveTurnState(context);
          context.session = makeSessionSnapshot(context);
          offerRuntimeEvent({
            ...completionBase,
            type: "turn.completed",
            payload:
              errorMessage && failure
                ? {
                    state: failure.state,
                    stopReason: failure.stopReason,
                    errorMessage,
                    usage: stats,
                  }
                : { state: "completed", stopReason: null, usage: stats },
            raw,
          } satisfies ProviderRuntimeEvent);
          return;
        }
        default:
          // `ttsr_triggered`, `irc_message` and `goal_updated` have no canonical
          // Synara surface yet (coverage map: "later"); ignoring them never
          // breaks the turn lifecycle.
          return;
      }
    };

    const startSession: OmpAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        const cwd = trimToUndefined(input.cwd) ?? serverConfig.cwd;
        const sdk = yield* loadOmpSdk("session/start");
        const agentDir = trimToUndefined(input.providerOptions?.omp?.agentDir);
        const requestedModelSlug =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined;
        const requestedThinkingLevel =
          input.modelSelection?.provider === PROVIDER
            ? toOmpThinkingLevel(input.modelSelection.options?.thinkingLevel)
            : undefined;
        // Thread-scoped gateway credentials, same lease discipline as PiAdapter;
        // OMP consumes them as an MCP server instead of injected custom tools so
        // the user's own MCP servers keep loading through the engine's manager.
        const agentGatewaySessionLease = acquireAgentGatewaySessionLease(
          agentGatewayCredentials,
          input.threadId,
          PROVIDER,
        );
        const agentGatewayConnection = agentGatewaySessionLease?.connection;
        const created = yield* Effect.tryPromise({
          try: async () => {
            const authStorage = await sdk.discoverAuthStorage(agentDir);
            const modelRegistry = new sdk.ModelRegistry(authStorage);
            const model = requestedModelSlug
              ? findModelInRegistry(modelRegistry, requestedModelSlug)
              : undefined;
            if (requestedModelSlug && !model) {
              throw new Error(
                `OMP model '${requestedModelSlug}' is not available. Pick a discovered model (provider/model slug).`,
              );
            }
            // `SessionManager.create` stamps a terminal breadcrumb that cannot
            // be suppressed (#resetToNewSession → #rememberBreadcrumb). Inside
            // Synara that crumb is inherited from whatever terminal launched
            // the server, so the user's own `omp` CLI would resume a Synara
            // thread's session. Minting the file explicitly avoids the crumb
            // and hands back a resume cursor before the first turn, so a crash
            // right after start is still resumable.
            const sessionFile =
              extractResumeSessionFile(input.resumeCursor) ??
              sdk.SessionManager.createEmptySessionFile(cwd);
            const sessionManager = await sdk.SessionManager.open(
              sessionFile,
              undefined,
              undefined,
              {
                // When the recorded cwd is gone the engine falls back to the
                // *process* project dir; pin the thread's workspace instead.
                initialCwd: cwd,
                suppressBreadcrumb: true,
              },
            );
            // The gateway rides in as native custom tools, not as a supplied
            // MCPManager: a caller-supplied manager only propagates to the
            // tool session for subagents to inherit — the engine registers MCP
            // tools in its own registry solely on its discovery path. Leaving
            // discovery to the engine also keeps the user's own MCP servers.
            let gatewayTools: ReadonlyArray<ToolDefinition> = [];
            let gatewayConnectError: string | undefined;
            if (agentGatewayConnection) {
              try {
                gatewayTools = await buildOmpAgentGatewayCustomTools({
                  connection: agentGatewayConnection,
                });
              } catch (cause) {
                gatewayConnectError = toMessage(cause, "Synara MCP catalog load failed.");
              }
            }
            const gatewayControlAvailable = gatewayTools.length > 0;
            const result = await sdk.createAgentSession({
              cwd,
              ...(agentDir ? { agentDir } : {}),
              authStorage,
              modelRegistry,
              sessionManager,
              ...(model ? { model } : {}),
              // Only override when the user picked a level; otherwise the
              // engine resolves it from its own settings/model roles.
              ...(requestedThinkingLevel ? { thinkingLevel: requestedThinkingLevel } : {}),
              // Synara IS the UI. The engine gates its interactive surface on
              // this flag — the native `ask` tool is only constructed when it is
              // true (tools/ask.ts) — and setToolUIContext below supplies the
              // context those surfaces render through.
              hasUI: true,
              // On. The engine's own `lsp.lazy` setting (default true) keeps
              // startup to discovery — language servers spawn on the first
              // `lsp` call, not per session — so the cost is bounded by the
              // user's setting rather than by a policy Synara invents. Off
              // would silently drop OMP's code-intelligence tool entirely.
              enableLsp: true,
              // Off. IRC registers the session on the shared agent hub; a
              // desktop host runs many threads at once and would flood the
              // user's roster with sessions they never addressed.
              enableIrc: false,
              // On. The engine discovers and owns the user's MCP servers;
              // Synara's gateway comes in beside them as custom tools.
              enableMCP: true,
              ...(gatewayTools.length > 0 ? { customTools: [...gatewayTools] } : {}),
              // On. The preflight only probes python/ruby/julia when JS eval is
              // disabled (tools/index.ts), so skipping it costs no capability:
              // `eval` stays available through JS and the other kernels are
              // checked at first invocation instead of at every session start.
              skipPythonPreflight: true,
            });
            return {
              result,
              sessionManager,
              modelRegistry,
              gatewayControlAvailable,
              gatewayConnectError,
            };
          },
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/start",
              detail: toMessage(cause, "Failed to start OMP session."),
              cause,
            }),
        });
        const now = new Date().toISOString();
        const agentSession = created.result.session;
        const model = agentSession.model;
        const resumeCursor = getSessionFile(agentSession);
        const session: ProviderSession = {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          threadId: input.threadId,
          createdAt: now,
          updatedAt: now,
          ...(model ? { model: `${model.provider}/${model.id}` } : {}),
          ...(resumeCursor ? { resumeCursor } : {}),
        };
        const context: OmpSessionContext = {
          ...(input.lifecycleGeneration !== undefined
            ? { lifecycleGeneration: input.lifecycleGeneration }
            : {}),
          agentSession,
          sessionManager: created.sessionManager,
          modelRegistry: created.modelRegistry,
          session,
          turns: [],
          activeTurnId: undefined,
          activeTurn: undefined,
          activeAssistantItemId: undefined,
          activeReasoningItemId: undefined,
          activeToolItems: new Map(),
          pendingAsyncDelivery: false,
          turnWatchdog: undefined,
          turnActivityAt: Date.now(),
          stopped: false,
          lastKnownTokenUsage: undefined,
          unsubscribe: undefined,
          pendingUserInputs: new Map(),
          gatewayControlAvailable: created.gatewayControlAvailable,
          ...(agentGatewaySessionLease && created.gatewayControlAvailable
            ? { gatewaySessionLease: agentGatewaySessionLease }
            : {}),
        };
        if (!created.gatewayControlAvailable) {
          agentGatewaySessionLease?.release();
          // Losing the gateway silently would leave the thread unable to drive
          // Synara while the model is told, without explanation, that Synara
          // control is unavailable.
          const reason = agentGatewayConnection
            ? (created.gatewayConnectError ?? "unknown")
            : "no gateway credentials in this server runtime";
          offerRuntimeEvent({
            ...makeEventBase(context, { includeTurnId: false }),
            type: "runtime.warning",
            payload: {
              message: "Synara MCP control is unavailable in this OMP session.",
              detail: {
                reason,
                ...(agentGatewayConnection ? { url: agentGatewayConnection.url } : {}),
              },
            },
            raw: {
              source: "omp.sdk.event",
              method: "mcp/gateway-unavailable",
              payload: { reason },
            },
          } satisfies ProviderRuntimeEvent);
        }
        context.unsubscribe = agentSession.subscribe((event) => handleSessionEvent(context, event));
        sessions.set(input.threadId, context);
        // `hasUI: true` only declares that a UI exists; this is the object the
        // engine actually renders through — the native `ask` tool, extension
        // select/confirm/input, and the harness `askUserQuestions` extra.
        created.result.setToolUIContext(makeUiContextFor(context), true);
        const loadedExtensions = created.result.extensionsResult.extensions;
        if (loadedExtensions.length > 0) {
          const extensions = loadedExtensions.map((extension) => ({
            name: extension.label ?? extension.path,
            tools: Array.from(extension.tools.keys()),
            commands: Array.from(extension.commands.keys()),
          }));
          offerRuntimeEvent({
            ...makeEventBase(context, { includeTurnId: false }),
            type: "runtime.warning",
            payload: {
              message:
                "OMP extensions are loaded with Synara's limited UI bridge. select/confirm/input/notify/status and the ask dialog are supported; TUI-only widgets and editor hooks are ignored.",
              detail: { extensionCount: loadedExtensions.length, extensions },
            },
            raw: {
              source: "omp.sdk.event",
              method: "extension/ui-limited-warning",
              payload: { extensionCount: loadedExtensions.length, extensions },
            },
          } satisfies ProviderRuntimeEvent);
        }
        if (created.result.modelFallbackMessage) {
          offerRuntimeEvent({
            ...makeEventBase(context, { includeTurnId: false }),
            type: "runtime.warning",
            payload: { message: created.result.modelFallbackMessage },
            raw: {
              source: "omp.sdk.event",
              method: "session/start",
              payload: { modelFallbackMessage: created.result.modelFallbackMessage },
            },
          } satisfies ProviderRuntimeEvent);
        }
        offerRuntimeEvent({
          ...makeEventBase(context),
          type: "session.started",
          payload: { message: "OMP session started", resume: session.resumeCursor },
        } satisfies ProviderRuntimeEvent);
        offerRuntimeEvent({
          ...makeEventBase(context),
          type: "thread.started",
          payload: { providerThreadId: agentSession.sessionId },
        } satisfies ProviderRuntimeEvent);
        const initialUsage = normalizeTokenUsage(
          agentSession.getSessionStats(),
          agentSession.model?.contextWindow,
        );
        context.lastKnownTokenUsage = initialUsage;
        if (initialUsage) {
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "thread.token-usage.updated",
            payload: { usage: initialUsage },
          } satisfies ProviderRuntimeEvent);
        }
        return session;
      });

    const buildPromptText = (input: {
      readonly input?: string | undefined;
      readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
    }) =>
      // Image attachments arrive with the phase-3 event/tool expansion; file
      // attachments are already projected into the prompt as text blocks.
      appendFileAttachmentsPromptBlock({
        text: input.input,
        attachments: input.attachments,
        attachmentsDir: serverConfig.attachmentsDir,
        include: "all-files",
      }) ?? "";

    const applyTurnModelSelection = (
      context: OmpSessionContext,
      modelSelection: ProviderSendTurnInput["modelSelection"],
    ) =>
      Effect.gen(function* () {
        if (modelSelection?.provider !== PROVIDER) return;
        const model = findModelInRegistry(context.modelRegistry, modelSelection.model);
        if (!model) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "model/set",
            issue: `OMP model '${modelSelection.model}' is not available. Pick a discovered model (provider/model slug).`,
          });
        }
        yield* Effect.tryPromise({
          try: () => context.agentSession.setModel(model),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "model/set",
              detail: toMessage(cause, "Failed to set OMP model."),
              cause,
            }),
        });
        const thinkingLevel = toOmpThinkingLevel(modelSelection.options?.thinkingLevel);
        if (thinkingLevel) {
          context.agentSession.setThinkingLevel(thinkingLevel);
        }
      });

    const sendTurn: OmpAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        if (context.activeTurnId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "An OMP turn is already active for this thread.",
          });
        }
        yield* applyTurnModelSelection(context, input.modelSelection);
        const text = buildPromptText(input);
        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        context.activeTurnId = turnId;
        context.turns.push({ id: turnId, items: [] });
        context.session = makeSessionSnapshot(context);
        armTurnWatchdog(context);
        const harnessPolicy = takeSynaraHarnessPolicyForProviderSession(context, {
          provider: PROVIDER,
          scopedGatewayConnectionAvailable: context.gatewayControlAvailable,
        });
        const providerText = [harnessPolicy, text].filter(Boolean).join("\n\n");
        void context.agentSession.prompt(providerText).catch((cause) => {
          completePromptRejection(context, turnId, cause);
        });
        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: getSessionFile(context.agentSession),
        };
      });

    const steerTurn: NonNullable<OmpAdapterShape["steerTurn"]> = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        yield* applyTurnModelSelection(context, input.modelSelection);
        const text = buildPromptText(input);
        const harnessPolicy = takeSynaraHarnessPolicyForProviderSession(context, {
          provider: PROVIDER,
          scopedGatewayConnectionAvailable: context.gatewayControlAvailable,
        });
        const providerText = [harnessPolicy, text].filter(Boolean).join("\n\n");
        const turnId = context.activeTurnId ?? TurnId.makeUnsafe(crypto.randomUUID());
        if (!context.activeTurnId) {
          context.activeTurnId = turnId;
          context.turns.push({ id: turnId, items: [] });
          armTurnWatchdog(context);
        }
        if (context.agentSession.isStreaming) {
          yield* Effect.tryPromise({
            try: () => context.agentSession.steer(providerText),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/steer",
                detail: toMessage(cause, "Failed to steer OMP turn."),
                cause,
              }),
          });
        } else {
          void context.agentSession.prompt(providerText).catch((cause) => {
            completePromptRejection(context, turnId, cause);
          });
        }
        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: getSessionFile(context.agentSession),
        };
      });

    const interruptTurn: OmpAdapterShape["interruptTurn"] = (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) =>
          Effect.tryPromise({
            try: () => context.agentSession.abort(),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/interrupt",
                detail: toMessage(cause, "Failed to interrupt OMP turn."),
                cause,
              }),
          }),
        ),
        Effect.asVoid,
      );

    const respondUnsupported = (threadId: ThreadId, method: string) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: `OMP does not expose Synara approval/user-input requests for thread ${threadId} yet (extension UI bridge lands in M4 phase 4).`,
        }),
      );

    const stopSession: OmpAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (!context) return;
        yield* Effect.tryPromise({
          try: () => disposeSessionContext(context),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/stop",
              detail: toMessage(cause, "Failed to stop OMP session."),
              cause,
            }),
        });
        if (sessions.get(threadId) === context) {
          sessions.delete(threadId);
        }
        offerRuntimeEvent({
          ...makeEventBase(context),
          type: "thread.state.changed",
          payload: { state: "closed", detail: { reason: "stopped" } },
        } satisfies ProviderRuntimeEvent);
        offerRuntimeEvent({
          ...makeEventBase(context),
          type: "session.exited",
          payload: { reason: "stopped", exitKind: "graceful" },
        } satisfies ProviderRuntimeEvent);
      });

    const listSessions: OmpAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values()).map(makeSessionSnapshot));

    const hasSession: OmpAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    // Turns recorded by this adapter instance only; mapping the engine's
    // persisted message history into snapshot turns lands in M4 phase 3.
    const snapshotThread = (context: OmpSessionContext): ProviderThreadSnapshot => ({
      threadId: context.session.threadId,
      ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
      turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
    });

    const readThread: OmpAdapterShape["readThread"] = (threadId) =>
      requireSession(threadId).pipe(Effect.map(snapshotThread));

    const rollbackThread: OmpAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const nextLength = Math.max(0, context.turns.length - Math.max(0, numTurns));
        context.turns.splice(nextLength);
        const leafId = context.turns.at(-1)?.leafId;
        if (leafId) {
          context.sessionManager.branch(leafId);
        } else if (nextLength === 0) {
          context.sessionManager.resetLeaf();
        }
        return snapshotThread(context);
      });

    const respondToUserInput: OmpAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (!resolveOmpExtensionUserInput(context, requestId, answers)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "user-input/respond",
            detail: `No pending OMP user-input request ${requestId} for thread ${threadId}.`,
          });
        }
      });

    const compactThread: NonNullable<OmpAdapterShape["compactThread"]> = (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) =>
          Effect.tryPromise({
            try: () => context.agentSession.compact(),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "thread/compact",
                detail: toMessage(cause, "Failed to compact OMP thread."),
                cause,
              }),
          }),
        ),
        Effect.asVoid,
      );

    const stopTask: NonNullable<OmpAdapterShape["stopTask"]> = (threadId, taskId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        // Background work is the engine's async job registry, so "stop task"
        // is a job cancel; a false return means the id is unknown or finished.
        if (context.agentSession.asyncJobManager?.cancel(taskId) !== true) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "task/stop",
            detail: `OMP has no cancellable background job '${taskId}' for thread ${threadId}.`,
          });
        }
      });

    const listSkills: NonNullable<OmpAdapterShape["listSkills"]> = (input) =>
      Effect.tryPromise({
        try: async () => {
          const sdk = await loadSdkModule();
          const discovered = await sdk.discoverSkills(input.cwd, trimToUndefined(input.agentDir));
          return {
            skills: discovered.skills.map((skill) => {
              const description = trimToUndefined(skill.description);
              const scope = trimToUndefined(skill._source?.level ?? skill.source);
              return {
                name: skill.name,
                ...(description ? { description } : {}),
                path: skill.filePath,
                // OMP has no per-skill model-invocation switch; `hide` only
                // removes it from the system prompt listing.
                enabled: skill.hide !== true,
                ...(scope ? { scope } : {}),
              };
            }),
            source: "omp.sdk",
            cached: false,
          } satisfies ProviderListSkillsResult;
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "skill/list",
            detail: toMessage(cause, "Failed to list OMP skills."),
            cause,
          }),
      });

    const listCommands: NonNullable<OmpAdapterShape["listCommands"]> = (input) =>
      Effect.tryPromise({
        try: async () => {
          const sdk = await loadSdkModule();
          const active = input.threadId
            ? sessions.get(ThreadId.makeUnsafe(input.threadId))
            : undefined;
          const [fileCommands, skills] = await Promise.all([
            sdk.discoverSlashCommands({ cwd: input.cwd }),
            sdk.discoverSkills(input.cwd, trimToUndefined(input.agentDir)),
          ]);
          // Extension commands only exist on a live session; discovery-only
          // callers still get the file/skill commands.
          const extensionCommands = active
            ? (active.agentSession.extensionRunner?.getRegisteredCommands() ?? []).map(
                (command) => ({
                  name: command.name,
                  description: trimToUndefined(command.description) ?? "Extension command",
                }),
              )
            : [];
          return {
            commands: [
              ...extensionCommands,
              ...fileCommands.map((command) => ({
                name: command.name,
                description: trimToUndefined(command.description) ?? "Slash command",
              })),
              ...skills.skills.map((skill) => ({
                name: `skill:${skill.name}`,
                description: trimToUndefined(skill.description) ?? "Skill",
              })),
            ],
            source: "omp.sdk",
            cached: false,
          } satisfies ProviderListCommandsResult;
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "command/list",
            detail: toMessage(cause, "Failed to list OMP commands."),
            cause,
          }),
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
      Effect.forEach(Array.from(sessions.keys()), (threadId) => stopSession(threadId), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.asVoid);

    const listModels: NonNullable<OmpAdapterShape["listModels"]> = (input) =>
      Effect.tryPromise({
        try: async () => {
          const sdk = await loadSdkModule();
          const authStorage = await sdk.discoverAuthStorage(trimToUndefined(input.agentDir));
          const registry = new sdk.ModelRegistry(authStorage);
          // Enrich the catalog off the sync constructor path; offline falls
          // back to the cached/bundled catalog instead of failing discovery.
          await registry.refresh("online-if-uncached").catch(() => undefined);
          const models = registry.getAvailable().map((model) => {
            const supportedThinkingOptions = getOmpSupportedThinkingOptions(model);
            return {
              slug: `${model.provider}/${model.id}`,
              name: model.name,
              upstreamProviderId: model.provider,
              upstreamProviderName: model.provider,
              ...(supportedThinkingOptions.length > 0
                ? {
                    supportedReasoningEfforts: supportedThinkingOptions.map((option) => ({
                      value: option.value,
                      label: option.label,
                      description: option.description,
                    })),
                    defaultReasoningEffort: "medium",
                  }
                : {}),
            };
          });
          return { models, source: "omp.sdk", cached: false } satisfies ProviderListModelsResult;
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail: toMessage(cause, "Failed to list OMP models."),
            cause,
          }),
      });

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.orDie,
        Effect.andThen(runtimeEventIngress.stop),
        Effect.ensuring(
          ownsNativeEventLogger && nativeEventLogger
            ? nativeEventLogger.close().pipe(Effect.ignore)
            : Effect.void,
        ),
        Effect.ensuring(Queue.shutdown(runtimeEventQueue)),
      ),
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
      // OMP routes every question through the UI context (native ask tool /
      // extension dialogs), never through Synara's approval-request channel.
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
