/**
 * App Factory feature facade consumed by the WS RPC layer.
 *
 * Owns token lifecycle (via ServerSecretStore, never exposed over RPC), account
 * caching, sync scheduling and the read model for the web UI. Media metadata
 * (videos/screens) is fetched lazily on first detail view and cached forever.
 */
import type {
  AppFactoryAppDetail,
  AppFactoryAppIdInput,
  AppFactoryAppNotFoundError,
  AppFactoryListAppsResult,
  AppFactoryListSyncRunsResult,
  AppFactorySetNoteInput,
  AppFactorySetPinnedInput,
  AppFactorySetTokenInput,
  AppFactoryStatus,
  AppFactorySyncInProgressError,
  AppFactorySyncNowInput,
  AppFactorySyncNowResult,
  AppFactorySyncProgress,
  AppFactoryTestTokenResult,
  AppFactoryTokenInvalidError,
  AppFactoryTokenNotConfiguredError,
} from "@nuncio/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export type AppFactoryServiceError =
  | AppFactoryTokenNotConfiguredError
  | AppFactoryTokenInvalidError
  | AppFactorySyncInProgressError
  | AppFactoryAppNotFoundError
  | unknown;

export interface AppFactoryServiceShape {
  readonly setToken: (input: AppFactorySetTokenInput) => Effect.Effect<void, unknown>;
  readonly clearToken: () => Effect.Effect<void, unknown>;
  readonly testToken: () => Effect.Effect<
    AppFactoryTestTokenResult,
    AppFactoryTokenNotConfiguredError | AppFactoryTokenInvalidError | unknown
  >;
  readonly getStatus: () => Effect.Effect<AppFactoryStatus, unknown>;
  readonly syncNow: (
    input: AppFactorySyncNowInput,
  ) => Effect.Effect<
    AppFactorySyncNowResult,
    AppFactoryTokenNotConfiguredError | AppFactorySyncInProgressError | unknown
  >;
  readonly syncStatus: () => Effect.Effect<AppFactorySyncProgress, unknown>;
  readonly listSyncRuns: () => Effect.Effect<AppFactoryListSyncRunsResult, unknown>;
  readonly refreshApp: (input: AppFactoryAppIdInput) => Effect.Effect<void, unknown>;
  readonly listApps: () => Effect.Effect<AppFactoryListAppsResult, unknown>;
  readonly getAppDetail: (
    input: AppFactoryAppIdInput,
  ) => Effect.Effect<AppFactoryAppDetail, AppFactoryAppNotFoundError | unknown>;
  readonly setPinned: (input: AppFactorySetPinnedInput) => Effect.Effect<void, unknown>;
  readonly setNote: (input: AppFactorySetNoteInput) => Effect.Effect<void, unknown>;
}

export class AppFactoryService extends ServiceMap.Service<
  AppFactoryService,
  AppFactoryServiceShape
>()("nuncioade/appFactory/Services/AppFactoryService") {}
