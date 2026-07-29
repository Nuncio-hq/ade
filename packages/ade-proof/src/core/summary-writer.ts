import { existsSync, readFileSync } from "node:fs";
import type { ProofManifest, ProofStep } from "./types.js";

const GITIGNORE_PATH = ".gitignore";

export function hasGitignoreAde(workspaceRoot: string): boolean {
  const p = `${workspaceRoot}/${GITIGNORE_PATH}`;
  if (!existsSync(p)) return false;
  try {
    const raw = readFileSync(p, "utf-8");
    return raw.split("\n").some((line) => {
      const hash = line.indexOf("#");
      const trimmed = (hash === -1 ? line : line.slice(0, hash)).trim();
      return trimmed === ".ade" || trimmed === ".ade/" || trimmed.startsWith(".ade/");
    });
  } catch {
    return false;
  }
}

export function gitignoreWarning(workspaceRoot: string): string | undefined {
  if (hasGitignoreAde(workspaceRoot)) return undefined;
  const p = `${workspaceRoot}/${GITIGNORE_PATH}`;
  if (!existsSync(p)) {
    return `No .gitignore found at workspace root. Add ".ade/" to avoid committing artifacts.`;
  }
  return `.gitignore does not ignore ".ade/". Add ".ade/" to avoid committing artifacts.`;
}

export function renderSummary(manifest: ProofManifest, warnings: readonly string[]): string {
  const lines: string[] = [];
  lines.push(`# Proof Summary: ${manifest.id}`);
  lines.push("");
  if (manifest.description) {
    lines.push(`**Description:** ${manifest.description}`);
  }
  lines.push(`**Started:** ${manifest.startedAt}`);
  if (manifest.finishedAt) {
    lines.push(`**Finished:** ${manifest.finishedAt}`);
  }
  if (manifest.serverCmd) {
    lines.push(`**Server command:** \`${manifest.serverCmd}\``);
  }
  lines.push("");

  const stepFlags = collectStepFlags(manifest.steps);
  if (stepFlags.length) {
    lines.push("## Flags");
    for (const f of stepFlags) lines.push(`- ${f}`);
    lines.push("");
  }

  if (warnings.length) {
    lines.push("## Warnings");
    for (const w of warnings) lines.push(`- ${w}`);
    lines.push("");
  }

  if (manifest.video) {
    lines.push(`**Video:** ${manifest.video}`);
    lines.push("");
  }

  if (manifest.steps.length) {
    lines.push("## Steps");
    lines.push("");
    lines.push("| # | Label | Target | File |");
    lines.push("|---|-------|--------|------|");
    let i = 1;
    for (const s of manifest.steps) {
      const flags = stepCellFlags(s);
      lines.push(`| ${i} | ${s.label} | ${s.target} | ${s.file}${flags} |`);
      i++;
    }
    lines.push("");
  }

  if (manifest.errors.length) {
    lines.push("## Errors");
    lines.push("");
    for (const e of manifest.errors) {
      lines.push(`- **${e.source}** \`${e.pattern}\`: ${e.line}`);
    }
    lines.push("");
  } else {
    lines.push("## Errors");
    lines.push("");
    lines.push("No errors detected.");
    lines.push("");
  }

  return lines.join("\n");
}

function stepCellFlags(step: ProofStep): string {
  const parts: string[] = [];
  if (step.httpStatus && step.httpStatus >= 400) parts.push(`HTTP ${step.httpStatus}`);
  if (step.finalUrl && step.url && step.finalUrl !== step.url) parts.push("redirected");
  if (step.truncated) parts.push("truncated");
  if (step.windowTitle) parts.push(`"${step.windowTitle}"`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function collectStepFlags(steps: readonly ProofStep[]): string[] {
  const out: string[] = [];
  let i = 1;
  for (const s of steps) {
    if (s.httpStatus && s.httpStatus >= 400) {
      out.push(`Step ${i} returned HTTP ${s.httpStatus} (${s.label}).`);
    }
    if (s.url && s.finalUrl && s.url !== s.finalUrl) {
      out.push(`Step ${i} redirected from ${s.url} to ${s.finalUrl}.`);
    }
    if (s.truncated) {
      out.push(`Step ${i} was truncated (page height exceeded the cap).`);
    }
    i++;
  }
  return out;
}
