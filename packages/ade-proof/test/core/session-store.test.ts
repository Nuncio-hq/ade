import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  addStep,
  findSession,
  listSessions,
  nextStepFile,
  setVideo,
  startSession,
  stopSession,
} from "../../src/core/session-store.js";
import { FakeCaptureBackend } from "./fake-backend.js";
import type { ProofTarget, SessionRef } from "../../src/core/types.js";
import { unwrap, unwrapErr } from "./test-helpers.js";

describe("session store lifecycle", () => {
  let root: string;
  let backend: FakeCaptureBackend;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ade-proof-session-"));
    backend = new FakeCaptureBackend();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("starts a session, lists it, finds it", async () => {
    const session = unwrap(await startSession({ workspaceRoot: root, description: "first" }));
    expect(session.state).toBe("active");
    expect(session.dir).toContain(root);

    const list = await listSessions(root);
    expect(list.length).toBe(1);
    const first = list[0];
    expect(first).toBeDefined();
    expect(first?.id).toBe(session.id);

    const found = unwrap(await findSession(root));
    expect(found.id).toBe(session.id);
  });

  it("produces monotonic step file names with collisions", async () => {
    const session = unwrap(await startSession({ workspaceRoot: root, slug: "session" }));

    const a = unwrap(await nextStepFile(session, "login"));
    expect(a.relPath).toMatch(/step-01-login\.png$/);

    unwrap(
      await addStep(session, {
        label: "login",
        target: "web",
        file: a.relPath,
      }),
    );

    const b = unwrap(await nextStepFile(session, "login"));
    expect(b.relPath).toMatch(/step-02-login\.png$/);

    unwrap(
      await addStep(session, {
        label: "login",
        target: "web",
        file: b.relPath,
      }),
    );

    const c = unwrap(await nextStepFile(session, "dashboard"));
    expect(c.relPath).toMatch(/step-03-dashboard\.png$/);
  });

  it("runs the full pipeline: start, step, add, video, stop", async () => {
    const session = unwrap(await startSession({ workspaceRoot: root, description: "pipeline" }));

    const file = unwrap(await nextStepFile(session, "home"));

    await backend.capture({
      target: "web" as ProofTarget,
      label: "home",
      url: "http://localhost:3000/",
      outFile: file.absPath,
    });

    const step = unwrap(
      await addStep(session, {
        label: "home",
        target: "web",
        file: file.relPath,
        url: "http://localhost:3000/",
        finalUrl: "http://localhost:3000/home",
        httpStatus: 200,
      }),
    );
    expect(step.ts).toBeDefined();

    const videoRel = `.ade/proof/${session.id}/session.webm`;
    unwrap(await setVideo(session, videoRel));

    const stop = unwrap(
      await stopSession(session, { consoleLines: ["Error: connection refused"] }),
    );
    expect(stop.manifest.finishedAt).toBeDefined();
    expect(stop.manifest.steps.length).toBe(1);
    expect(stop.manifest.errors.length).toBeGreaterThan(0);
    expect(stop.manifest.video).toBe(videoRel);

    const summary = readFileSync(stop.summaryAbsPath, "utf-8");
    expect(summary).toContain("home");
    expect(summary).toContain("connection refused");
  });

  it("double stop returns no-active-session", async () => {
    const session = unwrap(await startSession({ workspaceRoot: root }));
    unwrap(await stopSession(session));

    const stopped = unwrap(await findSession(root, session.id));
    expect(stopped.state).toBe("stopped");

    const second = await stopSession(stopped);
    expect(second.ok).toBe(false);
    const err = unwrapErr(second);
    expect(err.code).toBe("no-active-session");
    expect(err.message).toContain("already stopped");
  });

  it("stops and scans server.log with ANSI stripped", async () => {
    const session = unwrap(await startSession({ workspaceRoot: root }));
    writeFileSync(join(session.dir, "server.log"), "\u001b[31mError: boom\u001b[0m\n");

    const stop = unwrap(await stopSession(session));
    const log = readFileSync(join(session.dir, "server.log"), "utf-8");
    expect(log).not.toContain("\u001b");
    expect(stop.manifest.errors.some((e) => e.pattern === "js-error")).toBe(true);
  });

  it("warns in SUMMARY and stop output when .gitignore is missing", async () => {
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    const session = unwrap(await startSession({ workspaceRoot: root }));
    const stop = unwrap(await stopSession(session));
    const summary = readFileSync(stop.summaryAbsPath, "utf-8");
    expect(summary).toContain(".gitignore does not ignore");
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe("node_modules/\n");
  });

  it("finds the most recent active session and reports abandoned", async () => {
    const first = unwrap(await startSession({ workspaceRoot: root, slug: "one" }));
    const second = unwrap(await startSession({ workspaceRoot: root, slug: "two" }));

    // abandon the second session by faking a dead lock pid
    writeFileSync(
      join(second.dir, "session.lock"),
      JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }),
    );

    const found = unwrap(await findSession(root));
    expect(found.id).toBe(first.id);

    // abandon first too
    writeFileSync(
      join(first.dir, "session.lock"),
      JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }),
    );

    const none = await findSession(root);
    expect(none.ok).toBe(false);
    const err = unwrapErr(none);
    expect(err.code).toBe("no-active-session");
    expect(err.details?.abandoned).toContain(first.id);
    expect(err.details?.abandoned).toContain(second.id);
  });

  it("adds a monotonic suffix when two sessions share a slug in the same second", async () => {
    const first = unwrap(await startSession({ workspaceRoot: root, slug: "same" }));
    const second = unwrap(await startSession({ workspaceRoot: root, slug: "same" }));
    expect(second.id).not.toBe(first.id);
    expect(second.id).toMatch(/^\d{8}-\d{6}-same-\d+$/);
  });

  it("retains a large server.log with head+tail and strips ANSI", async () => {
    const session = unwrap(await startSession({ workspaceRoot: root }));
    const filler = "line".repeat(50);
    const lines: string[] = [];
    for (let i = 0; i < 6000; i++) {
      lines.push(`${filler} ${i}`);
    }
    lines.push("\u001b[31mError: too big\u001b[0m");
    writeFileSync(join(session.dir, "server.log"), lines.join("\n"));

    unwrap(await stopSession(session));
    const log = readFileSync(join(session.dir, "server.log"), "utf-8");
    expect(log).not.toContain("\u001b");
    expect(log).toContain("...");
  });
});
