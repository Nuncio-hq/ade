import { describe, expect, test } from "vitest";
import { readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { createServer } from "node:http";
import { startDevServer } from "../../src/capture/server-runner.js";
import { getFreePort } from "./test-helpers.js";
function isPortOpen(host: string, port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = createConnection(port, host);
  let settled = false;
  const finish = (v: boolean) => {
    if (settled) return;
    settled = true;
    try {
      socket.destroy();
    } catch {
      // ignore
    }
    resolve(v);
  };
  socket.on("connect", () => finish(true));
  socket.on("error", () => finish(false));
  return promise;
}

describe("server-runner", () => {
  test("waits for port, tee strips ANSI, and stop kills process group", async () => {
    const port = await getFreePort();
    const logFile = `/tmp/ade-proof-server-${Date.now()}.log`;
    const cmd = `PORT=${port} bun -e 'console.log("\\x1b[31mred\\x1b[0m normal"); console.error("stderr line"); console.log("ready"); Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch: () => new Response("ok") });'`;

    const res = await startDevServer({ cmd, cwd: process.cwd(), port, logFileAbsPath: logFile });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(await isPortOpen("127.0.0.1", port)).toBe(true);

    await res.value.stop();

    expect(() => process.kill(res.value.pid, 0)).toThrow();

    const log = await readFile(logFile, "utf8");
    expect(log).not.toContain("\x1b[");
    expect(log).toContain("red normal");
    expect(log).toContain("stderr line");
    expect(log).toContain("ready");

    await unlink(logFile).catch(() => {});
  });

  test("log is capped to head+tail with marker", async () => {
    const port = await getFreePort();
    const logFile = `/tmp/ade-proof-cap-${Date.now()}.log`;
    const cmd = `PORT=${port} bun -e 'for (let i=0;i<30000;i++){ console.log(i.toString().padStart(8,"0")); } console.log("TAIL_MARKER"); Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch: () => new Response("ok") });'`;

    const res = await startDevServer({ cmd, cwd: process.cwd(), port, logFileAbsPath: logFile });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    await res.value.stop();

    const log = await readFile(logFile, "utf8");
    expect(log).toContain("00000000");
    expect(log).toContain("TAIL_MARKER");
    expect(log).toContain("bytes omitted");
    await unlink(logFile).catch(() => {});
  });

  test("port-in-use reports occupying pid", async () => {
    const port = await getFreePort();
    const server = createServer((_req, res) => res.end("ok"));
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.listen(port, "127.0.0.1", () => resolve());
    server.on("error", reject);
    await promise;
    try {
      const res = await startDevServer({
        cmd: `bun -e 'Bun.serve({ port: ${port}, fetch: () => new Response("x") })'`,
        cwd: process.cwd(),
        port,
        logFileAbsPath: `/tmp/ade-proof-port-in-use-${Date.now()}.log`,
      });
      expect(res.ok).toBe(false);
      expect(!res.ok && res.error.code).toBe("port-in-use");
      if (!res.ok) {
        expect(typeof res.error.details?.occupyingPid).toBe("number");
        expect(res.error.details?.port).toBe(port);
      }
    } finally {
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      await promise;
    }
  });

  test("run-command-exited on immediate failure", async () => {
    const port = await getFreePort();
    const logFile = `/tmp/ade-proof-exit-${Date.now()}.log`;
    const res = await startDevServer({
      cmd: `bun -e 'console.error("nope"); process.exit(42)'`,
      cwd: process.cwd(),
      port,
      logFileAbsPath: logFile,
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe("run-command-exited");
    if (!res.ok) {
      expect(res.error.details?.exitCode).toBe(42);
    }
    if (existsSync(logFile)) await unlink(logFile);
  });
});
