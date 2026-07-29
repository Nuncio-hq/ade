import { mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { err, ok } from "./result-helpers.js";
import { readManifest, writeManifestAtomic } from "./manifest-io.js";
import { slugify } from "./paths-and-slugs.js";
import { stopSession } from "./session-stop.js";
import {
  makeSessionId,
  proofDir,
  sessionDir,
  writeSessionLock,
  loadSessionRef,
  type SessionLock,
} from "./session-disk.js";
import {
  MANIFEST_VERSION,
  PROOF_DIR_NAME,
  type ProofManifest,
  type ProofResult,
  type ProofStep,
  type SessionRef,
} from "./types.js";

export { stopSession } from "./session-stop.js";

export async function startSession(opts: {
  workspaceRoot: string;
  description?: string;
  slug?: string;
  serverCmd?: string;
}): Promise<ProofResult<SessionRef>> {
  const { workspaceRoot } = opts;
  const base = opts.slug || slugify(opts.description || "session");
  const startedAt = new Date().toISOString();
  const id = makeSessionId(workspaceRoot, startedAt, base);
  const dir = sessionDir(workspaceRoot, id);
  try {
    await mkdir(dir, { recursive: true });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err("disk-write-failed", `Could not create session dir ${dir}: ${reason}`);
  }
  const manifest: ProofManifest = {
    version: MANIFEST_VERSION,
    id,
    startedAt,
    steps: [],
    errors: [],
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.serverCmd ? { serverCmd: opts.serverCmd } : {}),
  };
  const write = await writeManifestAtomic(manifest, dir);
  if (!write.ok) {
    return { ok: false, error: write.error };
  }
  const lock: SessionLock = { pid: process.pid, startedAt };
  const lockWrite = await writeSessionLock(dir, lock);
  if (!lockWrite.ok) {
    return { ok: false, error: lockWrite.error };
  }
  return ok({ id, dir, workspaceRoot, state: "active" });
}

export async function findSession(
  workspaceRoot: string,
  id?: string,
): Promise<ProofResult<SessionRef>> {
  if (id) {
    const ref = await loadSessionRef(workspaceRoot, id);
    if (!ref) {
      return err("no-active-session", `No session ${id} in ${workspaceRoot}.`);
    }
    return ok(ref);
  }
  const sessions = await listSessions(workspaceRoot);
  const active = sessions.filter((s) => s.state === "active");
  if (active.length) {
    const first = active[0];
    if (first) return ok(first);
  }
  const abandoned = sessions.filter((s) => s.state === "abandoned").map((s) => s.id);
  return err("no-active-session", `No active session in ${workspaceRoot}.`, {
    abandoned,
    hint: "Run 'ade-proof start' or reclaim an abandoned session with --force.",
  });
}

export async function listSessions(workspaceRoot: string): Promise<readonly SessionRef[]> {
  const dir = proofDir(workspaceRoot);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const refs: SessionRef[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const ref = await loadSessionRef(workspaceRoot, e.name);
    if (ref) refs.push(ref);
  }
  refs.sort((a, b) => b.id.localeCompare(a.id)); // ids are timestamp-prefixed, lexicographic is newest-first
  return refs;
}

export async function nextStepFile(
  session: SessionRef,
  label: string,
): Promise<ProofResult<{ absPath: string; relPath: string }>> {
  if (session.state !== "active") {
    return err("no-active-session", `Session ${session.id} is ${session.state}; cannot add steps.`);
  }
  const manifestRes = await readManifest(session.dir);
  if (!manifestRes.ok) {
    return { ok: false, error: manifestRes.error };
  }
  const manifest = manifestRes.value;
  const files = await readdir(session.dir);
  const re = /step-(\d+)-.+\.png$/;
  let max = manifest.steps.length;
  for (const f of files) {
    const m = re.exec(f);
    if (m) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  for (const step of manifest.steps) {
    const basename = step.file.split("/").pop() ?? "";
    const m = re.exec(basename);
    if (m) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  const next = max + 1;
  const slug = slugify(label);
  const file = `step-${String(next).padStart(2, "0")}-${slug}.png`;
  const absPath = join(session.dir, file);
  const relPath = `${PROOF_DIR_NAME}/${session.id}/${file}`;
  return ok({ absPath, relPath });
}

export async function addStep(
  session: SessionRef,
  step: Omit<ProofStep, "ts">,
): Promise<ProofResult<ProofStep>> {
  if (session.state !== "active") {
    return err("no-active-session", `Session ${session.id} is ${session.state}; cannot add steps.`);
  }
  const manifestRes = await readManifest(session.dir);
  if (!manifestRes.ok) {
    return { ok: false, error: manifestRes.error };
  }
  const manifest = manifestRes.value;
  const full: ProofStep = { ...step, ts: new Date().toISOString() };
  const next: ProofManifest = { ...manifest, steps: [...manifest.steps, full] };
  const write = await writeManifestAtomic(next, session.dir);
  if (!write.ok) {
    return { ok: false, error: write.error };
  }
  return ok(full);
}

export async function setVideo(session: SessionRef, relPath: string): Promise<ProofResult<void>> {
  if (session.state !== "active") {
    return err("no-active-session", `Session ${session.id} is ${session.state}; cannot set video.`);
  }
  const manifestRes = await readManifest(session.dir);
  if (!manifestRes.ok) {
    return manifestRes;
  }
  const next = { ...manifestRes.value, video: relPath };
  return writeManifestAtomic(next, session.dir);
}
