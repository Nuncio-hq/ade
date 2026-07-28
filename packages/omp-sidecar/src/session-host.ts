// FILE: session-host.ts
// Purpose: OMP sidecar session registry and `OmpSidecarMethods` implementation.
// Layer: Sidecar engine (OMP)
// Exports: createOmpSidecarSessionHost, OmpSidecarSessionHost, OmpSidecarHostOptions

import type * as OmpCodingAgent from "@oh-my-pi/pi-coding-agent";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";

import {
  ApprovalRequestId,
  EventId,
  ProviderItemId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderListCommandsResult,
  type ProviderListModelsResult,
  type ProviderListSkillsResult,
  type ProviderComposerCapabilities,
  type ProviderRuntimeEvent,
  type ProviderRuntimeEventBase,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  type ThreadTokenUsageSnapshot,
} from "@nuncio/contracts";

import crypto from "node:crypto";

import { buildPromptText } from "./attachment-block";
import type {
  OmpSidecarSendTurnParams,
  OmpSidecarStartSessionParams,
  OmpSidecarThreadSnapshot,
} from "./protocol";
import { compactProviderRuntimeEventForIngress } from "./event-ingress";
import {
  completePromptRejection,
  ensureActiveTurn,
  handleSessionEvent,
  makeOmpRuntimeEventBase,
  type OmpPendingUserInput,
  type OmpSessionContext,
  type OmpStoredTurn,
  type OmpTrackedToolCall,
} from "./event-mapping";
import {
  makeOmpExtensionUiContext,
  type OmpUserInputOutcome,
  type OmpUserInputRequest,
} from "./extension-ui-context";
import { buildOmpAgentGatewayCustomTools, type AgentGatewayMcpConnection } from "./gateway-tools";
import { normalizeTokenUsage } from "./token-usage";

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

export interface OmpSidecarHostOptions {
  /** Test seam for the SDK module. */
  readonly loadSdk?: () => Promise<typeof OmpCodingAgent>;
  /** Test seam for the turn inactivity watchdog. */
  readonly turnInactivityTimeoutMs?: number;
  /** Called for every canonical runtime event the sidecar emits. */
  readonly onRuntimeEvent?: (event: ProviderRuntimeEvent) => void;
}

export type OmpSidecarSendTurnInput = OmpSidecarSendTurnParams;

/** The wire contract is the single source of truth for request shapes. */
export type OmpSidecarStartSessionInput = OmpSidecarStartSessionParams;

export interface OmpSidecarSessionHost {
  readonly startSession: (params: OmpSidecarStartSessionInput) => Promise<ProviderSession>;
  readonly stopSession: (params: { threadId: string }) => Promise<null>;
  readonly stopAll: () => Promise<null>;
  readonly listSessions: () => Promise<ReadonlyArray<ProviderSession>>;
  readonly hasSession: (params: { threadId: string }) => Promise<boolean>;
  readonly sendTurn: (
    params: OmpSidecarSendTurnInput,
  ) => Promise<{ turnId: string; resumeCursor?: string }>;
  readonly steerTurn: (
    params: OmpSidecarSendTurnInput,
  ) => Promise<{ turnId: string; resumeCursor?: string }>;
  readonly interruptTurn: (params: { threadId: string }) => Promise<null>;
  readonly stopTask: (params: { threadId: string; taskId: string }) => Promise<null>;
  readonly respondToUserInput: (params: {
    threadId: string;
    requestId: string;
    answers: ProviderUserInputAnswers;
  }) => Promise<null>;
  readonly readThread: (params: { threadId: string }) => Promise<OmpSidecarThreadSnapshot>;
  readonly rollbackThread: (params: {
    threadId: string;
    numTurns: number;
  }) => Promise<OmpSidecarThreadSnapshot>;
  readonly compactThread: (params: { threadId: string }) => Promise<null>;
  readonly listModels: (params: {
    agentDir?: string;
    refresh?: boolean;
  }) => Promise<ProviderListModelsResult>;
  readonly listSkills: (params: {
    cwd: string;
    agentDir?: string;
  }) => Promise<ProviderListSkillsResult>;
  readonly listCommands: (params: {
    cwd: string;
    agentDir?: string;
    threadId?: string;
  }) => Promise<ProviderListCommandsResult>;
  readonly getComposerCapabilities: () => Promise<ProviderComposerCapabilities>;
}

function toOmpThinkingLevel(value: string | null | undefined): ThinkingLevel | undefined {
  return value && (OMP_THINKING_LEVEL_NAMES as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : undefined;
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
  registry: OmpCodingAgent.ModelRegistry,
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

function getSessionFile(session: OmpCodingAgent.AgentSession): string | undefined {
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

class OmpSessionContextImpl implements OmpSessionContext {
  lifecycleGeneration?: string;
  session: ProviderSession;
  agentSession: OmpCodingAgent.AgentSession;
  sessionManager: OmpCodingAgent.SessionManager;
  modelRegistry: OmpCodingAgent.ModelRegistry;
  turns: OmpStoredTurn[] = [];
  activeTurnId: TurnId | undefined;
  activeTurn: OmpStoredTurn | undefined;
  activeAssistantItemId: RuntimeItemId | undefined;
  activeReasoningItemId: RuntimeItemId | undefined;
  activeToolItems = new Map<string, OmpTrackedToolCall>();
  pendingAsyncDelivery = false;
  turnWatchdog: ReturnType<typeof setTimeout> | undefined;
  turnActivityAt = Date.now();
  stopped = false;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  unsubscribe: (() => void) | undefined;
  pendingUserInputs = new Map<string, OmpPendingUserInput>();
  gatewayControlAvailable = false;
  harnessPolicyDelivered?: boolean;

  private readonly onRuntimeEvent: (event: ProviderRuntimeEvent) => void;
  private readonly turnInactivityTimeoutMs: number;

  constructor(args: {
    readonly session: ProviderSession;
    readonly agentSession: OmpCodingAgent.AgentSession;
    readonly sessionManager: OmpCodingAgent.SessionManager;
    readonly modelRegistry: OmpCodingAgent.ModelRegistry;
    readonly onRuntimeEvent: (event: ProviderRuntimeEvent) => void;
    readonly turnInactivityTimeoutMs: number;
    readonly lifecycleGeneration?: string;
    readonly gatewayControlAvailable: boolean;
  }) {
    this.session = args.session;
    this.agentSession = args.agentSession;
    this.sessionManager = args.sessionManager;
    this.modelRegistry = args.modelRegistry;
    this.onRuntimeEvent = args.onRuntimeEvent;
    this.turnInactivityTimeoutMs = args.turnInactivityTimeoutMs;
    if (args.lifecycleGeneration !== undefined) {
      this.lifecycleGeneration = args.lifecycleGeneration;
    }
    this.gatewayControlAvailable = args.gatewayControlAvailable;
  }

  offerRuntimeEvent(event: ProviderRuntimeEvent) {
    this.onRuntimeEvent(compactProviderRuntimeEventForIngress(event));
  }

  offerRuntimeError(input: {
    readonly message: string;
    readonly cause?: unknown;
    readonly method: string;
    readonly messageType?: string;
  }) {
    this.offerRuntimeEvent({
      ...this.makeEventBase({ includeTurnId: false }),
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
  }

  makeEventBase(options?: { readonly includeTurnId?: boolean }): ProviderRuntimeEventBase {
    return makeOmpRuntimeEventBase(this, options);
  }

  updateSessionSnapshot() {
    this.session = makeSessionSnapshot(this);
  }

  recordItem(item: unknown) {
    this.activeTurnFor()?.items.push(item);
  }

  activeTurnFor(): OmpStoredTurn | undefined {
    if (this.activeTurn && this.activeTurn.id === this.activeTurnId) {
      return this.activeTurn;
    }
    const turn = this.activeTurnId
      ? this.turns.find((candidate) => candidate.id === this.activeTurnId)
      : this.turns.at(-1);
    this.activeTurn = turn;
    return turn;
  }

  recordStreamDelta(type: "assistant_message" | "reasoning", delta: string) {
    const turn = this.activeTurnFor();
    if (!turn) return;
    const last = turn.items.at(-1) as
      | { type: "assistant_message" | "reasoning"; delta: string }
      | undefined;
    if (last && last.type === type && typeof last.delta === "string") {
      last.delta += delta;
      return;
    }
    turn.items.push({ type, delta });
  }

  closeActiveStreamItems(status: "completed" | "failed", raw: ProviderRuntimeEvent["raw"]) {
    if (this.activeAssistantItemId) {
      this.offerRuntimeEvent({
        ...this.makeEventBase(),
        itemId: this.activeAssistantItemId,
        type: "item.completed",
        payload: { itemType: "assistant_message", status, title: "Assistant" },
        raw,
      } satisfies ProviderRuntimeEvent);
      this.activeAssistantItemId = undefined;
    }
    if (this.activeReasoningItemId) {
      this.offerRuntimeEvent({
        ...this.makeEventBase(),
        itemId: this.activeReasoningItemId,
        type: "item.completed",
        payload: { itemType: "reasoning", status, title: "Reasoning" },
        raw,
      } satisfies ProviderRuntimeEvent);
      this.activeReasoningItemId = undefined;
    }
  }

  resetActiveTurnState() {
    if (this.turnWatchdog !== undefined) {
      clearTimeout(this.turnWatchdog);
      this.turnWatchdog = undefined;
    }
    this.activeTurnId = undefined;
    this.activeTurn = undefined;
    this.activeAssistantItemId = undefined;
    this.activeReasoningItemId = undefined;
    this.activeToolItems.clear();
    this.pendingAsyncDelivery = false;
  }

  clearTurnWatchdog() {
    if (this.turnWatchdog !== undefined) {
      clearTimeout(this.turnWatchdog);
      this.turnWatchdog = undefined;
    }
  }

  armTurnWatchdog(delayMs: number = this.turnInactivityTimeoutMs) {
    this.clearTurnWatchdog();
    if (!this.activeTurnId || this.stopped) return;
    const turnId = this.activeTurnId;
    const timeoutMs = this.turnInactivityTimeoutMs;
    const timer = setTimeout(() => {
      this.turnWatchdog = undefined;
      if (this.stopped || this.activeTurnId !== turnId) return;
      const idleMs = Date.now() - this.turnActivityAt;
      if (idleMs < timeoutMs) {
        this.armTurnWatchdog(timeoutMs - idleMs);
        return;
      }
      if (
        this.agentSession.asyncJobManager &&
        (this.agentSession.asyncJobManager.getRunningJobs().length > 0 ||
          this.agentSession.asyncJobManager.hasPendingDeliveries())
      ) {
        this.armTurnWatchdog();
        return;
      }
      this.failStalledTurn(idleMs);
    }, delayMs);
    timer.unref?.();
    this.turnWatchdog = timer;
  }

  ensureActiveTurn(): TurnId {
    return ensureActiveTurn(this);
  }

  failStalledTurn(idleMs: number) {
    if (!this.activeTurnId) return;
    const message = `OMP produced no session activity for ${String(Math.round(idleMs / 60_000))} minutes and reported no pending async work; failing the turn so the thread accepts new prompts.`;
    const raw = {
      source: "omp.sdk.event" as const,
      method: "turn/watchdog",
      payload: { idleMs },
    } satisfies ProviderRuntimeEvent["raw"];
    const completionBase = this.makeEventBase();
    this.offerRuntimeError({ message, method: "turn/watchdog" });
    this.closeActiveStreamItems("failed", raw);
    this.resetActiveTurnState();
    this.updateSessionSnapshot();
    this.offerRuntimeEvent({
      ...completionBase,
      type: "turn.completed",
      payload: { state: "failed", stopReason: "error", errorMessage: message },
      raw,
    } satisfies ProviderRuntimeEvent);
  }

  completePromptRejection(turnId: TurnId, cause: unknown) {
    completePromptRejection(this, turnId, cause);
  }
}

export function createOmpSidecarSessionHost(
  options?: OmpSidecarHostOptions,
): OmpSidecarSessionHost {
  const loadSdkModule = options?.loadSdk ?? (async () => import("@oh-my-pi/pi-coding-agent"));
  const turnInactivityTimeoutMs = options?.turnInactivityTimeoutMs ?? 10 * 60 * 1000;
  const emit = options?.onRuntimeEvent ?? (() => undefined);
  const sessions = new Map<string, OmpSessionContext>();

  const requireSession = (threadId: string): OmpSessionContext => {
    const context = sessions.get(threadId);
    if (!context) {
      throw new Error(`OMP session for thread ${threadId} not found.`);
    }
    if (context.stopped) {
      throw new Error(`OMP session for thread ${threadId} is closed.`);
    }
    return context;
  };

  const disposeSessionContext = async (context: OmpSessionContext) => {
    context.unsubscribe?.();
    context.unsubscribe = undefined;
    context.stopped = true;
    context.clearTurnWatchdog();
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
      // The sidecar holds no server-side lease; the gateway connection is
      // per-request and scoped to this session by the server.
    }
  };

  const makeEventBase = (context: OmpSessionContext, includeTurnId = true) =>
    context.makeEventBase({ includeTurnId });

  const makeSessionStarted = (context: OmpSessionContext) => {
    context.offerRuntimeEvent({
      ...makeEventBase(context),
      type: "session.started",
      payload: { message: "OMP session started", resume: context.session.resumeCursor },
    } satisfies ProviderRuntimeEvent);
    context.offerRuntimeEvent({
      ...makeEventBase(context),
      type: "thread.started",
      payload: { providerThreadId: context.agentSession.sessionId },
    } satisfies ProviderRuntimeEvent);
  };

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
      context.offerRuntimeEvent({
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

    context.offerRuntimeEvent({
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

  const resolveOmpExtensionUserInput = (
    context: OmpSessionContext,
    requestId: string,
    answers: ProviderUserInputAnswers,
  ): boolean => {
    const pending = context.pendingUserInputs.get(requestId);
    if (!pending) return false;
    pending.resolve(answers);
    return true;
  };

  const makeUiContextFor = (context: OmpSessionContext) => {
    const unsupportedWarnings = new Set<string>();
    return makeOmpExtensionUiContext({
      requestUserInput: (request) => requestOmpExtensionUserInput(context, request),
      warnUnsupported: (method) => {
        // One warning per method per session: extensions call these in loops.
        if (unsupportedWarnings.has(method)) return;
        unsupportedWarnings.add(method);
        context.offerRuntimeEvent({
          ...makeEventBase(context, false),
          type: "runtime.warning",
          payload: {
            message: `OMP extension UI API '${method}' is not supported in NuncioADE yet.`,
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
        context.offerRuntimeEvent({
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
          context.offerRuntimeError({ message, method: "extension/ui/notify" });
          return;
        }
        context.offerRuntimeEvent({
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

  const snapshotThread = (context: OmpSessionContext): OmpSidecarThreadSnapshot => ({
    threadId: context.session.threadId,
    ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
    turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
  });

  const applyTurnModelSelection = async (
    context: OmpSessionContext,
    modelSlug: string | null | undefined,
    thinkingLevelValue: string | null | undefined,
  ) => {
    const model = findModelInRegistry(context.modelRegistry, modelSlug);
    if (modelSlug && !model) {
      throw new Error(
        `OMP model '${modelSlug}' is not available. Pick a discovered model (provider/model slug).`,
      );
    }
    if (model) {
      await context.agentSession.setModel(model);
    }
    const thinkingLevel = toOmpThinkingLevel(thinkingLevelValue);
    if (thinkingLevel) {
      context.agentSession.setThinkingLevel(thinkingLevel);
    }
  };

  const buildProviderText = (input: {
    readonly input?: string;
    readonly attachmentPaths?: ReadonlyArray<string>;
    readonly harnessPolicy?: string;
  }) => {
    const text = buildPromptText({
      ...(input.input !== undefined ? { input: input.input } : {}),
      ...(input.attachmentPaths !== undefined ? { attachmentPaths: input.attachmentPaths } : {}),
    });
    return [input.harnessPolicy, text].filter(Boolean).join("\n\n");
  };

  const startSession = async (input: OmpSidecarStartSessionInput): Promise<ProviderSession> => {
    const cwd = trimToUndefined(input.cwd) ?? process.cwd();
    const sdk = await loadSdkModule();
    const agentDir = trimToUndefined(input.agentDir);
    const requestedModelSlug = input.model;
    const requestedThinkingLevel = input.thinkingLevel;

    let gatewayTools: ReadonlyArray<OmpCodingAgent.ToolDefinition> = [];
    let gatewayConnectError: string | undefined;
    const gatewayControlAvailable = input.gateway !== undefined;
    if (input.gateway) {
      try {
        gatewayTools = await buildOmpAgentGatewayCustomTools({
          connection: input.gateway,
        });
      } catch (cause) {
        gatewayConnectError = toMessage(cause, "NuncioADE MCP catalog load failed.");
      }
    }

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
    // NuncioADE that crumb is inherited from whatever terminal launched
    // the server, so the user's own `omp` CLI would resume a NuncioADE
    // thread's session. Minting the file explicitly avoids the crumb
    // and hands back a resume cursor before the first turn, so a crash
    // right after start is still resumable.
    const sessionFile =
      extractResumeSessionFile(input.resumeCursor) ??
      sdk.SessionManager.createEmptySessionFile(cwd);
    const sessionManager = await sdk.SessionManager.open(sessionFile, undefined, undefined, {
      // When the recorded cwd is gone the engine falls back to the
      // *process* project dir; pin the thread's workspace instead.
      initialCwd: cwd,
      suppressBreadcrumb: true,
    });

    const thinkingLevel = toOmpThinkingLevel(requestedThinkingLevel);
    const createResult = await sdk.createAgentSession({
      cwd,
      ...(agentDir ? { agentDir } : {}),
      authStorage,
      modelRegistry,
      sessionManager,
      ...(model ? { model } : {}),
      // Only override when the user picked a level; otherwise the
      // engine resolves it from its own settings/model roles.
      ...(thinkingLevel ? { thinkingLevel } : {}),
      // NuncioADE IS the UI. The engine gates its interactive surface on
      // this flag — the native `ask` tool is only constructed when it is
      // true (tools/ask.ts) — and setToolUIContext below supplies the
      // context those surfaces render through.
      hasUI: true,
      // On. The engine's own `lsp.lazy` setting (default true) keeps
      // startup to discovery — language servers spawn on the first
      // `lsp` call, not per session — so the cost is bounded by the
      // user's setting rather than by a policy NuncioADE invents. Off
      // would silently drop OMP's code-intelligence tool entirely.
      enableLsp: true,
      // Off. IRC registers the session on the shared agent hub; a
      // desktop host runs many threads at once and would flood the
      // user's roster with sessions they never addressed.
      enableIrc: false,
      // On. The engine discovers and owns the user's MCP servers;
      // NuncioADE's gateway comes in beside them as custom tools.
      enableMCP: true,
      ...(gatewayTools.length > 0 ? { customTools: [...gatewayTools] } : {}),
      // On. The preflight only probes python/ruby/julia when JS eval is
      // disabled (tools/index.ts), so skipping it costs no capability:
      // `eval` stays available through JS and the other kernels are
      // checked at first invocation instead of at every session start.
      skipPythonPreflight: true,
    });

    const now = new Date().toISOString();
    const agentSession = createResult.session;
    const session: ProviderSession = {
      provider: PROVIDER,
      status: "ready",
      runtimeMode: input.runtimeMode,
      cwd,
      threadId: ThreadId.makeUnsafe(input.threadId),
      createdAt: now,
      updatedAt: now,
      ...(agentSession.model
        ? { model: `${agentSession.model.provider}/${agentSession.model.id}` }
        : {}),
      ...(getSessionFile(agentSession) ? { resumeCursor: getSessionFile(agentSession) } : {}),
    };

    const context = new OmpSessionContextImpl({
      session,
      agentSession,
      sessionManager,
      modelRegistry,
      onRuntimeEvent: emit,
      turnInactivityTimeoutMs,
      ...(input.lifecycleGeneration !== undefined
        ? { lifecycleGeneration: input.lifecycleGeneration }
        : {}),
      gatewayControlAvailable,
    });

    const gatewayConnection = input.gateway;
    if (!gatewayControlAvailable && gatewayConnection) {
      // Losing the gateway silently would leave the thread unable to drive
      // NuncioADE while the model is told, without explanation, that NuncioADE
      // control is unavailable.
      context.offerRuntimeEvent({
        ...makeEventBase(context, false),
        type: "runtime.warning",
        payload: {
          message: "NuncioADE MCP control is unavailable in this OMP session.",
          detail: {
            reason: gatewayConnectError ?? "unknown",
            url: gatewayConnection.url,
          },
        },
        raw: {
          source: "omp.sdk.event",
          method: "mcp/gateway-unavailable",
          payload: { reason: gatewayConnectError ?? "unknown" },
        },
      } satisfies ProviderRuntimeEvent);
    }

    context.unsubscribe = agentSession.subscribe((event) => handleSessionEvent(context, event));
    sessions.set(input.threadId, context);

    // `hasUI: true` only declares that a UI exists; this is the object the
    // engine actually renders through — the native `ask` tool, extension
    // select/confirm/input, and the harness `askUserQuestions` extra.
    createResult.setToolUIContext(makeUiContextFor(context), true);

    const loadedExtensions = createResult.extensionsResult.extensions;
    if (loadedExtensions.length > 0) {
      const extensions = loadedExtensions.map((extension) => ({
        name: extension.label ?? extension.path,
        tools: Array.from(extension.tools.keys()),
        commands: Array.from(extension.commands.keys()),
      }));
      context.offerRuntimeEvent({
        ...makeEventBase(context, false),
        type: "runtime.warning",
        payload: {
          message:
            "OMP extensions are loaded with NuncioADE's limited UI bridge. select/confirm/input/notify/status and the ask dialog are supported; TUI-only widgets and editor hooks are ignored.",
          detail: { extensionCount: loadedExtensions.length, extensions },
        },
        raw: {
          source: "omp.sdk.event",
          method: "extension/ui-limited-warning",
          payload: { extensionCount: loadedExtensions.length, extensions },
        },
      } satisfies ProviderRuntimeEvent);
    }

    if (createResult.modelFallbackMessage) {
      context.offerRuntimeEvent({
        ...makeEventBase(context, false),
        type: "runtime.warning",
        payload: { message: createResult.modelFallbackMessage },
        raw: {
          source: "omp.sdk.event",
          method: "session/start",
          payload: { modelFallbackMessage: createResult.modelFallbackMessage },
        },
      } satisfies ProviderRuntimeEvent);
    }

    makeSessionStarted(context);

    const initialUsage = normalizeTokenUsage(
      agentSession.getSessionStats(),
      agentSession.model?.contextWindow,
    );
    context.lastKnownTokenUsage = initialUsage;
    if (initialUsage) {
      context.offerRuntimeEvent({
        ...makeEventBase(context),
        type: "thread.token-usage.updated",
        payload: { usage: initialUsage },
      } satisfies ProviderRuntimeEvent);
    }

    return context.session;
  };

  const sendTurn = async (
    input: OmpSidecarSendTurnInput,
  ): Promise<{ turnId: string; resumeCursor?: string }> => {
    const context = requireSession(input.threadId);
    if (context.activeTurnId) {
      throw new Error("An OMP turn is already active for this thread.");
    }
    const text = buildProviderText(input);
    const turnId = TurnId.makeUnsafe(crypto.randomUUID());
    context.activeTurnId = turnId;
    context.turns.push({ id: turnId, items: [] });
    context.updateSessionSnapshot();
    context.armTurnWatchdog();
    context.agentSession.prompt(text).catch((cause) => {
      context.completePromptRejection(turnId, cause);
    });
    const resumeCursor = getSessionFile(context.agentSession);
    return { turnId, ...(resumeCursor ? { resumeCursor } : {}) };
  };

  const steerTurn = async (
    input: OmpSidecarSendTurnInput,
  ): Promise<{ turnId: string; resumeCursor?: string }> => {
    const context = requireSession(input.threadId);
    const text = buildProviderText(input);
    const turnId = context.activeTurnId ?? TurnId.makeUnsafe(crypto.randomUUID());
    if (!context.activeTurnId) {
      context.activeTurnId = turnId;
      context.turns.push({ id: turnId, items: [] });
      context.armTurnWatchdog();
    }
    if (context.agentSession.isStreaming) {
      await context.agentSession.steer(text);
    } else {
      context.agentSession.prompt(text).catch((cause) => {
        context.completePromptRejection(turnId, cause);
      });
    }
    const resumeCursor = getSessionFile(context.agentSession);
    return { turnId, ...(resumeCursor ? { resumeCursor } : {}) };
  };

  const interruptTurn = async (params: { threadId: string }): Promise<null> => {
    const context = requireSession(params.threadId);
    await context.agentSession.abort();
    return null;
  };

  const respondToUserInput = async (input: {
    threadId: string;
    requestId: string;
    answers: ProviderUserInputAnswers;
  }): Promise<null> => {
    const context = requireSession(input.threadId);
    if (!resolveOmpExtensionUserInput(context, input.requestId, input.answers)) {
      throw new Error(
        `No pending OMP user-input request ${input.requestId} for thread ${input.threadId}.`,
      );
    }
    return null;
  };

  const compactThread = async (params: { threadId: string }): Promise<null> => {
    const context = requireSession(params.threadId);
    await context.agentSession.compact();
    return null;
  };

  const stopTask = async (input: { threadId: string; taskId: string }): Promise<null> => {
    const context = requireSession(input.threadId);
    // Background work is the engine's async job registry, so "stop task"
    // is a job cancel; a false return means the id is unknown or finished.
    if (context.agentSession.asyncJobManager?.cancel(input.taskId) !== true) {
      throw new Error(
        `OMP has no cancellable background job '${input.taskId}' for thread ${input.threadId}.`,
      );
    }
    return null;
  };

  const readThread = async (params: { threadId: string }): Promise<OmpSidecarThreadSnapshot> => {
    const context = requireSession(params.threadId);
    return snapshotThread(context);
  };

  const rollbackThread = async (input: {
    threadId: string;
    numTurns: number;
  }): Promise<OmpSidecarThreadSnapshot> => {
    const context = requireSession(input.threadId);
    const nextLength = Math.max(0, context.turns.length - Math.max(0, input.numTurns));
    context.turns.splice(nextLength);
    const leafId = context.turns.at(-1)?.leafId;
    if (leafId) {
      context.sessionManager.branch(leafId);
    } else if (nextLength === 0) {
      context.sessionManager.resetLeaf();
    }
    return snapshotThread(context);
  };

  const stopSession = async (params: { threadId: string }): Promise<null> => {
    const context = sessions.get(params.threadId);
    if (!context) return null;
    await disposeSessionContext(context);
    if (sessions.get(params.threadId) === context) {
      sessions.delete(params.threadId);
    }
    context.offerRuntimeEvent({
      ...makeEventBase(context),
      type: "thread.state.changed",
      payload: { state: "closed", detail: { reason: "stopped" } },
    } satisfies ProviderRuntimeEvent);
    context.offerRuntimeEvent({
      ...makeEventBase(context),
      type: "session.exited",
      payload: { reason: "stopped", exitKind: "graceful" },
    } satisfies ProviderRuntimeEvent);
    return null;
  };

  const listSessions = async (): Promise<ReadonlyArray<ProviderSession>> => {
    return Array.from(sessions.values()).map(makeSessionSnapshot);
  };

  const hasSession = async (params: { threadId: string }): Promise<boolean> => {
    return sessions.has(params.threadId);
  };

  const stopAll = async (): Promise<null> => {
    await Promise.all(Array.from(sessions.keys()).map((threadId) => stopSession({ threadId })));
    return null;
  };

  const listModels = async (input: {
    agentDir?: string;
    refresh?: boolean;
  }): Promise<ProviderListModelsResult> => {
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
    return { models, source: "omp.sdk", cached: false };
  };

  const listSkills = async (input: {
    cwd: string;
    agentDir?: string;
  }): Promise<ProviderListSkillsResult> => {
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
    };
  };

  const listCommands = async (input: {
    cwd: string;
    agentDir?: string;
    threadId?: string;
  }): Promise<ProviderListCommandsResult> => {
    const sdk = await loadSdkModule();
    const active = input.threadId ? sessions.get(input.threadId) : undefined;
    const [fileCommands, skills] = await Promise.all([
      sdk.discoverSlashCommands({ cwd: input.cwd }),
      sdk.discoverSkills(input.cwd, trimToUndefined(input.agentDir)),
    ]);
    // Extension commands only exist on a live session; discovery-only
    // callers still get the file/skill commands.
    const extensionCommands = active
      ? (active.agentSession.extensionRunner?.getRegisteredCommands() ?? []).map((command) => ({
          name: command.name,
          description: trimToUndefined(command.description) ?? "Extension command",
        }))
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
    };
  };

  const getComposerCapabilities = async (): Promise<ProviderComposerCapabilities> => {
    return {
      provider: PROVIDER,
      supportsSkillMentions: true,
      supportsSkillDiscovery: true,
      supportsNativeSlashCommandDiscovery: true,
      supportsPluginMentions: false,
      supportsPluginDiscovery: false,
      supportsRuntimeModelList: true,
      supportsThreadCompaction: true,
      supportsThreadImport: false,
    };
  };

  return {
    startSession,
    stopSession,
    stopAll,
    listSessions,
    hasSession,
    sendTurn,
    steerTurn,
    interruptTurn,
    stopTask,
    respondToUserInput,
    readThread,
    rollbackThread,
    compactThread,
    listModels,
    listSkills,
    listCommands,
    getComposerCapabilities,
  };
}
