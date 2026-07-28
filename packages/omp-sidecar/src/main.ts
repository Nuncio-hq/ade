// FILE: main.ts
// Purpose: stdio entrypoint for the OMP sidecar. Speaks the NDJSON protocol in
//          `protocol.ts` and delegates every engine decision to the session host.
// Layer: @nuncio/omp-sidecar entrypoint
//
// stdout is the protocol channel and nothing else may write to it: a stray
// console.log would land mid-frame and break the host's parser. Engine logging
// is redirected to stderr, which the server captures into the provider log.

import {
  encodeSidecarFrame,
  makeLineSplitter,
  OMP_SIDECAR_PROTOCOL_VERSION,
  type OmpSidecarMethod,
  type OmpSidecarOutboundFrame,
  type OmpSidecarRequestFrame,
} from "./protocol";
import { createOmpSidecarSessionHost, type OmpSidecarSessionHost } from "./session-host";

const stdoutWrite = process.stdout.write.bind(process.stdout);

/** Serialized, drain-aware writer: one physical line at a time, in order. */
let writeQueue: Promise<void> = Promise.resolve();
function emit(frame: OmpSidecarOutboundFrame): void {
  const line = encodeSidecarFrame(frame);
  writeQueue = writeQueue
    .then(async () => {
      if (!stdoutWrite(line)) {
        await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
      }
    })
    .catch(() => {
      // stdout is gone (the server exited); nothing left to deliver, but the
      // queue must stay alive so teardown below still runs.
    });
}

// Anything the engine prints goes to stderr. Reassigning rather than wrapping
// keeps third-party code that captured `console.log` early on the safe channel.
console.log = (...args: unknown[]) => {
  process.stderr.write(`${args.map(String).join(" ")}\n`);
};
console.info = console.log;
console.debug = console.log;

const host: OmpSidecarSessionHost = createOmpSidecarSessionHost({
  onRuntimeEvent: (event) => {
    emit({ type: "event", threadId: event.threadId, event });
  },
});

type Handler = (params: never) => Promise<unknown>;

const handlers: Record<OmpSidecarMethod, Handler> = {
  "session/start": host.startSession as Handler,
  "session/stop": host.stopSession as Handler,
  "session/stop-all": (() => host.stopAll()) as Handler,
  "session/list": (() => host.listSessions()) as Handler,
  "session/has": host.hasSession as Handler,
  "turn/send": host.sendTurn as Handler,
  "turn/steer": host.steerTurn as Handler,
  "turn/interrupt": host.interruptTurn as Handler,
  "task/stop": host.stopTask as Handler,
  "user-input/respond": host.respondToUserInput as Handler,
  "thread/read": host.readThread as Handler,
  "thread/rollback": host.rollbackThread as Handler,
  "thread/compact": host.compactThread as Handler,
  "model/list": host.listModels as Handler,
  "skill/list": host.listSkills as Handler,
  "command/list": host.listCommands as Handler,
};

function toDetail(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
  return fallback;
}

/**
 * Requests are dispatched without awaiting each other: a long turn on one
 * thread must never block a status call on another.
 */
function dispatch(frame: OmpSidecarRequestFrame): void {
  const handler = handlers[frame.method];
  if (!handler) {
    emit({
      type: "response",
      id: frame.id,
      ok: false,
      error: { method: frame.method, detail: `Unknown sidecar method '${frame.method}'.` },
    });
    return;
  }
  void (async () => {
    try {
      const result = await handler(frame.params as never);
      emit({ type: "response", id: frame.id, ok: true, result: result as never });
    } catch (cause) {
      emit({
        type: "response",
        id: frame.id,
        ok: false,
        error: {
          method: frame.method,
          detail: toDetail(cause, `OMP sidecar failed to handle '${frame.method}'.`),
          // The server restarts a thread whose session vanished instead of
          // surfacing a generic request error.
          ...(cause instanceof Error && /no (omp )?session/i.test(cause.message)
            ? { sessionMissing: true }
            : {}),
        },
      });
    }
  })();
}

async function readEngineVersion(): Promise<string> {
  try {
    const module = (await import("@oh-my-pi/pi-coding-agent")) as { readonly VERSION?: string };
    if (typeof module.VERSION === "string") return module.VERSION;
  } catch {
    // Fall through: the handshake still needs to happen so the server can
    // report a usable engine rather than hanging on a missing frame.
  }
  return "unknown";
}

emit({
  type: "hello",
  protocolVersion: OMP_SIDECAR_PROTOCOL_VERSION,
  engineVersion: await readEngineVersion(),
  pid: process.pid,
});

const splitLines = makeLineSplitter();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  for (const line of splitLines(chunk)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      emit({ type: "log", level: "warning", message: "Dropped unparseable request line." });
      continue;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { type?: unknown }).type !== "request"
    ) {
      continue;
    }
    dispatch(parsed as OmpSidecarRequestFrame);
  }
});

// EOF means the server is gone: dispose every session so `abort()` reaps the
// engine's brush-shell children instead of orphaning them.
process.stdin.on("end", () => {
  void (async () => {
    try {
      await host.stopAll();
    } finally {
      process.exit(0);
    }
  })();
});
