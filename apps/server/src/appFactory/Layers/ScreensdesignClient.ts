import { Effect, Layer, Schema, SchemaIssue } from "effect";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { fetchJson, parseRetryAfterMs, type FetchJsonResult } from "../../providerUsage/http.ts";
import {
  ScreensdesignClient,
  type ScreensdesignClientError,
  ScreensdesignNotFoundError,
  ScreensdesignProGatedError,
  ScreensdesignRateLimitedError,
  ScreensdesignRequestError,
  ScreensdesignTokenInvalidError,
  ScreensdesignTokenMissingError,
} from "../Services/ScreensdesignClient.ts";
import {
  SdAppsPage,
  SdAppDetail,
  SdMe,
  SdScreensPage,
  SdVideosPage,
  toAccount,
  type SdAccount,
} from "../screensdesignApi.ts";

export const SCREENDESIGN_API_ORIGIN = "https://api.screensdesign.com";
const API_BASE = `${SCREENDESIGN_API_ORIGIN}/v1`;

/** ServerSecretStore key holding the screensdesign bearer token. */
export const SCREENDESIGN_TOKEN_SECRET_NAME = "screensdesign.api-token";

const MAX_RATE_LIMIT_ATTEMPTS = 3;

export interface ScreensdesignClientDeps {
  readonly getToken: Effect.Effect<string | null, unknown>;
  readonly fetchJson: (input: {
    service: string;
    url: string;
    allowedOrigins: ReadonlyArray<string>;
    headers?: Record<string, string>;
    timeoutMs?: number;
  }) => Promise<FetchJsonResult>;
  readonly sleep: (ms: number) => Effect.Effect<void>;
}

const statusDetail = (result: FetchJsonResult): string => {
  if (result.json !== null && typeof result.json === "object" && "detail" in result.json) {
    const detail = (result.json as { readonly detail?: unknown }).detail;
    if (typeof detail === "string" && detail.length > 0) {
      return detail;
    }
  }
  return `HTTP ${result.status}`;
};

export const makeScreensdesignClient = (deps: ScreensdesignClientDeps) => {
  const withRateLimitRetry = (
    url: string,
    request: (token: string) => Promise<FetchJsonResult>,
  ): Effect.Effect<FetchJsonResult, ScreensdesignClientError> => {
    const attempt = (
      token: string,
      attemptNumber: number,
    ): Effect.Effect<FetchJsonResult, ScreensdesignClientError> =>
      Effect.tryPromise({
        try: () => request(token),
        catch: (cause) =>
          new ScreensdesignRequestError({
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
      }).pipe(
        Effect.flatMap((result) => {
          if (result.status !== 429) {
            return Effect.succeed(result);
          }
          if (attemptNumber >= MAX_RATE_LIMIT_ATTEMPTS) {
            return Effect.fail(new ScreensdesignRateLimitedError({ detail: statusDetail(result) }));
          }
          const delayMs = parseRetryAfterMs(result.headers, Date.now()) ?? attemptNumber * 1000;
          return Effect.flatMap(deps.sleep(delayMs), () => attempt(token, attemptNumber + 1));
        }),
      );
    return Effect.flatMap(deps.getToken, (token) =>
      token === null ? Effect.fail(new ScreensdesignTokenMissingError()) : attempt(token, 1),
    ).pipe(
      Effect.mapError(
        (cause): ScreensdesignClientError =>
          cause instanceof ScreensdesignRequestError ||
          cause instanceof ScreensdesignRateLimitedError ||
          cause instanceof ScreensdesignTokenMissingError
            ? cause
            : new ScreensdesignRequestError({ detail: String(cause) }),
      ),
    );
  };

  const request = (url: string): Effect.Effect<FetchJsonResult, ScreensdesignClientError> =>
    withRateLimitRetry(url, (token) =>
      deps.fetchJson({
        service: "screensdesign",
        url,
        allowedOrigins: [SCREENDESIGN_API_ORIGIN],
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: 20_000,
      }),
    );

  const decodeWith =
    <A>(schema: Schema.Decoder<A>, context: string) =>
    (result: FetchJsonResult): Effect.Effect<A, ScreensdesignClientError> => {
      if (result.status === 401) {
        return Effect.fail(new ScreensdesignTokenInvalidError({ detail: statusDetail(result) }));
      }
      if (result.status === 403) {
        return Effect.fail(new ScreensdesignProGatedError({ detail: statusDetail(result) }));
      }
      if (result.status === 404) {
        return Effect.fail(new ScreensdesignNotFoundError({ detail: statusDetail(result) }));
      }
      if (!result.ok) {
        return Effect.fail(
          new ScreensdesignRequestError({ detail: `${context}: ${statusDetail(result)}` }),
        );
      }
      if (result.json === null) {
        return Effect.fail(
          new ScreensdesignRequestError({
            detail: `${context}: response was not valid JSON (possible HTML error page)`,
          }),
        );
      }
      return Schema.decodeUnknownEffect(schema)(result.json).pipe(
        Effect.mapError(
          (error) =>
            new ScreensdesignRequestError({
              detail: `${context}: unexpected payload shape (${SchemaIssue.makeFormatterDefault()(error.issue)})`,
            }),
        ),
      );
    };

  return {
    me: (): Effect.Effect<SdAccount, ScreensdesignClientError> =>
      request(`${API_BASE}/me/`).pipe(
        Effect.flatMap(decodeWith(SdMe, "account info")),
        Effect.map(toAccount),
      ),

    fetchAppsPage: (nextUrl: string | null) =>
      request(nextUrl ?? `${API_BASE}/apps/`).pipe(
        Effect.flatMap(decodeWith(SdAppsPage, "apps page")),
      ),

    fetchAppDetail: (appId: number) =>
      request(`${API_BASE}/apps/${appId}/`).pipe(
        Effect.flatMap(decodeWith(SdAppDetail, "app detail")),
        Effect.map((detail) => detail),
        Effect.catch((error) =>
          error instanceof ScreensdesignNotFoundError ? Effect.succeed(null) : Effect.fail(error),
        ),
      ),

    fetchVideosPage: (appId: number, nextUrl: string | null) =>
      request(nextUrl ?? `${API_BASE}/appvideos/?app=${appId}`).pipe(
        Effect.flatMap(decodeWith(SdVideosPage, "videos page")),
      ),

    fetchScreensPage: (appVideoId: number, nextUrl: string | null) =>
      request(nextUrl ?? `${API_BASE}/appvideoscreens/?app_video=${appVideoId}`).pipe(
        Effect.flatMap(decodeWith(SdScreensPage, "screens page")),
      ),
  };
};

export const ScreensdesignClientLive = Layer.effect(
  ScreensdesignClient,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore;
    return makeScreensdesignClient({
      getToken: secrets.get(SCREENDESIGN_TOKEN_SECRET_NAME).pipe(
        Effect.map((value) => (value === null ? null : new TextDecoder().decode(value))),
        Effect.orElseSucceed(() => null),
      ),
      fetchJson,
      sleep: (ms) => Effect.sleep(ms),
    });
  }),
);
