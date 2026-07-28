// FILE: turn-failure.ts
// Purpose: Classify an OMP turn-ending error message as interrupted vs failed.
// Layer: Sidecar engine (OMP)
// Exports: classifyOmpTurnFailure
//
// Deliberately thinner than piTurnFailure's role in PiAdapter: OMP runs
// auto-retry and model fallback inside the engine and reports them as their own
// events, so by the time an error reaches `agent_end` it is already terminal.
// The only question left is whether the user aborted it.

const OMP_INTERRUPTION_MARKERS = [
  "aborterror",
  "request was aborted",
  "operation was aborted",
  "interrupted by user",
  "user aborted",
  "cancelled by user",
] as const;

export interface OmpTurnFailureClassification {
  readonly state: "failed" | "interrupted";
  readonly stopReason: "error" | "aborted";
}

export function classifyOmpTurnFailure(message: string): OmpTurnFailureClassification {
  const normalized = message.trim().toLowerCase();
  return OMP_INTERRUPTION_MARKERS.some((marker) => normalized.includes(marker))
    ? { state: "interrupted", stopReason: "aborted" }
    : { state: "failed", stopReason: "error" };
}
