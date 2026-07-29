// FILE: proofArtifacts.ts
// Purpose: Server route layer for proof-of-work artifacts (P5 web UI bridge).
// Layer: Server HTTP
// Exports: GET /api/proof/sessions, GET /api/proof/file
// Depends on: effect, @effect/platform-node/Mime, proofManifests, auth, config, startupAccess

import Mime from "@effect/platform-node/Mime";
import { Effect, FileSystem, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { authErrorResponse, makeEffectAuthRequest } from "./auth/effectHttp";
import { ServerAuth } from "./auth/Services/ServerAuth";
import { ServerConfig, type ServerConfigShape } from "./config";
import { isLoopbackHost } from "./startupAccess";
import { readProofManifests, resolveAllowedProofFile } from "./proofManifests.ts";

export const PROOF_SESSIONS_ROUTE_PATH = "/api/proof/sessions";
export const PROOF_FILE_ROUTE_PATH = "/api/proof/file";

function isLegacyTokenAuthorized(input: {
  readonly config: ServerConfigShape;
  readonly url: URL;
}): boolean {
  if (!isLoopbackHost(input.config.host) || input.config.publicUrl) {
    return false;
  }
  const legacyToken = input.url.searchParams.get("token");
  return !input.config.authToken || legacyToken === input.config.authToken;
}

const requireAuthenticatedRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  yield* serverAuth.authenticateHttpRequest(makeEffectAuthRequest(request));
});

export const proofSessionsEffectRouteLayer = HttpRouter.add(
  "GET",
  PROOF_SESSIONS_ROUTE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });

    const config = yield* ServerConfig;
    if (!isLegacyTokenAuthorized({ config, url })) {
      yield* requireAuthenticatedRequest;
    }

    const cwd = url.searchParams.get("cwd");
    const sessions = yield* Effect.promise(() =>
      readProofManifests({ cwd }).catch(() => [] as const as readonly unknown[]),
    );
    return HttpServerResponse.jsonUnsafe({ sessions });
  }).pipe(Effect.catchTag("AuthError", (error) => Effect.succeed(authErrorResponse(error)))),
);

export const proofFileEffectRouteLayer = HttpRouter.add(
  "GET",
  PROOF_FILE_ROUTE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });

    const config = yield* ServerConfig;
    if (!isLegacyTokenAuthorized({ config, url })) {
      yield* requireAuthenticatedRequest;
    }

    const proofFile = yield* Effect.promise(() =>
      resolveAllowedProofFile({
        requestedPath: url.searchParams.get("path"),
        cwd: url.searchParams.get("cwd"),
      }).catch(() => null),
    );
    if (!proofFile) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    return HttpServerResponse.stream(fileSystem.stream(proofFile.path), {
      status: 200,
      contentType: Mime.getType(proofFile.path) ?? "application/octet-stream",
      contentLength: proofFile.sizeBytes,
      headers: {
        "Cache-Control": "private, max-age=60",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }).pipe(Effect.catchTag("AuthError", (error) => Effect.succeed(authErrorResponse(error)))),
);

export const proofArtifactsEffectRouteLayer = Layer.merge(
  proofSessionsEffectRouteLayer,
  proofFileEffectRouteLayer,
);
