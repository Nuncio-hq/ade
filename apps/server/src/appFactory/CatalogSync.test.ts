import { AppFactorySyncInProgressError } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Layer } from "effect";

import { AppFactoryRepository } from "../persistence/Services/AppFactoryRepository.ts";
import type { AppFactoryRepositoryShape } from "../persistence/Services/AppFactoryRepository.ts";
import { AppFactoryRepositoryLive } from "../persistence/Layers/AppFactoryRepository.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeCatalogSyncScheduler, refreshApp, type CatalogSyncDeps } from "./CatalogSync.ts";
import {
  ScreensdesignTokenInvalidError,
  type ScreensdesignClientShape,
} from "./Services/ScreensdesignClient.ts";
import type { SdAppDetail, SdAppListItem, SdPage, SdScreen, SdVideo } from "./screensdesignApi.ts";

const layer = it.layer(AppFactoryRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

let clock = 0;
const now = () => {
  clock += 1;
  return `2026-07-28T04:00:${String(clock % 60).padStart(2, "0")}.000Z`;
};

function sdApp(id: number, overrides: Partial<SdAppListItem> = {}): SdAppListItem {
  return {
    id,
    slug: `app-${id}`,
    name: `App ${id}`,
    shortname: null,
    icon: null,
    developer: null,
    avs: null,
    revenue: id * 1000,
    revenue_list: [{ year: 2026, month: 6, revenue: id * 500 }],
    downloads: id * 2000,
    rating_value: 4.5,
    advertised: false,
    released: "2025-01-01",
    updated: "2026-07-01",
    featured: false,
    latest_appvideo_id: null,
    ...overrides,
  };
}

function sdDetail(id: number, overrides: Partial<SdAppDetail> = {}): SdAppDetail {
  return {
    ...sdApp(id),
    appstore_link: null,
    category_primary: { id: 11, name: "PRODUCTIVITY" },
    description: null,
    store_id: 1000 + id,
    latest_appobvideo_id: null,
    ...overrides,
  };
}

const FIRST = "__first__";

interface FakeClientScript {
  readonly pages: Readonly<Record<string, SdPage<SdAppListItem> | ScreensdesignTokenInvalidError>>;
  readonly details?: Readonly<Record<number, SdAppDetail | ScreensdesignTokenInvalidError | null>>;
  readonly videos?: Readonly<Record<number, SdPage<SdVideo>>>;
  readonly screens?: Readonly<Record<number, SdPage<SdScreen>>>;
  /** Latch URLs: the fetch waits on the gate before answering (single-flight test). */
  readonly gates?: Readonly<Record<string, Deferred.Deferred<void>>>;
}

function makeFakeClient(script: FakeClientScript) {
  const fetchedUrls: string[] = [];
  const fail = (error: ScreensdesignTokenInvalidError) => Effect.fail(error);
  const client: ScreensdesignClientShape = {
    me: () => fail(new ScreensdesignTokenInvalidError({ detail: "not needed" })),
    fetchAppsPage: (nextUrl) => {
      const key = nextUrl ?? FIRST;
      fetchedUrls.push(key);
      const entry = script.pages[key];
      if (entry === undefined) {
        return fail(new ScreensdesignTokenInvalidError({ detail: `unscripted page ${key}` }));
      }
      const respond = () =>
        entry instanceof ScreensdesignTokenInvalidError ? fail(entry) : Effect.succeed(entry);
      const gate = script.gates?.[key];
      return gate === undefined ? respond() : Effect.flatMap(Deferred.await(gate), respond);
    },
    fetchAppDetail: (appId) => {
      const entry = script.details?.[appId];
      if (entry === undefined) {
        return fail(new ScreensdesignTokenInvalidError({ detail: `unscripted detail ${appId}` }));
      }
      if (entry === null) {
        return Effect.succeed(null);
      }
      return entry instanceof ScreensdesignTokenInvalidError ? fail(entry) : Effect.succeed(entry);
    },
    fetchVideosPage: (appId) => {
      const entry = script.videos?.[appId];
      return entry === undefined
        ? Effect.succeed({ count: 0, next: null, results: [] })
        : Effect.succeed(entry);
    },
    fetchScreensPage: (appVideoId) => {
      const entry = script.screens?.[appVideoId];
      return entry === undefined
        ? Effect.succeed({ count: 0, next: null, results: [] })
        : Effect.succeed(entry);
    },
  };
  return { client, fetchedUrls };
}

const twoPageCatalog: Record<string, SdPage<SdAppListItem>> = {
  [FIRST]: { count: 4, next: "page=2", results: [sdApp(4), sdApp(3)] },
  "page=2": { count: 4, next: null, results: [sdApp(2), sdApp(1)] },
};

function makeDeps(
  client: ScreensdesignClientShape,
  repo: AppFactoryRepositoryShape,
): CatalogSyncDeps {
  return { client, repo, now, sleep: () => Effect.void };
}

layer("CatalogSync", (it) => {
  it.effect("full sync walks every page, upserts apps + revenue, completes the run", () =>
    Effect.gen(function* () {
      const repo = yield* AppFactoryRepository;
      const { client, fetchedUrls } = makeFakeClient({ pages: twoPageCatalog });
      const scheduler = yield* makeCatalogSyncScheduler(makeDeps(client, repo));

      const { runId } = yield* scheduler.start("full");
      yield* scheduler.awaitIdle();

      assert.deepStrictEqual(fetchedUrls, [FIRST, "page=2"]);
      const rows = yield* repo.listAppRows();
      assert.deepStrictEqual(
        rows.map((row) => row.appId),
        [4, 3, 2, 1],
      );
      assert.strictEqual((yield* repo.listRevenueRows()).length, 4);

      const runs = yield* repo.listSyncRuns(10);
      assert.strictEqual(runs[0]?.runId, runId);
      assert.strictEqual(runs[0]?.status, "completed");
      assert.strictEqual(runs[0]?.appsUpserted, 4);
      assert.strictEqual(runs[0]?.totalApps, 4);
      assert.isNull((yield* repo.getAppRow(1))?.removedAt);
    }),
  );

  it.effect("full re-sync updates changed rows and marks vanished apps removed", () =>
    Effect.gen(function* () {
      const repo = yield* AppFactoryRepository;
      // Previous test left apps 1-4 in the shared DB — the catalog now says
      // only apps 4 (changed) and 3 exist.
      const changed: Record<string, SdPage<SdAppListItem>> = {
        [FIRST]: {
          count: 2,
          next: null,
          results: [
            sdApp(4, { revenue: 999_000, rating_value: 1.25, updated: "2026-07-28" }),
            sdApp(3),
          ],
        },
      };
      const { client } = makeFakeClient({ pages: changed });
      const scheduler = yield* makeCatalogSyncScheduler(makeDeps(client, repo));

      yield* scheduler.start("full");
      yield* scheduler.awaitIdle();

      const updated = yield* repo.getAppRow(4);
      assert.strictEqual(updated?.revenue, 999_000);
      assert.strictEqual(updated?.ratingValue, 1.25);
      assert.strictEqual(updated?.updated, "2026-07-28");
      assert.isNull(updated?.removedAt);

      for (const vanished of [2, 1]) {
        const row = yield* repo.getAppRow(vanished);
        assert.isNotNull(row?.removedAt);
      }
      // Revenue history of removed apps is preserved (from the earlier sync).
      assert.isTrue((yield* repo.listRevenueRows()).some((row) => row.appId === 1));
    }),
  );

  it.effect("incremental stops at the known max id and only inserts new apps", () =>
    Effect.gen(function* () {
      const repo = yield* AppFactoryRepository;
      const maxBefore = yield* repo.getMaxAppId();
      const fresh: Record<string, SdPage<SdAppListItem>> = {
        [FIRST]: {
          count: 6,
          next: "page=2",
          results: [sdApp(maxBefore + 2), sdApp(maxBefore + 1), sdApp(maxBefore)],
        },
        "page=2": { count: 6, next: null, results: [sdApp(1)] },
      };
      const { client, fetchedUrls } = makeFakeClient({ pages: fresh });
      const scheduler = yield* makeCatalogSyncScheduler(makeDeps(client, repo));

      yield* scheduler.start("incremental");
      yield* scheduler.awaitIdle();

      // Stops on the first page: app(maxBefore) signals known territory.
      assert.deepStrictEqual(fetchedUrls, [FIRST]);
      const runs = yield* repo.listSyncRuns(1);
      assert.strictEqual(runs[0]?.mode, "incremental");
      assert.strictEqual(runs[0]?.status, "completed");
      assert.strictEqual(runs[0]?.appsUpserted, 2);
      assert.isNotNull(yield* repo.getMaxAppId());
      assert.strictEqual(yield* repo.getMaxAppId(), maxBefore + 2);
    }),
  );

  it.effect("401 mid-sync aborts with token_invalid and keeps all data intact", () =>
    Effect.gen(function* () {
      const repo = yield* AppFactoryRepository;
      const countBefore = (yield* repo.listAppRows()).length;
      const partial: Record<string, SdPage<SdAppListItem> | ScreensdesignTokenInvalidError> = {
        [FIRST]: { count: 9, next: "page=2", results: [sdApp(9001), sdApp(9002)] },
        "page=2": new ScreensdesignTokenInvalidError({ detail: "Token expired" }),
      };
      const { client } = makeFakeClient({ pages: partial });
      const scheduler = yield* makeCatalogSyncScheduler(makeDeps(client, repo));

      yield* scheduler.start("full");
      yield* scheduler.awaitIdle();

      const runs = yield* repo.listSyncRuns(1);
      assert.strictEqual(runs[0]?.status, "token_invalid");
      assert.match(runs[0]?.error ?? "", /Token expired/);
      // Page-1 rows from this run persist; earlier rows untouched.
      assert.strictEqual((yield* repo.listAppRows()).length, countBefore + 2);
      assert.isNull((yield* repo.getAppRow(9001))?.removedAt);
    }),
  );

  it.effect("a second sync started while one is running is rejected (single-flight)", () =>
    Effect.gen(function* () {
      const repo = yield* AppFactoryRepository;
      const gate = yield* Deferred.make<void>();
      const gated: Record<string, SdPage<SdAppListItem>> = {
        [FIRST]: { count: 1, next: null, results: [sdApp(9101)] },
      };
      const { client } = makeFakeClient({ pages: gated, gates: { [FIRST]: gate } });
      const scheduler = yield* makeCatalogSyncScheduler(makeDeps(client, repo));

      const first = yield* scheduler.start("full");
      assert.isTrue(first.runId > 0);
      const status = yield* scheduler.status();
      assert.isTrue(status.running);

      const error = yield* Effect.flip(scheduler.start("incremental"));
      assert.instanceOf(error, AppFactorySyncInProgressError);

      yield* Deferred.succeed(gate, undefined);
      yield* scheduler.awaitIdle();
      assert.isFalse((yield* scheduler.status()).running);
    }),
  );

  it.effect("refreshApp persists metadata, revenue, videos and screens", () =>
    Effect.gen(function* () {
      const repo = yield* AppFactoryRepository;
      const video: SdVideo = {
        id: 555,
        slug: "app-9301-video",
        label: "Jul 2026",
        video: "https://player.mediadelivery.net/embed/x/y",
        blur_starts_at: 26.0,
        app_version: { version: "2.0" },
        recording_date: "2026-07-14",
        duration_seconds: 120,
      };
      const screen: SdScreen = {
        id: 777,
        screen: "https://media.screensdesign.com/avs-pp/x.webp",
        timestamp: "3.5" as unknown as number,
        is_blurry: false,
        labels: ["paywall"],
        app_video: 555,
      };
      const { client } = makeFakeClient({
        pages: {},
        details: { 9301: sdDetail(9301, { latest_appvideo_id: 555 }) },
        videos: { 9301: { count: 1, next: null, results: [video] } },
        screens: { 555: { count: 1, next: null, results: [screen] } },
      });
      const deps = makeDeps(client, repo);

      yield* refreshApp(deps, 9301);

      const row = yield* repo.getAppRow(9301);
      assert.strictEqual(row?.categoryPrimary, "PRODUCTIVITY");
      assert.strictEqual(row?.storeId, "10301");
      const videos = yield* repo.listVideoRows(9301);
      assert.strictEqual(videos.length, 1);
      assert.strictEqual(videos[0]?.appVersion, "2.0");
      assert.isTrue(videos[0]?.screensFetched);
      const screens = yield* repo.listScreenRows(555);
      assert.deepStrictEqual(
        screens.map((s) => ({ screenId: s.screenId, timestamp: s.timestamp, labels: s.labels })),
        [{ screenId: 777, timestamp: 3.5, labels: ["paywall"] }],
      );
    }),
  );

  it.effect("refreshApp on a vanished app (404) marks removed and preserves history", () =>
    Effect.gen(function* () {
      const repo = yield* AppFactoryRepository;
      yield* repo.upsertApp({
        ...sdDetail(9401),
        appId: 9401,
        shortname: null,
        iconUrl: null,
        developerName: null,
        developerSlug: null,
        categoryPrimary: null,
        description: null,
        appstoreLink: null,
        storeId: null,
        revenue: 1000,
        downloads: 2000,
        ratingValue: null,
        advertised: false,
        featured: false,
        released: null,
        updated: null,
        paywallType: null,
        onboardingStepCount: null,
        hasOnboardingWithQuiz: null,
        latestAppvideoId: null,
        latestAppobvideoId: null,
        fetchedAt: now(),
      });
      yield* repo.replaceRevenue({
        appId: 9401,
        points: [{ year: 2026, month: 6, revenue: 500 }],
      });

      const { client } = makeFakeClient({ pages: {}, details: { 9401: null } });
      yield* refreshApp(makeDeps(client, repo), 9401);

      const row = yield* repo.getAppRow(9401);
      assert.isNotNull(row?.removedAt);
      assert.isTrue((yield* repo.listRevenueRows()).some((r) => r.appId === 9401));
    }),
  );
});

// Isolated layer: resume behavior asserts precise removed-marking, which the
// shared database above pollutes via earlier full-sync passes.
const resumeLayer = it.layer(
  AppFactoryRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

resumeLayer("CatalogSync (resume)", (it) => {
  it.effect("an interrupted run resumes from its cursor and skips removed-marking", () =>
    Effect.gen(function* () {
      const repo = yield* AppFactoryRepository;
      // A pre-existing app that a wrongly-marking resumed run would remove.
      yield* repo.upsertApp({
        ...sdDetail(9200),
        appId: 9200,
        shortname: null,
        iconUrl: null,
        developerName: null,
        developerSlug: null,
        categoryPrimary: null,
        description: null,
        appstoreLink: null,
        storeId: null,
        revenue: 1000,
        downloads: 2000,
        ratingValue: null,
        advertised: false,
        featured: false,
        released: null,
        updated: null,
        paywallType: null,
        onboardingStepCount: null,
        hasOnboardingWithQuiz: null,
        latestAppvideoId: null,
        latestAppobvideoId: null,
        fetchedAt: now(),
      });
      // Simulate a crashed full run that had only fetched page 1.
      const crashed = yield* repo.startSyncRun("full", "page=2", now());
      yield* repo.updateSyncRunProgress(crashed, "page=2", 2, 9);

      const resumed: Record<string, SdPage<SdAppListItem>> = {
        "page=2": { count: 9, next: null, results: [sdApp(9201), sdApp(9202)] },
      };
      const { client, fetchedUrls } = makeFakeClient({ pages: resumed });
      const scheduler = yield* makeCatalogSyncScheduler(makeDeps(client, repo));

      yield* scheduler.start("full");
      yield* scheduler.awaitIdle();

      // Only page 2 was fetched (cursor resume), counts accumulate, no duplicates.
      assert.deepStrictEqual(fetchedUrls, ["page=2"]);
      assert.strictEqual((yield* repo.listAppRows()).length, 3);
      const runs = yield* repo.listSyncRuns(1);
      assert.strictEqual(runs[0]?.status, "completed");
      assert.strictEqual(runs[0]?.appsUpserted, 4);
      // Removed-marking is skipped on resumed runs: the pre-existing app keeps
      // its un-removed state even though page 2 never mentioned it.
      assert.isNull((yield* repo.getAppRow(9200))?.removedAt);
    }),
  );
});
