// FILE: event-mapping.ts
// Purpose: Map OMP `AgentSessionEvent`s to canonical `ProviderRuntimeEvent`s.
// Layer: Sidecar engine (OMP)
// Exports: OmpSessionContext, OmpTrackedToolCall, handleSessionEvent

import type {
  AgentSession,
  AgentSessionEvent,
  ModelRegistry,
  SessionManager,
} from "@oh-my-pi/pi-coding-agent";
import type {
  EventId,
  ProviderItemId,
  ProviderRuntimeEvent,
  ProviderRuntimeEventBase,
  ProviderSession,
  ProviderUserInputAnswers,
  RuntimeItemId,
  ThreadTokenUsageSnapshot,
  TurnId,
} from "@nuncio/contracts";
import type { AgentToolItemType } from "./tool-projection";

import { makeRuntimeTaskListItem } from "./runtime-task-list";
import { toolDetailText, toolItemType, toolLifecycleData, toolTitle } from "./tool-projection";
import { classifyOmpTurnFailure } from "./turn-failure";
import { normalizeTokenUsage } from "./token-usage";

const PROVIDER = "omp" as const;

/**
 * A turn with no session activity for this long is treated as wedged. OMP has
 * no `agent_settled`: `agent_end.isTerminal` is the only "the run is really
 * over" signal. If it never arrives, `activeTurnId` would stay set and every
 * later prompt would be rejected with "a turn is already active", so the turn
 * is failed explicitly instead. Generous enough for xhigh reasoning and long
 * tool calls; engine-owned async work re-arms it (see `armTurnWatchdog`).
 */
const OMP_TURN_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

export interface OmpStoredTurn {
  readonly id: TurnId;
  items: unknown[];
  leafId?: string | null;
}

/** Trailing streamed item that consecutive deltas of the same kind append into. */
interface OmpStreamDeltaItem {
  readonly type: "assistant_message" | "reasoning";
  delta: string;
}

export interface OmpPendingUserInput {
  readonly resolve: (answers: ProviderUserInputAnswers) => void;
}

export interface OmpTrackedToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly itemId: RuntimeItemId;
  readonly itemType: AgentToolItemType;
}

export interface OmpSessionContext {
  lifecycleGeneration?: string;
  session: ProviderSession;
  agentSession: AgentSession;
  sessionManager: SessionManager;
  modelRegistry: ModelRegistry;
  turns: OmpStoredTurn[];
  activeTurnId: TurnId | undefined;
  activeTurn: OmpStoredTurn | undefined;
  activeAssistantItemId: RuntimeItemId | undefined;
  activeReasoningItemId: RuntimeItemId | undefined;
  activeToolItems: Map<string, OmpTrackedToolCall>;
  pendingAsyncDelivery: boolean;
  turnWatchdog: ReturnType<typeof setTimeout> | undefined;
  turnActivityAt: number;
  stopped: boolean;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  unsubscribe: (() => void) | undefined;
  pendingUserInputs: Map<string, OmpPendingUserInput>;
  gatewayControlAvailable: boolean;
  harnessPolicyDelivered?: boolean;

  offerRuntimeEvent(event: ProviderRuntimeEvent): void;
  offerRuntimeError(input: {
    readonly message: string;
    readonly cause?: unknown;
    readonly method: string;
    readonly messageType?: string;
  }): void;
  makeEventBase(options?: { readonly includeTurnId?: boolean }): ProviderRuntimeEventBase;
  updateSessionSnapshot(): void;
  recordItem(item: unknown): void;
  activeTurnFor(): OmpStoredTurn | undefined;
  recordStreamDelta(type: OmpStreamDeltaItem["type"], delta: string): void;
  closeActiveStreamItems(status: "completed" | "failed", raw: ProviderRuntimeEvent["raw"]): void;
  resetActiveTurnState(): void;
  clearTurnWatchdog(): void;
  armTurnWatchdog(delayMs?: number): void;
  ensureActiveTurn(): TurnId;
  failStalledTurn(idleMs: number): void;
  completePromptRejection(turnId: TurnId, cause: unknown): void;
}

export function makeOmpRuntimeEventBase(
  context: Pick<OmpSessionContext, "lifecycleGeneration" | "session" | "activeTurnId">,
  options?: { readonly includeTurnId?: boolean },
): ProviderRuntimeEventBase {
  return {
    eventId: crypto.randomUUID() as unknown as EventId,
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

export function activeTurnFor(context: OmpSessionContext): OmpStoredTurn | undefined {
  if (context.activeTurn && context.activeTurn.id === context.activeTurnId) {
    return context.activeTurn;
  }
  const turn = context.activeTurnId
    ? context.turns.find((candidate) => candidate.id === context.activeTurnId)
    : context.turns.at(-1);
  context.activeTurn = turn;
  return turn;
}

export function recordItem(context: OmpSessionContext, item: unknown) {
  activeTurnFor(context)?.items.push(item);
}

/**
 * Deltas arrive one per streamed token. Appending into the trailing item of
 * the same kind keeps `turns` proportional to the response length instead of
 * allocating one object per token for the lifetime of the thread.
 */
export function recordStreamDelta(
  context: OmpSessionContext,
  type: OmpStreamDeltaItem["type"],
  delta: string,
) {
  const turn = activeTurnFor(context);
  if (!turn) return;
  const last = turn.items.at(-1) as OmpStreamDeltaItem | undefined;
  if (last && last.type === type && typeof last.delta === "string") {
    last.delta += delta;
    return;
  }
  turn.items.push({ type, delta } satisfies OmpStreamDeltaItem);
}

export function clearTurnWatchdog(context: OmpSessionContext) {
  if (context.turnWatchdog !== undefined) {
    clearTimeout(context.turnWatchdog);
    context.turnWatchdog = undefined;
  }
}

/**
 * The engine owns async job lifecycles. While it still reports queued,
 * running, or undelivered work the silence between turns is expected, not a
 * wedge — the watchdog must not fail a turn that OMP is going to resume.
 */
export function hasPendingEngineWork(context: OmpSessionContext): boolean {
  const jobs = context.agentSession.asyncJobManager;
  if (!jobs) return false;
  return jobs.getRunningJobs().length > 0 || jobs.hasPendingDeliveries();
}

export function resetActiveTurnState(context: OmpSessionContext) {
  clearTurnWatchdog(context);
  context.activeTurnId = undefined;
  context.activeTurn = undefined;
  context.activeAssistantItemId = undefined;
  context.activeReasoningItemId = undefined;
  context.activeToolItems.clear();
  context.pendingAsyncDelivery = false;
}

export function failStalledTurn(context: OmpSessionContext, idleMs: number) {
  if (!context.activeTurnId) return;
  const message = `OMP produced no session activity for ${String(Math.round(idleMs / 60_000))} minutes and reported no pending async work; failing the turn so the thread accepts new prompts.`;
  const raw = {
    source: "omp.sdk.event" as const,
    method: "turn/watchdog",
    payload: { idleMs },
  } satisfies ProviderRuntimeEvent["raw"];
  const completionBase = context.makeEventBase();
  context.offerRuntimeError({ message, method: "turn/watchdog" });
  context.closeActiveStreamItems("failed", raw);
  resetActiveTurnState(context);
  context.updateSessionSnapshot();
  context.offerRuntimeEvent({
    ...completionBase,
    type: "turn.completed",
    payload: { state: "failed", stopReason: "error", errorMessage: message },
    raw,
  } satisfies ProviderRuntimeEvent);
}

export function armTurnWatchdog(
  context: OmpSessionContext,
  delayMs: number = OMP_TURN_INACTIVITY_TIMEOUT_MS,
) {
  clearTurnWatchdog(context);
  if (!context.activeTurnId || context.stopped) return;
  const turnId = context.activeTurnId;
  const timer = setTimeout(() => {
    context.turnWatchdog = undefined;
    if (context.stopped || context.activeTurnId !== turnId) return;
    // Session events only stamp `turnActivityAt`; re-arm for the remaining
    // window so the hot path never churns a timer per streamed token.
    const idleMs = Date.now() - context.turnActivityAt;
    if (idleMs < OMP_TURN_INACTIVITY_TIMEOUT_MS) {
      armTurnWatchdog(context, OMP_TURN_INACTIVITY_TIMEOUT_MS - idleMs);
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
}

/**
 * OMP can start a turn NuncioADE never asked for: when an async job finishes,
 * the job manager injects the result as a follow-up prompt. If that lands
 * after the previous turn already settled there is no open NuncioADE turn to
 * attribute the events to, so mint one. Every later event — items and the
 * final `turn.completed` — is keyed off this id, which is what keeps the
 * ingress guard in provider/terminalTurnApplicability.ts from dropping the
 * follow-up as a foreign turn.
 */
export function ensureActiveTurn(context: OmpSessionContext): TurnId {
  const existing = context.activeTurnId;
  if (existing) return existing;
  const turnId = crypto.randomUUID() as unknown as TurnId;
  context.activeTurnId = turnId;
  context.activeTurn = undefined;
  context.turns.push({ id: turnId, items: [] });
  context.updateSessionSnapshot();
  armTurnWatchdog(context);
  return turnId;
}

export function closeActiveStreamItems(
  context: OmpSessionContext,
  status: "completed" | "failed",
  raw: ProviderRuntimeEvent["raw"],
) {
  if (context.activeAssistantItemId) {
    context.offerRuntimeEvent({
      ...context.makeEventBase(),
      itemId: context.activeAssistantItemId,
      type: "item.completed",
      payload: { itemType: "assistant_message", status, title: "Assistant" },
      raw,
    } satisfies ProviderRuntimeEvent);
    context.activeAssistantItemId = undefined;
  }
  if (context.activeReasoningItemId) {
    context.offerRuntimeEvent({
      ...context.makeEventBase(),
      itemId: context.activeReasoningItemId,
      type: "item.completed",
      payload: { itemType: "reasoning", status, title: "Reasoning" },
      raw,
    } satisfies ProviderRuntimeEvent);
    context.activeReasoningItemId = undefined;
  }
}

export function completePromptRejection(
  context: OmpSessionContext,
  turnId: TurnId,
  cause: unknown,
) {
  if (context.activeTurnId !== turnId) {
    return;
  }
  const message = toMessage(cause, "OMP turn failed.");
  const completionBase = context.makeEventBase();
  context.offerRuntimeError({ message, method: "prompt", cause });
  resetActiveTurnState(context);
  context.updateSessionSnapshot();
  context.offerRuntimeEvent({
    ...completionBase,
    type: "turn.completed",
    payload: { state: "failed", stopReason: "error", errorMessage: message },
    raw: { source: "omp.sdk.event", method: "prompt", payload: cause },
  } satisfies ProviderRuntimeEvent);
}

export function handleMessageUpdate(
  context: OmpSessionContext,
  event: Extract<AgentSessionEvent, { type: "message_update" }>,
) {
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
      context.activeAssistantItemId =
        `omp-assistant-${crypto.randomUUID()}` as unknown as RuntimeItemId;
      context.offerRuntimeEvent({
        ...context.makeEventBase(),
        itemId: context.activeAssistantItemId,
        type: "item.started",
        payload: { itemType: "assistant_message", status: "inProgress", title: "Assistant" },
        raw,
      } satisfies ProviderRuntimeEvent);
    }
    recordStreamDelta(context, "assistant_message", update.delta);
    context.offerRuntimeEvent({
      ...context.makeEventBase(),
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
      context.activeReasoningItemId =
        `omp-reasoning-${crypto.randomUUID()}` as unknown as RuntimeItemId;
      context.offerRuntimeEvent({
        ...context.makeEventBase(),
        itemId: context.activeReasoningItemId,
        type: "item.started",
        payload: { itemType: "reasoning", status: "inProgress", title: "Reasoning" },
        raw,
      } satisfies ProviderRuntimeEvent);
    }
    recordStreamDelta(context, "reasoning", update.delta);
    context.offerRuntimeEvent({
      ...context.makeEventBase(),
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
}

export function handleSessionEvent(context: OmpSessionContext, event: AgentSessionEvent) {
  // Cheap liveness stamp read by the turn watchdog; avoids re-arming a timer
  // for every streamed token.
  context.turnActivityAt = Date.now();
  switch (event.type) {
    case "agent_start":
      // A run starting is the moment an async-result follow-up becomes a
      // real turn again; adopt or mint one before anything is attributed.
      context.pendingAsyncDelivery = false;
      ensureActiveTurn(context);
      context.offerRuntimeEvent({
        ...context.makeEventBase(),
        type: "thread.state.changed",
        payload: { state: "active" },
        raw: { source: "omp.sdk.event", messageType: event.type, payload: event },
      } satisfies ProviderRuntimeEvent);
      return;
    case "turn_start":
      ensureActiveTurn(context);
      context.offerRuntimeEvent({
        ...context.makeEventBase(),
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
      const itemId = `omp-tool-${event.toolCallId}` as unknown as RuntimeItemId;
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
      context.offerRuntimeEvent({
        ...context.makeEventBase(),
        itemId,
        providerRefs: {
          providerItemId: `omp-tool-${event.toolCallId}` as unknown as ProviderItemId,
        },
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
      context.offerRuntimeEvent({
        ...context.makeEventBase(),
        itemId: tracked.itemId,
        providerRefs: {
          providerItemId: `omp-tool-${event.toolCallId}` as unknown as ProviderItemId,
        },
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
        itemId: `omp-tool-${event.toolCallId}` as unknown as RuntimeItemId,
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
      context.offerRuntimeEvent({
        ...context.makeEventBase(),
        itemId: tracked.itemId,
        providerRefs: {
          providerItemId: `omp-tool-${event.toolCallId}` as unknown as ProviderItemId,
        },
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
      context.offerRuntimeEvent({
        ...context.makeEventBase(),
        itemId: `omp-compaction-${crypto.randomUUID()}` as unknown as RuntimeItemId,
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
      const itemId = `omp-compaction-${crypto.randomUUID()}` as unknown as RuntimeItemId;
      const detail = trimToUndefined(event.errorMessage);
      const raw = {
        source: "omp.sdk.event",
        messageType: event.type,
        payload: event,
      } satisfies ProviderRuntimeEvent["raw"];
      // A compaction that will be retried is not a terminal failure; keep it
      // in progress so the transcript does not report a dead compaction.
      if (event.willRetry) {
        context.offerRuntimeEvent({
          ...context.makeEventBase(),
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
      context.offerRuntimeEvent({
        ...context.makeEventBase(),
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
      context.offerRuntimeEvent({
        ...context.makeEventBase(),
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
      context.offerRuntimeEvent({
        ...context.makeEventBase(),
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
      context.offerRuntimeEvent({
        ...context.makeEventBase(),
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
      context.offerRuntimeEvent({
        ...context.makeEventBase(),
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
        context.offerRuntimeError({
          message,
          method: "session/notice",
          messageType: event.type,
        });
        return;
      }
      context.offerRuntimeEvent({
        ...context.makeEventBase(),
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
      context.offerRuntimeEvent({
        ...context.makeEventBase(),
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
      context.offerRuntimeEvent({
        ...context.makeEventBase(),
        type: "turn.tasks.updated",
        payload: { tasks },
        raw: { source: "omp.sdk.event", messageType: event.type, payload: event },
      } satisfies ProviderRuntimeEvent);
      return;
    }
    case "todo_auto_clear":
      context.offerRuntimeEvent({
        ...context.makeEventBase(),
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
        context.offerRuntimeEvent({
          ...context.makeEventBase(),
          type: "thread.token-usage.updated",
          payload: { usage },
          raw,
        } satisfies ProviderRuntimeEvent);
      }
      // OMP has no `agent_settled`: `isTerminal === false` means an async
      // delivery will resume this session with a follow-up turn, so the
      // NuncioADE turn stays open across the gap — same turn id on both sides
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
        context.offerRuntimeError({
          message: errorMessage,
          method: "session/event",
          messageType: event.type,
        });
      }
      closeActiveStreamItems(context, errorMessage ? "failed" : "completed", raw);
      const completionBase = context.makeEventBase();
      resetActiveTurnState(context);
      context.updateSessionSnapshot();
      context.offerRuntimeEvent({
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
      // NuncioADE surface yet (coverage map: "later"); ignoring them never
      // breaks the turn lifecycle.
      return;
  }
}
