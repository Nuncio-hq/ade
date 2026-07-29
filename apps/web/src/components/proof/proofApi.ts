// FILE: proofApi.ts
// Purpose: Fetch helpers for the proof panel.
// Layer: Web UI data access

import type { ProofManifest } from "./proofTypes";

export interface ProofSessionsResponse {
  readonly sessions: readonly ProofManifest[];
}

export async function fetchProofSessions(
  cwd: string | null | undefined,
): Promise<ProofSessionsResponse> {
  if (!cwd) {
    return { sessions: [] };
  }
  const response = await fetch(`/api/proof/sessions?cwd=${encodeURIComponent(cwd)}`, {
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(`Failed to load proof sessions: ${response.status}`);
  }
  return (await response.json()) as ProofSessionsResponse;
}

export async function fetchProofSummary(cwd: string, relPath: string): Promise<string | null> {
  const response = await fetch(proofFileUrl(cwd, relPath), { credentials: "same-origin" });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to load summary: ${response.status}`);
  }
  return await response.text();
}

export function proofFileUrl(cwd: string, relPath: string): string {
  return `/api/proof/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(relPath)}`;
}
