/**
 * Catalog sync orchestration: walks the screensdesign catalog into local SQLite.
 *
 * Three entry points:
 * - full sync: paginate `/v1/apps/` to the end, upserting every row (catches new
 *   apps and changed fields), then mark apps absent upstream as removed.
 * - incremental sync: same walk but stop once we reach already-known ids (cheap
 *   daily "new apps only" pass).
 * - refreshApp: re-fetch one app including revenue, videos and screens.
 *
 * Runs are recorded in af_sync_runs with a resume cursor; a crash mid-run leaves
 * a `running` row that startup marks `interrupted`, and the next run of the same
 * mode continues from that cursor. A resumed full sync skips the removed-marking
 * pass on purpose: its seen-id set only covers pages fetched after the resume, so
 * marking would produce false removals (the next complete full sync re-checks).
 */
import { AppFactorySyncInProgressError, type AppFactorySyncMode } from "@nuncio/contracts";
import { Effect, Ref } from "effect";

import type { AppFactoryRepositoryShape } from "../persistence/Services/AppFactoryRepository.ts";
import {
  ScreensdesignTokenInvalidError,
  type ScreensdesignClientShape,
} from "./Services/ScreensdesignClient.ts";
import { toAppUpsert, toRevenuePoints, toScreenRows, toVideoUpsert } from "./screensdesignApi.ts";

export interface CatalogSyncDeps {
  readonly client: ScreensdesignClientShape;
  readonly repo: AppFactoryRepositoryShape;
  readonly now: () => string;
  /** Politeness delay between page requests; zero in tests. */
  readonly sleep: (ms: number) => Effect.Effect<void>;
}

export interface SyncProgressState {
  readonly runId: number;
  readonly mode: AppFactorySyncMode;
  readonly startedAt: string;
  readonly pagesFetched: number;
  readonly appsUpserted: number;
  readonly totalApps: number | null;
}

const PAGE_DELAY_MS = 350;

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Follow `next` URLs until exhausted, sleeping between pages. */
const collectPages = <A>(
  firstPage: () => Effect.Effect<{ next: string | null; results: ReadonlyArray<A> }, unknown>,
  nextPage: (
    url: string,
  ) => Effect.Effect<{ next: string | null; results: ReadonlyArray<A> }, unknown>,
  sleep: (ms: number) => Effect.Effect<void>,
): Effect.Effect<ReadonlyArray<A>, unknown> =>
  Effect.gen(function* () {
    const all: A[] = [];
    let page = yield* firstPage();
    all.push(...page.results);
    while (page.next !== null) {
      yield* sleep(PAGE_DELAY_MS);
      page = yield* nextPage(page.next);
      all.push(...page.results);
    }
    return all;
  });

export const runCatalogSync = (
  deps: CatalogSyncDeps,
  options: {
    readonly runId: number;
    readonly mode: AppFactorySyncMode;
    readonly resumeCursor: string | null;
    readonly initialAppsUpserted?: number;
    readonly onProgress: (state: SyncProgressState) => Effect.Effect<void>;
  },
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const { client, repo, now, sleep } = deps;
    const startedAt = now();
    let appsUpserted = options.initialAppsUpserted ?? 0;
    let pagesFetched = 0;
    let totalApps: number | null = null;
    const seenAppIds: number[] = [];
    // A resumed incremental pass must keep skipping the ids it already knew;
    // capture the local watermark before the walk starts.
    const maxLocalId = options.mode === "incremental" ? yield* repo.getMaxAppId() : 0;

    const report = (cursor: string | null) =>
      repo.updateSyncRunProgress(options.runId, cursor, appsUpserted, totalApps).pipe(
        Effect.flatMap(() =>
          options.onProgress({
            runId: options.runId,
            mode: options.mode,
            startedAt,
            pagesFetched,
            appsUpserted,
            totalApps,
          }),
        ),
      );

    const finish = (status: "completed" | "failed" | "token_invalid", error: string | null) =>
      repo.finishSyncRun(options.runId, status, now(), error);

    const walk = Effect.gen(function* () {
      let url: string | null = options.resumeCursor;
      while (true) {
        const page = yield* client.fetchAppsPage(url);
        pagesFetched += 1;
        totalApps = page.count;

        const items =
          options.mode === "incremental"
            ? page.results.filter((item) => item.id > maxLocalId)
            : page.results;
        for (const item of items) {
          const fetchedAt = now();
          // Catalog rows come from list payloads: detail-only columns are
          // preserved on conflict (see upsertCatalogApp).
          yield* repo.upsertCatalogApp(toAppUpsert(item, fetchedAt));
          yield* repo.replaceRevenue({ appId: item.id, points: toRevenuePoints(item) });
          if (options.mode === "full") {
            seenAppIds.push(item.id);
          }
        }
        appsUpserted += items.length;
        yield* report(page.next);

        const reachedKnownIds =
          options.mode === "incremental" && page.results.some((item) => item.id <= maxLocalId);
        if (page.next === null || reachedKnownIds) {
          break;
        }
        yield* sleep(PAGE_DELAY_MS);
        url = page.next;
      }

      if (options.mode === "full" && options.resumeCursor === null) {
        yield* repo.markAppsRemovedExcept(seenAppIds, now());
      }
      yield* finish("completed", null);
    });

    yield* walk.pipe(
      Effect.catch((cause) =>
        finish(
          cause instanceof ScreensdesignTokenInvalidError ? "token_invalid" : "failed",
          errorMessage(cause),
        ),
      ),
    );
  });

/** Re-fetch one app: metadata + revenue + all recordings + all extracted frames. */
export const refreshApp = (deps: CatalogSyncDeps, appId: number): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const { client, repo, now, sleep } = deps;
    const detail = yield* client.fetchAppDetail(appId);
    if (detail === null) {
      yield* repo.markAppRemoved(appId, now());
      return;
    }
    const fetchedAt = now();
    yield* repo.upsertApp(toAppUpsert(detail, fetchedAt));
    yield* repo.replaceRevenue({ appId, points: toRevenuePoints(detail) });
    yield* repo.markDetailFetched(appId, fetchedAt);

    const videos = yield* collectPages(
      () => client.fetchVideosPage(appId, null),
      (url) => client.fetchVideosPage(appId, url),
      sleep,
    );
    for (const video of videos) {
      yield* repo.upsertVideo(toVideoUpsert(video, appId, fetchedAt));
      const screens = yield* collectPages(
        () => client.fetchScreensPage(video.id, null),
        (url) => client.fetchScreensPage(video.id, url),
        sleep,
      );
      yield* repo.replaceScreens({ videoId: video.id, fetchedAt, screens: toScreenRows(screens) });
    }
  });

export interface CatalogSyncScheduler {
  readonly start: (
    mode: AppFactorySyncMode,
  ) => Effect.Effect<{ readonly runId: number }, AppFactorySyncInProgressError | unknown>;
  readonly status: () => Effect.Effect<
    {
      readonly running: boolean;
      readonly mode: AppFactorySyncMode | null;
      readonly startedAt: string | null;
      readonly pagesFetched: number;
      readonly appsUpserted: number;
      readonly totalApps: number | null;
      readonly resumeAvailable: boolean;
    },
    unknown
  >;
  /** Test hook: wait until no sync fiber is running. */
  readonly awaitIdle: () => Effect.Effect<void>;
}

export const makeCatalogSyncScheduler = (
  deps: CatalogSyncDeps,
): Effect.Effect<CatalogSyncScheduler, unknown, never> =>
  Effect.gen(function* () {
    const { repo, now } = deps;
    const runningRef = yield* Ref.make<SyncProgressState | null>(null);

    // Crash recovery: runs this process left in `running` are leftovers.
    yield* repo.markRunningSyncRunsInterrupted(now());

    const start: CatalogSyncScheduler["start"] = (mode) =>
      Effect.gen(function* () {
        const running = yield* Ref.get(runningRef);
        if (running !== null) {
          return yield* new AppFactorySyncInProgressError({ startedAt: running.startedAt });
        }
        const latestForMode = yield* repo.getLatestSyncRunForMode(mode);
        const resumeCursor = latestForMode?.status === "interrupted" ? latestForMode.cursor : null;
        const initialAppsUpserted =
          latestForMode?.status === "interrupted" ? latestForMode.appsUpserted : 0;
        const runId = yield* repo.startSyncRun(mode, resumeCursor, now());

        yield* runCatalogSync(deps, {
          runId,
          mode,
          resumeCursor,
          initialAppsUpserted,
          onProgress: (state) => Ref.set(runningRef, state),
        }).pipe(Effect.ensuring(Ref.set(runningRef, null)), Effect.forkDetach);
        yield* Ref.set(runningRef, {
          runId,
          mode,
          startedAt: now(),
          pagesFetched: 0,
          appsUpserted: initialAppsUpserted,
          totalApps: latestForMode?.totalApps ?? null,
        });
        return { runId };
      });

    const status: CatalogSyncScheduler["status"] = () =>
      Effect.gen(function* () {
        const running = yield* Ref.get(runningRef);
        if (running !== null) {
          return { running: true as const, resumeAvailable: false, ...running };
        }
        const latest = yield* repo.getLatestSyncRun();
        return {
          running: false as const,
          mode: null,
          startedAt: null,
          pagesFetched: 0,
          appsUpserted: 0,
          totalApps: null,
          resumeAvailable: latest?.status === "interrupted",
        };
      });

    const awaitIdle: CatalogSyncScheduler["awaitIdle"] = () =>
      Effect.suspend(() =>
        Effect.flatMap(Ref.get(runningRef), (running) =>
          running === null ? Effect.void : Effect.flatMap(Effect.yieldNow, () => awaitIdle()),
        ),
      );

    return { start, status, awaitIdle };
  });
