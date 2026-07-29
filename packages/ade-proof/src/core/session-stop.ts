import { writeFile } from "node:fs/promises";
import { err, ok } from "./result-helpers.js";
import { scanErrors } from "./error-patterns.js";
import { gitignoreWarning, renderSummary } from "./summary-writer.js";
import { readManifest, writeManifestAtomic } from "./manifest-io.js";
import {
  isProcessAlive,
  readSessionLock,
  removeSessionLock,
  retainServerLog,
} from "./session-disk.js";
import {
  SUMMARY_FILENAME,
  type ProofLogError,
  type ProofManifest,
  type ProofResult,
  type SessionRef,
} from "./types.js";

export async function stopSession(
  session: SessionRef,
  opts: { consoleLines?: readonly string[] } = {},
): Promise<ProofResult<{ manifest: ProofManifest; summaryAbsPath: string }>> {
  const lock = await readSessionLock(session.dir);
  const manifestRes = await readManifest(session.dir);
  if (!manifestRes.ok) {
    return { ok: false, error: manifestRes.error };
  }
  const manifest = manifestRes.value;
  if (manifest.finishedAt || !lock) {
    return err("no-active-session", `Session ${session.id} has already stopped.`, {
      state: manifest.finishedAt ? "stopped" : "abandoned",
    });
  }
  if (!isProcessAlive(lock.pid)) {
    return err(
      "no-active-session",
      `Session ${session.id} was abandoned (lock pid ${lock.pid} is not alive).`,
      { state: "abandoned" },
    );
  }
  const finishedAt = new Date().toISOString();
  const serverLog = await retainServerLog(session.dir);
  const serverErrors = serverLog.length ? scanErrors(serverLog, "server") : [];
  const consoleErrors = opts.consoleLines?.length ? scanErrors(opts.consoleLines, "console") : [];
  const errors: readonly ProofLogError[] = [...serverErrors, ...consoleErrors];
  const updated: ProofManifest = { ...manifest, finishedAt, errors };
  const write = await writeManifestAtomic(updated, session.dir);
  if (!write.ok) {
    return { ok: false, error: write.error };
  }
  await removeSessionLock(session.dir);
  const warnings: string[] = [];
  const gitWarn = gitignoreWarning(session.workspaceRoot);
  if (gitWarn) warnings.push(gitWarn);
  const summary = renderSummary(updated, warnings);
  const summaryAbsPath = `${session.dir}/${SUMMARY_FILENAME}`;
  try {
    await writeFile(summaryAbsPath, summary);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err("disk-write-failed", `Could not write summary to ${summaryAbsPath}: ${reason}`);
  }
  return ok({ manifest: updated, summaryAbsPath });
}
