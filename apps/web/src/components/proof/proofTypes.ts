// FILE: proofTypes.ts
// Purpose: Local proof-of-work manifest types for the web panel.
// Layer: Web UI types

export type ProofTarget = "web" | "macos" | "electron" | "ios-sim" | "android";

export interface ProofStep {
  readonly ts: string;
  readonly label: string;
  readonly target: ProofTarget;
  readonly file: string;
  readonly url?: string;
  readonly finalUrl?: string;
  readonly httpStatus?: number;
  readonly truncated?: boolean;
  readonly windowTitle?: string;
}

export interface ProofLogError {
  readonly source: "console" | "server";
  readonly pattern: string;
  readonly line: string;
}

export interface ProofManifest {
  readonly version: 1;
  readonly id: string;
  readonly description?: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly serverCmd?: string;
  readonly steps: readonly ProofStep[];
  readonly errors: readonly ProofLogError[];
  readonly video?: string;
}
