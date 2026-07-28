// FILE: PiAdapter.turnLifecycle.test.ts
// Purpose: Verifies a Pi turn survives auto-retry and completes exactly once on agent_settled.
// Layer: Provider adapter tests
// Depends on: a minimal fake of @earendil-works/pi-coding-agent driving AgentSession events.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
// vi.mock is hoisted by the vitest transform, so it must come from "vitest".
import { vi } from "vitest";
import assert from "node:assert/strict";
import { ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { PiAdapter } from "../Services/PiAdapter.ts";

type PiEventListener = (event: any) => void;

const listeners = new Set<PiEventListener>();
const emitPi = (event: unknown) => {
  for (const listener of Array.from(listeners)) listener(event);
};

/** Session stats shape read by normalizeTokenUsage. */
const sessionStats = {
  tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
  contextUsage: { tokens: 15, contextWindow: 200_000, percent: 1 },
};

const agentState: { errorMessage: string | undefined } = { errorMessage: undefined };

const fakeSession = {
  sessionId: "pi-session-1",
  sessionFile: "/tmp/pi-session-1.jsonl",
  model: { provider: "anthropic", id: "claude-fable-5", contextWindow: 200_000 },
  thinkingLevel: "medium",
  isStreaming: false,
  messages: [] as unknown[],
  agent: { state: agentState },
  promptTemplates: [] as unknown[],
  sessionManager: {
    getCwd: () => process.cwd(),
    getSessionFile: () => "/tmp/pi-session-1.jsonl",
    getLeafId: () => "leaf-1",
    branch: () => undefined,
    resetLeaf: () => undefined,
  },
  resourceLoader: {
    getExtensions: () => ({ extensions: [] }),
    getSkills: () => ({ skills: [] }),
    getPrompts: () => ({ prompts: [] }),
    reload: async () => undefined,
  },
  extensionRunner: { getRegisteredCommands: () => [] },
  subscribe(listener: PiEventListener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  bindExtensions: async () => undefined,
  getSessionStats: () => sessionStats,
  prompt: async () => undefined,
  steer: async () => undefined,
  abort: async () => undefined,
  compact: async () => undefined,
  reload: async () => undefined,
  setModel: async () => undefined,
  setThinkingLevel: () => undefined,
};

const fakeServices = {
  modelRuntime: {},
  settingsManager: {
    getShellPath: () => undefined,
    getShellCommandPrefix: () => undefined,
  },
  resourceLoader: fakeSession.resourceLoader,
  diagnostics: {},
};

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/tmp/pi-agent-dir",
  getShellConfig: () => ({ shell: "/bin/sh", args: ["-c"], commandTransport: "arg" }),
  defineTool: (tool: unknown) => tool,
  createBashToolDefinition: () => ({ name: "bash" }),
  ModelRuntime: { create: async () => ({}) },
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
    getProviderDisplayName() {
      return "Anthropic";
    }
  },
  SessionManager: {
    create: () => fakeSession.sessionManager,
    open: () => fakeSession.sessionManager,
  },
  createAgentSessionServices: async () => fakeServices,
  createAgentSessionFromServices: async () => ({ session: fakeSession }),
  createAgentSessionRuntime: async (factory: any, options: any) => {
    const created = await factory({
      cwd: options.cwd,
      agentDir: options.agentDir,
      sessionManager: options.sessionManager,
    });
    return { ...created, dispose: async () => undefined };
  },
}));

const { makePiAdapterLive } = await import("./PiAdapter.ts");

const threadId = ThreadId.makeUnsafe("thread-pi-lifecycle");

const layer = it.layer(
  makePiAdapterLive().pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("Pi turn lifecycle across auto-retry", (it) => {
  it.effect("completes the turn once on agent_settled, not on a retrying agent_end", () =>
    Effect.gen(function* () {
      const adapter = yield* PiAdapter;
      agentState.errorMessage = undefined;
      listeners.clear();

      // Collect the whole event stream for this turn; the terminal turn.completed
      // is what the assertions are about.
      const collected = yield* Stream.runCollect(
        adapter.streamEvents.pipe(
          Stream.takeUntil((event: ProviderRuntimeEvent) => event.type === "turn.completed"),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        runtimeMode: "local",
        cwd: process.cwd(),
      } as never);

      yield* adapter.sendTurn({ threadId, input: "hello" } as never);

      emitPi({ type: "agent_start" });
      emitPi({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
      emitPi({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_delta", delta: "par", contentIndex: 0 },
      });

      // Transient provider failure: Pi reports the run ended but will retry.
      agentState.errorMessage = "overloaded_error: provider is overloaded";
      emitPi({ type: "agent_end", messages: [], willRetry: true });

      // The retry succeeds and only now does Pi settle.
      agentState.errorMessage = undefined;
      emitPi({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_delta", delta: "done", contentIndex: 0 },
      });
      emitPi({ type: "agent_end", messages: [], willRetry: false });
      emitPi({ type: "agent_settled" });

      const events = Array.from(yield* Fiber.join(collected));
      const completions = events.filter((event) => event.type === "turn.completed");

      assert.equal(completions.length, 1, "exactly one turn.completed per turn");
      const completion = completions[0];
      assert.ok(completion && completion.type === "turn.completed");
      assert.equal(completion.payload.state, "completed");

      // The transient failure is a warning, never a runtime.error, and the turn
      // stays open so post-retry deltas keep their turnId.
      assert.equal(
        events.some((event) => event.type === "runtime.error"),
        false,
        "a retried transient error must not surface as runtime.error",
      );
      const warnings = events.filter((event) => event.type === "runtime.warning");
      assert.ok(
        warnings.some(
          (event) =>
            event.type === "runtime.warning" && event.payload.message.includes("will retry"),
        ),
        "the pending retry is surfaced as a warning",
      );

      const retryDelta = events.find(
        (event) => event.type === "content.delta" && event.payload.delta === "done",
      );
      assert.ok(retryDelta, "post-retry delta is emitted");
      assert.equal(retryDelta.turnId, completion.turnId, "post-retry delta keeps the turn id");

      yield* adapter.stopSession(threadId);
    }),
  );
});
