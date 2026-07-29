export { resolveWorkspaceRoot, slugify } from "./paths-and-slugs.js";

export { scanErrors, stripAnsi } from "./error-patterns.js";

export {
  startSession,
  findSession,
  listSessions,
  nextStepFile,
  addStep,
  setVideo,
  stopSession,
} from "./session-store.js";

export type {
  ProofError,
  ProofErrorCode,
  ProofLogError,
  ProofManifest,
  ProofResult,
  ProofStep,
  ProofTarget,
  RecordRequest,
  CaptureBackend,
  CaptureMeta,
  CaptureRequest,
  SessionRef,
  SessionState,
} from "./types.js";
