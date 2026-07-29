#!/usr/bin/env bun
// Self-contained install of the ade-proof OMP extension: compiles the CLI to
// a single Bun binary and COPIES extension sources + binary into the OMP
// global agent dir. No symlinks — the install survives repo moves/deletion.
//
// Usage: bun run install:omp            (from packages/ade-proof)
//        OMP_AGENT_DIR=… bun scripts/install-omp.ts

import { $ } from "bun";
import { chmod, cp, lstat, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const pkgDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(pkgDir, "../..");
const extSrcDir = join(repoRoot, "harness/extensions/ade-proof");
const targetDir = join(
  process.env["OMP_AGENT_DIR"] ?? join(homedir(), ".omp/agent"),
  "extensions/ade-proof",
);

// Refuse to clobber a symlinked (dev) install silently.
const existing = await lstat(targetDir).catch(() => undefined);
if (existing?.isSymbolicLink()) {
  await rm(targetDir);
  console.log(`Removed dev symlink at ${targetDir}`);
}

await mkdir(targetDir, { recursive: true });

console.log("Compiling CLI binary…");
await $`bun build --compile ${join(pkgDir, "src/cli.ts")} --outfile ${join(targetDir, "ade-proof-cli")}`.cwd(
  pkgDir,
);
await chmod(join(targetDir, "ade-proof-cli"), 0o755);

console.log("Copying extension sources…");
for (const file of ["index.ts", "logic.ts", "run-ade-proof.ts", "resolve-cli.ts"]) {
  await cp(join(extSrcDir, file), join(targetDir, file));
}

console.log(`Installed ade-proof (self-contained) → ${targetDir}`);
console.log("Running omp sessions need /reload (or a new session) to pick this up.");
