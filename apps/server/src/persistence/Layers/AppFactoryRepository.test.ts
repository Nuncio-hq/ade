import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  AppFactoryNoteWithoutPinError,
  AppFactoryRepository,
  type AppFactoryAppUpsert,
} from "../Services/AppFactoryRepository.ts";
import { AppFactoryRepositoryLive } from "./AppFactoryRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(AppFactoryRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const NOW = "2026-07-28T04:00:00.000Z";
const LATER = "2026-07-28T05:00:00.000Z";

function appUpsert(overrides: Partial<AppFactoryAppUpsert> = {}): AppFactoryAppUpsert {
  return {
    appId: 1001,
    slug: "demo-app",
    name: "Demo App",
    shortname: "Demo",
    iconUrl: "https://media.screensdesign.com/icon.webp",
    developerName: "Acme Inc",
    developerSlug: "acme-inc",
    categoryPrimary: "PRODUCTIVITY",
    description: "A demo app",
    appstoreLink: "https://apps.apple.com/us/app/id1",
    storeId: "1",
    revenue: 12000,
    downloads: 34000,
    ratingValue: 4.5,
    advertised: true,
    featured: false,
    released: "2025-01-10",
    updated: "2026-07-01",
    paywallType: "Free Trial - Soft Paywall",
    onboardingStepCount: 5,
    hasOnboardingWithQuiz: null,
    latestAppvideoId: 501,
    latestAppobvideoId: null,
    fetchedAt: NOW,
    ...overrides,
  };
}

layer("AppFactoryRepository", (it) => {
  it.effect("upserting the same sd_id twice keeps one row with the latest fields", () =>
    Effect.gen(function* () {
      const repo = yield* AppFactoryRepository;
      yield* repo.upsertApp(appUpsert({ revenue: 100 }));
      yield* repo.upsertApp(appUpsert({ revenue: 999, ratingValue: 1.25, fetchedAt: LATER }));

      const rows = yield* repo.listAppRows();
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.revenue, 999);
      assert.strictEqual(rows[0]?.ratingValue, 1.25);
      assert.strictEqual(rows[0]?.fetchedAt, LATER);
    }),
  );

  it.effect("upsert clears removed_at when an app reappears upstream", () =>
    Effect.gen(function* () {
      const repo = yield* AppFactoryRepository;
      yield* repo.upsertApp(appUpsert());
      yield* repo.markAppRemoved(1001, NOW);
      const removed = yield* repo.getAppRow(1001);
      assert.strictEqual(removed?.removedAt, NOW);

      yield* repo.upsertApp(appUpsert({ fetchedAt: LATER }));
      const restored = yield* repo.getAppRow(1001);
      assert.isNull(restored?.removedAt);
    }),
  );

  it.effect("replaceRevenue fully replaces months (stale months disappear)", () =>
    Effect.gen(function* () {
      const repo = yield* AppFactoryRepository;
      yield* repo.upsertApp(appUpsert());
      yield* repo.replaceRevenue({
        appId: 1001,
        points: [
          { year: 2026, month: 5, revenue: 100 },
          { year: 2026, month: 6, revenue: 200 },
        ],
      });
      yield* repo.replaceRevenue({
        appId: 1001,
        points: [{ year: 2026, month: 6, revenue: 250 }],
      });

      const revenue = (yield* repo.listRevenueRows()).filter((row) => row.appId === 1001);
      assert.deepStrictEqual(
        revenue.map(({ year, month, revenue }) => ({ year, month, revenue })),
        [{ year: 2026, month: 6, revenue: 250 }],
      );
    }),
  );

  it.effect("replaceScreens is idempotent and marks the video as fetched", () =>
    Effect.gen(function* () {
      const repo = yield* AppFactoryRepository;
      yield* repo.upsertApp(appUpsert());
      yield* repo.upsertVideo({
        videoId: 501,
        appId: 1001,
        slug: "demo-video",
        label: "Jul 2026",
        videoUrl: "https://player.mediadelivery.net/embed/x/y",
        blurStartsAt: 26.0,
        appVersion: "1.0",
        recordingDate: "2026-07-14",
        durationSeconds: 60,
        fetchedAt: NOW,
      });

      const screens = [
        {
          screenId: 9001,
          screenUrl: "https://media.screensdesign.com/avs-pp/a.webp",
          timestamp: 1.4,
          isBlurry: false,
          labels: ["onboarding"],
        },
      ];
      yield* repo.replaceScreens({ videoId: 501, fetchedAt: NOW, screens });
      yield* repo.replaceScreens({ videoId: 501, fetchedAt: LATER, screens });

      const rows = yield* repo.listScreenRows(501);
      assert.strictEqual(rows.length, 1);
      assert.deepStrictEqual(rows[0]?.labels, ["onboarding"]);

      const video = (yield* repo.listVideoRows(1001))[0];
      assert.isTrue(video?.screensFetched);
    }),
  );

  it.effect("watchlist: double pin is a no-op, note requires pin, unpin deletes the row", () =>
    Effect.gen(function* () {
      const repo = yield* AppFactoryRepository;
      yield* repo.upsertApp(appUpsert({ appId: 2001, slug: "pin-target" }));

      // Note before pin → domain error.
      const noteError = yield* Effect.flip(repo.setNote(2001, "interesting"));
      assert.instanceOf(noteError, AppFactoryNoteWithoutPinError);

      // Unpin when not pinned → no-op, no error.
      yield* repo.setPinned(2001, false, NOW);

      yield* repo.setPinned(2001, true, NOW);
      yield* repo.setNote(2001, "clone this");
      const pinnedRow = yield* repo.getAppRow(2001);
      assert.isTrue(pinnedRow?.isPinned);
      assert.strictEqual(pinnedRow?.note, "clone this");

      // Empty note clears but keeps the pin.
      yield* repo.setNote(2001, "");
      assert.isNull((yield* repo.getAppRow(2001))?.note);
      assert.isTrue((yield* repo.getAppRow(2001))?.isPinned);

      yield* repo.setNote(2001, "clone this");
      yield* repo.setPinned(2001, false, NOW);
      const unpinnedRow = yield* repo.getAppRow(2001);
      assert.isFalse(unpinnedRow?.isPinned);
      assert.isNull(unpinnedRow?.note);
    }),
  );

  it.effect("markAppsRemovedExcept only marks absent apps and preserves revenue", () =>
    Effect.gen(function* () {
      const repo = yield* AppFactoryRepository;
      yield* repo.upsertApp(appUpsert({ appId: 3001, slug: "stays" }));
      yield* repo.upsertApp(appUpsert({ appId: 3002, slug: "vanishes" }));
      yield* repo.replaceRevenue({
        appId: 3002,
        points: [{ year: 2026, month: 1, revenue: 50 }],
      });

      yield* repo.markAppsRemovedExcept([3001], LATER);

      assert.isNull((yield* repo.getAppRow(3001))?.removedAt);
      assert.strictEqual((yield* repo.getAppRow(3002))?.removedAt, LATER);
      // Revenue history survives removal.
      const revenue = (yield* repo.listRevenueRows()).filter((row) => row.appId === 3002);
      assert.strictEqual(revenue.length, 1);
      // Rows are still listed (UI decides how to present removed apps).
      const ids = (yield* repo.listAppRows()).map((row) => row.appId);
      assert.includeMembers(ids, [3001, 3002]);
    }),
  );

  it.effect("getMaxAppId tracks the highest synced catalog id", () =>
    Effect.gen(function* () {
      const repo = yield* AppFactoryRepository;
      yield* repo.upsertApp(appUpsert({ appId: 4242 }));
      assert.strictEqual(yield* repo.getMaxAppId(), 4242);
    }),
  );

  it.effect("sync runs: progress, finish, newest-first, crash interruption + resume lookup", () =>
    Effect.gen(function* () {
      const repo = yield* AppFactoryRepository;

      const firstRun = yield* repo.startSyncRun("full", null, NOW);
      yield* repo.updateSyncRunProgress(firstRun, "https://x/page=4", 18, 2621);
      yield* repo.finishSyncRun(firstRun, "completed", LATER, null);

      const secondRun = yield* repo.startSyncRun("incremental", null, LATER);
      yield* repo.finishSyncRun(secondRun, "completed", LATER, null);

      const ordered = yield* repo.listSyncRuns(10);
      assert.deepStrictEqual(
        ordered.map((run) => run.runId),
        [secondRun, firstRun],
      );
      assert.strictEqual(ordered[1]?.appsUpserted, 18);
      assert.strictEqual(ordered[1]?.totalApps, 2621);

      // A crash leaves a `running` row; startup marks it interrupted and it
      // becomes the resume seed for the next run of the same mode.
      const crashedRun = yield* repo.startSyncRun("full", "https://x/page=9", LATER);
      yield* repo.markRunningSyncRunsInterrupted(LATER);

      const latestFull = yield* repo.getLatestSyncRunForMode("full");
      assert.strictEqual(latestFull?.runId, crashedRun);
      assert.strictEqual(latestFull?.cursor, "https://x/page=9");
      assert.strictEqual(latestFull?.status, "interrupted");

      // The completed incremental run is untouched by the interruption sweep.
      const latestIncremental = yield* repo.getLatestSyncRunForMode("incremental");
      assert.strictEqual(latestIncremental?.runId, secondRun);
      assert.strictEqual(latestIncremental?.status, "completed");

      const latest = yield* repo.getLatestSyncRun();
      assert.strictEqual(latest?.runId, crashedRun);
    }),
  );

  it.effect("state KV round-trips and deletes", () =>
    Effect.gen(function* () {
      const repo = yield* AppFactoryRepository;
      yield* repo.setStateValue("account.email", "dev@example.com");
      assert.strictEqual(yield* repo.getStateValue("account.email"), "dev@example.com");
      yield* repo.setStateValue("account.email", "other@example.com");
      assert.strictEqual(yield* repo.getStateValue("account.email"), "other@example.com");
      yield* repo.deleteStateValue("account.email");
      assert.isNull(yield* repo.getStateValue("account.email"));
    }),
  );
});

// Isolated layer: the shared in-memory database above is intentionally reused
// across cases, so empty-catalog behavior needs its own database.
const freshLayer = it.layer(
  AppFactoryRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

freshLayer("AppFactoryRepository (empty catalog)", (it) => {
  it.effect("getMaxAppId returns 0 and missing lookups return null", () =>
    Effect.gen(function* () {
      const repo = yield* AppFactoryRepository;
      assert.strictEqual(yield* repo.getMaxAppId(), 0);
      assert.isNull(yield* repo.getAppRow(9999));
      assert.isNull(yield* repo.getStateValue("account.email"));
      assert.isNull(yield* repo.getLatestSyncRun());
      assert.isNull(yield* repo.getLatestSyncRunForMode("full"));
      const counts = yield* repo.counts();
      assert.deepStrictEqual(counts, { apps: 0, videos: 0, screens: 0, pinned: 0 });
    }),
  );
});
