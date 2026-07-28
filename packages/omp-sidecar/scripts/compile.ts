// FILE: compile.ts
// Purpose: Build the self-contained Bun binary that hosts the OMP SDK.
// Layer: Build tooling (@nuncio/omp-sidecar)
//
// Two externals are mandatory:
//   - `omp-legacy-pi-modules` is a runtime-only specifier the engine resolves
//     lazily; bundling fails on it.
//   - `*.node` keeps native addons out of the bundle. The engine looks for
//     `pi_natives.<platform>.node` beside the executable (and in
//     `~/.omp/natives/<version>/`), so packaging places it there.

import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const targetFlag = process.argv.find((arg) => arg.startsWith("--target="));
const outFlag = process.argv.find((arg) => arg.startsWith("--outfile="));

const hostTarget = `bun-${process.platform === "win32" ? "windows" : process.platform}-${
  process.arch === "x64" ? "x64" : "arm64"
}`;
const target = targetFlag?.slice("--target=".length) ?? hostTarget;
const outfile =
  outFlag?.slice("--outfile=".length) ??
  join(packageRoot, "dist", process.platform === "win32" ? "omp-sidecar.exe" : "omp-sidecar");

await mkdir(dirname(outfile), { recursive: true });

const result = Bun.spawnSync(
  [
    "bun",
    "build",
    "--compile",
    `--target=${target}`,
    join(packageRoot, "src/main.ts"),
    "--outfile",
    outfile,
    "--external",
    "omp-legacy-pi-modules",
    "--external",
    "*.node",
  ],
  { cwd: packageRoot, stdout: "inherit", stderr: "inherit" },
);

if (result.exitCode !== 0) {
  console.error(`[omp-sidecar] compile failed for ${target}`);
  process.exit(result.exitCode ?? 1);
}

// The engine resolves `pi_natives.<platform>.node` beside the executable, so the
// binary is only shippable together with it. Placing it here keeps packaging to
// "copy one directory" instead of teaching electron-builder about bun's store.
const [, targetOs, targetArch] = target.split("-");
const nativePlatform = targetOs === "windows" ? "win32" : (targetOs ?? process.platform);
const nativeName = `pi_natives.${nativePlatform}-${targetArch ?? process.arch}.node`;
const nativePackage = `@oh-my-pi/pi-natives-${nativePlatform}-${targetArch ?? process.arch}`;

try {
  // `pi-natives` is a dependency of the SDK, and the platform binary is an
  // optionalDependency of `pi-natives` — neither is linked into this package's
  // own node_modules, so walk the chain from the SDK we do depend on.
  const sdkRoot = dirname(Bun.resolveSync("@oh-my-pi/pi-coding-agent/package.json", packageRoot));
  const nativesRoot = dirname(Bun.resolveSync("@oh-my-pi/pi-natives/package.json", sdkRoot));
  const manifest = Bun.resolveSync(`${nativePackage}/package.json`, nativesRoot);
  const source = join(dirname(manifest), nativeName);
  const destination = join(dirname(outfile), nativeName);
  await Bun.write(destination, Bun.file(source));
  const nativeSize = (await Bun.file(destination).stat()).size;
  console.log(`[omp-sidecar] native ${nativeName} (${(nativeSize / 1024 / 1024).toFixed(1)} MiB)`);
} catch (cause) {
  // Cross-compiling to a platform whose native package is not installed is a
  // CI concern (each runner builds its own target), not a local failure.
  console.warn(
    `[omp-sidecar] WARNING: ${nativePackage} not installed — binary needs ${nativeName} beside it to run.`,
    cause instanceof Error ? cause.message : cause,
  );
}

const size = (await Bun.file(outfile).stat()).size;
console.log(`[omp-sidecar] ${target} -> ${outfile} (${(size / 1024 / 1024).toFixed(1)} MiB)`);
