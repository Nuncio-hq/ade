import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import type { FetchJsonResult } from "../providerUsage/http.ts";
import {
  makeScreensdesignClient,
  type ScreensdesignClientDeps,
} from "./Layers/ScreensdesignClient.ts";
import {
  ScreensdesignProGatedError,
  ScreensdesignRateLimitedError,
  ScreensdesignRequestError,
  ScreensdesignTokenInvalidError,
  ScreensdesignTokenMissingError,
} from "./Services/ScreensdesignClient.ts";
import {
  SdAppsPage,
  SdAppDetail,
  SdMe,
  SdScreensPage,
  SdVideosPage,
  toAccount,
  toAppUpsert,
  toRevenuePoints,
  toScreenRows,
  toVideoUpsert,
} from "./screensdesignApi.ts";

import appDetail1796 from "./fixtures/app-detail-1796.json";
import appsPage1 from "./fixtures/apps-page1.json";
import appvideos2688 from "./fixtures/appvideos-2688.json";
import appvideoscreens3665 from "./fixtures/appvideoscreens-3665.json";
import meFixture from "./fixtures/me.json";

// ── Mapping tests against real probed payloads (2026-07-28) ──────────

describe("screensdesignApi mapping (real fixtures)", () => {
  it("decodes the catalog page and coerces string numbers", () => {
    const page = Schema.decodeUnknownSync(SdAppsPage)(appsPage1);
    assert.strictEqual(page.count, 2621);
    assert.strictEqual(page.results.length, 6);
    assert.strictEqual(page.next, "https://api.screensdesign.com/v1/apps/?page=2");

    const first = page.results[0]!;
    assert.strictEqual(first.id, 2688);
    assert.strictEqual(first.rating_value, 4.8);
    assert.strictEqual(typeof first.rating_value, "number");
  });

  it("maps a list item to an upsert row", () => {
    const page = Schema.decodeUnknownSync(SdAppsPage)(appsPage1);
    const row = toAppUpsert(page.results[0]!, "2026-07-28T04:00:00.000Z");
    assert.strictEqual(row.appId, 2688);
    assert.strictEqual(row.developerName, "Gabriel Jacobson");
    assert.strictEqual(row.paywallType, "Free Trial - Soft Paywall");
    assert.strictEqual(row.onboardingStepCount, 6);
    assert.isNull(row.hasOnboardingWithQuiz);
    assert.strictEqual(row.revenue, 45000);
    assert.strictEqual(row.ratingValue, 4.8);
  });

  it("decodes app detail with category object and numeric store_id", () => {
    const detail = Schema.decodeUnknownSync(SdAppDetail)(appDetail1796);
    const row = toAppUpsert(detail, "2026-07-28T04:00:00.000Z");
    assert.strictEqual(row.categoryPrimary, "PRODUCTIVITY");
    assert.strictEqual(row.storeId, "1671071139");
    assert.strictEqual(row.appstoreLink, "https://apps.apple.com/us/app/id1671071139");
    assert.isNull(row.latestAppobvideoId);
    assert.strictEqual(row.hasOnboardingWithQuiz, false);
    assert.strictEqual(row.onboardingStepCount, 0);
  });

  it("preserves revenue months as-is (sparse, zero, order untouched)", () => {
    const detail = Schema.decodeUnknownSync(SdAppDetail)(appDetail1796);
    const points = toRevenuePoints(detail);
    assert.deepStrictEqual(
      points.map((p) => `${p.year}-${p.month}:${p.revenue}`),
      ["2026-2:0", "2026-1:0", "2025-12:6000", "2025-11:6000", "2025-10:6000", "2025-9:11000"],
    );
  });

  it("decodes videos with version, blur boundary and duration", () => {
    const page = Schema.decodeUnknownSync(SdVideosPage)(appvideos2688);
    assert.isNull(page.next);
    const row = toVideoUpsert(page.results[0]!, 2688, "2026-07-28T04:00:00.000Z");
    assert.strictEqual(row.videoId, 3665);
    assert.strictEqual(row.blurStartsAt, 26.0);
    assert.strictEqual(row.appVersion, "1.15");
    assert.strictEqual(row.recordingDate, "2026-07-14");
    assert.strictEqual(row.durationSeconds, 502);
  });

  it("decodes screens with coerced timestamps and labels", () => {
    const page = Schema.decodeUnknownSync(SdScreensPage)(appvideoscreens3665);
    assert.strictEqual(page.count, 75);
    assert.strictEqual(
      page.next,
      "https://api.screensdesign.com/v1/appvideoscreens/?app_video=3665&page=2",
    );
    const rows = toScreenRows(page.results);
    assert.strictEqual(rows[0]?.screenId, 322159);
    assert.strictEqual(rows[0]?.timestamp, 1.4);
    assert.deepStrictEqual(rows[0]?.labels, ["onboarding"]);
    assert.isFalse(rows[0]?.isBlurry);
    const blurry = rows.find((row) => row.isBlurry);
    assert.isDefined(blurry);
  });

  it("extracts account info from /v1/me/ organizations", () => {
    const me = Schema.decodeUnknownSync(SdMe)(meFixture);
    const account = toAccount(me);
    assert.strictEqual(account.email, "dev@example.com");
    assert.strictEqual(account.isPro, false);
    assert.strictEqual(account.subscriptionProductName, "Pro");
    assert.strictEqual(account.subscriptionStatus, "incomplete_expired");
  });
});

// ── Client behavior tests with a fake transport ──────────────────────

function jsonResult(
  status: number,
  json: unknown,
  headers?: Record<string, string>,
): FetchJsonResult {
  return {
    status,
    ok: status >= 200 && status < 300,
    json,
    headers: new Headers(headers),
  };
}

function makeDeps(overrides: Partial<ScreensdesignClientDeps> = {}) {
  const slept: number[] = [];
  const calls: string[] = [];
  const deps: ScreensdesignClientDeps = {
    getToken: Effect.succeed("test-token"),
    fetchJson: ({ url }) => {
      calls.push(url);
      return Promise.resolve(jsonResult(200, { count: 0, next: null, results: [] }));
    },
    sleep: (ms) =>
      Effect.sync(() => {
        slept.push(ms);
      }),
    ...overrides,
  };
  return { deps, slept, calls };
}

describe("ScreensdesignClient", () => {
  it.effect("fails with TokenMissing when no token is stored", () => {
    const { deps } = makeDeps({ getToken: Effect.succeed(null) });
    const client = makeScreensdesignClient(deps);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(client.fetchAppsPage(null));
      assert.instanceOf(error, ScreensdesignTokenMissingError);
    });
  });

  it.effect("maps 401 to TokenInvalid without retrying", () => {
    let calls = 0;
    const { deps } = makeDeps({
      fetchJson: () => {
        calls += 1;
        return Promise.resolve(jsonResult(401, { detail: "Invalid token." }));
      },
    });
    const client = makeScreensdesignClient(deps);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(client.fetchAppsPage(null));
      assert.instanceOf(error, ScreensdesignTokenInvalidError);
      assert.strictEqual(calls, 1);
    });
  });

  it.effect("maps 403 to ProGated (distinct from token failure)", () => {
    const { deps } = makeDeps({
      fetchJson: () => Promise.resolve(jsonResult(403, { detail: "Upgrade to Pro." })),
    });
    const client = makeScreensdesignClient(deps);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(client.fetchAppsPage(null));
      assert.instanceOf(error, ScreensdesignProGatedError);
    });
  });

  it.effect("honors Retry-After on 429 and succeeds within the retry budget", () => {
    const { deps, slept } = makeDeps({
      fetchJson: (() => {
        let attempt = 0;
        return () => {
          attempt += 1;
          return Promise.resolve(
            attempt < 3
              ? jsonResult(429, null, { "retry-after": "2" })
              : jsonResult(200, { count: 1, next: null, results: [] }),
          );
        };
      })(),
    });
    const client = makeScreensdesignClient(deps);
    return Effect.gen(function* () {
      const page = yield* client.fetchAppsPage(null);
      assert.strictEqual(page.count, 1);
      assert.deepStrictEqual(slept, [2000, 2000]);
    });
  });

  it.effect("fails with RateLimited after the bounded attempts", () => {
    let calls = 0;
    const { deps, slept } = makeDeps({
      fetchJson: () => {
        calls += 1;
        return Promise.resolve(jsonResult(429, null));
      },
    });
    const client = makeScreensdesignClient(deps);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(client.fetchAppsPage(null));
      assert.instanceOf(error, ScreensdesignRateLimitedError);
      assert.strictEqual(calls, 3);
      assert.strictEqual(slept.length, 2);
    });
  });

  it.effect("maps 404 on app detail to null (app vanished upstream)", () => {
    const { deps } = makeDeps({
      fetchJson: () => Promise.resolve(jsonResult(404, { detail: "Not found." })),
    });
    const client = makeScreensdesignClient(deps);
    return Effect.gen(function* () {
      assert.isNull(yield* client.fetchAppDetail(999999));
    });
  });

  it.effect("treats an HTML error page (non-JSON) as RequestError, never as data", () => {
    const { deps } = makeDeps({
      fetchJson: () => Promise.resolve(jsonResult(200, null)),
    });
    const client = makeScreensdesignClient(deps);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(client.fetchAppsPage(null));
      assert.instanceOf(error, ScreensdesignRequestError);
    });
  });

  it.effect("treats a malformed payload shape as RequestError with context", () => {
    const { deps } = makeDeps({
      fetchJson: () => Promise.resolve(jsonResult(200, { unexpected: true })),
    });
    const client = makeScreensdesignClient(deps);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(client.fetchAppsPage(null));
      assert.instanceOf(error, ScreensdesignRequestError);
      assert.match(error.detail, /apps page/i);
    });
  });

  it.effect("treats transport failures as RequestError", () => {
    const { deps } = makeDeps({
      fetchJson: () => Promise.reject(new Error("socket hangup")),
    });
    const client = makeScreensdesignClient(deps);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(client.fetchVideosPage(2688, null));
      assert.instanceOf(error, ScreensdesignRequestError);
      assert.match(error.detail, /socket hangup/);
    });
  });

  it.effect("requests the first page when nextUrl is null, then follows absolute next URLs", () => {
    const { deps, calls } = makeDeps();
    const client = makeScreensdesignClient(deps);
    return Effect.gen(function* () {
      yield* client.fetchAppsPage(null);
      yield* client.fetchAppsPage("https://api.screensdesign.com/v1/apps/?page=2");
      yield* client.fetchScreensPage(3665, null);
      assert.deepStrictEqual(calls, [
        "https://api.screensdesign.com/v1/apps/",
        "https://api.screensdesign.com/v1/apps/?page=2",
        "https://api.screensdesign.com/v1/appvideoscreens/?app_video=3665",
      ]);
    });
  });
});
