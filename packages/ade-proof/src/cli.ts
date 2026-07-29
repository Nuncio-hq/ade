#!/usr/bin/env bun
import { appendFile, readFile, writeFile, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CaptureRequest,
  ProofResult,
  ProofStep,
  ProofTarget,
  RecordRequest,
  SessionRef,
} from "./core/types.js";
import {
  PROOF_DIR_NAME,
  SESSION_LOCK_FILENAME,
  SERVER_LOG_FILENAME,
  SUMMARY_FILENAME,
} from "./core/types.js";
import {
  addStep,
  findSession,
  listSessions,
  nextStepFile,
  resolveWorkspaceRoot,
  setVideo,
  startSession,
  stopSession,
} from "./core/index.js";
import { getBackend, recordWeb, startDevServer } from "./capture/index.js";
import { runMcpServer } from "./mcp.js";

const readFileAsync = promisify(readFile);
const appendFileAsync = promisify(appendFile);
const writeFileAsync = promisify(writeFile);
const execFileAsync = promisify(execFile);

function parseArgs(argv: string[]): {
  cmd: string | undefined;
  flags: Record<string, string | boolean>;
} {
  const flags: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      pos.push(a);
    }
  }
  return { cmd: pos[0], flags };
}

function output<T>(res: ProofResult<T>, json: boolean, human: (v: T) => string): never {
  if (json) {
    console.log(JSON.stringify(res));
  } else if (res.ok) {
    console.log(human(res.value));
  } else {
    console.error(`Error: ${res.error.message}`);
  }
  process.exit(res.ok ? 0 : 1);
}

async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

async function killProcessGroup(pid: number): Promise<void> {
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

async function updateLockPid(session: SessionRef, pid: number): Promise<void> {
  const lockPath = join(session.dir, SESSION_LOCK_FILENAME);
  await writeFileAsync(
    lockPath,
    JSON.stringify({ pid, startedAt: new Date().toISOString() }) + "\n",
  );
}

async function getSession(
  root: string,
  flags: Record<string, string | boolean>,
): Promise<ProofResult<SessionRef>> {
  const id = typeof flags.session === "string" ? flags.session : undefined;
  return findSession(root, id);
}

async function handleStart(flags: Record<string, string | boolean>, json: boolean): Promise<never> {
  const rootRes = await resolveWorkspaceRoot(process.cwd());
  if (!rootRes.ok) output(rootRes, json, () => "");

  const startOpts: {
    workspaceRoot: string;
    description?: string;
    slug?: string;
    serverCmd?: string;
  } = {
    workspaceRoot: rootRes.value,
  };
  const desc = typeof flags.desc === "string" ? flags.desc : undefined;
  const slug = typeof flags.slug === "string" ? flags.slug : undefined;
  const run = typeof flags.run === "string" ? flags.run : undefined;
  if (desc) startOpts.description = desc;
  if (slug) startOpts.slug = slug;
  if (run) startOpts.serverCmd = run;

  const sessionRes = await startSession(startOpts);
  if (!sessionRes.ok) output(sessionRes, json, () => "");
  const session = sessionRes.value;

  if (run) {
    const port = typeof flags.port === "string" ? Number(flags.port) : undefined;
    if (!port || !Number.isFinite(port)) {
      output(
        {
          ok: false,
          error: {
            code: "port-in-use",
            message: "--run requires a valid --port number",
            details: {},
          },
        },
        json,
        () => "",
      );
    }
    const serverRes = await startDevServer({
      cmd: run,
      cwd: rootRes.value,
      port,
      logFileAbsPath: join(session.dir, SERVER_LOG_FILENAME),
    });
    if (!serverRes.ok) output(serverRes, json, () => "");
    await updateLockPid(session, serverRes.value.pid);
  }

  output(
    { ok: true, value: { sessionId: session.id, dir: session.dir } },
    json,
    (v) => `Started session ${v.sessionId}`,
  );
}

async function handleShot(flags: Record<string, string | boolean>, json: boolean): Promise<never> {
  const rootRes = await resolveWorkspaceRoot(process.cwd());
  if (!rootRes.ok) output(rootRes, json, () => "");
  const sessionRes = await getSession(rootRes.value, flags);
  if (!sessionRes.ok) output(sessionRes, json, () => "");
  const session = sessionRes.value;

  const target = typeof flags.target === "string" ? flags.target : "web";
  const backend = getBackend(target as ProofTarget);
  if (!backend) {
    output(
      {
        ok: false,
        error: {
          code: "unsupported-target",
          message: `Unsupported capture target: ${target}`,
          details: { target },
        },
      },
      json,
      () => "",
    );
  }

  const label = typeof flags.label === "string" ? flags.label : "";
  if (!label) {
    output(
      {
        ok: false,
        error: { code: "selector-not-found", message: "--label is required", details: {} },
      },
      json,
      () => "",
    );
  }

  const stepRes = await nextStepFile(session, label);
  if (!stepRes.ok) output(stepRes, json, () => "");

  const url = typeof flags.url === "string" ? flags.url : undefined;
  const selector = typeof flags.selector === "string" ? flags.selector : undefined;
  const windowTitle = typeof flags.window === "string" ? flags.window : undefined;
  const storageState =
    typeof flags["storage-state"] === "string" ? flags["storage-state"] : undefined;
  const fullPage = flags["full-page"] === true;
  const captureReq: CaptureRequest = {
    target: target as ProofTarget,
    label,
    outFile: stepRes.value.absPath,
    ...(url ? { url } : {}),
    ...(selector ? { selector } : {}),
    ...(fullPage ? { fullPage: true } : {}),
    ...(windowTitle ? { windowTitle } : {}),
    ...(storageState ? { storageStatePath: storageState } : {}),
  };

  const captureRes = await backend.capture(captureReq);
  if (!captureRes.ok) output(captureRes, json, () => "");

  const meta = captureRes.value;
  const step: Omit<ProofStep, "ts"> = {
    label,
    target: target as ProofTarget,
    file: stepRes.value.relPath,
    ...(url ? { url } : {}),
    ...(meta.finalUrl ? { finalUrl: meta.finalUrl } : {}),
    ...(meta.httpStatus !== undefined ? { httpStatus: meta.httpStatus } : {}),
    ...(meta.truncated ? { truncated: true } : {}),
    ...(meta.windowTitle ? { windowTitle: meta.windowTitle } : {}),
  };

  const addRes = await addStep(session, step);
  if (!addRes.ok) output(addRes, json, () => "");

  if (meta.consoleLines?.length) {
    const consolePath = join(session.dir, "console.log");
    await appendFileAsync(consolePath, meta.consoleLines.join("\n") + "\n");
  }

  output(
    { ok: true, value: { file: stepRes.value.relPath, ...meta } },
    json,
    (v) => `Captured ${v.file}`,
  );
}

async function handleRecord(
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<never> {
  const rootRes = await resolveWorkspaceRoot(process.cwd());
  if (!rootRes.ok) output(rootRes, json, () => "");
  const sessionRes = await getSession(rootRes.value, flags);
  if (!sessionRes.ok) output(sessionRes, json, () => "");
  const session = sessionRes.value;

  const url = typeof flags.url === "string" ? flags.url : "";
  const duration = typeof flags.duration === "string" ? Number(flags.duration) : NaN;
  if (!url || !Number.isFinite(duration) || duration <= 0) {
    output(
      {
        ok: false,
        error: {
          code: "navigation-failed",
          message: "--record requires --url and --duration (seconds)",
          details: {},
        },
      },
      json,
      () => "",
    );
  }

  const outFile = join(session.dir, "session.webm") as `${string}.webm`;
  const relPath = `${PROOF_DIR_NAME}/${session.id}/session.webm`;
  const storageState =
    typeof flags["storage-state"] === "string" ? flags["storage-state"] : undefined;
  const recordReq: RecordRequest = {
    url,
    durationMs: duration * 1000,
    outFile,
    ...(storageState ? { storageStatePath: storageState } : {}),
  };

  const recordRes = await recordWeb(recordReq);

  if (!recordRes.ok) output(recordRes, json, () => "");

  const setRes = await setVideo(session, relPath);
  output(setRes, json, () => `Recorded ${relPath}`);
}

async function handleStop(flags: Record<string, string | boolean>, json: boolean): Promise<never> {
  const rootRes = await resolveWorkspaceRoot(process.cwd());
  if (!rootRes.ok) output(rootRes, json, () => "");
  const sessionRes = await getSession(rootRes.value, flags);
  if (!sessionRes.ok) output(sessionRes, json, () => "");
  const session = sessionRes.value;

  const lockPath = join(session.dir, SESSION_LOCK_FILENAME);
  let lockPid: number | undefined;
  try {
    const raw = await readFileAsync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number };
    lockPid = typeof parsed.pid === "number" ? parsed.pid : undefined;
  } catch {
    // ignore
  }

  const consolePath = join(session.dir, "console.log");
  let consoleLines: string[] = [];
  if (existsSync(consolePath)) {
    const raw = await readFileAsync(consolePath, "utf8");
    consoleLines = raw.split("\n").filter(Boolean);
  }

  const stopRes = await stopSession(session, { consoleLines });
  if (lockPid !== undefined) {
    await killProcessGroup(lockPid);
  }
  output(stopRes, json, (v) => `Stopped session ${v.manifest.id}; summary at ${v.summaryAbsPath}`);
}

async function handleList(_flags: Record<string, string | boolean>, json: boolean): Promise<never> {
  const rootRes = await resolveWorkspaceRoot(process.cwd());
  if (!rootRes.ok) output(rootRes, json, () => "");
  const sessions = await listSessions(rootRes.value);
  output(
    { ok: true, value: sessions },
    json,
    (list) => list.map((s) => `${s.id} [${s.state}]`).join("\n") || "No sessions",
  );
}

async function handlePr(flags: Record<string, string | boolean>, json: boolean): Promise<never> {
  const rootRes = await resolveWorkspaceRoot(process.cwd());
  if (!rootRes.ok) output(rootRes, json, () => "");
  const sessionRes = await getSession(rootRes.value, flags);
  if (!sessionRes.ok) output(sessionRes, json, () => "");
  const summaryPath = join(sessionRes.value.dir, SUMMARY_FILENAME);
  if (!existsSync(summaryPath)) {
    output(
      {
        ok: false,
        error: {
          code: "no-active-session",
          message: `No SUMMARY.md for session ${sessionRes.value.id}. Run 'ade-proof stop' first.`,
          details: {},
        },
      },
      json,
      () => "",
    );
  }
  try {
    const { stdout } = await execFileAsync("gh", ["pr", "comment", "--body-file", summaryPath], {
      cwd: rootRes.value,
    });
    output({ ok: true, value: stdout.trim() }, json, (v) => `Commented on PR: ${v}`);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    output(
      {
        ok: false,
        error: {
          code: "run-command-exited",
          message: `gh pr comment failed: ${reason}. Ensure gh is installed and the current branch has a PR.`,
          details: {},
        },
      },
      json,
      () => "",
    );
  }
}

async function runMcpSubcommand(): Promise<void> {
  await runMcpServer();
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  const json = raw.includes("--json");
  const argv = raw.filter((a) => a !== "--json");
  const { cmd, flags } = parseArgs(argv);

  switch (cmd) {
    case "start":
      await handleStart(flags, json);
      break;
    case "shot":
      await handleShot(flags, json);
      break;
    case "record":
      await handleRecord(flags, json);
      break;
    case "stop":
      await handleStop(flags, json);
      break;
    case "list":
      await handleList(flags, json);
      break;
    case "pr":
      await handlePr(flags, json);
      break;
    case "mcp":
      await runMcpSubcommand();
      break;
    default:
      console.error("Usage: ade-proof {start|shot|record|stop|list|pr}");
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
