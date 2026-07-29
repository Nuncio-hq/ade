/**
 * Pure session-level proof-capture gate logic for the ade-proof extension.
 *
 * Keeps all testable, side-effect-free behavior in one place so the
 * extension index only wires OMP events to state transitions.
 */
export interface SessionProofGateState {
  /** The user (or agent) has run `ade_proof_shot` at least once. */
  shotRan: boolean;
  /** A `git commit` with UI files was observed this session. */
  commitWithUiFiles: boolean;
  /** A write/ast-edit touched a UI-ish file this session. */
  uiFilesChanged: boolean;
  /** The at-most-one continuation has already been requested. */
  continuationRequested: boolean;
}

export const UI_FILE_RE = /\.(tsx|jsx|css|vue|svelte|html)$/i;

export const PROOF_CAPTURE_TOOL = "ade_proof_shot";

export function initialSessionProofGateState(): SessionProofGateState {
  return {
    shotRan: false,
    commitWithUiFiles: false,
    uiFilesChanged: false,
    continuationRequested: false,
  };
}

export function parseGitNameOnly(stdout: string): readonly string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function isSuccessfulGitCommitCommand(command: string): boolean {
  return /^git\s+commit\b/i.test(command.trim());
}

export function noteShotRan(state: SessionProofGateState): SessionProofGateState {
  return { ...state, shotRan: true };
}

export function noteUiFilePaths(
  state: SessionProofGateState,
  paths: readonly string[],
): SessionProofGateState {
  if (
    state.shotRan ||
    state.continuationRequested ||
    !paths.some((path) => UI_FILE_RE.test(path))
  ) {
    return state;
  }
  return { ...state, uiFilesChanged: true };
}

export function noteCommitWithUiFiles(
  state: SessionProofGateState,
  paths: readonly string[],
): SessionProofGateState {
  if (
    state.shotRan ||
    state.continuationRequested ||
    !paths.some((path) => UI_FILE_RE.test(path))
  ) {
    return state;
  }
  return { ...state, commitWithUiFiles: true };
}

export interface StopGateResult {
  continue?: boolean;
  reason?: string;
  additionalContext?: string;
}

export interface StopGateDecision {
  result: StopGateResult;
  nextState: SessionProofGateState;
}

export function decideSessionStopGate(state: SessionProofGateState): StopGateDecision {
  if (
    state.continuationRequested ||
    state.shotRan ||
    (!state.uiFilesChanged && !state.commitWithUiFiles)
  ) {
    return { result: {}, nextState: state };
  }

  const reason = state.commitWithUiFiles
    ? "This session committed UI files but no proof capture was taken. Run `ade_proof_shot` to capture the final state before stopping."
    : "This session edited UI files but no proof capture was taken. Run `ade_proof_shot` to capture the final state before stopping.";

  return {
    result: { continue: true, reason },
    nextState: { ...state, continuationRequested: true },
  };
}
