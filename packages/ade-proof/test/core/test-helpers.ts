import type { ProofError, ProofResult } from "../../src/core/types.js";

export function unwrap<T>(result: ProofResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.code} — ${result.error.message}`);
  }
  return result.value;
}

export function unwrapErr<T>(result: ProofResult<T>): ProofError {
  if (result.ok) {
    throw new Error(`expected error, got value: ${JSON.stringify(result.value)}`);
  }
  return result.error;
}
