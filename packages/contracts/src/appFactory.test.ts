import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  AppFactoryAppDetail,
  AppFactoryAppNotFoundError,
  AppFactoryAppSummary,
  AppFactoryListAppsResult,
  AppFactoryScreen,
  AppFactorySetNoteInput,
  AppFactoryStatus,
  AppFactorySyncInProgressError,
  AppFactorySyncRun,
  AppFactoryTokenInvalidError,
  AppFactoryVideo,
} from "./appFactory";

// Samples mirror real screensdesign payloads probed 2026-07-28
// (apps 2688 "Scroll The Bible" and 1796 "AI Chatbot", video 3665), after
// server-side mapping: snake_case → camelCase, string numbers → numbers.

const decodeSummary = Schema.decodeUnknownSync(AppFactoryAppSummary);
const decodeDetail = Schema.decodeUnknownSync(AppFactoryAppDetail);
const decodeScreen = Schema.decodeUnknownSync(AppFactoryScreen);
const decodeVideo = Schema.decodeUnknownSync(AppFactoryVideo);
const decodeStatus = Schema.decodeUnknownSync(AppFactoryStatus);
const decodeSyncRun = Schema.decodeUnknownSync(AppFactorySyncRun);

function summarySample() {
  return {
    appId: 2688,
    slug: "scroll-the-bible",
    name: "Scroll The Bible",
    shortname: "Swipe Through Scripture",
    iconUrl: "https://media.screensdesign.com/appicon-thumbs/65ca009be6264dd590e9fa1bdce5645e.webp",
    developerName: "Gabriel Jacobson",
    categoryPrimary: "PRODUCTIVITY",
    revenue: 45000,
    downloads: 45000,
    ratingValue: 4.8,
    advertised: false,
    featured: false,
    released: "2025-12-17",
    updated: "2026-07-15",
    paywallType: "Free Trial - Soft Paywall",
    onboardingStepCount: 6,
    hasOnboardingWithQuiz: null,
    latestAppvideoId: 3665,
    revenueList: [{ year: 2026, month: 6, revenue: 40000 }],
    isPinned: false,
    note: null,
    fetchedAt: "2026-07-28T04:00:00.000Z",
    removedAt: null,
  };
}

describe("AppFactory contracts", () => {
  it("decodes an app summary including revenue history", () => {
    const decoded = decodeSummary(summarySample());
    expect(decoded.appId).toBe(2688);
    expect(decoded.revenueList).toEqual([{ year: 2026, month: 6, revenue: 40000 }]);
    expect(decoded.ratingValue).toBe(4.8);
  });

  it("preserves null fields from sparse upstream payloads", () => {
    const decoded = decodeSummary({
      ...summarySample(),
      shortname: null,
      iconUrl: null,
      developerName: null,
      categoryPrimary: null,
      ratingValue: null,
      released: null,
      updated: null,
      paywallType: null,
      onboardingStepCount: null,
      latestAppvideoId: null,
      revenueList: [],
    });
    expect(decoded.revenueList).toEqual([]);
    expect(decoded.paywallType).toBeNull();
  });

  it("rejects non-positive app ids", () => {
    expect(() => decodeSummary({ ...summarySample(), appId: 0 })).toThrow();
    expect(() => decodeSummary({ ...summarySample(), appId: -3 })).toThrow();
  });

  it("decodes a screen frame with labels", () => {
    const decoded = decodeScreen({
      screenId: 322159,
      screenUrl: "https://media.screensdesign.com/avs-pp/70e72c16a8d94ea589df446710e40eef.webp",
      timestamp: 1.4,
      isBlurry: false,
      labels: ["onboarding"],
    });
    expect(decoded.labels).toEqual(["onboarding"]);
    expect(decoded.timestamp).toBe(1.4);
  });

  it("decodes a video whose screens have not been fetched yet", () => {
    const decoded = decodeVideo({
      videoId: 3665,
      slug: "scroll-the-bible-video-3665",
      label: "Jul 2026",
      videoUrl:
        "https://player.mediadelivery.net/embed/624624/cfbe281e-ef1a-43b8-b851-d5dbf8e4aa0f",
      blurStartsAt: 26.0,
      appVersion: "1.15",
      recordingDate: "2026-07-14",
      durationSeconds: 502,
      screens: null,
    });
    expect(decoded.screens).toBeNull();
  });

  it("decodes an app detail with videos", () => {
    const decoded = decodeDetail({
      ...summarySample(),
      description: "Read scripture by scrolling.",
      appstoreLink: "https://apps.apple.com/us/app/id1671071139",
      storeId: "1671071139",
      videos: [
        {
          videoId: 3665,
          slug: "scroll-the-bible-video-3665",
          label: "Jul 2026",
          videoUrl:
            "https://player.mediadelivery.net/embed/624624/cfbe281e-ef1a-43b8-b851-d5dbf8e4aa0f",
          blurStartsAt: 26.0,
          appVersion: "1.15",
          recordingDate: "2026-07-14",
          durationSeconds: 502,
          screens: [],
        },
      ],
    });
    expect(decoded.videos).toHaveLength(1);
    expect(decoded.storeId).toBe("1671071139");
  });

  it("decodes sync runs in every terminal status", () => {
    const base = {
      runId: 3,
      mode: "full",
      startedAt: "2026-07-28T04:00:00.000Z",
      finishedAt: null,
      cursor: "https://api.screensdesign.com/v1/apps/?page=4",
      appsUpserted: 18,
      totalApps: 2621,
      error: null,
    };
    for (const status of ["running", "completed", "failed", "interrupted", "token_invalid"]) {
      expect(decodeSyncRun({ ...base, status }).status).toBe(status);
    }
  });

  it("decodes a full status payload", () => {
    const decoded = decodeStatus({
      tokenConfigured: true,
      accountEmail: "dev@example.com",
      accountIsPro: false,
      appCount: 2621,
      videoCount: 1400,
      screenCount: 8000,
      pinnedCount: 2,
      lastSync: null,
      sync: {
        running: false,
        mode: null,
        startedAt: null,
        pagesFetched: 0,
        appsUpserted: 0,
        totalApps: null,
        resumeAvailable: false,
      },
    });
    expect(decoded.sync.running).toBe(false);
  });

  it("decodes list results and note input with empty note (clears note)", () => {
    expect(Schema.decodeUnknownSync(AppFactoryListAppsResult)({ apps: [] }).apps).toEqual([]);
    expect(Schema.decodeUnknownSync(AppFactorySetNoteInput)({ appId: 1, note: "" }).note).toBe("");
  });

  it("exposes readable error messages", () => {
    expect(new AppFactoryTokenInvalidError({ detail: "HTTP 401" }).message).toContain("401");
    expect(
      new AppFactorySyncInProgressError({ startedAt: "2026-07-28T04:00:00.000Z" }).message,
    ).toContain("already running");
    expect(new AppFactoryAppNotFoundError({ appId: 7 }).message).toContain("7");
  });
});
