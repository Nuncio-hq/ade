// FILE: rebrand-identity.ts
// Purpose: Deterministic codemod that rebrands inherited Synara identity to NuncioADE.
// Kept as a permanent asset: after every upstream sync, the shadow branch
// (sync/rebranded-upstream) re-applies this script so merges stay nearly clean.
// Modes: default = apply in place; --check = report what would change, exit 1 (CI).

import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

interface RebrandRule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

// Order matters: the scoped-package rule must run before the bare lowercase
// rule so "@synara/shared" becomes "@nuncio/shared", not "@nuncioade/shared".
export const REBRAND_RULES: readonly RebrandRule[] = [
  { pattern: /@synara\//g, replacement: "@nuncio/" },
  { pattern: /SYNARA_/g, replacement: "NUNCIO_" },
  { pattern: /Synara/g, replacement: "NuncioADE" },
  { pattern: /synara/g, replacement: "nuncioade" },
];

export const EXEMPT_MARKER = "rebrand-exempt";

// Strings that must survive verbatim: upstream repository references and the
// upstream hosted site (docs/changelog/feedback endpoints we still point at).
// The markdown-link entry must come first so its link text is protected before
// the bare URL pattern can match inside it.
const PROTECTIONS: readonly RegExp[] = [
  /\[Synara\]\(https:\/\/github\.com\/Emanuele-web04\/synara\)/g,
  /Emanuele-web04\/synara/gi,
  /trysynara/gi,
];

const EXEMPT_PATHS = new Set([
  "SYNARA-AGENTS.md",
  "SYNARA-CLAUDE.md",
  "docs/DECISIONS.md",
  "CHANGELOG.md",
  "UPSTREAM-BASE",
  "bun.lock",
  // The codemod and its fixtures must survive verbatim so future runs keep the
  // old tokens they match against.
  "scripts/rebrand-identity.ts",
  "scripts/rebrand-identity.test.ts",
]);

// Migration files are immutable history: their SQL was applied to real
// databases and their contents must never change.
const EXEMPT_PREFIXES = [
  "plans/",
  ".plans/",
  "audit/",
  "advisor-plans/",
  "apps/server/src/persistence/Migrations/",
];

export function isExemptPath(path: string): boolean {
  return EXEMPT_PATHS.has(path) || EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function applyRules(text: string): string {
  let result = text;
  for (const rule of REBRAND_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

export function transformContent(contents: string): string {
  if (contents.includes("\0")) return contents;

  const protectedValues: string[] = [];
  let protectedContents = contents;
  for (const pattern of PROTECTIONS) {
    protectedContents = protectedContents.replace(pattern, (match) => {
      protectedValues.push(match);
      return `@@REBRAND_PROTECTED_${protectedValues.length - 1}@@`;
    });
  }

  const transformed = protectedContents
    .split("\n")
    .map((line) => (line.includes(EXEMPT_MARKER) ? line : applyRules(line)))
    .join("\n");

  return transformed.replace(
    /@@REBRAND_PROTECTED_(\d+)@@/g,
    (_placeholder, index) => protectedValues[Number(index)] ?? "",
  );
}

export function transformPath(path: string): string {
  return isExemptPath(path) ? path : applyRules(path);
}

interface RebrandChange {
  readonly path: string;
  readonly kind: "content" | "rename";
  readonly renamedTo?: string;
}

function collectChanges(): { changes: RebrandChange[]; apply: () => void } {
  const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);

  const changes: RebrandChange[] = [];
  const contentWrites: Array<{ path: string; contents: string }> = [];
  const renames: Array<{ from: string; to: string }> = [];

  for (const path of paths) {
    if (isExemptPath(path)) continue;

    const raw = readFileSync(path);
    if (!raw.includes(0)) {
      const contents = raw.toString("utf8");
      const rebranded = transformContent(contents);
      if (rebranded !== contents) {
        changes.push({ path, kind: "content" });
        contentWrites.push({ path, contents: rebranded });
      }
    }

    const renamedTo = transformPath(path);
    if (renamedTo !== path) {
      changes.push({ path, kind: "rename", renamedTo });
      renames.push({ from: path, to: renamedTo });
    }
  }

  return {
    changes,
    apply: () => {
      for (const { path, contents } of contentWrites) writeFileSync(path, contents);
      for (const { from, to } of renames) renameSync(from, to);
    },
  };
}

function main(): void {
  const checkOnly = process.argv.includes("--check");
  const { changes, apply } = collectChanges();

  if (changes.length === 0) {
    console.log("Rebrand identity: nothing to change.");
    return;
  }

  for (const change of changes) {
    const detail = change.kind === "rename" ? ` -> ${change.renamedTo}` : "";
    console.log(`- ${change.kind}: ${change.path}${detail}`);
  }

  if (checkOnly) {
    console.error(`Rebrand identity: ${changes.length} pending change(s). Run without --check.`);
    process.exitCode = 1;
    return;
  }

  apply();
  console.log(`Rebrand identity: applied ${changes.length} change(s).`);
}

if (import.meta.main) main();
