/**
 * Upstream screensdesign wire schemas and pure mapping into App Factory shapes.
 *
 * Schemas are intentionally lenient: unknown keys are ignored and sparse fields
 * fall back to null/empty so a catalog sync never dies on one unusual row.
 * Field quirks observed on the live API (2026-07-28): `rating_value` and screen
 * `timestamp` are serialized as strings; `store_id` is numeric; `next` is an
 * absolute URL or null.
 */
import { Schema } from "effect";

import type {
  AppFactoryAppUpsert,
  AppFactoryVideoUpsert,
} from "../persistence/Services/AppFactoryRepository.ts";

const CoercedNumber = Schema.Union([Schema.Number, Schema.NumberFromString]);

export const SdDeveloper = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  slug: Schema.optional(Schema.NullOr(Schema.String)),
});
export type SdDeveloper = typeof SdDeveloper.Type;

export const SdAvs = Schema.Struct({
  id: Schema.Number,
  url: Schema.optional(Schema.NullOr(Schema.String)),
  screens: Schema.optional(Schema.Array(Schema.Unknown)),
  paywall_type: Schema.optional(Schema.NullOr(Schema.String)),
  onboarding_step_count: Schema.optional(Schema.NullOr(Schema.Number)),
  has_onboarding_with_quiz: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export type SdAvs = typeof SdAvs.Type;

export const SdRevenuePoint = Schema.Struct({
  year: Schema.Number,
  month: Schema.Number,
  revenue: Schema.Number,
});
export type SdRevenuePoint = typeof SdRevenuePoint.Type;

const sdAppCoreFields = {
  id: Schema.Number,
  slug: Schema.String,
  name: Schema.String,
  shortname: Schema.optional(Schema.NullOr(Schema.String)),
  icon: Schema.optional(Schema.NullOr(Schema.String)),
  developer: Schema.optional(Schema.NullOr(SdDeveloper)),
  avs: Schema.optional(Schema.NullOr(SdAvs)),
  revenue: Schema.optional(Schema.NullOr(Schema.Number)),
  revenue_list: Schema.optional(Schema.Array(SdRevenuePoint)),
  downloads: Schema.optional(Schema.NullOr(Schema.Number)),
  rating_value: Schema.optional(Schema.NullOr(CoercedNumber)),
  advertised: Schema.optional(Schema.NullOr(Schema.Boolean)),
  released: Schema.optional(Schema.NullOr(Schema.String)),
  updated: Schema.optional(Schema.NullOr(Schema.String)),
  featured: Schema.optional(Schema.NullOr(Schema.Boolean)),
  latest_appvideo_id: Schema.optional(Schema.NullOr(Schema.Number)),
} as const;

export const SdAppListItem = Schema.Struct(sdAppCoreFields);
export type SdAppListItem = typeof SdAppListItem.Type;

export const SdCategory = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
});

export const SdAppDetail = Schema.Struct({
  ...sdAppCoreFields,
  appstore_link: Schema.optional(Schema.NullOr(Schema.String)),
  category_primary: Schema.optional(Schema.NullOr(SdCategory)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  store_id: Schema.optional(Schema.NullOr(CoercedNumber)),
  latest_appobvideo_id: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type SdAppDetail = typeof SdAppDetail.Type;

export const SdVideo = Schema.Struct({
  id: Schema.Number,
  slug: Schema.String,
  label: Schema.optional(Schema.NullOr(Schema.String)),
  video: Schema.String,
  blur_starts_at: Schema.optional(Schema.NullOr(Schema.Number)),
  app_version: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        version: Schema.String,
      }),
    ),
  ),
  recording_date: Schema.optional(Schema.NullOr(Schema.String)),
  duration_seconds: Schema.optional(Schema.NullOr(CoercedNumber)),
});
export type SdVideo = typeof SdVideo.Type;

export const SdScreen = Schema.Struct({
  id: Schema.Number,
  screen: Schema.String,
  timestamp: CoercedNumber,
  is_blurry: Schema.optional(Schema.Boolean),
  labels: Schema.optional(Schema.Array(Schema.String)),
  app_video: Schema.optional(Schema.Number),
});
export type SdScreen = typeof SdScreen.Type;

export const SdOrganization = Schema.Struct({
  subscription_product_name: Schema.optional(Schema.NullOr(Schema.String)),
  subscription_status: Schema.optional(Schema.NullOr(Schema.String)),
  is_pro: Schema.optional(Schema.Boolean),
});

export const SdMe = Schema.Struct({
  email: Schema.optional(Schema.NullOr(Schema.String)),
  username: Schema.optional(Schema.NullOr(Schema.String)),
  organizations: Schema.optional(Schema.Array(SdOrganization)),
});
export type SdMe = typeof SdMe.Type;

export interface SdPage<out A> {
  readonly count: number;
  readonly next: string | null;
  readonly results: ReadonlyArray<A>;
}

const makePageSchema = <A, I, R>(item: Schema.Codec<A, I, R>) =>
  Schema.Struct({
    count: Schema.Number,
    next: Schema.NullOr(Schema.String),
    results: Schema.Array(item),
  });

export const SdAppsPage = makePageSchema(SdAppListItem);
export const SdVideosPage = makePageSchema(SdVideo);
export const SdScreensPage = makePageSchema(SdScreen);

export interface SdAccount {
  readonly email: string | null;
  readonly isPro: boolean | null;
  readonly subscriptionProductName: string | null;
  readonly subscriptionStatus: string | null;
}

// ── Mapping into repository/contract shapes ──────────────────────────

const toNonNegativeInt = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? 0
    : Math.max(0, Math.round(value));

export function toAppUpsert(
  item: SdAppListItem | SdAppDetail,
  fetchedAt: string,
): AppFactoryAppUpsert {
  const detail = item as SdAppDetail;
  return {
    appId: item.id,
    slug: item.slug,
    name: item.name,
    shortname: item.shortname ?? null,
    iconUrl: item.icon ?? null,
    developerName: item.developer?.name ?? null,
    developerSlug: item.developer?.slug ?? null,
    categoryPrimary: detail.category_primary?.name ?? null,
    description: detail.description ?? null,
    appstoreLink: detail.appstore_link ?? null,
    storeId:
      detail.store_id === null || detail.store_id === undefined ? null : String(detail.store_id),
    revenue: toNonNegativeInt(item.revenue),
    downloads: toNonNegativeInt(item.downloads),
    ratingValue: item.rating_value ?? null,
    advertised: item.advertised ?? false,
    featured: item.featured ?? false,
    released: item.released ?? null,
    updated: item.updated ?? null,
    paywallType: item.avs?.paywall_type ?? null,
    onboardingStepCount:
      item.avs?.onboarding_step_count === null || item.avs?.onboarding_step_count === undefined
        ? null
        : toNonNegativeInt(item.avs.onboarding_step_count),
    hasOnboardingWithQuiz: item.avs?.has_onboarding_with_quiz ?? null,
    latestAppvideoId: item.latest_appvideo_id ?? null,
    latestAppobvideoId: detail.latest_appobvideo_id ?? null,
    fetchedAt,
  };
}

export function toRevenuePoints(item: SdAppListItem | SdAppDetail) {
  return (item.revenue_list ?? []).map((point) => ({
    year: toNonNegativeInt(point.year),
    month: toNonNegativeInt(point.month),
    revenue: toNonNegativeInt(point.revenue),
  }));
}

export function toVideoUpsert(
  video: SdVideo,
  appId: number,
  fetchedAt: string,
): AppFactoryVideoUpsert {
  return {
    videoId: video.id,
    appId,
    slug: video.slug,
    label: video.label ?? null,
    videoUrl: video.video,
    blurStartsAt: video.blur_starts_at ?? null,
    appVersion: video.app_version?.version ?? null,
    recordingDate: video.recording_date ?? null,
    durationSeconds: video.duration_seconds ?? null,
    fetchedAt,
  };
}

export function toScreenRows(screens: ReadonlyArray<SdScreen>) {
  return screens.map((screen) => ({
    screenId: screen.id,
    screenUrl: screen.screen,
    timestamp: Math.max(0, screen.timestamp),
    isBlurry: screen.is_blurry ?? false,
    labels: screen.labels ?? [],
  }));
}

export function toAccount(me: SdMe): SdAccount {
  const organization = me.organizations?.[0];
  return {
    email: me.email ?? me.username ?? null,
    isPro: organization?.is_pro ?? null,
    subscriptionProductName: organization?.subscription_product_name ?? null,
    subscriptionStatus: organization?.subscription_status ?? null,
  };
}
