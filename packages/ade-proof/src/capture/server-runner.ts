import { mkdir, writeFile } from "node:fs/promises";
import { spawn, execSync } from "node:child_process";
import { dirname } from "node:path";
import { createConnection } from "node:net";
import type { ProofResult } from "../core/types.js";
import {
  PORT_WAIT_TIMEOUT_MS,
  SERVER_LOG_HEAD_BYTES,
  SERVER_LOG_TAIL_BYTES,
} from "../core/types.js";
import { stripAnsi } from "../core/index.js";

class LogTee {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private inTail = false;
  private totalBytes = 0;

  constructor(private path: string) {}

  write(text: string): void {
    let buf = Buffer.from(stripAnsi(text), "utf8");
    this.totalBytes += buf.length;

    if (!this.inTail) {
      const headSpace = Math.max(0, SERVER_LOG_HEAD_BYTES - this.head.length);
      if (headSpace > 0) {
        this.head = Buffer.concat([this.head, buf.subarray(0, headSpace)]);
        buf = buf.subarray(headSpace);
      }
      if (buf.length > 0) {
        this.inTail = true;
      }
    }

    if (this.inTail && buf.length > 0) {
      this.tail = Buffer.concat([this.tail, buf]);
      if (this.tail.length > SERVER_LOG_TAIL_BYTES) {
        this.tail = this.tail.subarray(-SERVER_LOG_TAIL_BYTES);
      }
    }
  }

  getTail(byteCount: number): string {
    const all = Buffer.concat([this.head, this.tail]);
    return all.subarray(-byteCount).toString("utf8");
  }

  async close(): Promise<void> {
    const omitted = Math.max(0, this.totalBytes - this.head.length - this.tail.length);
    let out: Buffer;
    if (omitted > 0) {
      const marker = Buffer.from(`\n\n... (${omitted} bytes omitted) ...\n\n`, "utf8");
      out = Buffer.concat([this.head, marker, this.tail]);
    } else {
      out = Buffer.concat([this.head, this.tail]);
    }
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, out);
  }
}

function getPortPid(port: number): number | undefined {
  try {
    const out = execSync(`lsof -t -i :${port} -sTCP:LISTEN 2>/dev/null`, {
      encoding: "utf8",
    }).trim();
    if (!out) return undefined;
    const first = out.split("\n")[0];
    const pid = Number(first);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function isPortOpen(host: string, port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = createConnection(port, host);
  let settled = false;

  function finish(value: boolean): void {
    if (settled) return;
    settled = true;
    try {
      socket.destroy();
    } catch {
      // ignore
    }
    resolve(value);
  }

  socket.on("connect", () => finish(true));
  socket.on("error", () => finish(false));
  socket.setTimeout(2000, () => finish(false));

  return promise;
}

async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function stopProcessGroup(pid: number): Promise<void> {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // already gone
  }
  await sleep(3000);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

export async function startDevServer(opts: {
  cmd: string;
  cwd: string;
  port?: number;
  logFileAbsPath: string;
}): Promise<ProofResult<{ pid: number; stop: () => Promise<void> }>> {
  await mkdir(dirname(opts.logFileAbsPath), { recursive: true });

  if (opts.port) {
    const occupying = getPortPid(opts.port);
    if (occupying) {
      return {
        ok: false,
        error: {
          code: "port-in-use",
          message: `Port ${opts.port} is already in use by pid ${occupying}. Stop that process first or pick another port.`,
          details: { port: opts.port, occupyingPid: occupying },
        },
      };
    }
  }

  const log = new LogTee(opts.logFileAbsPath);

  const child = spawn(opts.cmd, {
    shell: true,
    detached: true,
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  if (!child.pid) {
    return {
      ok: false,
      error: {
        code: "run-command-exited",
        message: `Could not spawn command: ${opts.cmd}`,
        details: { cmd: opts.cmd },
      },
    };
  }

  const pid = child.pid;

  child.stdout.on("data", (d) => log.write(d.toString("utf8")));
  child.stderr.on("data", (d) => log.write(d.toString("utf8")));

  const { promise: exitPromise, resolve: resolveExit } = Promise.withResolvers<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>();

  let exited = false;
  child.on("exit", (code, signal) => {
    if (exited) return;
    exited = true;
    void log.close();
    resolveExit({ code, signal });
  });

  async function waitForExit(ms: number): Promise<"exited" | "running"> {
    const { promise, resolve } = Promise.withResolvers<"exited" | "running">();
    const timer = setTimeout(() => resolve("running"), ms);
    exitPromise.then(() => {
      clearTimeout(timer);
      resolve("exited");
    });
    return promise;
  }

  // Give the command a moment to fail immediately
  const immediate = await waitForExit(250);
  if (immediate === "exited" && !opts.port) {
    const exit = await exitPromise;
    await log.close();
    const tail = log.getTail(4096);
    return {
      ok: false,
      error: {
        code: "run-command-exited",
        message: `Command exited immediately (code ${exit.code ?? 0}). ${tail.slice(-500)}`,
        details: { cmd: opts.cmd, exitCode: exit.code, tail },
      },
    };
  }

  if (!opts.port) {
    return {
      ok: true,
      value: {
        pid,
        stop: async () => {
          await stopProcessGroup(pid);
          await log.close();
        },
      },
    };
  }

  const start = Date.now();
  while (Date.now() - start < PORT_WAIT_TIMEOUT_MS) {
    if (exited) {
      const exit = await exitPromise;
      await log.close();
      const tail = log.getTail(4096);
      return {
        ok: false,
        error: {
          code: "run-command-exited",
          message: `Command exited (code ${exit.code ?? 0}) before port ${opts.port} was ready. ${tail.slice(-500)}`,
          details: { cmd: opts.cmd, exitCode: exit.code, port: opts.port, tail },
        },
      };
    }

    if (await isPortOpen("127.0.0.1", opts.port)) {
      return {
        ok: true,
        value: {
          pid,
          stop: async () => {
            await stopProcessGroup(pid);
            await log.close();
          },
        },
      };
    }

    await sleep(200);
  }

  await stopProcessGroup(pid);
  await log.close();
  return {
    ok: false,
    error: {
      code: "port-timeout",
      message: `Timed out waiting for ${opts.cmd} to listen on port ${opts.port} after ${PORT_WAIT_TIMEOUT_MS}ms.`,
      details: { cmd: opts.cmd, port: opts.port, logFileAbsPath: opts.logFileAbsPath },
    },
  };
}
