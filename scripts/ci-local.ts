// FILE: ci-local.ts
// Purpose: Run the GitHub CI quality gate locally, cheapest steps first, fail-fast.
// Mirrors .github/workflows/ci.yml so failures surface in minutes instead of a
// 20-minute browser timeout on the runner.
//
// Usage:
//   bun run ci:local:fast          brand/fmt/lint/typecheck/migrations/smoke
//   bun run ci:local               fast + full unit tests (default pre-push)
//   bun run ci:local:web           + Playwright stable browser suite
//   bun run ci:local:full          + desktop build (closest to the Ubuntu job)
//
// Flags (also accepted on `node scripts/ci-local.ts …`):
//   --fast | --web | --build | --install-browsers | --help

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Step = {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
};

const args = new Set(process.argv.slice(2));
const wantsHelp = args.has("--help") || args.has("-h");
const fastOnly = args.has("--fast");
const withWeb = args.has("--web") || args.has("--build");
const withBuild = args.has("--build");
const installBrowsers = args.has("--install-browsers");

if (wantsHelp) {
  console.log(`ci-local — local mirror of the GitHub CI quality gate (fail-fast)

  bun run ci:local:fast    ~2–5 min   brand, fmt, lint, typecheck, migrations, release smoke
  bun run ci:local         ~8–15 min  + full unit tests          ← default before push
  bun run ci:local:web     +5–15 min  + Playwright stable suite  ← when touching web/vite/vitest
  bun run ci:local:full             + desktop build             ← closest to the Ubuntu job

  Extra flags on the script:
    --install-browsers   run Playwright chromium install before browser tests
    --help               show this message

  Tip: if browser hangs >3 min on "[optimizer] bundling dependencies...", kill it —
  that is the same hang CI hits at the 20-minute step timeout.`);
  process.exit(0);
}

if (fastOnly && (withWeb || withBuild)) {
  console.error("ci-local: --fast cannot be combined with --web/--build");
  process.exit(2);
}

const steps: Step[] = [
  { name: "brand:check", command: "bun", args: ["run", "brand:check"] },
  { name: "fmt:check", command: "bun", args: ["run", "fmt:check"] },
  { name: "lint", command: "bun", args: ["run", "lint"] },
  { name: "typecheck", command: "bun", args: ["run", "typecheck"] },
  { name: "migrations:check", command: "bun", args: ["run", "migrations:check"] },
  { name: "release:smoke", command: "bun", args: ["run", "release:smoke"] },
];

if (!fastOnly) {
  steps.push({ name: "test", command: "bun", args: ["run", "test"] });
}

if (withWeb) {
  if (installBrowsers || !hasPlaywrightChromiumCache()) {
    steps.push({
      name: "test:browser:install",
      command: "bun",
      args: ["run", "--cwd", "apps/web", "test:browser:install"],
    });
  }
  steps.push({
    name: "test:browser:stable",
    command: "bun",
    args: ["run", "--cwd", "apps/web", "test:browser:stable"],
  });
}

if (withBuild) {
  steps.push({ name: "build:desktop", command: "bun", args: ["run", "build:desktop"] });
  steps.push({
    name: "verify preload bundle",
    command: "node",
    args: [
      "-e",
      [
        "const fs=require('node:fs');",
        "const p='apps/desktop/dist-electron/preload.js';",
        "if(!fs.existsSync(p)) { console.error('missing '+p); process.exit(1); }",
        "const s=fs.readFileSync(p,'utf8');",
        "if(!/desktopBridge|getWsUrl|PICK_FOLDER_CHANNEL|wsUrl/.test(s)) {",
        "  console.error('preload.js missing expected bridge markers');",
        "  process.exit(1);",
        "}",
        "console.log('preload bundle ok');",
      ].join(""),
    ],
  });
}

function hasPlaywrightChromiumCache(): boolean {
  const candidates = [
    join(homedir(), "Library", "Caches", "ms-playwright"),
    join(homedir(), ".cache", "ms-playwright"),
  ];
  for (const base of candidates) {
    if (!existsSync(base)) continue;
    try {
      // Any chromium* dir is good enough to skip a cold install prompt.
      if (readdirSync(base).some((name) => name.startsWith("chromium"))) {
        return true;
      }
    } catch {
      // ignore unreadable cache dirs
    }
  }
  return false;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds - minutes * 60);
  return `${minutes}m${String(rem).padStart(2, "0")}s`;
}

console.log(
  `ci-local: ${steps.length} steps (${fastOnly ? "fast" : withBuild ? "full" : withWeb ? "web" : "default"})`,
);

const wallStart = Date.now();
for (const [index, step] of steps.entries()) {
  const label = `[${index + 1}/${steps.length}] ${step.name}`;
  console.log(`\n→ ${label}`);
  const started = Date.now();
  const result = spawnSync(step.command, [...step.args], {
    stdio: "inherit",
    cwd: step.cwd,
    env: process.env,
    shell: false,
  });
  const elapsed = formatDuration(Date.now() - started);
  if (result.error) {
    console.error(`\n✗ ${label} failed to start (${elapsed}): ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\n✗ ${label} failed (${elapsed}), exit ${result.status ?? "?"}`);
    if (step.name === "test:browser:stable") {
      console.error(
        "  Hint: first-time setup → bun run ci:local:web -- --install-browsers\n" +
          "  Hint: hang on bundling dependencies >3 min → kill; check vite.config imports vite not vitest/config",
      );
    }
    console.error(`ci-local: stopped after ${formatDuration(Date.now() - wallStart)}`);
    process.exit(result.status ?? 1);
  }
  console.log(`✓ ${label} (${elapsed})`);
}

console.log(
  `\nci-local: all ${steps.length} steps passed in ${formatDuration(Date.now() - wallStart)}`,
);
