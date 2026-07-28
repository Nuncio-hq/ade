import { Readable, Writable } from "node:stream";
import { it, assert, vi } from "@effect/vitest";
import { beforeEach } from "vitest";
import { Effect, Fiber, Layer, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ApprovalRequestId,
  EventId,
  ThreadId,
  TurnId,
} from "@nuncio/contracts";
import {
  encodeSidecarFrame,
  OMP_SIDECAR_PROTOCOL_VERSION,
  type OmpSidecarOutboundFrame,
} from "@nuncio/omp-sidecar/protocol";

import { ServerConfig } from "../../config.ts";
import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError } from "../Errors.ts";
import { OmpAdapter } from "../Services/OmpAdapter.ts";
import { makeOmpAdapterLive, type OmpSidecarProcess } from "./OmpAdapter.ts";

class FakeSidecar {
  readonly requests: Array<{
    readonly id: string;
    readonly method: string;
    readonly params: unknown;
  }> = [];
  private readonly resolvers: Array<
    (req: { readonly id: string; readonly method: string; readonly params: unknown }) => void
  > = [];
  readonly exit = Promise.withResolvers<number | null>();
  private lineBuffer = "";

  constructor(
    private readonly helloProtocolVersion = OMP_SIDECAR_PROTOCOL_VERSION,
    private readonly processPid = 12345,
  ) {}

  readonly stdin = new Writable({
    write: (
      chunk: Buffer | string,
      _encoding: string,
      callback: (error?: Error | null) => void,
    ) => {
      this.lineBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const lines = this.lineBuffer.split("\n");
      this.lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        try {
          const frame = JSON.parse(line) as {
            type: string;
            id: string;
            method: string;
            params: unknown;
          };
          if (frame.type === "request") {
            const request = { id: frame.id, method: frame.method, params: frame.params };
            const next = this.resolvers.shift();
            if (next) {
              next(request);
            } else {
              this.requests.push(request);
            }
          }
        } catch {
          // ignore stray lines
        }
      }
      callback();
    },
  });

  readonly stdout = new Readable({
    read() {
      // data is pushed from the test
    },
  });

  readonly stderr = new Readable({
    read() {
      // data is pushed from the test
    },
  });

  readonly kill = vi.fn((_signal?: string) => {
    this.close(0);
  });

  close(exitCode: number | null) {
    this.stdout.push(null);
    this.stderr.push(null);
    this.exit.resolve(exitCode);
  }

  spawn(): OmpSidecarProcess {
    this.sendHello();
    return {
      pid: this.processPid,
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      kill: this.kill,
      exit: this.exit.promise,
    };
  }

  nextRequest(): Promise<{
    readonly id: string;
    readonly method: string;
    readonly params: unknown;
  }> {
    if (this.requests.length > 0) {
      return Promise.resolve(this.requests.shift()!);
    }
    const { promise, resolve } = Promise.withResolvers<{
      readonly id: string;
      readonly method: string;
      readonly params: unknown;
    }>();
    this.resolvers.push(resolve);
    return promise;
  }

  sendFrame(frame: OmpSidecarOutboundFrame) {
    this.stdout.push(encodeSidecarFrame(frame));
  }

  sendHello() {
    this.sendFrame({
      type: "hello",
      protocolVersion: this.helloProtocolVersion,
      engineVersion: "test",
      pid: this.processPid,
    });
  }

  sendResponse(id: string, result: unknown) {
    this.sendFrame({
      type: "response",
      id,
      ok: true,
      result,
    } as unknown as OmpSidecarOutboundFrame);
  }

  sendError(
    id: string,
    error: { readonly method: string; readonly detail: string; readonly sessionMissing?: boolean },
  ) {
    this.sendFrame({ type: "response", id, ok: false, error });
  }

  sendEvent(threadId: string, event: unknown) {
    this.sendFrame({ type: "event", threadId, event } as unknown as OmpSidecarOutboundFrame);
  }

  sendLog(level: "info" | "warning" | "error", message: string, detail?: Record<string, unknown>) {
    this.sendFrame({
      type: "log",
      level,
      message,
      ...(detail ? { detail } : {}),
    } as unknown as OmpSidecarOutboundFrame);
  }
}

function makeTestLayer(fake: FakeSidecar) {
  return Layer.provide(
    makeOmpAdapterLive({
      spawnSidecar: () => Promise.resolve(fake.spawn()),
      requestTimeoutMs: 1000,
    }),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "omp-adapter-test-" }),
      NodeServices.layer,
    ),
  );
}

/** One fake per test: the body and the adapter must share the same instance. */
let fake: FakeSidecar;
beforeEach(() => {
  fake = new FakeSidecar();
});

const baseSession = (threadId: ThreadId): ProviderSession => ({
  provider: "omp",
  status: "ready",
  runtimeMode: "full-access",
  threadId,
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
});

it.effect("correlates requests and responses with the sidecar", () =>
  Effect.gen(function* () {
    const adapter = yield* OmpAdapter;
    const threadId = ThreadId.makeUnsafe("thread-corr");

    const startedFiber = yield* Effect.forkChild(
      adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      }),
    );

    const req = yield* Effect.promise(() => fake.nextRequest());
    assert.equal(req.method, "session/start");
    fake.sendResponse(req.id, baseSession(threadId));

    const session = yield* Fiber.join(startedFiber);
    assert.equal(session.threadId, threadId);

    const turnFiber = yield* Effect.forkChild(adapter.sendTurn({ threadId, input: "hello" }));
    const turnReq = yield* Effect.promise(() => fake.nextRequest());
    assert.equal(turnReq.method, "turn/send");
    fake.sendResponse(turnReq.id, { turnId: "turn-1" });

    const turn = yield* Fiber.join(turnFiber);
    assert.equal(turn.threadId, threadId);
    assert.equal(turn.turnId, TurnId.makeUnsafe("turn-1"));
  }).pipe(Effect.provide(makeTestLayer(fake)), Effect.scoped),
);

it.effect("routes event frames into streamEvents by threadId", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.makeUnsafe("thread-event");
    const event: ProviderRuntimeEvent = {
      eventId: EventId.makeUnsafe("event-1"),
      provider: "omp",
      threadId,
      createdAt: "2026-07-28T00:00:00.000Z",
      type: "turn.started",
      payload: { model: "test-model" },
      raw: {
        source: "omp.sdk.event",
        method: "turn.started",
        payload: { model: "test-model" },
      },
    };

    const adapter = yield* OmpAdapter;
    const startFiber = yield* Effect.forkChild(
      adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" }),
    );
    const startReq = yield* Effect.promise(() => fake.nextRequest());
    fake.sendResponse(startReq.id, baseSession(threadId));
    yield* Fiber.join(startFiber);

    const turnFiber = yield* Effect.forkChild(adapter.sendTurn({ threadId, input: "hello" }));
    const turnReq = yield* Effect.promise(() => fake.nextRequest());
    fake.sendResponse(turnReq.id, { turnId: "turn-2" });
    fake.sendEvent(threadId, event);
    yield* Fiber.join(turnFiber);

    const events = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 1));
    const eventArray = events;
    assert.equal(eventArray.length, 1);
    assert.equal(eventArray[0]?.threadId, threadId);
    assert.equal(eventArray[0]?.type, "turn.started");
  }).pipe(Effect.provide(makeTestLayer(fake)), Effect.scoped),
);

it.effect("maps ok:false with sessionMissing to SessionNotFoundError", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.makeUnsafe("thread-missing");

    const adapter = yield* OmpAdapter;
    const startFiber = yield* Effect.forkChild(
      adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      }),
    );
    const startReq = yield* Effect.promise(() => fake.nextRequest());
    fake.sendResponse(startReq.id, baseSession(threadId));
    yield* Fiber.join(startFiber);

    const turnFiber = yield* Effect.forkChild(adapter.sendTurn({ threadId, input: "hello" }));
    const turnReq = yield* Effect.promise(() => fake.nextRequest());
    fake.sendError(turnReq.id, {
      method: "turn/send",
      detail: "session gone",
      sessionMissing: true,
    });

    const failed = yield* Fiber.join(turnFiber).pipe(Effect.result);

    assert.equal(failed._tag, "Failure");
    const sessionError = failed._tag === "Failure" ? failed.failure : undefined;
    assert.instanceOf(sessionError, ProviderAdapterSessionNotFoundError);
    assert.equal((sessionError as ProviderAdapterSessionNotFoundError).threadId, threadId);
  }).pipe(Effect.provide(makeTestLayer(fake)), Effect.scoped),
);

it.effect("passes respondToUserInput through to the sidecar", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.makeUnsafe("thread-input");
    const requestId = ApprovalRequestId.makeUnsafe("request-1");

    const adapter = yield* OmpAdapter;
    const startFiber = yield* Effect.forkChild(
      adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      }),
    );
    const startReq = yield* Effect.promise(() => fake.nextRequest());
    fake.sendResponse(startReq.id, baseSession(threadId));
    yield* Fiber.join(startFiber);

    const answers: ProviderUserInputAnswers = { field1: "value1" };
    const responseFiber = yield* Effect.forkChild(
      adapter.respondToUserInput(threadId, requestId, answers),
    );

    const req = yield* Effect.promise(() => fake.nextRequest());
    assert.equal(req.method, "user-input/respond");
    fake.sendResponse(req.id, null);

    yield* Fiber.join(responseFiber);
  }).pipe(Effect.provide(makeTestLayer(fake)), Effect.scoped),
);

it.effect("refuses a mismatched protocol version and surfaces a runtime warning", () => {
  fake = new FakeSidecar(99);
  return Effect.gen(function* () {
    const threadId = ThreadId.makeUnsafe("thread-version");

    const adapter = yield* OmpAdapter;
    const started = adapter
      .startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" })
      .pipe(Effect.result);

    const failed = yield* started;

    const events = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 1));
    const eventArray = events;

    assert.equal(failed._tag, "Failure");
    const versionError = failed._tag === "Failure" ? failed.failure : undefined;
    assert.instanceOf(versionError, ProviderAdapterRequestError);
    assert.include(
      (versionError as ProviderAdapterRequestError).detail ?? "",
      "protocol version 99 is not supported",
    );
    assert.equal(eventArray.length, 1);
    assert.equal(eventArray[0]?.type, "runtime.warning");
    assert.include((eventArray[0]?.payload as { message: string }).message, "not supported");
  }).pipe(Effect.provide(makeTestLayer(fake)), Effect.scoped);
});

it.effect("fails an active turn when the sidecar crashes", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.makeUnsafe("thread-crash");

    const adapter = yield* OmpAdapter;
    const startFiber = yield* Effect.forkChild(
      adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" }),
    );
    const startReq = yield* Effect.promise(() => fake.nextRequest());
    fake.sendResponse(startReq.id, baseSession(threadId));
    yield* Fiber.join(startFiber);

    const turnFiber = yield* Effect.forkChild(adapter.sendTurn({ threadId, input: "hello" }));
    const turnReq = yield* Effect.promise(() => fake.nextRequest());
    fake.sendResponse(turnReq.id, { turnId: "turn-crash" });
    const turn = yield* Fiber.join(turnFiber);

    fake.close(1);

    const events = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2));
    const eventArray = events;

    assert.equal(turn.turnId, TurnId.makeUnsafe("turn-crash"));
    assert.equal(eventArray.length, 2);
    assert.equal(eventArray[0]?.type, "runtime.error");
    assert.equal(eventArray[1]?.type, "turn.completed");
    const payload = eventArray[1]?.payload as { state: string; errorMessage?: string };
    assert.equal(payload?.state, "failed");
    assert.include(payload?.errorMessage ?? "", "exited unexpectedly");
  }).pipe(Effect.provide(makeTestLayer(fake)), Effect.scoped),
);
