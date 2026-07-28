/**
 * Thin typed client over the screensdesign REST API.
 *
 * Error taxonomy is deliberate: 401 (token invalid), 403 (Pro-gated filter),
 * 429 (rate limited after bounded retry), 404 (entity vanished upstream) and
 * everything else (network, non-JSON, unexpected payload) each get a distinct
 * failure so the sync layer can react differently to each.
 */
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type {
  SdAccount,
  SdAppDetail,
  SdAppListItem,
  SdPage,
  SdScreen,
  SdVideo,
} from "../screensdesignApi.ts";

export class ScreensdesignTokenMissingError extends Schema.TaggedErrorClass<ScreensdesignTokenMissingError>()(
  "ScreensdesignTokenMissingError",
  {},
) {
  override get message(): string {
    return "ScreensDesign token is not configured.";
  }
}

export class ScreensdesignTokenInvalidError extends Schema.TaggedErrorClass<ScreensdesignTokenInvalidError>()(
  "ScreensdesignTokenInvalidError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `ScreensDesign rejected the token: ${this.detail}`;
  }
}

export class ScreensdesignProGatedError extends Schema.TaggedErrorClass<ScreensdesignProGatedError>()(
  "ScreensdesignProGatedError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `ScreensDesign feature requires a Pro plan: ${this.detail}`;
  }
}

export class ScreensdesignRateLimitedError extends Schema.TaggedErrorClass<ScreensdesignRateLimitedError>()(
  "ScreensdesignRateLimitedError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `ScreensDesign rate limit persisted after retries: ${this.detail}`;
  }
}

export class ScreensdesignNotFoundError extends Schema.TaggedErrorClass<ScreensdesignNotFoundError>()(
  "ScreensdesignNotFoundError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `ScreensDesign resource not found: ${this.detail}`;
  }
}

export class ScreensdesignRequestError extends Schema.TaggedErrorClass<ScreensdesignRequestError>()(
  "ScreensdesignRequestError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `ScreensDesign request failed: ${this.detail}`;
  }
}

export type ScreensdesignClientError =
  | ScreensdesignTokenMissingError
  | ScreensdesignTokenInvalidError
  | ScreensdesignProGatedError
  | ScreensdesignRateLimitedError
  | ScreensdesignNotFoundError
  | ScreensdesignRequestError;

export interface ScreensdesignClientShape {
  readonly me: () => Effect.Effect<SdAccount, ScreensdesignClientError>;

  /** `nextUrl: null` fetches the first page; subsequent pages follow the API's absolute `next` URLs. */
  readonly fetchAppsPage: (
    nextUrl: string | null,
  ) => Effect.Effect<SdPage<SdAppListItem>, ScreensdesignClientError>;

  /** Returns null when the app vanished upstream (404). */
  readonly fetchAppDetail: (
    appId: number,
  ) => Effect.Effect<SdAppDetail | null, ScreensdesignClientError>;

  readonly fetchVideosPage: (
    appId: number,
    nextUrl: string | null,
  ) => Effect.Effect<SdPage<SdVideo>, ScreensdesignClientError>;

  readonly fetchScreensPage: (
    appVideoId: number,
    nextUrl: string | null,
  ) => Effect.Effect<SdPage<SdScreen>, ScreensdesignClientError>;
}

export class ScreensdesignClient extends ServiceMap.Service<
  ScreensdesignClient,
  ScreensdesignClientShape
>()("nuncioade/appFactory/Services/ScreensdesignClient") {}
