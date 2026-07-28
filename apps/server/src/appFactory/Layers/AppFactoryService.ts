/**
 * Live implementation of the App Factory facade.
 *
 * The Screensdesign bearer token lives in ServerSecretStore (`mode 0600` file)
 * and never leaves the server. Screens/videos are mirrored lazily: the first
 * detail view fetches and caches them, later views read from SQLite only.
 */
import {
  AppFactoryAppNotFoundError,
  AppFactoryTokenInvalidError,
  AppFactoryTokenNotConfiguredError,
  type AppFactoryAppSummary,
  type AppFactoryRevenuePoint,
  type AppFactoryVideo,
} from "@synara/contracts";
import { Effect, Layer } from "effect";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { AppFactoryRepository } from "../../persistence/Services/AppFactoryRepository.ts";
import type { AppFactoryVideoRow } from "../../persistence/Services/AppFactoryRepository.ts";
import { AppFactoryService } from "../Services/AppFactoryService.ts";
import type { AppFactoryServiceShape } from "../Services/AppFactoryService.ts";
import { ScreensdesignClient } from "../Services/ScreensdesignClient.ts";
import { SCREENDESIGN_TOKEN_SECRET_NAME } from "./ScreensdesignClient.ts";
import {
  makeCatalogSyncScheduler,
  refreshApp as refreshAppInCatalog,
  type CatalogSyncDeps,
} from "../CatalogSync.ts";
import { toScreenRows, type SdScreen } from "../screensdesignApi.ts";
import type { AppFactoryAppRow } from "../../persistence/Services/AppFactoryRepository.ts";

const SECRET_NAME = SCREENDESIGN_TOKEN_SECRET_NAME;

const ACCOUNT_STATE_KEYS = {
  email: "account.email",
  isPro: "account.isPro",
  subscription: "account.subscription",
} as const;

const collectScreens = (
  client: {
    fetchScreensPage: (
      appVideoId: number,
      nextUrl: string | null,
    ) => Effect.Effect<{ next: string | null; results: ReadonlyArray<SdScreen> }, unknown>;
  },
  appVideoId: number,
): Effect.Effect<ReadonlyArray<SdScreen>, unknown> =>
  Effect.gen(function* () {
    const all: SdScreen[] = [];
    let page = yield* client.fetchScreensPage(appVideoId, null);
    all.push(...page.results);
    while (page.next !== null) {
      page = yield* client.fetchScreensPage(appVideoId, page.next);
      all.push(...page.results);
    }
    return all;
  });

const toSummary = (
  row: AppFactoryAppRow,
  revenueList: ReadonlyArray<AppFactoryRevenuePoint>,
): AppFactoryAppSummary => ({
  appId: row.appId,
  name: row.name,
  slug: row.slug,
  shortname: row.shortname,
  iconUrl: row.iconUrl,
  developerName: row.developerName,
  categoryPrimary: row.categoryPrimary,
  revenue: row.revenue,
  downloads: row.downloads,
  ratingValue: row.ratingValue,
  advertised: row.advertised,
  featured: row.featured,
  released: row.released,
  updated: row.updated,
  paywallType: row.paywallType,
  onboardingStepCount: row.onboardingStepCount,
  hasOnboardingWithQuiz: row.hasOnboardingWithQuiz,
  latestAppvideoId: row.latestAppvideoId,
  revenueList,
  isPinned: row.isPinned,
  note: row.note,
  fetchedAt: row.fetchedAt,
  removedAt: row.removedAt,
});

export const AppFactoryServiceLive = Layer.effect(
  AppFactoryService,
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore;
    const client = yield* ScreensdesignClient;
    const repo = yield* AppFactoryRepository;

    const syncDeps: CatalogSyncDeps = {
      client,
      repo,
      now: () => new Date().toISOString(),
      sleep: (ms) => Effect.sleep(ms),
    };
    const scheduler = yield* makeCatalogSyncScheduler(syncDeps);

    const readToken = (): Effect.Effect<string | null, unknown> =>
      secretStore
        .get(SECRET_NAME)
        .pipe(Effect.map((bytes) => (bytes === null ? null : new TextDecoder().decode(bytes))));

    const requireToken = (): Effect.Effect<string, AppFactoryTokenNotConfiguredError | unknown> =>
      Effect.flatMap(readToken(), (token) =>
        token === null || token === ""
          ? Effect.fail(new AppFactoryTokenNotConfiguredError({}))
          : Effect.succeed(token),
      );

    const setToken: AppFactoryServiceShape["setToken"] = ({ token }) =>
      secretStore.set(SECRET_NAME, new TextEncoder().encode(token.trim()));

    const writeState = (key: string, value: string | null): Effect.Effect<void, unknown> =>
      value === null ? repo.deleteStateValue(key) : repo.setStateValue(key, value);

    const clearToken: AppFactoryServiceShape["clearToken"] = () =>
      Effect.gen(function* () {
        yield* secretStore.remove(SECRET_NAME);
        yield* writeState(ACCOUNT_STATE_KEYS.email, null);
        yield* writeState(ACCOUNT_STATE_KEYS.isPro, null);
        yield* writeState(ACCOUNT_STATE_KEYS.subscription, null);
      });

    const testToken: AppFactoryServiceShape["testToken"] = () =>
      requireToken().pipe(
        Effect.flatMap(() =>
          client
            .me()
            .pipe(
              Effect.catchTag("ScreensdesignTokenInvalidError", (e) =>
                Effect.fail(new AppFactoryTokenInvalidError({ detail: e.detail })),
              ),
            ),
        ),
        Effect.flatMap((account) =>
          Effect.gen(function* () {
            yield* writeState(ACCOUNT_STATE_KEYS.email, account.email);
            yield* writeState(
              ACCOUNT_STATE_KEYS.isPro,
              account.isPro === null ? null : account.isPro ? "1" : "0",
            );
            yield* writeState(ACCOUNT_STATE_KEYS.subscription, account.subscriptionProductName);
            return {
              ok: true as const,
              email: account.email,
              isPro: account.isPro,
            };
          }),
        ),
      );

    const getStatus: AppFactoryServiceShape["getStatus"] = () =>
      Effect.gen(function* () {
        const token = yield* readToken();
        const counts = yield* repo.counts();
        const lastSync = yield* repo.getLatestSyncRun();
        const sync = yield* scheduler.status();
        const email = yield* repo.getStateValue(ACCOUNT_STATE_KEYS.email);
        const isPro = yield* repo.getStateValue(ACCOUNT_STATE_KEYS.isPro);
        return {
          tokenConfigured: token !== null && token !== "",
          accountEmail: email,
          accountIsPro: isPro === null ? null : isPro === "1",
          appCount: counts.apps,
          videoCount: counts.videos,
          screenCount: counts.screens,
          pinnedCount: counts.pinned,
          lastSync,
          sync,
        };
      });

    const syncNow: AppFactoryServiceShape["syncNow"] = ({ mode }) =>
      requireToken().pipe(Effect.flatMap(() => scheduler.start(mode)));

    const syncStatus: AppFactoryServiceShape["syncStatus"] = () => scheduler.status();

    const listSyncRuns: AppFactoryServiceShape["listSyncRuns"] = () =>
      Effect.map(repo.listSyncRuns(20), (runs) => ({ runs }));

    const refreshApp: AppFactoryServiceShape["refreshApp"] = ({ appId }) =>
      requireToken().pipe(Effect.flatMap(() => refreshAppInCatalog(syncDeps, appId)));

    const listApps: AppFactoryServiceShape["listApps"] = () =>
      Effect.gen(function* () {
        const rows = yield* repo.listAppRows();
        const revenueRows = yield* repo.listRevenueRows();
        const revenueByApp = new Map<number, AppFactoryRevenuePoint[]>();
        for (const point of revenueRows) {
          const list = revenueByApp.get(point.appId);
          const entry: AppFactoryRevenuePoint = {
            year: point.year,
            month: point.month,
            revenue: point.revenue,
          };
          if (list === undefined) {
            revenueByApp.set(point.appId, [entry]);
          } else {
            list.push(entry);
          }
        }
        return {
          apps: rows.map((row) => toSummary(row, revenueByApp.get(row.appId) ?? [])),
        };
      });

    const loadVideoWithScreens = (
      video: AppFactoryVideoRow,
      fetchedAt: string,
    ): Effect.Effect<AppFactoryVideo, unknown> =>
      Effect.gen(function* () {
        if (!video.screensFetched) {
          const screens = yield* collectScreens(client, video.videoId);
          yield* repo.replaceScreens({
            videoId: video.videoId,
            fetchedAt,
            screens: toScreenRows(screens),
          });
        }
        const screens = yield* repo.listScreenRows(video.videoId);
        return {
          videoId: video.videoId,
          slug: video.slug,
          label: video.label,
          videoUrl: video.videoUrl,
          blurStartsAt: video.blurStartsAt,
          appVersion: video.appVersion,
          recordingDate: video.recordingDate,
          durationSeconds: video.durationSeconds,
          screens: screens.map((screen) => ({
            screenId: screen.screenId,
            screenUrl: screen.screenUrl,
            timestamp: screen.timestamp,
            isBlurry: screen.isBlurry,
            labels: screen.labels,
          })),
        };
      });

    const getAppDetail: AppFactoryServiceShape["getAppDetail"] = ({ appId }) =>
      Effect.gen(function* () {
        const row = yield* repo.getAppRow(appId);
        if (row === null) {
          return yield* new AppFactoryAppNotFoundError({ appId });
        }
        let videos = yield* repo.listVideoRows(appId);
        if (videos.length === 0 && row.latestAppvideoId !== null) {
          yield* refreshAppInCatalog(syncDeps, appId);
          videos = yield* repo.listVideoRows(appId);
        }
        const now = new Date().toISOString();
        const videoDtos: AppFactoryVideo[] = [];
        for (const video of videos) {
          videoDtos.push(yield* loadVideoWithScreens(video, now));
        }
        const revenueRows = (yield* repo.listRevenueRows()).filter(
          (point) => point.appId === appId,
        );
        return {
          ...toSummary(
            row,
            revenueRows.map((point) => ({
              year: point.year,
              month: point.month,
              revenue: point.revenue,
            })),
          ),
          description: row.description,
          appstoreLink: row.appstoreLink,
          storeId: row.storeId,
          videos: videoDtos,
        };
      });

    const setPinned: AppFactoryServiceShape["setPinned"] = ({ appId, pinned }) =>
      repo.setPinned(appId, pinned, new Date().toISOString());

    const setNote: AppFactoryServiceShape["setNote"] = ({ appId, note }) =>
      repo.setNote(appId, note);

    return {
      setToken,
      clearToken,
      testToken,
      getStatus,
      syncNow,
      syncStatus,
      listSyncRuns,
      refreshApp,
      listApps,
      getAppDetail,
      setPinned,
      setNote,
    } satisfies AppFactoryServiceShape;
  }),
);
