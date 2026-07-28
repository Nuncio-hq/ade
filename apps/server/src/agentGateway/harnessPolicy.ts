import type { ProviderKind } from "@nuncio/contracts";

import { AUTOMATION_AUTHORING_GUIDANCE } from "./automationAuthoringGuidance.ts";

/** Canonical, versioned host policy delivered to every supported provider. */
export const NUNCIO_HARNESS_POLICY_VERSION = "2026-07-25.2";
export const NUNCIO_HARNESS_POLICY_MARKER = `[NuncioADE harness policy ${NUNCIO_HARNESS_POLICY_VERSION}]`;

export interface NuncioADEHarnessCapabilities {
  readonly gatewayControlAvailable: boolean;
}

/**
 * Render one truthful policy. Providers without a safely thread-scoped MCP
 * connection still receive host identity, but are never told they can mutate
 * NuncioADE resources.
 */
export function renderNuncioADEHarnessPolicy(capabilities: NuncioADEHarnessCapabilities): string {
  const controlPolicy = capabilities.gatewayControlAvailable
    ? [
        "Use the nuncioade_* tools for NuncioADE threads, projects, automations, and coordination.",
        "For thread discovery and diagnosis, use nuncioade_list_threads, nuncioade_read_thread, nuncioade_read_thread_activity, nuncioade_read_thread_events, nuncioade_read_thread_runtime_events, and nuncioade_diagnose_thread before inspecting NuncioADE's SQLite files or process logs. Fall back to host storage only when a tool's coverage metadata says the required evidence is unavailable.",
        "Provider-native subagent or Task tools are implementation details: they do not create NuncioADE threads and must not substitute for an explicit request to create NuncioADE threads.",
        "For a plural thread request, submit one exact nuncioade_create_threads plan. The array length is the exact requested count.",
        "If nuncioade_create_threads rejects the plan during validation or preflight before returning an operationId, correct that same plan and retry it with the same requestId. This is safe because no durable operation, thread, or worktree was created.",
        "Use nuncioade_capabilities to select canonical provider, model, and option values. Never guess a model slug or silently substitute a provider or model.",
        "Provider option keys are not interchangeable: Codex uses options.reasoningEffort and Claude Agent uses options.effort. Follow nuncioade_capabilities.targetConstruction for every provider instead of inspecting NuncioADE source code.",
        "When results are requested, call nuncioade_wait_for_threads for the created thread ids, wait for every requested result, then synthesize all outcomes.",
        "After nuncioade_create_threads returns an operationId, retries must keep the same requestId and exact plan. Report terminal operation failures as outcomes; do not create replacement threads unless the user gives a new instruction.",
        "NuncioADE automations support heartbeat, standalone, and dedicated modes plus interval, once, daily, weekdays, weekly, and cron schedules. Existing everyMinutes heartbeat calls remain supported. Use fastInterval: true only when the user explicitly accepts a sub-minute bounded loop.",
        "Mode picks where runs execute: heartbeat appends turns to a target thread and waits for it to be idle, so use it to drive that thread forward; standalone opens a fresh thread per run, so use it for independent recurring tasks; dedicated opens one thread the automation owns and reuses it for every run, so use it when the runs should build on each other in a single conversation without writing into somebody else's thread.",
        "Prefer dedicated over standalone for anything that observes or tracks something over time: a standalone automation creates a new thread on every run and cannot see what its previous runs did beyond its memory, while a dedicated automation keeps one growing thread.",
        'Mode does not restrict stop conditions. completionPolicy {"type":"ai-evaluated","stopWhen":"..."} works in both modes and disables the automation when the clause matches a successful run; prefer it over encoding the stop condition in the prompt. maxIterations remains the backstop, and an automation-dispatched run may always call nuncioade_cancel_automation on its own automation.',
        AUTOMATION_AUTHORING_GUIDANCE,
        "Prefer nuncioade_create_automation with suggested: true when the user has not explicitly asked to create an automation. Suggested automations remain disabled until the user accepts their proposal card.",
        "Before nuncioade_update_automation, call nuncioade_view_automation and resend the complete mutable configuration, including unchanged fields. Updates are full replacement and partial payloads are rejected.",
        'Automation-dispatched turns receive an identity/run/memory envelope in the current user message. Only that current turn is automation-dispatched; the status never carries into a later manual follow-up such as "continue", even in the same thread.',
        'During an automation-dispatched turn, persist durable context with nuncioade_update_automation_memory {"memory": "..."} before finishing; memory is full replacement, DB-backed, and capped at 32 KiB.',
        'Every automation-dispatched turn must finish by calling nuncioade_report_automation_result. Use decision "silent" only for a successful run with nothing requiring user attention; otherwise use "notify" with a concise title and summary. Failures remain visible regardless of this decision or the automation notification policy. Never call this tool for a manual follow-up turn.',
      ]
    : [
        "NuncioADE MCP control is unavailable in this provider session. Do not claim that NuncioADE threads, projects, or automations were created or changed.",
        "Provider-native subagent or Task tools do not create NuncioADE threads. If the user explicitly requests NuncioADE resource management, explain that this session cannot perform it.",
      ];

  return [
    NUNCIO_HARNESS_POLICY_MARKER,
    "You are running inside NuncioADE. NuncioADE is the host and harness for this session.",
    ...controlPolicy,
  ].join("\n");
}

export const NUNCIO_GATEWAY_HARNESS_POLICY = renderNuncioADEHarnessPolicy({
  gatewayControlAvailable: true,
});

export const NUNCIO_IDENTITY_ONLY_HARNESS_POLICY = renderNuncioADEHarnessPolicy({
  gatewayControlAvailable: false,
});

export interface NuncioADEHarnessPolicyDeliveryState {
  harnessPolicyDelivered?: boolean;
}

const PROVIDERS_WITH_THREAD_SCOPED_NUNCIO_MCP = new Set<ProviderKind>([
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "droid",
  "opencode",
  "kilo",
  "pi",
  "omp",
]);

export function providerHasNuncioADEGatewayControl(input: {
  readonly provider: ProviderKind;
  readonly scopedGatewayConnectionAvailable: boolean;
}): boolean {
  return (
    input.scopedGatewayConnectionAvailable &&
    PROVIDERS_WITH_THREAD_SCOPED_NUNCIO_MCP.has(input.provider)
  );
}

/** Return the private host-context block exactly once for one provider session. */
export function takeNuncioADEHarnessPolicyForSession(
  state: NuncioADEHarnessPolicyDeliveryState,
  capabilities: NuncioADEHarnessCapabilities,
): string | null {
  if (state.harnessPolicyDelivered === true) return null;
  state.harnessPolicyDelivered = true;
  return [
    "<nuncioade_host_context>",
    renderNuncioADEHarnessPolicy(capabilities),
    "</nuncioade_host_context>",
  ].join("\n");
}

/**
 * Provider-aware delivery guard. The transport flag must only become true
 * after a provider has installed thread-scoped gateway tools successfully.
 */
export function takeNuncioADEHarnessPolicyForProviderSession(
  state: NuncioADEHarnessPolicyDeliveryState,
  input: {
    readonly provider: ProviderKind;
    readonly scopedGatewayConnectionAvailable: boolean;
  },
): string | null {
  return takeNuncioADEHarnessPolicyForSession(state, {
    gatewayControlAvailable: providerHasNuncioADEGatewayControl(input),
  });
}

export function takeNuncioADEHarnessPolicyTextPartForProviderSession(
  state: NuncioADEHarnessPolicyDeliveryState,
  input: {
    readonly provider: ProviderKind;
    readonly scopedGatewayConnectionAvailable: boolean;
  },
): { readonly type: "text"; readonly text: string } | null {
  const text = takeNuncioADEHarnessPolicyForProviderSession(state, input);
  return text === null ? null : { type: "text", text };
}
