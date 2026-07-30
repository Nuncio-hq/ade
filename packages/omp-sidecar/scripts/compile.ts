// FILE: compile.ts
// Purpose: Build the self-contained Bun binary that hosts the OMP SDK.
// Layer: Build tooling (@nuncio/omp-sidecar)
//
// The engine's legacy-Pi compat layer serves `@oh-my-pi/*` imports made by
// runtime-loaded extensions through an `omp-legacy-pi-modules` registry that
// must be synthesized AT BUILD TIME (Bun 1.3.14+ cannot reach bunfs entries
// at runtime — engine issue #3423). The upstream plugin
// (`scripts/legacy-pi-virtual-module.ts`) assumes the OMP monorepo layout, so
// this script rebuilds the entry list from the installed node_modules layout
// and reuses the upstream renderer. Without this plugin every file-based
// extension fails to load with "Cannot find package 'omp-legacy-pi-modules'".
//
// `*.node` stays external: the engine looks for `pi_natives.<platform>.node`
// beside the executable (and in `~/.omp/natives/<version>/`), so packaging
// places it there.

import { mkdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const targetFlag = process.argv.find((arg) => arg.startsWith("--target="));
const outFlag = process.argv.find((arg) => arg.startsWith("--outfile="));

const hostTarget = `bun-${process.platform === "win32" ? "windows" : process.platform}-${
  process.arch === "x64" ? "x64" : "arm64"
}`;
const target = (targetFlag?.slice("--target=".length) ?? hostTarget) as Bun.Build.CompileTarget;
const outfile =
  outFlag?.slice("--outfile=".length) ??
  join(packageRoot, "dist", process.platform === "win32" ? "omp-sidecar.exe" : "omp-sidecar");

// ---------------------------------------------------------------------------
// Legacy-Pi bundled module registry (installed-layout replacement for the
// upstream collectBundledPiEntries, which requires the OMP monorepo).
// ---------------------------------------------------------------------------

interface BundledPiPackage {
  readonly name: string;
  /** Root import redirected to a compat shim inside pi-coding-agent. */
  readonly rootShim?: string;
}

// Mirrors BUNDLED_PACKAGES in the upstream script (same six packages).
const BUNDLED_PI_PACKAGES: readonly BundledPiPackage[] = [
  { name: "@oh-my-pi/pi-agent-core" },
  { name: "@oh-my-pi/pi-ai", rootShim: "legacy-pi-ai-shim.ts" },
  {
    name: "@oh-my-pi/pi-coding-agent",
    rootShim: "legacy-pi-coding-agent-shim.ts",
  },
  { name: "@oh-my-pi/pi-natives" },
  { name: "@oh-my-pi/pi-tui", rootShim: "legacy-pi-tui-shim.ts" },
  { name: "@oh-my-pi/pi-utils" },
];

function installedPackageRoot(name: string, importer: string = packageRoot): string {
  // pi-natives/pi-tui/pi-utils are transitive deps of the SDK, not of this
  // package — resolve them from the SDK's own root (second argument).
  const entry = Bun.resolveSync(name, importer);
  const marker = `${sep}node_modules${sep}${name.replaceAll("/", sep)}${sep}`;
  const index = entry.lastIndexOf(marker);
  if (index === -1) {
    throw new Error(`Cannot derive package root for ${name} from ${entry}`);
  }
  return entry.slice(0, index + marker.length - 1);
}

interface BundledPiEntry {
  readonly key: string;
  readonly binding: string;
  readonly importSpecifier: string;
}

async function collectInstalledBundledPiEntries(
  codingAgentRoot: string,
): Promise<BundledPiEntry[]> {
  const entries: BundledPiEntry[] = [];
  const seen = new Set<string>();
  const addEntry = (key: string, importSpecifier: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ key, binding: `bundled${entries.length}`, importSpecifier });
  };

  // The virtual module lives in a namespace with no filesystem directory, so
  // bare `@oh-my-pi/*` specifiers inside it would resolve from the build root
  // (where they are not dependencies). Emit RESOLVED absolute file paths.
  const resolveFromSdk = (specifier: string): string | null => {
    try {
      return Bun.resolveSync(specifier, codingAgentRoot);
    } catch {
      return null; // types-only / conditional export — nothing to bundle
    }
  };

  for (const pkg of BUNDLED_PI_PACKAGES) {
    const root =
      pkg.name === "@oh-my-pi/pi-coding-agent"
        ? codingAgentRoot
        : installedPackageRoot(pkg.name, codingAgentRoot);
    const manifest = (await Bun.file(join(root, "package.json")).json()) as {
      exports?: Record<string, unknown>;
    };
    const rootSpecifier = pkg.rootShim
      ? join(codingAgentRoot, "src", "extensibility", pkg.rootShim)
      : resolveFromSdk(pkg.name);
    if (rootSpecifier) addEntry(pkg.name, rootSpecifier);
    // Explicit (non-wildcard) subpath exports; wildcard exports are
    // intentionally not expanded — none of the harness extensions import
    // them, and the upstream expansion needs monorepo globs.
    for (const exportKey of Object.keys(manifest.exports ?? {})) {
      if (!exportKey.startsWith("./") || exportKey === "." || exportKey.includes("*")) continue;
      const key = `${pkg.name}/${exportKey.slice(2)}`;
      const resolved = resolveFromSdk(key);
      if (resolved) addEntry(key, resolved);
    }
  }

  // Zod-backed TypeBox shim, same key the compat layer requests.
  addEntry("typebox", join(codingAgentRoot, "src", "extensibility", "typebox.ts"));
  return entries;
}

function renderLegacyPiVirtualModule(entries: readonly BundledPiEntry[]): string {
  // Same output shape as the upstream __renderLegacyPiVirtualModule.
  const loaders = entries.map(
    (entry) => `const ${entry.binding} = () => import(${JSON.stringify(entry.importSpecifier)});`,
  );
  const modules = entries.map((entry) => `\t${JSON.stringify(entry.key)}: ${entry.binding},`);
  return [...loaders, "", "export const BUNDLED_PI_MODULE_LOADERS = {", ...modules, "};", ""].join(
    "\n",
  );
}

const codingAgentRoot = installedPackageRoot("@oh-my-pi/pi-coding-agent");
const virtualModuleSource = renderLegacyPiVirtualModule(
  await collectInstalledBundledPiEntries(codingAgentRoot),
);

const legacyPiVirtualModulePlugin: Bun.BunPlugin = {
  name: "nuncio:omp-legacy-pi-modules",
  setup(build) {
    build.onResolve({ filter: /^omp-legacy-pi-modules$/ }, () => ({
      path: "omp-legacy-pi-modules",
      namespace: "omp-legacy-pi-modules-build",
    }));
    build.onLoad({ filter: /.*/, namespace: "omp-legacy-pi-modules-build" }, () => ({
      contents: virtualModuleSource,
      loader: "ts",
    }));
  },
};

// ---------------------------------------------------------------------------

await mkdir(dirname(outfile), { recursive: true });

const output = await Bun.build({
  entrypoints: [join(packageRoot, "src/main.ts")],
  external: ["*.node"],
  plugins: [legacyPiVirtualModulePlugin],
  compile: {
    target,
    outfile,
  },
  throw: false,
});

if (!output.success) {
  console.error(`[omp-sidecar] compile failed for ${target}`);
  for (const log of output.logs) {
    console.error(log.message);
  }
  process.exit(1);
}

console.log(`[omp-sidecar] compiled ${outfile} (${target})`);
