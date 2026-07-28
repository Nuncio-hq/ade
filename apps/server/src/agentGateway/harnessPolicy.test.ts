import { assert, describe, it } from "@effect/vitest";

import {
  renderNuncioADEHarnessPolicy,
  NUNCIO_HARNESS_POLICY_MARKER,
  takeNuncioADEHarnessPolicyForProviderSession,
  takeNuncioADEHarnessPolicyTextPartForProviderSession,
  takeNuncioADEHarnessPolicyForSession,
} from "./harnessPolicy.ts";

describe("NuncioADE harness policy", () => {
  it("identifies NuncioADE and explains exact batch coordination when MCP is available", () => {
    const policy = renderNuncioADEHarnessPolicy({ gatewayControlAvailable: true });
    assert.include(policy, NUNCIO_HARNESS_POLICY_MARKER);
    assert.include(policy, "NuncioADE is the host and harness");
    assert.include(policy, "one exact nuncioade_create_threads plan");
    assert.include(policy, "before returning an operationId");
    assert.include(policy, "nuncioade_wait_for_threads");
    assert.include(policy, "do not create NuncioADE threads");
    assert.include(policy, "3–8 word outcome-oriented task label");
    assert.include(policy, "no assumed chat context");
    assert.include(policy, "notifying the user versus staying silent");
    assert.include(policy, 'later manual follow-up such as "continue"');
    assert.include(policy, "Never call this tool for a manual follow-up turn");
  });

  it("never advertises gateway mutation to providers without scoped MCP", () => {
    const policy = renderNuncioADEHarnessPolicy({ gatewayControlAvailable: false });
    assert.include(policy, "NuncioADE MCP control is unavailable");
    assert.notInclude(policy, "one exact nuncioade_create_threads plan");
  });

  it("delivers a private host-context block once per provider session", () => {
    const state: { harnessPolicyDelivered?: boolean } = {};
    assert.include(
      takeNuncioADEHarnessPolicyForSession(state, { gatewayControlAvailable: true }) ?? "",
      "<nuncioade_host_context>",
    );
    assert.isNull(takeNuncioADEHarnessPolicyForSession(state, { gatewayControlAvailable: true }));
  });

  it("delivers once on fresh/load/fork sessions for every scoped MCP provider", () => {
    for (const provider of ["cursor", "grok", "droid", "opencode", "kilo", "pi", "omp"] as const) {
      for (const lifecycle of ["fresh", "load", "fork"] as const) {
        const state: { harnessPolicyDelivered?: boolean } = {};
        const first =
          takeNuncioADEHarnessPolicyTextPartForProviderSession(state, {
            provider,
            scopedGatewayConnectionAvailable: true,
          })?.text ?? "";
        assert.include(first, NUNCIO_HARNESS_POLICY_MARKER, `${provider}/${lifecycle}`);
        assert.include(first, "Use the nuncioade_* tools", `${provider}/${lifecycle}`);
        assert.isNull(
          takeNuncioADEHarnessPolicyForProviderSession(state, {
            provider,
            scopedGatewayConnectionAvailable: true,
          }),
          `${provider}/${lifecycle}`,
        );
      }
    }
  });

  it("keeps OpenCode, Kilo, Pi, and OMP identity-only until scoped setup succeeds", () => {
    for (const provider of ["opencode", "kilo", "pi", "omp"] as const) {
      const text =
        takeNuncioADEHarnessPolicyForProviderSession(
          {},
          { provider, scopedGatewayConnectionAvailable: false },
        ) ?? "";
      assert.include(text, NUNCIO_HARNESS_POLICY_MARKER, provider);
      assert.include(text, "NuncioADE MCP control is unavailable", provider);
      assert.notInclude(text, "one exact nuncioade_create_threads plan", provider);
    }
  });
});
