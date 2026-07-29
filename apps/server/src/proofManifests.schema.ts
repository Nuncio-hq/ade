// FILE: proofManifests.schema.ts
// Purpose: Effect Schema for proof-of-work manifests (read-only, server side).
// Layer: Server schema

import { Schema } from "effect";

const ProofStep = Schema.Struct({
  ts: Schema.String,
  label: Schema.String,
  target: Schema.String,
  file: Schema.String,
  url: Schema.optional(Schema.String),
  finalUrl: Schema.optional(Schema.String),
  httpStatus: Schema.optional(Schema.Number),
  truncated: Schema.optional(Schema.Boolean),
  windowTitle: Schema.optional(Schema.String),
});

const ProofLogError = Schema.Struct({
  source: Schema.Literals(["console", "server"] as const),
  pattern: Schema.String,
  line: Schema.String,
});

export const ProofManifest = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  description: Schema.optional(Schema.String),
  startedAt: Schema.String,
  finishedAt: Schema.optional(Schema.String),
  serverCmd: Schema.optional(Schema.String),
  steps: Schema.Array(ProofStep),
  errors: Schema.Array(ProofLogError),
  video: Schema.optional(Schema.String),
});

export type ProofManifest = typeof ProofManifest.Type;
