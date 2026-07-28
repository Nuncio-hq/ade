import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

// ── App Factory domain models ────────────────────────────────────────
// Mirrors of the screensdesign catalog, persisted server-side in af_* tables.
// All identifiers are screensdesign ids (`sd_id` in SQLite, `appId`/`videoId` here).

export const AppFactoryRevenuePoint = Schema.Struct({
  year: NonNegativeInt,
  month: NonNegativeInt,
  revenue: NonNegativeInt,
});
export type AppFactoryRevenuePoint = typeof AppFactoryRevenuePoint.Type;

export const AppFactoryAppSummary = Schema.Struct({
  appId: PositiveInt,
  slug: TrimmedNonEmptyString,
  name: Schema.String,
  shortname: Schema.NullOr(Schema.String),
  iconUrl: Schema.NullOr(Schema.String),
  developerName: Schema.NullOr(Schema.String),
  categoryPrimary: Schema.NullOr(Schema.String),
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
  revenueList: Schema.Array(AppFactoryRevenuePoint),
  isPinned: Schema.Boolean,
  note: Schema.NullOr(Schema.String),
  fetchedAt: IsoDateTime,
  removedAt: Schema.NullOr(IsoDateTime),
});
export type AppFactoryAppSummary = typeof AppFactoryAppSummary.Type;

export const AppFactoryScreen = Schema.Struct({
  screenId: PositiveInt,
  screenUrl: Schema.String,
  timestamp: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  isBlurry: Schema.Boolean,
  labels: Schema.Array(Schema.String),
});
export type AppFactoryScreen = typeof AppFactoryScreen.Type;

/** `screens: null` means frames have not been fetched yet (lazy cache). */
export const AppFactoryVideo = Schema.Struct({
  videoId: PositiveInt,
  slug: Schema.String,
  label: Schema.NullOr(Schema.String),
  videoUrl: Schema.String,
  blurStartsAt: Schema.NullOr(Schema.Number),
  appVersion: Schema.NullOr(Schema.String),
  recordingDate: Schema.NullOr(Schema.String),
  durationSeconds: Schema.NullOr(Schema.Number),
  screens: Schema.NullOr(Schema.Array(AppFactoryScreen)),
});
export type AppFactoryVideo = typeof AppFactoryVideo.Type;

export const AppFactoryAppDetail = Schema.Struct({
  ...AppFactoryAppSummary.fields,
  description: Schema.NullOr(Schema.String),
  appstoreLink: Schema.NullOr(Schema.String),
  storeId: Schema.NullOr(Schema.String),
  videos: Schema.Array(AppFactoryVideo),
});
export type AppFactoryAppDetail = typeof AppFactoryAppDetail.Type;

// ── Sync state ───────────────────────────────────────────────────────

export const AppFactorySyncMode = Schema.Literals(["full", "incremental"]);
export type AppFactorySyncMode = typeof AppFactorySyncMode.Type;

export const AppFactorySyncRunStatus = Schema.Literals([
  "running",
  "completed",
  "failed",
  "interrupted",
  "token_invalid",
]);
export type AppFactorySyncRunStatus = typeof AppFactorySyncRunStatus.Type;

export const AppFactorySyncRun = Schema.Struct({
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
export type AppFactorySyncRun = typeof AppFactorySyncRun.Type;

export const AppFactorySyncProgress = Schema.Struct({
  running: Schema.Boolean,
  mode: Schema.NullOr(AppFactorySyncMode),
  startedAt: Schema.NullOr(IsoDateTime),
  pagesFetched: NonNegativeInt,
  appsUpserted: NonNegativeInt,
  totalApps: Schema.NullOr(NonNegativeInt),
  resumeAvailable: Schema.Boolean,
});
export type AppFactorySyncProgress = typeof AppFactorySyncProgress.Type;

export const AppFactoryStatus = Schema.Struct({
  tokenConfigured: Schema.Boolean,
  accountEmail: Schema.NullOr(Schema.String),
  accountIsPro: Schema.NullOr(Schema.Boolean),
  appCount: NonNegativeInt,
  videoCount: NonNegativeInt,
  screenCount: NonNegativeInt,
  pinnedCount: NonNegativeInt,
  lastSync: Schema.NullOr(AppFactorySyncRun),
  sync: AppFactorySyncProgress,
});
export type AppFactoryStatus = typeof AppFactoryStatus.Type;

// ── RPC inputs / results ─────────────────────────────────────────────

export const AppFactorySetTokenInput = Schema.Struct({
  token: TrimmedNonEmptyString,
});
export type AppFactorySetTokenInput = typeof AppFactorySetTokenInput.Type;

export const AppFactoryTestTokenResult = Schema.Struct({
  ok: Schema.Boolean,
  email: Schema.NullOr(Schema.String),
  isPro: Schema.NullOr(Schema.Boolean),
});
export type AppFactoryTestTokenResult = typeof AppFactoryTestTokenResult.Type;

export const AppFactorySyncNowInput = Schema.Struct({
  mode: AppFactorySyncMode,
});
export type AppFactorySyncNowInput = typeof AppFactorySyncNowInput.Type;

export const AppFactorySyncNowResult = Schema.Struct({
  runId: PositiveInt,
});
export type AppFactorySyncNowResult = typeof AppFactorySyncNowResult.Type;

export const AppFactoryAppIdInput = Schema.Struct({
  appId: PositiveInt,
});
export type AppFactoryAppIdInput = typeof AppFactoryAppIdInput.Type;

export const AppFactorySetPinnedInput = Schema.Struct({
  appId: PositiveInt,
  pinned: Schema.Boolean,
});
export type AppFactorySetPinnedInput = typeof AppFactorySetPinnedInput.Type;

/** Empty note clears an existing note. */
export const AppFactorySetNoteInput = Schema.Struct({
  appId: PositiveInt,
  note: Schema.String.check(Schema.isMaxLength(2_000)),
});
export type AppFactorySetNoteInput = typeof AppFactorySetNoteInput.Type;

export const AppFactoryListAppsResult = Schema.Struct({
  apps: Schema.Array(AppFactoryAppSummary),
});
export type AppFactoryListAppsResult = typeof AppFactoryListAppsResult.Type;

export const AppFactoryListSyncRunsResult = Schema.Struct({
  runs: Schema.Array(AppFactorySyncRun),
});
export type AppFactoryListSyncRunsResult = typeof AppFactoryListSyncRunsResult.Type;

// ── RPC errors ───────────────────────────────────────────────────────

export class AppFactoryTokenNotConfiguredError extends Schema.TaggedErrorClass<AppFactoryTokenNotConfiguredError>()(
  "AppFactoryTokenNotConfiguredError",
  {},
) {
  override get message(): string {
    return "ScreensDesign token is not configured.";
  }
}

export class AppFactoryTokenInvalidError extends Schema.TaggedErrorClass<AppFactoryTokenInvalidError>()(
  "AppFactoryTokenInvalidError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `ScreensDesign token was rejected: ${this.detail}`;
  }
}

export class AppFactorySyncInProgressError extends Schema.TaggedErrorClass<AppFactorySyncInProgressError>()(
  "AppFactorySyncInProgressError",
  {
    startedAt: IsoDateTime,
  },
) {
  override get message(): string {
    return `An App Factory sync is already running (started ${this.startedAt}).`;
  }
}

export class AppFactoryAppNotFoundError extends Schema.TaggedErrorClass<AppFactoryAppNotFoundError>()(
  "AppFactoryAppNotFoundError",
  {
    appId: PositiveInt,
  },
) {
  override get message(): string {
    return `App Factory app not found: ${this.appId}`;
  }
}
