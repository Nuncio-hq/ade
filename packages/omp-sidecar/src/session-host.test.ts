// FILE: session-host.test.ts
// Purpose: Regression net for the engine half of the OMP integration after it
//          moved out of the Node adapter. Pins the two turn-lifecycle risks
//          (async-result follow-up, watchdog), event mapping v1, and the session
//          resume discipline.
// Layer: @nuncio/omp-sidecar tests
// Depends on: the `loadSdk` seam driving fake AgentSession events.

import type { ProviderRuntimeEvent } from "@nuncio/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { createOmpSidecarSessionHost } from "./session-host";

type OmpEventListener = (event: unknown) => void;

const listeners = new Set<OmpEventListener>();
const emitOmp = (event: unknown) => {
  for (const listener of Array.from(listeners)) listener(event);
};

/** Shape read by normalizeTokenUsage (SessionStats). */
const sessionStats = {
  sessionFile: "/tmp/omp-session-1.jsonl",
  sessionId: "omp-session-1",
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 2,
  tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
  premiumRequests: 0,
  cost: 0,
  contextUsage: { tokens: 15, contextWindow: 200_000, percent: 1 },
};

const agentState: { error: string | undefined } = { error: undefined };
const engineWork = { runningJobs: 0, pendingDeliveries: false };

const fakeSessionManager = {
  getLeafId: () => "leaf-1",
  branch: () => undefined,
  resetLeaf: () => undefined,
};

const fakeSession = {
  sessionId: "omp-session-1",
  sessionFile: "/tmp/omp-session-1.jsonl",
  model: { provider: "anthropic", id: "claude-fable-5", contextWindow: 200_000 },
  thinkingLevel: "medium",
  isStreaming: false,
  agent: { state: agentState },
  asyncJobManager: {
    getRunningJobs: () => new Array<unknown>(engineWork.runningJobs).fill({}),
    hasPendingDeliveries: () => engineWork.pendingDeliveries,
  },
  subscribe(listener: OmpEventListener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSessionStats: () => sessionStats,
  prompt: async () => true,
  steer: async () => undefined,
  abort: async () => undefined,
  dispose: async () => undefined,
  setModel: async () => undefined,
  setThinkingLevel: () => undefined,
};

const capturedUiContext: { context: unknown } = { context: undefined };

/** How the host obtained its SessionManager — mint-then-open vs resume. */
const sessionManagerCalls: Array<{
  readonly op: "mint" | "open";
  readonly arg: string;
  readonly options?: unknown;
}> = [];

const fakeSdk = {
  discoverAuthStorage: async () => ({}),
  ModelRegistry: class {
    find() {
      return fakeSession.model;
    }
    getAll() {
      return [fakeSession.model];
    }
    getAvailable() {
      return [fakeSession.model];
    }
    async refresh() {
      return undefined;
    }
  },
  SessionManager: {
    create: () => fakeSessionManager,
    createEmptySessionFile: (cwd: string) => {
      sessionManagerCalls.push({ op: "mint", arg: cwd });
      return "/tmp/omp-minted-session.jsonl";
    },
    open: async (file: string, _dir: unknown, _storage: unknown, options?: unknown) => {
      sessionManagerCalls.push({ op: "open", arg: file, options });
      return fakeSessionManager;
    },
  },
  createAgentSession: async () => ({
    session: fakeSession,
    setToolUIContext: (context: unknown) => {
      capturedUiContext.context = context;
    },
    extensionsResult: { extensions: [] as unknown[] },
  }),
};

const loadSdk = async () => fakeSdk as never;

function makeHost(options?: { readonly turnInactivityTimeoutMs?: number }) {
  const events: ProviderRuntimeEvent[] = [];
  const host = createOmpSidecarSessionHost({
    loadSdk,
    ...(options?.turnInactivityTimeoutMs !== undefined
      ? { turnInactivityTimeoutMs: options.turnInactivityTimeoutMs }
      : {}),
    onRuntimeEvent: (event) => events.push(event),
  });
  return { host, events };
}

const startInput = (threadId: string, extra?: Record<string, unknown>) =>
  ({
    threadId,
    runtimeMode: "full-access",
    cwd: process.cwd(),
    ...extra,
  }) as never;

const completions = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.filter((event) => event.type === "turn.completed");

beforeEach(() => {
  listeners.clear();
  agentState.error = undefined;
  engineWork.runningJobs = 0;
  engineWork.pendingDeliveries = false;
  sessionManagerCalls.length = 0;
  capturedUiContext.context = undefined;
});

describe("OMP async-result follow-up turns", () => {
  it("keeps one turn across a non-terminal agent_end and completes it once", async () => {
    const { host, events } = makeHost();
    await host.startSession(startInput("thread-followup"));
    const started = await host.sendTurn({ threadId: "thread-followup", input: "run a job" });

    emitOmp({ type: "agent_start" });
    emitOmp({ type: "turn_start" });
    // Non-terminal: the engine promised to resume this turn once the async
    // result lands, so the turn must stay open across the gap.
    emitOmp({ type: "agent_end", messages: [], isTerminal: false });
    emitOmp({ type: "turn_start" });
    emitOmp({ type: "agent_end", messages: [], isTerminal: true });

    const settled = completions(events);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.turnId).toBe(started.turnId);
    await host.stopSession({ threadId: "thread-followup" });
  });

  it("mints a provider-initiated turn when the result lands after the turn settled", async () => {
    const { host, events } = makeHost();
    await host.startSession(startInput("thread-late"));
    await host.sendTurn({ threadId: "thread-late", input: "hello" });

    emitOmp({ type: "agent_start" });
    emitOmp({ type: "turn_start" });
    emitOmp({ type: "agent_end", messages: [], isTerminal: true });
    // Nothing is open now; a late delivery must still land on a turn nobody owns.
    emitOmp({ type: "agent_start" });
    emitOmp({ type: "turn_start" });
    emitOmp({ type: "agent_end", messages: [], isTerminal: true });

    const settled = completions(events);
    expect(settled).toHaveLength(2);
    expect(settled[1]?.turnId).toBeTruthy();
    expect(settled[1]?.turnId).not.toBe(settled[0]?.turnId);
    await host.stopSession({ threadId: "thread-late" });
  });
});

describe("OMP event mapping v1", () => {
  it("projects tool lifecycle and notices onto canonical events", async () => {
    const { host, events } = makeHost();
    await host.startSession(startInput("thread-mapping"));
    await host.sendTurn({ threadId: "thread-mapping", input: "do work" });

    emitOmp({ type: "agent_start" });
    emitOmp({ type: "turn_start" });
    emitOmp({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "echo hi" },
    });
    emitOmp({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: { output: "hi" },
      isError: false,
    });
    emitOmp({ type: "notice", level: "warning", message: "heads up" });
    emitOmp({ type: "agent_end", messages: [], isTerminal: true });

    expect(events.some((event) => event.type === "item.started")).toBe(true);
    expect(events.some((event) => event.type === "item.completed")).toBe(true);
    expect(events.some((event) => event.type === "runtime.warning")).toBe(true);
    await host.stopSession({ threadId: "thread-mapping" });
  });

  it("classifies an aborted turn as interrupted rather than failed", async () => {
    const { host, events } = makeHost();
    await host.startSession(startInput("thread-abort"));
    await host.sendTurn({ threadId: "thread-abort", input: "long job" });

    emitOmp({ type: "agent_start" });
    emitOmp({ type: "turn_start" });
    agentState.error = "operation was aborted";
    emitOmp({ type: "agent_end", messages: [], isTerminal: true });

    const settled = completions(events);
    expect(settled[0]?.type === "turn.completed" && settled[0].payload.state).toBe("interrupted");
    await host.stopSession({ threadId: "thread-abort" });
  });
});

describe("OMP turn watchdog", () => {
  it("fails a turn the engine silently abandoned so the thread unwedges", async () => {
    const { host, events } = makeHost({ turnInactivityTimeoutMs: 40 });
    await host.startSession(startInput("thread-wedged"));
    await host.sendTurn({ threadId: "thread-wedged", input: "hello" });

    emitOmp({ type: "agent_start" });
    // No terminal event ever arrives.
    await new Promise((resolve) => setTimeout(resolve, 120));

    const settled = completions(events);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.type === "turn.completed" && settled[0].payload.state).toBe("failed");
    await host.stopSession({ threadId: "thread-wedged" });
  });

  it("leaves the turn open while the engine still reports async work", async () => {
    const { host, events } = makeHost({ turnInactivityTimeoutMs: 40 });
    await host.startSession(startInput("thread-busy"));
    await host.sendTurn({ threadId: "thread-busy", input: "background it" });

    emitOmp({ type: "agent_start" });
    engineWork.runningJobs = 1;
    await new Promise((resolve) => setTimeout(resolve, 140));
    expect(completions(events)).toHaveLength(0);

    // Draining the job lets the turn finish normally.
    engineWork.runningJobs = 0;
    emitOmp({ type: "turn_start" });
    emitOmp({ type: "agent_end", messages: [], isTerminal: true });
    expect(completions(events)).toHaveLength(1);
    await host.stopSession({ threadId: "thread-busy" });
  });
});

describe("OMP session resume", () => {
  it("mints its own session file so a thread is resumable before its first turn", async () => {
    const { host } = makeHost();
    const session = await host.startSession(startInput("thread-fresh"));

    // `SessionManager.create` stamps a terminal breadcrumb that would point the
    // user's own `omp` CLI at this session, so the host mints and opens instead.
    expect(sessionManagerCalls.map((call) => call.op)).toEqual(["mint", "open"]);
    expect(sessionManagerCalls[1]?.options).toEqual({
      initialCwd: process.cwd(),
      suppressBreadcrumb: true,
    });
    expect(session.resumeCursor).toBe("/tmp/omp-session-1.jsonl");
    await host.stopSession({ threadId: "thread-fresh" });
  });

  it("reopens the persisted session file instead of starting a new one", async () => {
    const { host } = makeHost();
    await host.startSession(
      startInput("thread-resume", { resumeCursor: "/tmp/omp-restored.jsonl" }),
    );

    expect(sessionManagerCalls.map((call) => call.op)).toEqual(["open"]);
    expect(sessionManagerCalls[0]?.arg).toBe("/tmp/omp-restored.jsonl");
    await host.stopSession({ threadId: "thread-resume" });
  });
});
