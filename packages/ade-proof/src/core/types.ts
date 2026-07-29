// Contract types for @nuncio/ade-proof. This file IS the frozen artifact
// contract (docs/plans/ade-proof.md §3) — change with a version bump only.

// ---------------------------------------------------------------- constants

export const PROOF_DIR_NAME = ".ade/proof" as const;
export const MANIFEST_FILENAME = "manifest.json" as const;
export const MANIFEST_VERSION = 1 as const;
export const SESSION_LOCK_FILENAME = "session.lock" as const;
export const SUMMARY_FILENAME = "SUMMARY.md" as const;
export const SERVER_LOG_FILENAME = "server.log" as const;

/** Wait strategy caps — never `networkidle` (SSE/WS apps never settle). */
export const PAGE_SETTLE_DELAY_MS = 750;
export const PAGE_LOAD_TIMEOUT_MS = 20_000;
export const FULL_PAGE_MAX_HEIGHT_PX = 20_000;
export const RECORD_MAX_DURATION_MS = 120_000;
/** server.log retention: head + tail, ANSI stripped. */
export const SERVER_LOG_HEAD_BYTES = 64 * 1024;
export const SERVER_LOG_TAIL_BYTES = 192 * 1024;
export const PORT_WAIT_TIMEOUT_MS = 30_000;

// ------------------------------------------------------------------ errors

export type ProofErrorCode =
  | "no-active-session"
  | "session-already-active"
  | "lock-held"
  | "chrome-not-found"
  | "navigation-failed"
  | "selector-not-found"
  | "storage-state-invalid"
  | "window-not-found"
  | "window-ambiguous"
  | "screen-recording-denied"
  | "port-timeout"
  | "run-command-exited"
  | "port-in-use"
  | "disk-write-failed"
  | "invalid-manifest"
  | "record-too-long"
  | "unsupported-target";

export interface ProofError {
  readonly code: ProofErrorCode;
  /** Human hint: what happened AND the next command to try. */
  readonly message: string;
  /** e.g. probed Chrome paths, candidate window titles, occupying pid. */
  readonly details?: Record<string, unknown>;
}

export type ProofResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProofError };

// ---------------------------------------------------------------- manifest

export type ProofTarget = "web" | "macos" | "electron" | "ios-sim" | "android";

/** One captured artifact. Paths are ALWAYS workspace-relative + URL-safe. */
export interface ProofStep {
  readonly ts: string; // ISO 8601
  readonly label: string;
  readonly target: ProofTarget;
  readonly file: string; // e.g. ".ade/proof/<id>/step-01-login.png"
  readonly url?: string; // requested (web/electron)
  readonly finalUrl?: string; // after redirects; SUMMARY flags mismatch
  readonly httpStatus?: number; // 4xx/5xx still captured, but flagged
  readonly truncated?: boolean; // full-page hit FULL_PAGE_MAX_HEIGHT_PX
  readonly windowTitle?: string; // macos
}

export interface ProofLogError {
  readonly source: "console" | "server";
  readonly pattern: string; // error-pattern id that matched
  readonly line: string; // ANSI-stripped, single line (stacks counted once)
}

export interface ProofManifest {
  readonly version: typeof MANIFEST_VERSION;
  readonly id: string; // "<yyyymmdd-hhmmss>-<slug>", dir name
  readonly description?: string;
  readonly startedAt: string;
  readonly finishedAt?: string; // present ⇔ session stopped
  readonly serverCmd?: string; // --run command line
  readonly steps: readonly ProofStep[];
  readonly errors: readonly ProofLogError[];
  readonly video?: string; // workspace-relative .webm
}

// ----------------------------------------------------------------- session

/** Pure state machine; store persists it as dir + lock + manifest. */
export type SessionState = "active" | "stopped" | "abandoned";
// active:    lock present, pid alive, no finishedAt
// stopped:   finishedAt set (lock removed)
// abandoned: lock present, pid dead — reported by next `start`, reclaimable

export interface SessionRef {
  readonly id: string;
  readonly dir: string; // absolute
  readonly workspaceRoot: string; // git root of cwd (worktree-aware)
  readonly state: SessionState;
}

// ----------------------------------------------------------------- capture

export interface CaptureRequest {
  readonly target: ProofTarget;
  readonly label: string;
  readonly url?: string; // web/electron
  readonly selector?: string; // web: element capture, NO silent fallback
  readonly fullPage?: boolean;
  readonly windowTitle?: string; // macos
  readonly storageStatePath?: string; // web auth (cookies/localStorage JSON)
  readonly outFile: string; // absolute .png path chosen by core
}

export interface CaptureMeta {
  readonly finalUrl?: string;
  readonly httpStatus?: number;
  readonly truncated?: boolean;
  readonly consoleLines?: readonly string[]; // for error-pattern scan
}

/** Every backend implements exactly this; a fake backend drives core tests. */
export interface CaptureBackend {
  readonly target: ProofTarget;
  capture(req: CaptureRequest): Promise<ProofResult<CaptureMeta>>;
}

export interface RecordRequest {
  readonly url: string;
  readonly durationMs: number; // hard-capped at RECORD_MAX_DURATION_MS
  readonly outFile: string; // absolute .webm
  readonly storageStatePath?: string;
}
