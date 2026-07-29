// Catalog coverage map for ade-proof P0 core.
//
// §5.A Session lifecycle
// - shot/stop with no active session → typed error: test/core/session-state.test.ts, session-store.test.ts
// - start over a live session → error; --force reclaims only when pid dead: test/core/session-state.test.ts
// - double stop → no-active-session: test/core/session-state.test.ts, session-store.test.ts
// - concurrent sessions in one workspace (keyed by id): test/core/session-store.test.ts "finds the most recent active session and reports abandoned"
// - crash mid-session:
//   - orphaned --run children (kill group) → deferred to P1 (dev-server spawn in src/capture/server-runner.ts)
//   - half-written manifest impossible by construction → test/core/manifest-io.test.ts atomic write
//   - next start reports abandoned session in output → test/core/session-store.test.ts
//
// §5.C Artifacts & contract
// - slug/label collisions within a second → monotonic counter suffix:
//   - session id: test/core/session-store.test.ts "adds a monotonic suffix..."
//   - step file: test/core/session-store.test.ts "produces monotonic step file names..."
// - workspace paths with spaces/unicode; cwd deep; git worktrees: test/core/paths-and-slugs.test.ts
// - .gitignore missing the .ade/ entry → warn in stop output and SUMMARY, never edit user files: test/core/summary-writer.test.ts, session-store.test.ts
// - disk-full / EACCES on write → typed error; session recoverable: test/core/manifest-io.test.ts "does not corrupt existing manifest if rename fails"
// - markdown refs workspace-relative and URL-safe: test/core/session-store.test.ts nextStepFile relPath assertions
// - server log ANSI stripped, size-capped head+tail: test/core/session-store.test.ts "retains a large server.log..."
//
// §5.B Capture — web (deferred to P1)
// - Dev server not listening / dead URL: deferred to P1
// - Page 4xx/5xx capture + httpStatus: deferred to P1
// - Redirect requestedUrl≠finalUrl: deferred to P1
// - Page never settles load+settle: deferred to P1
// - Chrome not found / launch fails: deferred to P1
// - Determinism viewport/DPR/reduced-motion: deferred to P1
// - Element capture fallback/no fallback: deferred to P1
// - Storage-state invalid: deferred to P1
//
// §5.D Adapters (deferred to later phases)
// - MCP (P2)
// - macOS backend (P1)
// - --run dev server (P1)
// - OMP extension (P3)

export {};
