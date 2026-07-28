// FILE: 089_AppFactoryDetailFetchedAt.ts
// Purpose: Track when an app's detail payload (description, App Store link,
// recordings) was last mirrored, so lazy detail loading knows a fetch is due
// even for apps that have no recordings to key off.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Guarded like other column migrations: lineage-rebuild fixtures replay all
  // migrations on a database that may already carry the column.
  const columns = yield* sql<{ readonly exists: number }>`
    SELECT EXISTS (
      SELECT 1 FROM pragma_table_info('af_apps') WHERE name = 'detail_fetched_at'
    ) AS "exists"
  `;
  if (columns[0]?.exists !== 1) {
    yield* sql.unsafe(`
      ALTER TABLE af_apps
      ADD COLUMN detail_fetched_at TEXT
    `);
  }
});
