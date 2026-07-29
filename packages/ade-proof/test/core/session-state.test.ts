import { describe, expect, it } from "vitest";
import {
  reclaimSession,
  startSession,
  stopSession,
  takeShot,
  type SessionMap,
} from "../../src/core/session-state.js";
import type { SessionRef } from "../../src/core/types.js";
import { unwrap, unwrapErr } from "./test-helpers.js";

function ref(id: string, state: SessionRef["state"]): SessionRef {
  return { id, dir: "/tmp/" + id, workspaceRoot: "/tmp", state };
}

function get(map: SessionMap, id: string): SessionRef {
  const r = map[id];
  expect(r).toBeDefined();
  return r as SessionRef;
}

const empty: SessionMap = {};

describe("session state machine", () => {
  it("starts a new active session", () => {
    const { map, result } = startSession(empty, ref("a", "active"));
    expect(unwrap(result).state).toBe("active");
    expect(get(map, "a").state).toBe("active");
  });

  it("shots only an active session", () => {
    const { map } = startSession(empty, ref("a", "active"));
    const shot = takeShot(map, "a");
    expect(unwrap(shot.result)).toBeUndefined();
  });

  it("shot without a session returns no-active-session", () => {
    const { result } = takeShot(empty, "missing");
    const err = unwrapErr(result);
    expect(err.code).toBe("no-active-session");
  });

  it("start over a live session returns session-already-active", () => {
    const { map } = startSession(empty, ref("a", "active"));
    const next = startSession(map, ref("a", "active"));
    expect(unwrapErr(next.result).code).toBe("session-already-active");
  });

  it("reclaims an abandoned session", () => {
    const { map } = startSession(empty, ref("a", "active"));
    const abandoned = { ...map, a: ref("a", "abandoned") };
    const { map: next, result } = reclaimSession(abandoned, ref("a", "active"));
    expect(unwrap(result).state).toBe("active");
    expect(get(next, "a").state).toBe("active");
  });

  it("reclaim on a live session fails", () => {
    const { map } = startSession(empty, ref("a", "active"));
    const { result } = reclaimSession(map, ref("a", "active"));
    expect(unwrapErr(result).code).toBe("session-already-active");
  });

  it("stops an active session", () => {
    const { map } = startSession(empty, ref("a", "active"));
    const { map: next, result } = stopSession(map, "a");
    expect(unwrap(result).state).toBe("stopped");
    expect(get(next, "a").state).toBe("stopped");
  });

  it("double stop returns no-active-session", () => {
    const { map } = startSession(empty, ref("a", "active"));
    const first = stopSession(map, "a").map;
    const { result } = stopSession(first, "a");
    const err = unwrapErr(result);
    expect(err.code).toBe("no-active-session");
    expect(err.details?.state).toBe("stopped");
  });

  it("start with force over an abandoned session reclaims", () => {
    const { map } = startSession(empty, ref("a", "active"));
    const abandoned = { ...map, a: ref("a", "abandoned") };
    const { map: next, result } = startSession(abandoned, ref("a", "active"), { force: true });
    expect(unwrap(result).state).toBe("active");
    expect(get(next, "a").state).toBe("active");
  });

  it("start with force over a live session still fails", () => {
    const { map } = startSession(empty, ref("a", "active"));
    const { result } = startSession(map, ref("a", "active"), { force: true });
    expect(unwrapErr(result).code).toBe("session-already-active");
  });

  it("start over an abandoned session without force returns lock-held", () => {
    const { map } = startSession(empty, ref("a", "active"));
    const abandoned = { ...map, a: ref("a", "abandoned") };
    const { result } = startSession(abandoned, ref("a", "active"));
    expect(unwrapErr(result).code).toBe("lock-held");
  });
});
