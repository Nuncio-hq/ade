import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const insertIntegration = (audience: string, integrationId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO external_mcp_integrations (
        integration_id, name, audience, client_kind, credential_hash,
        capabilities_json, project_scope, created_at, expires_at,
        rate_limit_per_minute, concurrency_limit
      ) VALUES (
        ${integrationId}, 'Integration', ${audience}, 'other', NULL,
        '[]', 'selected', '2026-07-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z',
        60, 2
      )
    `;
  });

layer("088_ExternalMcpAudienceIdentity", (it) => {
  it.effect("renormalizes legacy audience rows and retightens the check", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 87 });

      // The pre-088 check only accepts the legacy pre-rebrand audience.
      yield* insertIntegration("synara.external-mcp", "integration-legacy");

      yield* runMigrations();

      const rows = yield* sql<{ readonly audience: string }>`
        SELECT audience FROM external_mcp_integrations
        WHERE integration_id = 'integration-legacy'
      `;
      assert.equal(rows[0]?.audience, "nuncioade.external-mcp");

      yield* insertIntegration("nuncioade.external-mcp", "integration-current");

      const legacyWrite = yield* insertIntegration(
        "synara.external-mcp",
        "integration-rejected",
      ).pipe(Effect.exit);
      assert.equal(legacyWrite._tag, "Failure");
    }),
  );

  it.effect("is a no-op when replayed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* insertIntegration("nuncioade.external-mcp", "integration-replay");

      yield* runMigrations();

      const rows = yield* sql<{ readonly audience: string }>`
        SELECT audience FROM external_mcp_integrations
        WHERE integration_id = 'integration-replay'
      `;
      assert.equal(rows[0]?.audience, "nuncioade.external-mcp");
    }),
  );
});
