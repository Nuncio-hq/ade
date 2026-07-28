/**
 * Durable App Factory mirror of the screensdesign catalog.
 *
 * The server is the source of truth for everything persisted here: app rows are
 * upserted from upstream payloads, revenue months are fully replaced per app on
 * every sync, and watchlist pins/notes are the only locally-authored data.
 */
import { AppFactorySyncMode, AppFactorySyncRunStatus } from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import { IsoDateTime, NonNegativeInt, PositiveInt } from "@synara/contracts";
import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export class AppFactoryNoteWithoutPinError extends Schema.TaggedErrorClass<AppFactoryNoteWithoutPinError>()(
  "AppFactoryNoteWithoutPinError",
  {
    appId: PositiveInt,
  },
) {
  override get message(): string {
    return `Cannot attach a note to app ${this.appId}: pin the app first.`;
  }
}

export type AppFactoryRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | AppFactoryNoteWithoutPinError;

// ── Row / input schemas ──────────────────────────────────────────────

export const AppFactoryAppUpsert = Schema.Struct({
  appId: PositiveInt,
  slug: Schema.String,
  name: Schema.String,
  shortname: Schema.NullOr(Schema.String),
  iconUrl: Schema.NullOr(Schema.String),
  developerName: Schema.NullOr(Schema.String),
  developerSlug: Schema.NullOr(Schema.String),
  categoryPrimary: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  appstoreLink: Schema.NullOr(Schema.String),
  storeId: Schema.NullOr(Schema.String),
  revenue: NonNegativeInt,
  downloads: NonNegativeInt,
  ratingValue: Schema.NullOr(Schema.Number),
  advertised: Schema.Boolean,
  featured: Schema.Boolean,
  released: Schema.NullOr(Schema.String),
  updated: Schema.NullOr(Schema.String),
  paywallType: Schema.NullOr(Schema.String),
  onboardingStepCount: Schema.NullOr(NonNegativeInt),
  hasOnboardingWithQuiz: Schema.NullOr(Schema.Boolean),
  latestAppvideoId: Schema.NullOr(PositiveInt),
  latestAppobvideoId: Schema.NullOr(PositiveInt),
  fetchedAt: IsoDateTime,
});
export type AppFactoryAppUpsert = typeof AppFactoryAppUpsert.Type;

export const AppFactoryRevenueReplace = Schema.Struct({
  appId: PositiveInt,
  points: Schema.Array(
    Schema.Struct({
      year: NonNegativeInt,
      month: NonNegativeInt,
      revenue: NonNegativeInt,
    }),
  ),
});
export type AppFactoryRevenueReplace = typeof AppFactoryRevenueReplace.Type;

export const AppFactoryVideoUpsert = Schema.Struct({
  videoId: PositiveInt,
  appId: PositiveInt,
  slug: Schema.String,
  label: Schema.NullOr(Schema.String),
  videoUrl: Schema.String,
  blurStartsAt: Schema.NullOr(Schema.Number),
  appVersion: Schema.NullOr(Schema.String),
  recordingDate: Schema.NullOr(Schema.String),
  durationSeconds: Schema.NullOr(Schema.Number),
  fetchedAt: IsoDateTime,
});
export type AppFactoryVideoUpsert = typeof AppFactoryVideoUpsert.Type;

export const AppFactoryScreensReplace = Schema.Struct({
  videoId: PositiveInt,
  fetchedAt: IsoDateTime,
  screens: Schema.Array(
    Schema.Struct({
      screenId: PositiveInt,
      screenUrl: Schema.String,
      timestamp: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
      isBlurry: Schema.Boolean,
      labels: Schema.Array(Schema.String),
    }),
  ),
});
export type AppFactoryScreensReplace = typeof AppFactoryScreensReplace.Type;

export const AppFactoryAppRow = Schema.Struct({
  ...AppFactoryAppUpsert.fields,
  removedAt: Schema.NullOr(IsoDateTime),
  isPinned: Schema.Boolean,
  note: Schema.NullOr(Schema.String),
});
export type AppFactoryAppRow = typeof AppFactoryAppRow.Type;

export const AppFactoryVideoRow = Schema.Struct({
  ...AppFactoryVideoUpsert.fields,
  screensFetched: Schema.Boolean,
});
export type AppFactoryVideoRow = typeof AppFactoryVideoRow.Type;

export const AppFactoryScreenRow = Schema.Struct({
  screenId: PositiveInt,
  videoId: PositiveInt,
  screenUrl: Schema.String,
  timestamp: Schema.Number,
  isBlurry: Schema.Boolean,
  labels: Schema.Array(Schema.String),
});
export type AppFactoryScreenRow = typeof AppFactoryScreenRow.Type;

export const AppFactorySyncRunRow = Schema.Struct({
  runId: PositiveInt,
  mode: AppFactorySyncMode,
  status: AppFactorySyncRunStatus,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  cursor: Schema.NullOr(Schema.String),
  appsUpserted: NonNegativeInt,
  totalApps: Schema.NullOr(NonNegativeInt),
  error: Schema.NullOr(Schema.String),
});
export type AppFactorySyncRunRow = typeof AppFactorySyncRunRow.Type;

export const AppFactoryCounts = Schema.Struct({
  apps: NonNegativeInt,
  videos: NonNegativeInt,
  screens: NonNegativeInt,
  pinned: NonNegativeInt,
});
export type AppFactoryCounts = typeof AppFactoryCounts.Type;

export const AppFactoryRevenueRow = Schema.Struct({
  appId: PositiveInt,
  year: NonNegativeInt,
  month: NonNegativeInt,
  revenue: NonNegativeInt,
});
export type AppFactoryRevenueRow = typeof AppFactoryRevenueRow.Type;

// ── Service shape ────────────────────────────────────────────────────

export interface AppFactoryRepositoryShape {
  /** Insert or fully refresh one catalog app; clears `removed_at` when it reappears. */
  readonly upsertApp: (
    input: AppFactoryAppUpsert,
  ) => Effect.Effect<void, AppFactoryRepositoryError>;

  /** Replace all revenue months for one app (server payload is authoritative). */
  readonly replaceRevenue: (
    input: AppFactoryRevenueReplace,
  ) => Effect.Effect<void, AppFactoryRepositoryError>;

  readonly listAppRows: () => Effect.Effect<
    ReadonlyArray<AppFactoryAppRow>,
    AppFactoryRepositoryError
  >;

  readonly getAppRow: (
    appId: number,
  ) => Effect.Effect<AppFactoryAppRow | null, AppFactoryRepositoryError>;

  readonly listRevenueRows: () => Effect.Effect<
    ReadonlyArray<AppFactoryRevenueRow>,
    AppFactoryRepositoryError
  >;

  readonly upsertVideo: (
    input: AppFactoryVideoUpsert,
  ) => Effect.Effect<void, AppFactoryRepositoryError>;

  readonly listVideoRows: (
    appId: number,
  ) => Effect.Effect<ReadonlyArray<AppFactoryVideoRow>, AppFactoryRepositoryError>;

  /** Replace the cached frame list for one video and mark it fetched. */
  readonly replaceScreens: (
    input: AppFactoryScreensReplace,
  ) => Effect.Effect<void, AppFactoryRepositoryError>;

  readonly listScreenRows: (
    videoId: number,
  ) => Effect.Effect<ReadonlyArray<AppFactoryScreenRow>, AppFactoryRepositoryError>;

  readonly getMaxAppId: () => Effect.Effect<number, AppFactoryRepositoryError>;

  /** Mark an app removed upstream; rows, revenue and watchlist are preserved. */
  readonly markAppRemoved: (
    appId: number,
    removedAt: string,
  ) => Effect.Effect<void, AppFactoryRepositoryError>;

  /** After a full sync: mark every app absent from `seenAppIds` as removed. */
  readonly markAppsRemovedExcept: (
    seenAppIds: ReadonlyArray<number>,
    removedAt: string,
  ) => Effect.Effect<void, AppFactoryRepositoryError>;

  readonly setPinned: (
    appId: number,
    pinned: boolean,
    pinnedAt: string,
  ) => Effect.Effect<void, AppFactoryRepositoryError>;

  /** Notes require a pin; empty note clears. Unpin deletes the watchlist row. */
  readonly setNote: (appId: number, note: string) => Effect.Effect<void, AppFactoryRepositoryError>;

  readonly counts: () => Effect.Effect<AppFactoryCounts, AppFactoryRepositoryError>;

  readonly startSyncRun: (
    mode: AppFactorySyncMode,
    cursor: string | null,
    startedAt: string,
  ) => Effect.Effect<number, AppFactoryRepositoryError>;

  readonly updateSyncRunProgress: (
    runId: number,
    cursor: string | null,
    appsUpserted: number,
    totalApps: number | null,
  ) => Effect.Effect<void, AppFactoryRepositoryError>;

  readonly finishSyncRun: (
    runId: number,
    status: AppFactorySyncRunStatus,
    finishedAt: string,
    error: string | null,
  ) => Effect.Effect<void, AppFactoryRepositoryError>;

  /** Rows still marked `running` from a previous process are crash leftovers. */
  readonly markRunningSyncRunsInterrupted: (
    finishedAt: string,
  ) => Effect.Effect<void, AppFactoryRepositoryError>;

  /** Latest run for one mode; an `interrupted` status means the next run resumes from its cursor. */
  readonly getLatestSyncRunForMode: (
    mode: AppFactorySyncMode,
  ) => Effect.Effect<AppFactorySyncRunRow | null, AppFactoryRepositoryError>;

  readonly getLatestSyncRun: () => Effect.Effect<
    AppFactorySyncRunRow | null,
    AppFactoryRepositoryError
  >;

  readonly listSyncRuns: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<AppFactorySyncRunRow>, AppFactoryRepositoryError>;

  readonly getStateValue: (key: string) => Effect.Effect<string | null, AppFactoryRepositoryError>;

  readonly setStateValue: (
    key: string,
    value: string,
  ) => Effect.Effect<void, AppFactoryRepositoryError>;

  readonly deleteStateValue: (key: string) => Effect.Effect<void, AppFactoryRepositoryError>;
}

export class AppFactoryRepository extends ServiceMap.Service<
  AppFactoryRepository,
  AppFactoryRepositoryShape
>()("synara/persistence/Services/AppFactoryRepository/AppFactoryRepository") {}
