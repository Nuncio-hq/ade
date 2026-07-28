// FILE: 088_AppFactory.ts
// Purpose: App Factory mirror of the screensdesign catalog: apps, monthly
// revenue, recordings, extracted screens, watchlist, sync runs and KV state.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS af_apps (
      sd_id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      shortname TEXT,
      icon_url TEXT,
      developer_name TEXT,
      developer_slug TEXT,
      category_primary TEXT,
      description TEXT,
      appstore_link TEXT,
      store_id TEXT,
      revenue INTEGER NOT NULL DEFAULT 0,
      downloads INTEGER NOT NULL DEFAULT 0,
      rating_value REAL,
      advertised INTEGER NOT NULL DEFAULT 0,
      featured INTEGER NOT NULL DEFAULT 0,
      released TEXT,
      updated TEXT,
      paywall_type TEXT,
      onboarding_step_count INTEGER,
      has_onboarding_with_quiz INTEGER,
      latest_appvideo_id INTEGER,
      latest_appobvideo_id INTEGER,
      fetched_at TEXT NOT NULL,
      removed_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS af_app_revenue (
      sd_id INTEGER NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      revenue INTEGER NOT NULL,
      PRIMARY KEY (sd_id, year, month)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS af_videos (
      id INTEGER PRIMARY KEY,
      sd_id INTEGER NOT NULL,
      slug TEXT NOT NULL,
      label TEXT,
      video_url TEXT NOT NULL,
      blur_starts_at REAL,
      app_version TEXT,
      recording_date TEXT,
      duration_seconds REAL,
      screens_fetched INTEGER NOT NULL DEFAULT 0,
      fetched_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS af_screens (
      id INTEGER PRIMARY KEY,
      video_id INTEGER NOT NULL,
      screen_url TEXT NOT NULL,
      timestamp_s REAL NOT NULL,
      is_blurry INTEGER NOT NULL DEFAULT 0,
      labels_json TEXT NOT NULL DEFAULT '[]'
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS af_watchlist (
      sd_id INTEGER PRIMARY KEY,
      pinned_at TEXT NOT NULL,
      note TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS af_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      cursor TEXT,
      apps_upserted INTEGER NOT NULL DEFAULT 0,
      total_apps INTEGER,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS af_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS af_app_revenue_sd_id_idx ON af_app_revenue (sd_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS af_videos_sd_id_idx ON af_videos (sd_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS af_screens_video_id_idx ON af_screens (video_id)
  `;
});
