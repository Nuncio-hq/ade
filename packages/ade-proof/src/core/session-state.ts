import { err, ok } from "./result-helpers.js";
import type { ProofResult, SessionRef, SessionState } from "./types.js";

/** Pure in-memory session table used by the state-machine tests. */
export type SessionMap = Readonly<Record<string, SessionRef>>;

function withState(map: SessionMap, ref: SessionRef, state: SessionState): SessionMap {
  return { ...map, [ref.id]: { ...ref, state } };
}

export function startSession(
  map: SessionMap,
  ref: SessionRef,
  { force = false }: { force?: boolean } = {},
): { map: SessionMap; result: ProofResult<SessionRef> } {
  const existing = map[ref.id];
  if (existing) {
    if (existing.state === "active") {
      return {
        map,
        result: err(
          "session-already-active",
          `Session ${ref.id} is already active. Stop it or use a different id.`,
        ),
      };
    }
    if (existing.state === "abandoned") {
      if (!force) {
        return {
          map,
          result: err(
            "lock-held",
            `Session ${ref.id} was abandoned (stale lock). Reclaim with --force or start a new session.`,
          ),
        };
      }
      return { map: withState(map, ref, "active"), result: ok(ref) };
    }
    return {
      map,
      result: err(
        "session-already-active",
        `Session ${ref.id} already exists and is stopped. Start a new session instead.`,
      ),
    };
  }
  return { map: withState(map, ref, "active"), result: ok(ref) };
}

export function takeShot(
  map: SessionMap,
  id: string,
): { map: SessionMap; result: ProofResult<void> } {
  const existing = map[id];
  if (!existing) {
    return {
      map,
      result: err(
        "no-active-session",
        `No active session with id ${id}. Run 'ade-proof start' first.`,
      ),
    };
  }
  if (existing.state !== "active") {
    return {
      map,
      result: err(
        "no-active-session",
        `Session ${id} is ${existing.state}, not active. Start a new session.`,
        { state: existing.state },
      ),
    };
  }
  return { map, result: ok(undefined) };
}

export function stopSession(
  map: SessionMap,
  id: string,
): { map: SessionMap; result: ProofResult<SessionRef> } {
  const existing = map[id];
  if (!existing) {
    return {
      map,
      result: err(
        "no-active-session",
        `No active session with id ${id}. It may have already stopped.`,
      ),
    };
  }
  if (existing.state !== "active") {
    return {
      map,
      result: err("no-active-session", `Session ${id} is already ${existing.state}.`, {
        state: existing.state,
      }),
    };
  }
  const updated = { ...existing, state: "stopped" } as SessionRef;
  return { map: withState(map, updated, "stopped"), result: ok(updated) };
}

export function reclaimSession(
  map: SessionMap,
  ref: SessionRef,
): { map: SessionMap; result: ProofResult<SessionRef> } {
  const existing = map[ref.id];
  if (!existing) {
    return { map, result: err("no-active-session", `No session with id ${ref.id} to reclaim.`) };
  }
  if (existing.state !== "abandoned") {
    return {
      map,
      result: err(
        "session-already-active",
        `Session ${ref.id} is ${existing.state}; only abandoned sessions can be reclaimed.`,
      ),
    };
  }
  return { map: withState(map, ref, "active"), result: ok(ref) };
}
