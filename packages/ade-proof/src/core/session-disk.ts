import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { err, ok } from "./result-helpers.js";
import { readManifest } from "./manifest-io.js";
import { resolveWorkspaceRoot } from "./paths-and-slugs.js";
import { scanErrors, stripAnsi } from "./error-patterns.js";
import {
  PROOF_DIR_NAME,
  SERVER_LOG_FILENAME,
  SERVER_LOG_HEAD_BYTES,
  SERVER_LOG_TAIL_BYTES,
  SESSION_LOCK_FILENAME,
  type ProofResult,
  type SessionRef,
  type SessionState,
} from "./types.js";

export function proofDir(root: string): string {
  return `${root}/${PROOF_DIR_NAME}`;
}

export function sessionDir(root: string, id: string): string {
  return `${root}/${PROOF_DIR_NAME}/${id}`;
}

export function makeSessionId(root: string, startedAt: string, slugBase: string): string {
  const ts = new Date(startedAt).toISOString().replace(/[-:]/g, "").replace("T", "-").split(".")[0];
  const base = `${ts}-${slugBase}`;
  let id = base;
  let n = 2;
  while (existsSync(sessionDir(root, id))) {
    id = `${base}-${n++}`;
  }
  return id;
}

export async function resolveAndProofDir(
  cwd: string,
): Promise<ProofResult<{ workspaceRoot: string; proofDir: string }>> {
  const root = await resolveWorkspaceRoot(cwd);
  if (!root.ok) return root;
  return ok({ workspaceRoot: root.value, proofDir: proofDir(root.value) });
}

export interface SessionLock {
  readonly pid: number;
  readonly startedAt: string;
}

export async function readSessionLock(dir: string): Promise<SessionLock | undefined> {
  const p = `${dir}/${SESSION_LOCK_FILENAME}`;
  if (!existsSync(p)) return undefined;
  try {
    const raw = await readFile(p, "utf-8");
    const parsed = JSON.parse(raw) as SessionLock;
    if (typeof parsed.pid === "number" && typeof parsed.startedAt === "string") return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

export async function writeSessionLock(dir: string, lock: SessionLock): Promise<ProofResult<void>> {
  const p = `${dir}/${SESSION_LOCK_FILENAME}`;
  await mkdir(dirname(p), { recursive: true });
  try {
    await writeFile(p, JSON.stringify(lock) + "\n");
    return ok(undefined);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err("disk-write-failed", `Could not write lock ${p}: ${reason}`);
  }
}

export async function removeSessionLock(dir: string): Promise<void> {
  const p = `${dir}/${SESSION_LOCK_FILENAME}`;
  try {
    await unlink(p);
  } catch {
    // already gone is fine
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "EPERM"; // process exists, we just lack permission to signal it
  }
}

export async function loadSessionRef(root: string, id: string): Promise<SessionRef | undefined> {
  const dir = sessionDir(root, id);
  if (!existsSync(dir)) return undefined;
  const manifestRes = await readManifest(dir);
  const manifest = manifestRes.ok ? manifestRes.value : undefined;
  const lock = await readSessionLock(dir);
  let state: SessionState;
  if (manifest?.finishedAt) {
    state = "stopped";
  } else if (lock) {
    state = isProcessAlive(lock.pid) ? "active" : "abandoned";
  } else {
    state = "abandoned";
  }
  return {
    id,
    dir,
    workspaceRoot: root,
    state,
  };
}

export async function listSessionIds(workspaceRoot: string): Promise<readonly string[]> {
  const dir = proofDir(workspaceRoot);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

export async function retainServerLog(dir: string): Promise<readonly string[]> {
  const p = `${dir}/${SERVER_LOG_FILENAME}`;
  if (!existsSync(p)) return [];
  try {
    const raw = await readFile(p, "utf-8");
    const stripped = stripAnsi(raw);
    let retained = stripped;
    const byteLimit = SERVER_LOG_HEAD_BYTES + SERVER_LOG_TAIL_BYTES;
    const bytes = Buffer.byteLength(stripped, "utf8");
    if (bytes > byteLimit) {
      const head = Buffer.from(stripped, "utf8")
        .subarray(0, SERVER_LOG_HEAD_BYTES)
        .toString("utf8");
      const tail = Buffer.from(stripped, "utf8").subarray(-SERVER_LOG_TAIL_BYTES).toString("utf8");
      retained = `${head}\n...\n${tail}`;
    }
    await writeFile(p, retained);
    return retained.split("\n");
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return [`[ade-proof] Could not read server.log: ${reason}`];
  }
}
