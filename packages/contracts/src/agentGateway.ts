/**
 * Public contracts for the NuncioADE agent-control gateway.
 *
 * New gateway tools decode these schemas before doing any work. Keeping the
 * limits here ensures the MCP surface, server implementation, and tests share
 * the same definition of an exact creation/wait plan.
 */
import { Schema } from "effect";

import { ProjectId, ThreadId, TurnId } from "./baseSchemas";
import { ModelSelection, ProviderKind } from "./orchestration";
import { ProviderModelDescriptor } from "./providerDiscovery";
import { ServerProviderAuthStatus } from "./server";

export const NUNCIO_GATEWAY_MAX_THREADS_PER_OPERATION = 20;
export const NUNCIO_GATEWAY_MAX_REQUEST_ID_LENGTH = 256;
export const NUNCIO_GATEWAY_MAX_WAIT_MS = 60_000;

export const NuncioADEGatewayErrorCode = Schema.Literals([
  "caller_session_inactive",
  "caller_turn_inactive",
  "capability_denied",
  "provider_unavailable",
  "model_unavailable",
  "model_option_unavailable",
  "idempotency_conflict",
  "creation_plan_locked",
  "creation_limit_exceeded",
  "thread_not_found",
  "wait_timed_out",
  "operation_failed",
]);
export type NuncioADEGatewayErrorCode = typeof NuncioADEGatewayErrorCode.Type;

export const NuncioADEGatewayError = Schema.Struct({
  code: NuncioADEGatewayErrorCode,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
});
export type NuncioADEGatewayError = typeof NuncioADEGatewayError.Type;

export const NuncioADEGatewayErrorResult = Schema.Struct({
  error: NuncioADEGatewayError,
});
export type NuncioADEGatewayErrorResult = typeof NuncioADEGatewayErrorResult.Type;

export const NuncioADEContextResult = Schema.Struct({
  harness: Schema.Struct({
    name: Schema.Literal("NuncioADE"),
    policyVersion: Schema.String,
  }),
  caller: Schema.Struct({
    threadId: ThreadId,
    turnId: Schema.NullOr(TurnId),
    provider: ProviderKind,
    projectId: ProjectId,
  }),
  capabilities: Schema.Struct({
    threadRead: Schema.Boolean,
    threadCreate: Schema.Boolean,
    threadWait: Schema.Boolean,
    automations: Schema.Boolean,
  }),
});
export type NuncioADEContextResult = typeof NuncioADEContextResult.Type;

export const NuncioADECreateThreadSpec = Schema.Struct({
  prompt: Schema.String.check(Schema.isNonEmpty()),
  title: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  target: ModelSelection,
  projectId: Schema.optional(ProjectId),
  environment: Schema.optional(Schema.Literals(["local", "worktree"])),
  baseRef: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  // Legacy inputs remain decodable for replay/backward compatibility, but the
  // MCP catalog no longer advertises branch-backed worktree creation.
  baseBranch: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  branchName: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  runtimeMode: Schema.optional(Schema.Literals(["approval-required", "full-access"])),
});
export type NuncioADECreateThreadSpec = typeof NuncioADECreateThreadSpec.Type;

const NuncioADEGatewayRequestId = Schema.String.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(NUNCIO_GATEWAY_MAX_REQUEST_ID_LENGTH),
);

export const NuncioADECreateThreadsInput = Schema.Struct({
  requestId: NuncioADEGatewayRequestId,
  threads: Schema.Array(NuncioADECreateThreadSpec)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(NUNCIO_GATEWAY_MAX_THREADS_PER_OPERATION)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type NuncioADECreateThreadsInput = typeof NuncioADECreateThreadsInput.Type;

export const NuncioADEProviderCatalog = Schema.Struct({
  provider: ProviderKind,
  defaultModel: Schema.NullOr(Schema.String),
  models: Schema.Array(ProviderModelDescriptor),
  enabled: Schema.Boolean,
  available: Schema.Boolean,
  authStatus: Schema.optional(ServerProviderAuthStatus),
  source: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type NuncioADEProviderCatalog = typeof NuncioADEProviderCatalog.Type;

export const NuncioADEGatewayTargetOptionValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
]);
export type NuncioADEGatewayTargetOptionValue = typeof NuncioADEGatewayTargetOptionValue.Type;

export const NuncioADEGatewayTargetOptionRule = Schema.Struct({
  key: Schema.String,
  valueType: Schema.Literals(["string", "number", "boolean"]),
  allowedValues: Schema.Array(NuncioADEGatewayTargetOptionValue),
  allowedValuesSource: Schema.Literals(["provider-contract", "model-discovery"]),
});
export type NuncioADEGatewayTargetOptionRule = typeof NuncioADEGatewayTargetOptionRule.Type;

export const NuncioADEGatewayTargetConstruction = Schema.Struct({
  modelValueSource: Schema.Literal("providers[].models[].slug"),
  primaryOptionKey: Schema.String,
  alternativeOptionKeys: Schema.Array(Schema.String),
  optionSelectionRule: Schema.String,
  providerOptions: Schema.Array(NuncioADEGatewayTargetOptionRule),
  optionsByModel: Schema.Record(Schema.String, Schema.Array(NuncioADEGatewayTargetOptionRule)),
  exampleTarget: Schema.NullOr(ModelSelection),
});
export type NuncioADEGatewayTargetConstruction = typeof NuncioADEGatewayTargetConstruction.Type;

export const NuncioADECapabilitiesResult = Schema.Struct({
  targetConstruction: Schema.Record(Schema.String, NuncioADEGatewayTargetConstruction),
  providers: Schema.Array(NuncioADEProviderCatalog),
  limits: Schema.Struct({
    maxThreadsPerOperation: Schema.Int,
    maxWaitMs: Schema.Int,
    oneCreationPlanPerActiveTurn: Schema.Boolean,
  }),
});
export type NuncioADECapabilitiesResult = typeof NuncioADECapabilitiesResult.Type;

export const NuncioADECreatedThreadResult = Schema.Struct({
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  target: ModelSelection,
  provider: ProviderKind,
  model: Schema.String,
  runtimeMode: Schema.Literals(["approval-required", "full-access"]),
  environment: Schema.Literals(["local", "worktree"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  status: Schema.Literal("task_dispatched"),
});
export type NuncioADECreatedThreadResult = typeof NuncioADECreatedThreadResult.Type;

export const NuncioADECreateThreadsResult = Schema.Struct({
  operationId: Schema.String,
  requestId: NuncioADEGatewayRequestId,
  requestedCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  createdCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  threadIds: Schema.Array(ThreadId),
  threads: Schema.Array(NuncioADECreatedThreadResult),
});
export type NuncioADECreateThreadsResult = typeof NuncioADECreateThreadsResult.Type;

export const NuncioADEWaitForThreadsInput = Schema.Struct({
  threadIds: Schema.Array(ThreadId)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(NUNCIO_GATEWAY_MAX_THREADS_PER_OPERATION)),
  runIds: Schema.optional(
    Schema.Array(Schema.NullOr(TurnId)).check(
      Schema.isMaxLength(NUNCIO_GATEWAY_MAX_THREADS_PER_OPERATION),
    ),
  ),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
      Schema.isLessThanOrEqualTo(NUNCIO_GATEWAY_MAX_WAIT_MS),
    ),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type NuncioADEWaitForThreadsInput = typeof NuncioADEWaitForThreadsInput.Type;

export const NuncioADEWaitedThreadResult = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(TurnId),
  state: Schema.Literals(["idle", "pending", "running", "completed", "error", "interrupted"]),
  terminal: Schema.Boolean,
  timedOut: Schema.Boolean,
  summary: Schema.NullOr(Schema.String),
  summaryTruncated: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  readThread: Schema.Struct({
    tool: Schema.Literal("nuncioade_read_thread"),
    arguments: Schema.Struct({ threadId: ThreadId }),
  }),
});
export type NuncioADEWaitedThreadResult = typeof NuncioADEWaitedThreadResult.Type;

export const NuncioADEWaitForThreadsResult = Schema.Struct({
  callerThreadId: ThreadId,
  runIds: Schema.Array(Schema.NullOr(TurnId)),
  allTerminal: Schema.Boolean,
  timedOut: Schema.Boolean,
  threads: Schema.Array(NuncioADEWaitedThreadResult),
});
export type NuncioADEWaitForThreadsResult = typeof NuncioADEWaitForThreadsResult.Type;
