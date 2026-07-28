import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Rebuilds external_mcp_integrations with the current identity as the only
 * accepted audience and renormalizes rows written before the rebrand. The
 * table's CHECK constraint made the legacy value the only legal one, so both
 * the constraint and the data must move together. Guarded on the pre-state so
 * replays are no-ops.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const table = yield* sql<{ readonly sql: string | null }>`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'external_mcp_integrations'
  `;
  const definition = table[0]?.sql;
  if (definition == null || !definition.includes("synara.external-mcp")) {
    return;
  }

  yield* sql`DROP TABLE IF EXISTS external_mcp_integrations_v88`;
  yield* sql`
    CREATE TABLE external_mcp_integrations_v88 (
      integration_id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
      audience TEXT NOT NULL CHECK (audience = 'nuncioade.external-mcp'),
      client_kind TEXT NOT NULL CHECK (
        client_kind IN ('codex', 'claudeCode', 'claudeDesktop', 'other')
      ),
      credential_hash TEXT UNIQUE,
      capabilities_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_used_at TEXT,
      paired_at TEXT,
      revoked_at TEXT,
      rate_limit_per_minute INTEGER NOT NULL CHECK (rate_limit_per_minute BETWEEN 1 AND 10000),
      concurrency_limit INTEGER NOT NULL CHECK (concurrency_limit BETWEEN 1 AND 100),
      project_scope TEXT NOT NULL DEFAULT 'selected' CHECK (project_scope IN ('all', 'selected'))
    )
  `;
  yield* sql`
    INSERT INTO external_mcp_integrations_v88 (
      integration_id,
      name,
      audience,
      client_kind,
      credential_hash,
      capabilities_json,
      created_at,
      expires_at,
      last_used_at,
      paired_at,
      revoked_at,
      rate_limit_per_minute,
      concurrency_limit,
      project_scope
    )
    SELECT
      integration_id,
      name,
      'nuncioade.external-mcp',
      client_kind,
      credential_hash,
      capabilities_json,
      created_at,
      expires_at,
      last_used_at,
      paired_at,
      revoked_at,
      rate_limit_per_minute,
      concurrency_limit,
      project_scope
    FROM external_mcp_integrations
  `;
  yield* sql`DROP TABLE external_mcp_integrations`;
  yield* sql`
    ALTER TABLE external_mcp_integrations_v88
    RENAME TO external_mcp_integrations
  `;
});
