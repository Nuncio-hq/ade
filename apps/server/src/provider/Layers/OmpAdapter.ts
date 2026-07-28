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
} from "@oh-my-pi/pi-coding-agent";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import {
  type ChatAttachment,
  EventId,
  ProviderItemId,
  type ProviderListModelsResult,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  RuntimeItemId,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
} from "@synara/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import { takeSynaraHarnessPolicyForProviderSession } from "../../agentGateway/harnessPolicy.ts";
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
import { classifyOmpTurnFailure } from "../ompTurnFailure.ts";
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

interface OmpSessionContext {
  harnessPolicyDelivered?: boolean;
  readonly lifecycleGeneration?: string;
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
      await context.agentSession.dispose({});
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
            const sessionFile = extractResumeSessionFile(input.resumeCursor);
            const sessionManager = sessionFile
              ? await sdk.SessionManager.open(sessionFile)
              : sdk.SessionManager.create(cwd);
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
              // Synara is the UI; the engine must not assume a terminal exists.
              hasUI: false,
              // LSP warmup spawns language servers per session — resource cost
              // with no consumer until Synara surfaces diagnostics. Off for now.
              enableLsp: false,
              // IRC would register every embedded session on the shared hub and
              // pollute the user's agent registry. Off inside the server.
              enableIrc: false,
              // MCP stays off until phase 4 wires the Synara gateway through
              // MCPManager.connectServers (user servers come with it).
              enableMCP: false,
              // The python preflight probes interpreters at startup; the eval
              // kernel is unused in the embedded skeleton, so skip the cost.
              skipPythonPreflight: true,
            });
            return { result, sessionManager, modelRegistry };
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
        };
        context.unsubscribe = agentSession.subscribe((event) => handleSessionEvent(context, event));
        sessions.set(input.threadId, context);
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
          scopedGatewayConnectionAvailable: false,
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
          scopedGatewayConnectionAvailable: false,
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
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: false,
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
      respondToUserInput: (threadId) => respondUnsupported(threadId, "user-input/respond"),
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      listModels,
      get streamEvents() {
        return Stream.fromQueue(runtimeEventQueue);
      },
    } satisfies OmpAdapterShape;
  });

export const OmpAdapterLive = Layer.effect(OmpAdapter, makeOmpAdapter());

export function makeOmpAdapterLive(options?: OmpAdapterLiveOptions) {
  return Layer.effect(OmpAdapter, makeOmpAdapter(options));
}
