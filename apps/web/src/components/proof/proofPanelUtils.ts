// FILE: proofPanelUtils.ts
// Purpose: Pure helpers for the proof panel (red flags, formatting).
// Layer: Web UI helpers

import type { ProofManifest } from "./proofTypes";

export function redFlagMessages(manifest: ProofManifest): string[] {
  const flags: string[] = [];
  for (const step of manifest.steps) {
    if (step.url && step.finalUrl && step.url !== step.finalUrl) {
      flags.push(`Step "${step.label}" ended at ${step.finalUrl} instead of ${step.url}`);
    }
    if (step.httpStatus && step.httpStatus >= 400) {
      flags.push(`Step "${step.label}" returned HTTP ${step.httpStatus}`);
    }
    if (step.truncated) {
      flags.push(`Step "${step.label}" screenshot was truncated`);
    }
  }
  for (const error of manifest.errors) {
    flags.push(`${error.source} log matched "${error.pattern}": ${error.line}`);
  }
  return flags;
}

export function sessionDisplayTitle(session: ProofManifest): string {
  return session.description?.trim() || session.id;
}

export function formatStartedAt(startedAt: string): string {
  try {
    return new Date(startedAt).toLocaleString();
  } catch {
    return startedAt;
  }
}
