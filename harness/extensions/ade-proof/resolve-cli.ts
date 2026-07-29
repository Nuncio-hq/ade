import { realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * How to invoke the ade-proof CLI: `argv0` plus leading args (the actual
 * subcommand args are appended by the caller).
 */
export interface AdeProofCliInvocation {
  readonly argv0: string;
  readonly prefixArgs: readonly string[];
}

/**
 * Resolve the ade-proof CLI, most-specific first:
 * 1. `NUNCIO_ADE_PROOF_CLI` — explicit override (path to binary or cli.ts).
 * 2. `ade-proof-cli` compiled binary next to this file — the copied,
 *    self-contained install produced by `bun run install:omp`.
 * 3. `<repo>/packages/ade-proof/src/cli.ts` relative to this file's realpath —
 *    dev flow (in-repo or symlinked extension).
 */
export async function resolveAdeProofCli(): Promise<AdeProofCliInvocation> {
  const override = process.env["NUNCIO_ADE_PROOF_CLI"];
  if (override) return toInvocation(override);

  const thisFile = fileURLToPath(import.meta.url);
  const siblingBinary = resolve(dirname(thisFile), "ade-proof-cli");
  if (existsSync(siblingBinary)) return { argv0: siblingBinary, prefixArgs: [] };

  const realThisFile = await realpath(thisFile);
  const repoCli = resolve(dirname(realThisFile), "../../../packages/ade-proof/src/cli.ts");
  return toInvocation(repoCli);
}

function toInvocation(path: string): AdeProofCliInvocation {
  return path.endsWith(".ts")
    ? { argv0: "bun", prefixArgs: [path] }
    : { argv0: path, prefixArgs: [] };
}
