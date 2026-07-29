import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Resolve the absolute path to the `ade-proof` CLI entrypoint from this
 * extension file. Works when the extension is symlinked from
 * `~/.omp/agent/extensions/ade-proof/` because `realpath` follows the link.
 */
export async function resolveAdeProofCliPath(): Promise<string> {
  const thisFile = fileURLToPath(import.meta.url);
  const realThisFile = await realpath(thisFile);
  const extDir = dirname(realThisFile);
  // extDir  = <repo>/harness/extensions/ade-proof
  // target  = <repo>/packages/ade-proof/src/cli.ts
  return resolve(extDir, "../../../packages/ade-proof/src/cli.ts");
}
