// FILE: CursorAdapter.test.ts
// Purpose: Characterizes Cursor's private NuncioADE host-policy delivery.
// Layer: Provider adapter tests

import { NUNCIO_HARNESS_POLICY_MARKER } from "../../agentGateway/harnessPolicy.ts";
import { describe, expect, it } from "vitest";

import { takeCursorNuncioADEHarnessPolicyTextPart } from "./CursorAdapter.ts";

describe("Cursor NuncioADE harness policy", () => {
  it("delivers scoped MCP host context exactly once per fresh/load/fork session", () => {
    for (const lifecycle of ["fresh", "load", "fork"] as const) {
      const state: { harnessPolicyDelivered?: boolean } = {};
      const first = takeCursorNuncioADEHarnessPolicyTextPart(state, true);
      expect(first?.text, lifecycle).toContain(NUNCIO_HARNESS_POLICY_MARKER);
      expect(first?.text, lifecycle).toContain("Use the nuncioade_* tools");
      expect(takeCursorNuncioADEHarnessPolicyTextPart(state, true), lifecycle).toBeNull();
    }
  });

  it("stays truthful without a scoped gateway connection", () => {
    expect(takeCursorNuncioADEHarnessPolicyTextPart({}, false)?.text).toContain(
      "NuncioADE MCP control is unavailable",
    );
  });
});
