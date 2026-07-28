import { Effect, Layer, Option, Schema, Struct } from "effect";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  AppFactoryAppRow,
  AppFactoryAppUpsert,
  AppFactoryCounts,
  AppFactoryNoteWithoutPinError,
  AppFactoryRepository,
  type AppFactoryRepositoryError,
  type AppFactoryRepositoryShape,
  AppFactoryRevenueReplace,
  AppFactoryRevenueRow,
  AppFactoryScreenRow,
  AppFactoryScreensReplace,
  AppFactorySyncRunRow,
  AppFactoryVideoRow,
  AppFactoryVideoUpsert,
} from "../Services/AppFactoryRepository.ts";

const SqliteBoolean = Schema.Number.pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value !== 0),
    encode: SchemaGetter.transform((value) => (value ? 1 : 0)),
  }),
);

const SqliteBooleanOrNull = Schema.NullOr(SqliteBoolean);

const AppRowDb = AppFactoryAppRow.mapFields(
  Struct.assign({
    advertised: SqliteBoolean,
    featured: SqliteBoolean,
    hasOnboardingWithQuiz: SqliteBooleanOrNull,
    isPinned: SqliteBoolean,
  }),
);

const VideoRowDb = AppFactoryVideoRow.mapFields(Struct.assign({ screensFetched: SqliteBoolean }));

const ScreenRowDb = AppFactoryScreenRow.mapFields(
  Struct.assign({
    isBlurry: SqliteBoolean,
    labels: Schema.fromJsonString(Schema.Array(Schema.String)),
  }),
);

const AppIdRequest = Schema.Struct({ appId: AppFactoryAppUpsert.fields.appId });
const VideoIdRequest = Schema.Struct({ videoId: AppFactoryVideoUpsert.fields.videoId });

const SetPinnedRequest = Schema.Struct({
  appId: AppFactoryAppUpsert.fields.appId,
  pinned: Schema.Boolean,
  pinnedAt: Schema.String,
});

const SetNoteRequest = Schema.Struct({
  appId: AppFactoryAppUpsert.fields.appId,
  note: Schema.String,
});

const MarkRemovedExceptRequest = Schema.Struct({
  seenAppIdsJson: Schema.String,
  removedAt: Schema.String,
});

const StartSyncRunRequest = Schema.Struct({
  mode: AppFactorySyncRunRow.fields.mode,
  cursor: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
});

const SyncRunProgressRequest = Schema.Struct({
  runId: AppFactorySyncRunRow.fields.runId,
  cursor: Schema.NullOr(Schema.String),
  appsUpserted: Schema.Number,
  totalApps: Schema.NullOr(Schema.Number),
});

const FinishSyncRunRequest = Schema.Struct({
  runId: AppFactorySyncRunRow.fields.runId,
  status: AppFactorySyncRunRow.fields.status,
  finishedAt: Schema.String,
  error: Schema.NullOr(Schema.String),
});

const SyncModeRequest = Schema.Struct({ mode: AppFactorySyncRunRow.fields.mode });
const LimitRequest = Schema.Struct({ limit: Schema.Number });
const StateKeyRequest = Schema.Struct({ key: Schema.String });
const StateEntryRequest = Schema.Struct({ key: Schema.String, value: Schema.String });
const MarkInterruptedRequest = Schema.Struct({ finishedAt: Schema.String });
const MarkAppRemovedRequest = Schema.Struct({
  appId: AppFactoryAppUpsert.fields.appId,
  removedAt: Schema.String,
});

const CountsDbRow = Schema.Struct({
  apps: Schema.Number,
  videos: Schema.Number,
  screens: Schema.Number,
  pinned: Schema.Number,
});

const MaxIdRow = Schema.Struct({ maxId: Schema.Number });
const RunIdRow = Schema.Struct({ runId: Schema.Number });
const StateValueRow = Schema.Struct({ value: Schema.String });

const makeAppFactoryRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertAppRow = SqlSchema.void({
    Request: AppFactoryAppUpsert,
    execute: (row) => sql`
      INSERT INTO af_apps (
        sd_id, slug, name, shortname, icon_url, developer_name, developer_slug,
        category_primary, description, appstore_link, store_id, revenue, downloads,
        rating_value, advertised, featured, released, updated, paywall_type,
        onboarding_step_count, has_onboarding_with_quiz, latest_appvideo_id,
        latest_appobvideo_id, fetched_at, removed_at
      ) VALUES (
        ${row.appId}, ${row.slug}, ${row.name}, ${row.shortname}, ${row.iconUrl},
        ${row.developerName}, ${row.developerSlug}, ${row.categoryPrimary},
        ${row.description}, ${row.appstoreLink}, ${row.storeId}, ${row.revenue},
        ${row.downloads}, ${row.ratingValue}, ${row.advertised ? 1 : 0},
        ${row.featured ? 1 : 0}, ${row.released}, ${row.updated}, ${row.paywallType},
        ${row.onboardingStepCount},
        ${row.hasOnboardingWithQuiz === null ? null : row.hasOnboardingWithQuiz ? 1 : 0},
        ${row.latestAppvideoId}, ${row.latestAppobvideoId}, ${row.fetchedAt}, NULL
      )
      ON CONFLICT (sd_id) DO UPDATE SET
        slug = excluded.slug,
        name = excluded.name,
        shortname = excluded.shortname,
        icon_url = excluded.icon_url,
        developer_name = excluded.developer_name,
        developer_slug = excluded.developer_slug,
        category_primary = excluded.category_primary,
        description = excluded.description,
        appstore_link = excluded.appstore_link,
        store_id = excluded.store_id,
        revenue = excluded.revenue,
        downloads = excluded.downloads,
        rating_value = excluded.rating_value,
        advertised = excluded.advertised,
        featured = excluded.featured,
        released = excluded.released,
        updated = excluded.updated,
        paywall_type = excluded.paywall_type,
        onboarding_step_count = excluded.onboarding_step_count,
        has_onboarding_with_quiz = excluded.has_onboarding_with_quiz,
        latest_appvideo_id = excluded.latest_appvideo_id,
        latest_appobvideo_id = excluded.latest_appobvideo_id,
        fetched_at = excluded.fetched_at,
        removed_at = NULL
    `,
  });

  const listAppRowEntries = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: AppRowDb,
    execute: () => sql`
      SELECT
        a.sd_id AS "appId",
        a.slug,
        a.name,
        a.shortname,
        a.icon_url AS "iconUrl",
        a.developer_name AS "developerName",
        a.developer_slug AS "developerSlug",
        a.category_primary AS "categoryPrimary",
        a.description,
        a.appstore_link AS "appstoreLink",
        a.store_id AS "storeId",
        a.revenue,
        a.downloads,
        a.rating_value AS "ratingValue",
        a.advertised,
        a.featured,
        a.released,
        a.updated,
        a.paywall_type AS "paywallType",
        a.onboarding_step_count AS "onboardingStepCount",
        a.has_onboarding_with_quiz AS "hasOnboardingWithQuiz",
        a.latest_appvideo_id AS "latestAppvideoId",
        a.latest_appobvideo_id AS "latestAppobvideoId",
        a.fetched_at AS "fetchedAt",
        a.removed_at AS "removedAt",
        CASE WHEN w.sd_id IS NULL THEN 0 ELSE 1 END AS "isPinned",
        w.note
      FROM af_apps a
      LEFT JOIN af_watchlist w ON w.sd_id = a.sd_id
      ORDER BY a.sd_id DESC
    `,
  });

  const getAppRowEntry = SqlSchema.findOneOption({
    Request: AppIdRequest,
    Result: AppRowDb,
    execute: ({ appId }) => sql`
      SELECT
        a.sd_id AS "appId",
        a.slug,
        a.name,
        a.shortname,
        a.icon_url AS "iconUrl",
        a.developer_name AS "developerName",
        a.developer_slug AS "developerSlug",
        a.category_primary AS "categoryPrimary",
        a.description,
        a.appstore_link AS "appstoreLink",
        a.store_id AS "storeId",
        a.revenue,
        a.downloads,
        a.rating_value AS "ratingValue",
        a.advertised,
        a.featured,
        a.released,
        a.updated,
        a.paywall_type AS "paywallType",
        a.onboarding_step_count AS "onboardingStepCount",
        a.has_onboarding_with_quiz AS "hasOnboardingWithQuiz",
        a.latest_appvideo_id AS "latestAppvideoId",
        a.latest_appobvideo_id AS "latestAppobvideoId",
        a.fetched_at AS "fetchedAt",
        a.removed_at AS "removedAt",
        CASE WHEN w.sd_id IS NULL THEN 0 ELSE 1 END AS "isPinned",
        w.note
      FROM af_apps a
      LEFT JOIN af_watchlist w ON w.sd_id = a.sd_id
      WHERE a.sd_id = ${appId}
    `,
  });

  const listRevenueRowEntries = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: AppFactoryRevenueRow,
    execute: () => sql`
      SELECT
        sd_id AS "appId",
        year,
        month,
        revenue
      FROM af_app_revenue
      ORDER BY sd_id ASC, year DESC, month DESC
    `,
  });

  const deleteRevenueRows = SqlSchema.void({
    Request: AppIdRequest,
    execute: ({ appId }) => sql`
      DELETE FROM af_app_revenue WHERE sd_id = ${appId}
    `,
  });

  const upsertVideoRow = SqlSchema.void({
    Request: AppFactoryVideoUpsert,
    execute: (row) => sql`
      INSERT INTO af_videos (
        id, sd_id, slug, label, video_url, blur_starts_at, app_version,
        recording_date, duration_seconds, fetched_at
      ) VALUES (
        ${row.videoId}, ${row.appId}, ${row.slug}, ${row.label}, ${row.videoUrl},
        ${row.blurStartsAt}, ${row.appVersion}, ${row.recordingDate},
        ${row.durationSeconds}, ${row.fetchedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        sd_id = excluded.sd_id,
        slug = excluded.slug,
        label = excluded.label,
        video_url = excluded.video_url,
        blur_starts_at = excluded.blur_starts_at,
        app_version = excluded.app_version,
        recording_date = excluded.recording_date,
        duration_seconds = excluded.duration_seconds,
        fetched_at = excluded.fetched_at
    `,
  });

  const listVideoRowEntries = SqlSchema.findAll({
    Request: AppIdRequest,
    Result: VideoRowDb,
    execute: ({ appId }) => sql`
      SELECT
        id AS "videoId",
        sd_id AS "appId",
        slug,
        label,
        video_url AS "videoUrl",
        blur_starts_at AS "blurStartsAt",
        app_version AS "appVersion",
        recording_date AS "recordingDate",
        duration_seconds AS "durationSeconds",
        screens_fetched AS "screensFetched",
        fetched_at AS "fetchedAt"
      FROM af_videos
      WHERE sd_id = ${appId}
      ORDER BY id DESC
    `,
  });

  const deleteScreenRows = SqlSchema.void({
    Request: VideoIdRequest,
    execute: ({ videoId }) => sql`
      DELETE FROM af_screens WHERE video_id = ${videoId}
    `,
  });

  const markVideoScreensFetched = SqlSchema.void({
    Request: AppFactoryScreensReplace,
    execute: ({ videoId, fetchedAt }) => sql`
      UPDATE af_videos
      SET screens_fetched = 1, fetched_at = ${fetchedAt}
      WHERE id = ${videoId}
    `,
  });

  const listScreenRowEntries = SqlSchema.findAll({
    Request: VideoIdRequest,
    Result: ScreenRowDb,
    execute: ({ videoId }) => sql`
      SELECT
        id AS "screenId",
        video_id AS "videoId",
        screen_url AS "screenUrl",
        timestamp_s AS "timestamp",
        is_blurry AS "isBlurry",
        labels_json AS "labels"
      FROM af_screens
      WHERE video_id = ${videoId}
      ORDER BY timestamp_s ASC, id ASC
    `,
  });

  const readMaxAppId = SqlSchema.findOne({
    Request: Schema.Struct({}),
    Result: MaxIdRow,
    execute: () => sql`
      SELECT COALESCE(MAX(sd_id), 0) AS "maxId" FROM af_apps
    `,
  });

  const markAppRemovedRow = SqlSchema.void({
    Request: MarkAppRemovedRequest,
    execute: ({ appId, removedAt }) => sql`
      UPDATE af_apps SET removed_at = ${removedAt}
      WHERE sd_id = ${appId} AND removed_at IS NULL
    `,
  });

  // json_each keeps the id list in one bound parameter, avoiding SQLite's
  // variable limit when a full sync carries thousands of seen ids.
  const markRemovedExceptRows = SqlSchema.void({
    Request: MarkRemovedExceptRequest,
    execute: ({ seenAppIdsJson, removedAt }) => sql`
      UPDATE af_apps SET removed_at = ${removedAt}
      WHERE removed_at IS NULL
        AND sd_id NOT IN (SELECT value FROM json_each(${seenAppIdsJson}))
    `,
  });

  const insertWatchlistRow = SqlSchema.void({
    Request: SetPinnedRequest,
    execute: ({ appId, pinnedAt }) => sql`
      INSERT INTO af_watchlist (sd_id, pinned_at, note)
      VALUES (${appId}, ${pinnedAt}, NULL)
      ON CONFLICT (sd_id) DO NOTHING
    `,
  });

  const deleteWatchlistRow = SqlSchema.void({
    Request: SetPinnedRequest,
    execute: ({ appId }) => sql`
      DELETE FROM af_watchlist WHERE sd_id = ${appId}
    `,
  });

  const readWatchlistPinned = SqlSchema.findOneOption({
    Request: SetNoteRequest,
    Result: Schema.Struct({ pinnedAppId: Schema.Number }),
    execute: ({ appId }) => sql`
      SELECT sd_id AS "pinnedAppId" FROM af_watchlist WHERE sd_id = ${appId}
    `,
  });

  const updateWatchlistNote = SqlSchema.void({
    Request: SetNoteRequest,
    execute: ({ appId, note }) => sql`
      UPDATE af_watchlist SET note = ${note === "" ? null : note} WHERE sd_id = ${appId}
    `,
  });

  const readCounts = SqlSchema.findOne({
    Request: Schema.Struct({}),
    Result: CountsDbRow,
    execute: () => sql`
      SELECT
        (SELECT COUNT(*) FROM af_apps) AS "apps",
        (SELECT COUNT(*) FROM af_videos) AS "videos",
        (SELECT COUNT(*) FROM af_screens) AS "screens",
        (SELECT COUNT(*) FROM af_watchlist) AS "pinned"
    `,
  });

  const insertSyncRun = SqlSchema.findOne({
    Request: StartSyncRunRequest,
    Result: RunIdRow,
    execute: ({ mode, cursor, startedAt }) => sql`
      INSERT INTO af_sync_runs (mode, status, cursor, started_at)
      VALUES (${mode}, ${"running"}, ${cursor}, ${startedAt})
      RETURNING id AS "runId"
    `,
  });

  const updateSyncRun = SqlSchema.void({
    Request: SyncRunProgressRequest,
    execute: ({ runId, cursor, appsUpserted, totalApps }) => sql`
      UPDATE af_sync_runs
      SET cursor = ${cursor}, apps_upserted = ${appsUpserted}, total_apps = ${totalApps}
      WHERE id = ${runId}
    `,
  });

  const finishSyncRunRow = SqlSchema.void({
    Request: FinishSyncRunRequest,
    execute: ({ runId, status, finishedAt, error }) => sql`
      UPDATE af_sync_runs
      SET status = ${status}, finished_at = ${finishedAt}, error = ${error}
      WHERE id = ${runId}
    `,
  });

  const markInterruptedRows = SqlSchema.void({
    Request: MarkInterruptedRequest,
    execute: ({ finishedAt }) => sql`
      UPDATE af_sync_runs
      SET status = ${"interrupted"}, finished_at = ${finishedAt},
        error = COALESCE(error, ${"Process exited while the sync was running"})
      WHERE status = ${"running"}
    `,
  });

  const findLatestSyncRunForMode = SqlSchema.findOneOption({
    Request: SyncModeRequest,
    Result: AppFactorySyncRunRow,
    execute: ({ mode }) => sql`
      SELECT
        id AS "runId",
        mode,
        status,
        started_at AS "startedAt",
        finished_at AS "finishedAt",
        cursor,
        apps_upserted AS "appsUpserted",
        total_apps AS "totalApps",
        error
      FROM af_sync_runs
      WHERE mode = ${mode}
      ORDER BY id DESC
      LIMIT 1
    `,
  });

  const readLatestSyncRun = SqlSchema.findOneOption({
    Request: Schema.Struct({}),
    Result: AppFactorySyncRunRow,
    execute: () => sql`
      SELECT
        id AS "runId",
        mode,
        status,
        started_at AS "startedAt",
        finished_at AS "finishedAt",
        cursor,
        apps_upserted AS "appsUpserted",
        total_apps AS "totalApps",
        error
      FROM af_sync_runs
      ORDER BY id DESC
      LIMIT 1
    `,
  });

  const listSyncRunEntries = SqlSchema.findAll({
    Request: LimitRequest,
    Result: AppFactorySyncRunRow,
    execute: ({ limit }) => sql`
      SELECT
        id AS "runId",
        mode,
        status,
        started_at AS "startedAt",
        finished_at AS "finishedAt",
        cursor,
        apps_upserted AS "appsUpserted",
        total_apps AS "totalApps",
        error
      FROM af_sync_runs
      ORDER BY id DESC
      LIMIT ${limit}
    `,
  });

  const readStateValue = SqlSchema.findOneOption({
    Request: StateKeyRequest,
    Result: StateValueRow,
    execute: ({ key }) => sql`
      SELECT value FROM af_state WHERE key = ${key}
    `,
  });

  const writeStateValue = SqlSchema.void({
    Request: StateEntryRequest,
    execute: ({ key, value }) => sql`
      INSERT INTO af_state (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `,
  });

  const deleteStateEntry = SqlSchema.void({
    Request: StateKeyRequest,
    execute: ({ key }) => sql`
      DELETE FROM af_state WHERE key = ${key}
    `,
  });

  const mapError = toPersistenceSqlOrDecodeError(
    "AppFactoryRepository:query",
    "AppFactoryRepository:decode",
  );

  const replaceRevenue: AppFactoryRepositoryShape["replaceRevenue"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* deleteRevenueRows({ appId: input.appId });
          yield* Effect.forEach(
            input.points,
            (point) => sql`
            INSERT INTO af_app_revenue (sd_id, year, month, revenue)
            VALUES (${input.appId}, ${point.year}, ${point.month}, ${point.revenue})
            ON CONFLICT (sd_id, year, month) DO UPDATE SET revenue = excluded.revenue
          `,
            { discard: true },
          );
        }),
      )
      .pipe(Effect.mapError(mapError));

  const replaceScreens: AppFactoryRepositoryShape["replaceScreens"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* deleteScreenRows({ videoId: input.videoId });
          yield* Effect.forEach(
            input.screens,
            (screen) => sql`
            INSERT INTO af_screens (
              id, video_id, screen_url, timestamp_s, is_blurry, labels_json
            ) VALUES (
              ${screen.screenId}, ${input.videoId}, ${screen.screenUrl},
              ${screen.timestamp}, ${screen.isBlurry ? 1 : 0},
              ${JSON.stringify(screen.labels)}
            )
          `,
            { discard: true },
          );
          yield* markVideoScreensFetched(input);
        }),
      )
      .pipe(Effect.mapError(mapError));

  const setPinned: AppFactoryRepositoryShape["setPinned"] = (appId, pinned, pinnedAt) =>
    (pinned
      ? insertWatchlistRow({ appId, pinned, pinnedAt })
      : deleteWatchlistRow({ appId, pinned, pinnedAt })
    ).pipe(Effect.mapError(mapError));

  const setNote: AppFactoryRepositoryShape["setNote"] = (appId, note) =>
    Effect.gen(function* () {
      const pinned = yield* readWatchlistPinned({ appId, note });
      if (Option.isNone(pinned)) {
        return yield* new AppFactoryNoteWithoutPinError({ appId });
      }
      yield* updateWatchlistNote({ appId, note });
    }).pipe(
      Effect.mapError(
        (cause): AppFactoryRepositoryError =>
          cause instanceof AppFactoryNoteWithoutPinError ? cause : mapError(cause),
      ),
    );

  return {
    upsertApp: (input) => upsertAppRow(input).pipe(Effect.mapError(mapError)),
    replaceRevenue,
    listAppRows: () => listAppRowEntries({}).pipe(Effect.mapError(mapError)),
    getAppRow: (appId) =>
      getAppRowEntry({ appId }).pipe(Effect.map(Option.getOrNull), Effect.mapError(mapError)),
    listRevenueRows: () => listRevenueRowEntries({}).pipe(Effect.mapError(mapError)),
    upsertVideo: (input) => upsertVideoRow(input).pipe(Effect.mapError(mapError)),
    listVideoRows: (appId) => listVideoRowEntries({ appId }).pipe(Effect.mapError(mapError)),
    replaceScreens,
    listScreenRows: (videoId) => listScreenRowEntries({ videoId }).pipe(Effect.mapError(mapError)),
    getMaxAppId: () =>
      readMaxAppId({}).pipe(
        Effect.map((row) => row?.maxId ?? 0),
        Effect.mapError(mapError),
      ),
    markAppRemoved: (appId, removedAt) =>
      markAppRemovedRow({ appId, removedAt }).pipe(Effect.mapError(mapError)),
    markAppsRemovedExcept: (seenAppIds, removedAt) =>
      seenAppIds.length === 0
        ? Effect.void
        : markRemovedExceptRows({
            seenAppIdsJson: JSON.stringify(seenAppIds),
            removedAt,
          }).pipe(Effect.mapError(mapError)),
    setPinned,
    setNote,
    counts: () =>
      readCounts({}).pipe(
        Effect.map((row) => row ?? { apps: 0, videos: 0, screens: 0, pinned: 0 }),
        Effect.mapError(mapError),
      ),
    startSyncRun: (mode, cursor, startedAt) =>
      insertSyncRun({ mode, cursor, startedAt }).pipe(
        Effect.map((row) => {
          const runId = row?.runId;
          if (runId === undefined) {
            throw new Error("af_sync_runs insert did not return an id");
          }
          return runId as AppFactorySyncRunRow["runId"];
        }),
        Effect.mapError(mapError),
      ),
    updateSyncRunProgress: (runId, cursor, appsUpserted, totalApps) =>
      updateSyncRun({ runId, cursor, appsUpserted, totalApps }).pipe(Effect.mapError(mapError)),
    finishSyncRun: (runId, status, finishedAt, error) =>
      finishSyncRunRow({ runId, status, finishedAt, error }).pipe(Effect.mapError(mapError)),
    markRunningSyncRunsInterrupted: (finishedAt) =>
      markInterruptedRows({ finishedAt }).pipe(Effect.mapError(mapError)),
    getLatestSyncRunForMode: (mode) =>
      findLatestSyncRunForMode({ mode }).pipe(
        Effect.map(Option.getOrNull),
        Effect.mapError(mapError),
      ),
    getLatestSyncRun: () =>
      readLatestSyncRun({}).pipe(Effect.map(Option.getOrNull), Effect.mapError(mapError)),
    listSyncRuns: (limit) => listSyncRunEntries({ limit }).pipe(Effect.mapError(mapError)),
    getStateValue: (key) =>
      readStateValue({ key }).pipe(
        Effect.map((row) => (Option.isSome(row) ? row.value.value : null)),
        Effect.mapError(mapError),
      ),
    setStateValue: (key, value) => writeStateValue({ key, value }).pipe(Effect.mapError(mapError)),
    deleteStateValue: (key) => deleteStateEntry({ key }).pipe(Effect.mapError(mapError)),
  } satisfies AppFactoryRepositoryShape;
});

export const AppFactoryRepositoryLive = Layer.effect(
  AppFactoryRepository,
  makeAppFactoryRepository,
);
