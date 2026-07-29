import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { err, ok } from "./result-helpers.js";
import type { ProofResult } from "./types.js";

const execFileAsync = promisify(execFile);

export function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "-") // URL-safe: keep alphanum, -, _
    .replace(/--+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export async function resolveWorkspaceRoot(cwd: string): Promise<ProofResult<string>> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
    const root = stdout.trim();
    if (!root) return err("invalid-manifest", `git returned empty toplevel for ${cwd}`);
    const resolved = await realpath(root);
    return ok(resolved);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err("invalid-manifest", `Could not resolve git workspace root for ${cwd}: ${reason}`);
  }
}
