import type { ProofErrorCode, ProofResult } from "./types.js";

export function ok<T>(value: T): ProofResult<T> {
  return { ok: true, value };
}

export function err<T>(
  code: ProofErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ProofResult<T> {
  const error = details ? { code, message, details } : { code, message };
  return { ok: false, error };
}
