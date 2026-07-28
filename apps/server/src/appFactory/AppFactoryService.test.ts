import {
  AppFactoryAppNotFoundError,
  AppFactoryTokenInvalidError,
  AppFactoryTokenNotConfiguredError,
} from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "../auth/Services/ServerSecretStore.ts";
import { AppFactoryRepository } from "../persistence/Services/AppFactoryRepository.ts";
import { AppFactoryRepositoryLive } from "../persistence/Layers/AppFactoryRepository.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AppFactoryService } from "./Services/AppFactoryService.ts";
import { AppFactoryServiceLive } from "./Layers/AppFactoryService.ts";
import {
  ScreensdesignClient,
  ScreensdesignTokenInvalidError,
  type ScreensdesignClientShape,
} from "./Services/ScreensdesignClient.ts";
import type { SdAccount, SdAppDetail, SdPage, SdScreen, SdVideo } from "./screensdesignApi.ts";

interface FakeClientOptions {
  readonly me?: () => Effect.Effect<SdAccount, ScreensdesignTokenInvalidError>;
  readonly pages?: Readonly<Record<string, SdPage<{ id: number } & Record<string, unknown>>>>;
  readonly details?: Readonly<Record<number, SdAppDetail | null>>;
  readonly videos?: Readonly<Record<number, SdPage<SdVideo>>>;
  readonly screens?: Readonly<Record<number, SdPage<SdScreen>>>;
}

function makeFakeClient(options: FakeClientOptions) {
  const calls = {
    me: 0,
    fetchAppsPage: 0,
    fetchAppDetail: 0,
    fetchVideosPage: 0,
    fetchScreensPage: 0,
  };
  const unscripted = new ScreensdesignTokenInvalidError({ detail: "unscripted call" });
  const client: ScreensdesignClientShape = {
    me: () => {
      calls.me += 1;
      return options.me === undefined ? Effect.fail(unscripted) : options.me();
    },
    fetchAppsPage: (nextUrl) => {
      calls.fetchAppsPage += 1;
      const entry = options.pages?.[nextUrl ?? "__first__"];
      return (entry === undefined ? Effect.fail(unscripted) : Effect.succeed(entry)) as never;
    },
    fetchAppDetail: (appId) => {
      calls.fetchAppDetail += 1;
      const entry = options.details?.[appId];
      return entry === undefined
        ? Effect.fail(unscripted)
        : Effect.succeed(entry as SdAppDetail | null);
    },
    fetchVideosPage: (appId) => {
      calls.fetchVideosPage += 1;
      const entry = options.videos?.[appId];
      return Effect.succeed(entry ?? { count: 0, next: null, results: [] });
    },
    fetchScreensPage: (appVideoId) => {
      calls.fetchScreensPage += 1;
      const entry = options.screens?.[appVideoId];
      return Effect.succeed(entry ?? { count: 0, next: null, results: [] });
    },
  };
  return { client, calls };
}

const makeSecretStoreLayer = () => {
  const store = new Map<string, Uint8Array>();
  const shape: ServerSecretStoreShape = {
    get: (name) => Effect.succeed(store.get(name) ?? null),
    set: (name, value) => Effect.sync(() => store.set(name, value)).pipe(Effect.asVoid),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = store.get(name);
        if (existing !== undefined) return existing;
        const created = new Uint8Array(bytes).fill(1);
        store.set(name, created);
        return created;
      }),
    remove: (name) => Effect.sync(() => store.delete(name)).pipe(Effect.asVoid),
  };
  return Layer.succeed(ServerSecretStore, shape);
};

function makeServiceLayer(options: FakeClientOptions) {
  const { client, calls } = makeFakeClient(options);
  const layer = AppFactoryServiceLive.pipe(
    Layer.provideMerge(Layer.succeed(ScreensdesignClient, client)),
    Layer.provideMerge(AppFactoryRepositoryLive),
    Layer.provideMerge(makeSecretStoreLayer()),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  return { layer, calls };
}

const proAccount = () =>
  Effect.succeed({
    email: "dev@nuncio.app",
    isPro: true,
    subscriptionProductName: "PRO_YEARLY",
    subscriptionStatus: "active",
  });

// @effect/vitest injects a TestClock, so Effect.sleep never advances on its
// own. Instead of sleeping, yield to the forked sync fiber until its run
// leaves the `running` state (its page fetches are synchronous fakes).
const waitForSyncToSettle = Effect.gen(function* () {
  const service = yield* AppFactoryService;
  for (let attempt = 0; attempt < 200; attempt++) {
    const { runs } = yield* service.listSyncRuns();
    if (runs.length > 0 && runs[0]?.status !== "running") {
      return;
    }
    yield* Effect.yieldNow;
  }
  assert.fail("background sync did not settle");
});

// --- Token lifecycle + status (isolated: secrets live in this layer only) ---

const tokenLayer = it.layer(makeServiceLayer({ me: proAccount }).layer);

tokenLayer("AppFactoryService (token + status)", (it) => {
  it.effect("reports tokenConfigured=false before any token is stored", () =>
    Effect.gen(function* () {
      const service = yield* AppFactoryService;
      const status = yield* service.getStatus();
      assert.isFalse(status.tokenConfigured);
      assert.isNull(status.accountEmail);
    }),
  );

  it.effect("setToken + testToken validates and caches the account", () =>
    Effect.gen(function* () {
      const service = yield* AppFactoryService;
      yield* service.setToken({ token: "sds_test_token" });
      const result = yield* service.testToken();
      assert.deepStrictEqual(result, {
        ok: true,
        email: "dev@nuncio.app",
        isPro: true,
      });
      const status = yield* service.getStatus();
      assert.isTrue(status.tokenConfigured);
      assert.strictEqual(status.accountEmail, "dev@nuncio.app");
      assert.strictEqual(status.accountIsPro, true);
    }),
  );

  it.effect("clearToken removes the token and wipes the cached account", () =>
    Effect.gen(function* () {
      const service = yield* AppFactoryService;
      yield* service.setToken({ token: "sds_test_token" });
      yield* service.testToken();
      yield* service.clearToken();
      const status = yield* service.getStatus();
      assert.isFalse(status.tokenConfigured);
      assert.isNull(status.accountEmail);
      assert.isNull(status.accountIsPro);
    }),
  );
});

const invalidLayer = it.layer(
  makeServiceLayer({
    me: () => Effect.fail(new ScreensdesignTokenInvalidError({ detail: "Token expired" })),
  }).layer,
);

invalidLayer("AppFactoryService (invalid token)", (it) => {
  it.effect("testToken maps 401 to AppFactoryTokenInvalidError without touching data", () =>
    Effect.gen(function* () {
      const service = yield* AppFactoryService;
      yield* service.setToken({ token: "sds_expired" });
      const error = yield* Effect.flip(service.testToken());
      assert.instanceOf(error, AppFactoryTokenInvalidError);
      // Token is still stored — clearing is an explicit user action.
      assert.isTrue((yield* service.getStatus()).tokenConfigured);
      // syncNow starts a background run whose 401 surfaces as a token_invalid
      // run status, not as an RPC error.
      yield* service.syncNow({ mode: "full" });
      yield* waitForSyncToSettle;
      const { runs } = yield* service.listSyncRuns();
      assert.strictEqual(runs[0]?.status, "token_invalid");
    }),
  );

  it.effect("syncNow without a token fails fast with TokenNotConfigured", () =>
    Effect.gen(function* () {
      const service = yield* AppFactoryService;
      // The previous test in this shared layer stored a token; clear it first.
      yield* service.clearToken();
      const error = yield* Effect.flip(service.syncNow({ mode: "incremental" }));
      assert.instanceOf(error, AppFactoryTokenNotConfiguredError);
    }),
  );
});

// --- Read model: listApps join + lazy detail caching (fresh DB) ---

const catalogPage: SdPage<SdAppDetail> = {
  count: 1,
  next: null,
  results: [
    {
      id: 9001,
      slug: "focus-garden",
      name: "Focus Garden",
      shortname: "Focus",
      icon: "https://media.screensdesign.com/icons/9001.png",
      developer: { id: 12, name: "Plant Labs", slug: "plant-labs" },
      avs: null,
      revenue: 30_000,
      revenue_list: [{ year: 2026, month: 6, revenue: 30_000 }],
      downloads: 55_000,
      rating_value: 4.8,
      advertised: false,
      released: "2025-01-01",
      updated: "2026-07-01",
      featured: false,
      latest_appvideo_id: 410,
      appstore_link: "https://apps.apple.com/app/id6460009001",
      category_primary: { id: 11, name: "PRODUCTIVITY" },
      description: "A focus timer that grows a garden.",
      store_id: "6460009001",
      latest_appobvideo_id: null,
    } as unknown as SdAppDetail,
  ],
};

const video410: SdVideo = {
  id: 410,
  slug: "focus-garden-video",
  label: "Jul 2026",
  video: "https://player.mediadelivery.net/embed/f/g",
  blur_starts_at: null,
  app_version: { version: "3.0" },
  recording_date: "2026-07-10",
  duration_seconds: 95,
};

const screens410: SdScreen[] = [
  {
    id: 7001,
    screen: "https://media.screensdesign.com/avs-pp/s1.webp",
    timestamp: 2.0,
    is_blurry: false,
    labels: ["onboarding"],
    app_video: 410,
  },
];

const catalogCalls = { current: null as ReturnType<typeof makeFakeClient>["calls"] | null };
const catalogLayer = (() => {
  const { layer, calls } = makeServiceLayer({
    pages: { __first__: catalogPage as never },
    videos: { 9001: { count: 1, next: null, results: [video410] } },
    screens: { 410: { count: 1, next: null, results: screens410 } },
    details: {
      9001: catalogPage.results[0] as SdAppDetail,
    },
  });
  catalogCalls.current = calls;
  return it.layer(layer);
})();

catalogLayer("AppFactoryService (read model)", (it) => {
  it.effect("syncs the catalog, then listApps joins revenue and watchlist state", () =>
    Effect.gen(function* () {
      const service = yield* AppFactoryService;
      yield* service.setToken({ token: "sds_test_token" });
      yield* service.syncNow({ mode: "full" });
      yield* waitForSyncToSettle;

      yield* service.setPinned({ appId: 9001, pinned: true });
      yield* service.setNote({ appId: 9001, note: "Strong paywall, clone candidate" });

      const { apps } = yield* service.listApps();
      assert.strictEqual(apps.length, 1);
      const app = apps[0];
      assert.strictEqual(app?.name, "Focus Garden");
      assert.strictEqual(app?.developerName, "Plant Labs");
      assert.strictEqual(app?.categoryPrimary, "PRODUCTIVITY");
      assert.deepStrictEqual(app?.revenueList, [{ year: 2026, month: 6, revenue: 30_000 }]);
      assert.isTrue(app?.isPinned);
      assert.strictEqual(app?.note, "Strong paywall, clone candidate");
      assert.strictEqual(app?.ratingValue, 4.8);
    }),
  );

  it.effect("getAppDetail fetches media lazily once, then serves from the cache", () =>
    Effect.gen(function* () {
      const service = yield* AppFactoryService;
      const calls = catalogCalls.current;
      assert.isNotNull(calls);
      const videosBefore = calls!.fetchVideosPage;
      const screensBefore = calls!.fetchScreensPage;

      const detail = yield* service.getAppDetail({ appId: 9001 });
      assert.strictEqual(detail.description, "A focus timer that grows a garden.");
      assert.strictEqual(detail.appstoreLink, "https://apps.apple.com/app/id6460009001");
      assert.strictEqual(detail.videos.length, 1);
      const video = detail.videos[0];
      if (video === undefined) {
        assert.fail("expected one cached video");
      }
      assert.strictEqual(video.appVersion, "3.0");
      if (video.screens === null) {
        assert.fail("expected screens to be cached after the first view");
      }
      assert.deepStrictEqual(
        video.screens.map((s) => ({ id: s.screenId, ts: s.timestamp })),
        [{ id: 7001, ts: 2.0 }],
      );
      assert.strictEqual(calls!.fetchVideosPage, videosBefore + 1);
      assert.strictEqual(calls!.fetchScreensPage, screensBefore + 1);

      // Second view: no upstream calls at all.
      yield* service.getAppDetail({ appId: 9001 });
      assert.strictEqual(calls!.fetchVideosPage, videosBefore + 1);
      assert.strictEqual(calls!.fetchScreensPage, screensBefore + 1);
    }),
  );

  it.effect("getAppDetail on an unknown id fails with AppNotFound", () =>
    Effect.gen(function* () {
      const service = yield* AppFactoryService;
      const error = yield* Effect.flip(service.getAppDetail({ appId: 424242 }));
      assert.instanceOf(error, AppFactoryAppNotFoundError);
    }),
  );
});

// --- Lazy detail mirror: list payloads never carry detail fields ---

const LIST_ONLY_ITEM = {
  id: 9101,
  slug: "quiet-ledger",
  name: "Quiet Ledger",
  shortname: null,
  icon: null,
  developer: null,
  avs: null,
  revenue: 8000,
  revenue_list: [{ year: 2026, month: 6, revenue: 8000 }],
  downloads: 12_000,
  rating_value: 4.2,
  advertised: false,
  released: "2025-03-01",
  updated: "2026-06-15",
  featured: false,
  latest_appvideo_id: null, // no recordings at all
};

const DETAIL_9101 = {
  ...LIST_ONLY_ITEM,
  appstore_link: "https://apps.apple.com/app/id9101",
  category_primary: { id: 22, name: "FINANCE" },
  description: "Detail-only description",
  store_id: 9101,
  latest_appobvideo_id: null,
} as unknown as SdAppDetail;

const lazyDetailLayer = (() => {
  const { layer, calls } = makeServiceLayer({
    pages: {
      __first__: { count: 1, next: null, results: [LIST_ONLY_ITEM] },
    },
    details: { 9101: DETAIL_9101 },
  });
  return { layer: it.layer(layer), calls };
})();

lazyDetailLayer.layer("AppFactoryService (lazy detail mirror)", (it) => {
  it.effect(
    "first detail view fetches detail even without recordings and returns fresh fields",
    () =>
      Effect.gen(function* () {
        const service = yield* AppFactoryService;
        const { calls } = lazyDetailLayer;
        yield* service.setToken({ token: "sds_test_token" });
        yield* service.syncNow({ mode: "full" });
        yield* waitForSyncToSettle;

        const repo = yield* AppFactoryRepository;
        assert.isNull((yield* repo.getAppRow(9101))?.detailFetchedAt);

        const detail = yield* service.getAppDetail({ appId: 9101 });
        assert.strictEqual(detail.description, "Detail-only description");
        assert.strictEqual(detail.appstoreLink, "https://apps.apple.com/app/id9101");
        assert.strictEqual(detail.storeId, "9101");
        assert.strictEqual(detail.categoryPrimary, "FINANCE");
        assert.strictEqual(calls.fetchAppDetail, 1);
        assert.isNotNull((yield* repo.getAppRow(9101))?.detailFetchedAt);

        // Second view: fully cached, no further upstream calls.
        yield* service.getAppDetail({ appId: 9101 });
        assert.strictEqual(calls.fetchAppDetail, 1);
      }),
  );
});

// --- No token: detail view serves the local cache without upstream calls ---

const noTokenLayer = (() => {
  const { layer, calls } = makeServiceLayer({});
  return { layer: it.layer(layer), calls };
})();

noTokenLayer.layer("AppFactoryService (no token)", (it) => {
  it.effect("getAppDetail without a token serves local cache; unmirrored screens stay null", () =>
    Effect.gen(function* () {
      const service = yield* AppFactoryService;
      const repo = yield* AppFactoryRepository;
      const NOW = "2026-07-28T04:00:00.000Z";
      yield* repo.upsertCatalogApp({
        appId: 9201,
        slug: "cached-app",
        name: "Cached App",
        shortname: null,
        iconUrl: null,
        developerName: null,
        developerSlug: null,
        categoryPrimary: null,
        description: "Cached description",
        appstoreLink: null,
        storeId: null,
        revenue: 5000,
        downloads: 9000,
        ratingValue: null,
        advertised: false,
        featured: false,
        released: null,
        updated: null,
        paywallType: null,
        onboardingStepCount: null,
        hasOnboardingWithQuiz: null,
        latestAppvideoId: 555,
        latestAppobvideoId: null,
        fetchedAt: NOW,
      });
      yield* repo.upsertVideo({
        videoId: 555,
        appId: 9201,
        slug: "cached-app-video",
        label: "Jul 2026",
        videoUrl: "https://player.mediadelivery.net/embed/a/b",
        blurStartsAt: null,
        appVersion: null,
        recordingDate: null,
        durationSeconds: null,
        fetchedAt: NOW,
      });

      const detail = yield* service.getAppDetail({ appId: 9201 });
      assert.strictEqual(detail.description, "Cached description");
      assert.strictEqual(detail.videos.length, 1);
      assert.isNull(detail.videos[0]?.screens);

      const { calls } = noTokenLayer;
      assert.strictEqual(calls.fetchAppDetail, 0);
      assert.strictEqual(calls.fetchScreensPage, 0);
    }),
  );
});
