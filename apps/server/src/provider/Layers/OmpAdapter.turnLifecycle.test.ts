// FILE: OmpAdapter.turnLifecycle.test.ts
// Purpose: Pins the two M4 turn-lifecycle risks — an async-result follow-up must
//          reuse the open turn (or mint one) instead of being dropped, and the
//          watchdog must free a wedged turn without killing a turn the engine is
//          still going to resume — plus the phase-3 event mapping.
// Layer: Provider adapter tests
// Depends on: the OmpAdapterLiveOptions.loadSdk seam driving AgentSession events.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { vi } from "vitest";
import assert from "node:assert/strict";
import { ApprovalRequestId, ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { OmpAdapter } from "../Services/OmpAdapter.ts";
import { makeOmpAdapterLive } from "./OmpAdapter.ts";
import type { OmpExtensionUiContext } from "../ompExtensionUiContext.ts";

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

/** Set by the adapter through `setToolUIContext`; the engine's ask surface. */
const capturedUiContext: { context: unknown } = { context: undefined };

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
    open: async () => fakeSessionManager,
  },
  createAgentSession: async () => ({
    session: fakeSession,
    // Phase 4 wiring: the adapter binds its UI bridge and reports what loaded.
    setToolUIContext: (context: unknown) => {
      capturedUiContext.context = context;
    },
    extensionsResult: { extensions: [] as unknown[] },
  }),
};

const loadSdk = async () => fakeSdk as never;

function resetFake() {
  listeners.clear();
  agentState.error = undefined;
  engineWork.runningJobs = 0;
  engineWork.pendingDeliveries = false;
}

/**
 * The adapter's event stream is queue-backed and never ends on its own, so a
 * plain `forkChild` over it deadlocks the test and `Stream.timeout` does not
 * halt it either. Bounding by "the Nth turn.completed for this thread" is both
 * deterministic and exactly the lifecycle boundary these tests care about.
 */
const collectTurnCompletions = (
  adapter: { readonly streamEvents: Stream.Stream<ProviderRuntimeEvent> },
  threadId: ThreadId,
  completions: number,
) => {
  let seen = 0;
  return Stream.runCollect(
    adapter.streamEvents.pipe(
      Stream.takeUntil(
        (event) =>
          event.threadId === threadId && event.type === "turn.completed" && ++seen >= completions,
      ),
    ),
  ).pipe(Effect.forkChild);
};

const startedSession = (threadId: ThreadId, completions = 1) =>
  Effect.gen(function* () {
    const adapter = yield* OmpAdapter;
    const collector = yield* collectTurnCompletions(adapter, threadId, completions);
    yield* adapter.startSession({ threadId, runtimeMode: "local", cwd: process.cwd() } as never);
    return { adapter, collector };
  });

// Tests in one `it.layer` block share the adapter queue, so a previous test's
// teardown events can still be in flight; scope every assertion by thread.
const eventsFor = (collected: Iterable<ProviderRuntimeEvent>, threadId: ThreadId) =>
  Array.from(collected).filter((event) => event.threadId === threadId);

const testLayers = (options?: { readonly turnInactivityTimeoutMs?: number }) =>
  makeOmpAdapterLive({
    loadSdk,
    ...(options?.turnInactivityTimeoutMs !== undefined
      ? { turnInactivityTimeoutMs: options.turnInactivityTimeoutMs }
      : {}),
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  );

it.layer(testLayers())("OMP async-result follow-up turns", (it) => {
  it.effect("keeps one turn across a non-terminal agent_end and completes it once", () =>
    Effect.gen(function* () {
      resetFake();
      const threadId = ThreadId.makeUnsafe("thread-omp-async-followup");
      const { adapter, collector } = yield* startedSession(threadId);

      const started = yield* adapter.sendTurn({ threadId, input: "run a job" } as never);

      emitOmp({ type: "agent_start" });
      emitOmp({ type: "turn_start" });
      emitOmp({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_delta", delta: "starting", contentIndex: 0 },
      });
      // Backgrounded bash: the engine ends the run but promises to resume.
      engineWork.runningJobs = 1;
      emitOmp({ type: "agent_end", messages: [], isTerminal: false });
      // ...the job finishes and its result is injected as a follow-up turn.
      engineWork.runningJobs = 0;
      emitOmp({ type: "agent_start" });
      emitOmp({ type: "turn_start" });
      emitOmp({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_delta", delta: "job done", contentIndex: 0 },
      });
      emitOmp({ type: "agent_end", messages: [], isTerminal: true });

      const events = eventsFor(yield* Fiber.join(collector), threadId);
      const completions = events.filter((event) => event.type === "turn.completed");
      assert.equal(completions.length, 1, "exactly one turn.completed across the async gap");
      const completion = completions[0];
      assert.ok(completion && completion.type === "turn.completed");
      assert.equal(completion.payload.state, "completed");

      // The whole point of RISK #1: the follow-up must stay on the turn Synara
      // dispatched, because the ingress drops a terminal event whose turn id
      // conflicts with the active one (provider/terminalTurnApplicability.ts).
      const followUpDelta = events.find(
        (event) => event.type === "content.delta" && event.payload.delta === "job done",
      );
      assert.ok(followUpDelta, "post-async delta is emitted");
      assert.equal(followUpDelta.turnId, started.turnId, "follow-up delta keeps the turn id");
      assert.equal(completion.turnId, started.turnId, "completion keeps the turn id");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("mints a provider-initiated turn when the result lands after the turn settled", () =>
    Effect.gen(function* () {
      resetFake();
      const threadId = ThreadId.makeUnsafe("thread-omp-late-followup");
      const { adapter, collector } = yield* startedSession(threadId, 2);

      const started = yield* adapter.sendTurn({ threadId, input: "hello" } as never);
      emitOmp({ type: "agent_start" });
      emitOmp({ type: "turn_start" });
      emitOmp({ type: "agent_end", messages: [], isTerminal: true });
      // `agent_end` settles the turn synchronously, so no wait is needed here.

      // Nothing is open now: an async delivery that arrives late must still be
      // attributable, or its events would land on a turn nobody owns.
      emitOmp({ type: "agent_start" });
      emitOmp({ type: "turn_start" });
      emitOmp({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_delta", delta: "late result", contentIndex: 0 },
      });
      emitOmp({ type: "agent_end", messages: [], isTerminal: true });

      const events = eventsFor(yield* Fiber.join(collector), threadId);
      const completions = events.filter((event) => event.type === "turn.completed");
      assert.equal(completions.length, 2, "the late follow-up completes its own turn");
      const secondTurnId = completions[1]?.turnId;
      assert.ok(secondTurnId, "provider-initiated turn carries a turn id");
      assert.notEqual(secondTurnId, started.turnId, "it is a new turn, not the settled one");

      const lateDelta = events.find(
        (event) => event.type === "content.delta" && event.payload.delta === "late result",
      );
      assert.ok(lateDelta);
      assert.equal(lateDelta.turnId, secondTurnId, "late delta is attributed to the minted turn");

      yield* adapter.stopSession(threadId);
    }),
  );
});

it.layer(testLayers())("OMP event mapping v1", (it) => {
  it.effect("projects tool lifecycle, task list, and notices onto canonical events", () =>
    Effect.gen(function* () {
      resetFake();
      const threadId = ThreadId.makeUnsafe("thread-omp-mapping");
      const { adapter, collector } = yield* startedSession(threadId);

      yield* adapter.sendTurn({ threadId, input: "do work" } as never);
      emitOmp({ type: "agent_start" });
      emitOmp({ type: "turn_start" });
      emitOmp({
        type: "tool_execution_start",
        toolCallId: "tc-1",
        toolName: "bash",
        args: { command: "ls -la" },
      });
      emitOmp({
        type: "tool_execution_end",
        toolCallId: "tc-1",
        toolName: "bash",
        result: { stdout: "total 0\n", exitCode: 0 },
        isError: false,
      });
      emitOmp({
        type: "todo_reminder",
        todos: [
          { content: "write tests", status: "in_progress" },
          { content: "ship it", status: "pending" },
        ],
        attempt: 1,
        maxAttempts: 3,
      });
      emitOmp({ type: "notice", level: "warning", message: "disk is nearly full" });
      emitOmp({ type: "retry_fallback_applied", from: "a/one", to: "b/two", role: "default" });
      emitOmp({ type: "agent_end", messages: [], isTerminal: true });

      const events = eventsFor(yield* Fiber.join(collector), threadId);

      const toolStarted = events.find((event) => event.type === "item.started");
      assert.ok(toolStarted && toolStarted.type === "item.started");
      assert.equal(toolStarted.payload.itemType, "command_execution");
      assert.equal(toolStarted.payload.title, "ls -la");

      const toolCompleted = events.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "command_execution",
      );
      assert.ok(toolCompleted && toolCompleted.type === "item.completed");
      assert.equal(toolCompleted.payload.status, "completed");
      // Trailing newlines fail the durable journal's trimmed-string contract.
      assert.equal(toolCompleted.payload.detail, "total 0");

      const tasks = events.find((event) => event.type === "turn.tasks.updated");
      assert.ok(tasks && tasks.type === "turn.tasks.updated");
      assert.deepEqual(
        tasks.payload.tasks.map((task) => [task.task, task.status]),
        [
          ["write tests", "inProgress"],
          ["ship it", "pending"],
        ],
      );

      const warning = events.find(
        (event) =>
          event.type === "runtime.warning" && event.payload.message === "disk is nearly full",
      );
      assert.ok(warning, "an info/warning notice surfaces as runtime.warning");

      const rerouted = events.find((event) => event.type === "model.rerouted");
      assert.ok(rerouted && rerouted.type === "model.rerouted");
      assert.equal(rerouted.payload.fromModel, "a/one");
      assert.equal(rerouted.payload.toModel, "b/two");

      assert.ok(
        events.some((event) => event.type === "thread.token-usage.updated"),
        "token usage is reported from getSessionStats",
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("classifies an aborted turn as interrupted rather than failed", () =>
    Effect.gen(function* () {
      resetFake();
      const threadId = ThreadId.makeUnsafe("thread-omp-abort");
      const { adapter, collector } = yield* startedSession(threadId);

      yield* adapter.sendTurn({ threadId, input: "long job" } as never);
      emitOmp({ type: "agent_start" });
      emitOmp({ type: "turn_start" });
      agentState.error = "AbortError: The operation was aborted";
      emitOmp({ type: "agent_end", messages: [], isTerminal: true });

      const events = eventsFor(yield* Fiber.join(collector), threadId);
      const completion = events.find((event) => event.type === "turn.completed");
      assert.ok(completion && completion.type === "turn.completed");
      assert.equal(completion.payload.state, "interrupted");
      assert.equal(completion.payload.stopReason, "aborted");
      assert.equal(
        events.some((event) => event.type === "runtime.error"),
        false,
        "a user abort is not a runtime error",
      );

      yield* adapter.stopSession(threadId);
    }),
  );
});

it.layer(testLayers({ turnInactivityTimeoutMs: 40 }))("OMP turn watchdog", (it) => {
  it.effect("fails a turn the engine silently abandoned so the thread unwedges", () =>
    Effect.gen(function* () {
      resetFake();
      const threadId = ThreadId.makeUnsafe("thread-omp-wedged");
      const { adapter, collector } = yield* startedSession(threadId);

      yield* adapter.sendTurn({ threadId, input: "hello" } as never);
      emitOmp({ type: "agent_start" });
      emitOmp({ type: "turn_start" });
      // The engine promised a follow-up, then never delivered and reports no
      // pending work: without the watchdog `activeTurnId` would stay set forever
      // and every later prompt would be rejected as "a turn is already active".
      emitOmp({ type: "agent_end", messages: [], isTerminal: false });

      const events = eventsFor(yield* Fiber.join(collector), threadId);
      const completion = events.find((event) => event.type === "turn.completed");
      assert.ok(completion && completion.type === "turn.completed", "watchdog closes the turn");
      assert.equal(completion.payload.state, "failed");

      // The real regression this guards: the thread accepts work again.
      const next = yield* adapter.sendTurn({ threadId, input: "still alive?" } as never);
      assert.ok(next.turnId, "a new turn can start after the watchdog fired");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("leaves the turn open while the engine still reports async work", () =>
    Effect.gen(function* () {
      resetFake();
      const threadId = ThreadId.makeUnsafe("thread-omp-async-pending");
      // A watchdog misfire would land a `failed` completion here first, which is
      // what the single-completion assertion below rejects.
      const { adapter, collector } = yield* startedSession(threadId);

      yield* adapter.sendTurn({ threadId, input: "background it" } as never);
      emitOmp({ type: "agent_start" });
      emitOmp({ type: "turn_start" });
      engineWork.runningJobs = 1;
      emitOmp({ type: "agent_end", messages: [], isTerminal: false });

      // Drive five watchdog windows without real waiting. Only setTimeout is
      // faked: Effect's fiber scheduling must keep using the real microtask
      // queue or `Fiber.join` below would never resume.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.advanceTimersByTime(220);
      vi.useRealTimers();

      // Draining the job lets the follow-up finish the turn normally.
      engineWork.runningJobs = 0;
      emitOmp({ type: "agent_start" });
      emitOmp({ type: "turn_start" });
      emitOmp({ type: "agent_end", messages: [], isTerminal: true });
      const events = eventsFor(yield* Fiber.join(collector), threadId);
      const completions = events.filter((event) => event.type === "turn.completed");
      assert.equal(
        completions.length,
        1,
        "pending engine work must not trigger a watchdog completion",
      );
      const completion = completions[0];
      assert.ok(completion && completion.type === "turn.completed");
      assert.equal(completion.payload.state, "completed");

      yield* adapter.stopSession(threadId);
    }),
  );
});

/** Collects until the engine's question surfaces, so the id can be answered. */
const collectUserInputRequest = (
  adapter: { readonly streamEvents: Stream.Stream<ProviderRuntimeEvent> },
  threadId: ThreadId,
) =>
  Stream.runCollect(
    adapter.streamEvents.pipe(
      Stream.takeUntil(
        (event) => event.threadId === threadId && event.type === "user-input.requested",
      ),
    ),
  ).pipe(Effect.forkChild);

it.layer(testLayers())("OMP extension UI bridge", (it) => {
  it.effect("parks an engine question until Synara answers it", () =>
    Effect.gen(function* () {
      resetFake();
      const threadId = ThreadId.makeUnsafe("thread-omp-ask");
      const adapter = yield* OmpAdapter;
      const collector = yield* collectUserInputRequest(adapter, threadId);
      yield* adapter.startSession({ threadId, runtimeMode: "local", cwd: process.cwd() } as never);

      // This is the object the engine's native `ask` tool renders through.
      const uiContext = capturedUiContext.context as OmpExtensionUiContext | undefined;
      assert.ok(uiContext, "the adapter must hand the engine a UI context");
      const answered = uiContext.select("Pick an action", ["Deploy", "Rollback"]);

      const request = eventsFor(yield* Fiber.join(collector), threadId).find(
        (event) => event.type === "user-input.requested",
      );
      assert.ok(request && request.type === "user-input.requested");
      assert.ok(request.requestId, "the dialog must carry an id Synara can answer");
      assert.deepEqual(
        request.payload.questions[0]?.options?.map((option) => option.label),
        ["Deploy", "Rollback"],
      );

      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.makeUnsafe(request.requestId), {
        selection: "Deploy",
      });
      assert.equal(yield* Effect.promise(() => answered), "Deploy");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects an answer to a request the session never made", () =>
    Effect.gen(function* () {
      resetFake();
      const threadId = ThreadId.makeUnsafe("thread-omp-ask-unknown");
      const adapter = yield* OmpAdapter;
      yield* adapter.startSession({ threadId, runtimeMode: "local", cwd: process.cwd() } as never);

      const failure = yield* adapter
        .respondToUserInput(threadId, ApprovalRequestId.makeUnsafe("nope"), {})
        .pipe(Effect.flip);
      assert.match(String(failure), /No pending OMP user-input request/);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("releases a pending question when the session is torn down", () =>
    Effect.gen(function* () {
      resetFake();
      const threadId = ThreadId.makeUnsafe("thread-omp-ask-teardown");
      const adapter = yield* OmpAdapter;
      const collector = yield* collectUserInputRequest(adapter, threadId);
      yield* adapter.startSession({ threadId, runtimeMode: "local", cwd: process.cwd() } as never);

      const uiContext = capturedUiContext.context as OmpExtensionUiContext | undefined;
      assert.ok(uiContext);
      const answered = uiContext.confirm("Delete", "Really delete?");
      yield* Fiber.join(collector);

      // The engine blocks a tool call on this promise; teardown must settle it
      // rather than leave the turn hanging on a dialog nobody can answer.
      yield* adapter.stopSession(threadId);
      assert.equal(yield* Effect.promise(() => answered), false);
    }),
  );
});
