# Phase 01 — Data layer: contracts + server module + sync + SQLite

## Context Links

- Overview: [plan.md](plan.md)
- Codebase templates: `pullRequests/{Services,Layers}/`,
  `persistence/Migrations/044_Automations.ts`,
  `auth/Services/ServerSecretStore.ts`, `packages/shared/src/outboundHttp.ts`,
  `apps/server/src/providerUsage/http.ts` (`fetchJson`)

## Overview

- Priority: first — everything else depends on it
- Status: pending
- Server-side foundation: contracts schemas, WS RPC methods, appFactory
  module, screensdesign client, catalog sync, SQLite tables, token storage

## Key Insights

- Catalog is small (~2,600+ apps and growing, ~263+ pages at probe time) →
  full mirror; filtering happens in local SQL, never through Pro-gated API
  params. Never hardcode the count anywhere in code/UI — always derive from
  DB or API `count`.
- Full re-sync is cheap (~263 requests, minutes at polite rate) → the
  "pull latest data" action is simply a full upsert pass; no per-row
  diffing needed. It catches both new apps and changed fields (revenue,
  downloads, rating, `updated`, new recordings).
- Revenue history is embedded in app payloads (`revenue_list`) — no extra
  calls needed during mirror.
- Screens metadata is per-video (`appvideoscreens?app_video=`) — fetch lazily
  on first detail view, then cache (not during bulk sync).
- Token in `ServerSecretStore` (0700/0600 files), same pattern as
  `ProviderCredentials`; web UI only learns "configured/not configured".

## Requirements

- Functional: configure token; test connection (`/v1/me/`); full mirror with
  progress + resume; **update latest data at 3 levels**: (a) auto incremental
  daily sync (new apps, stop at max local id), (b) manual full sync (upsert
  every row — new + changed), (c) per-app refresh re-fetching metadata +
  revenue + videos + screens; list apps (compact DTO, all rows); app detail
  incl. videos + screens (lazy-cached); watchlist pin/note; sync
  status/history.
- Non-functional: polite rate (~2-3 req/s), resumable after crash, 401 →
  surface token-expired state without wiping data, sync never blocks server.

## Architecture

```
contracts: appFactory.ts — AppSummary, RevenuePoint, AppDetail, AppVideo,
  AppScreen, SyncStatus, WatchlistEntry; WS_METHODS.appFactory*; Ws*Rpc in
  WsFeatureRpcGroup
server: appFactory/Services/AppFactoryService.ts (tag)
  appFactory/Layers/AppFactoryServiceLive.ts
  appFactory/ScreensdesignClient.ts (fetchJson + Bearer from ServerSecretStore)
  appFactory/CatalogSync.ts (full upsert + incremental + per-app refresh,
  progress events)
  persistence/Migrations/089_AppFactory.ts
  persistence/Services/AppFactoryRepository.ts (+ Layers)
```

### SQLite schema (migration 089)

```sql
af_apps(sd_id PK, store_id, slug, name, shortname, developer_name,
  category_name, icon_url, revenue, downloads, rating REAL, advertised INT,
  released, updated, paywall_type, onboarding_steps, has_quiz INT,
  latest_video_id, raw_json, fetched_at)
af_revenue_monthly(sd_id, year, month, revenue, PK(sd_id,year,month))
af_videos(sd_video_id PK, sd_id, label, video_url, blur_starts_at,
  app_version, whatsnew, recording_date, duration_s, fetched_at)
af_screens(sd_screen_id PK, sd_video_id, ts REAL, labels_json, image_url,
  is_blurry INT, fetched_at)
af_watchlist(sd_id PK, pinned_at, note)
af_sync_runs(id PK, kind, started_at, finished_at, rows, status, error)
```

### RPC surface

- `appFactory.setToken` / `appFactory.testToken` (→ `/v1/me/`) / `appFactory.getStatus`
- `appFactory.syncNow` (full|incremental) / `appFactory.syncStatus` (progress)
- `appFactory.refreshApp` (re-fetch one app + revenue + videos + screens)
- `appFactory.listApps` → all compact rows (client filters/sorts locally)
- `appFactory.getAppDetail` (app + revenue + videos + screens; lazy-fetch
  screens per video on miss, then cache)
- `appFactory.pinApp` / `appFactory.unpinApp` / `appFactory.setNote`

## Related Code Files

- Create: `packages/contracts/src/appFactory.ts`;
  `apps/server/src/appFactory/*` (6 files);
  `apps/server/src/persistence/Migrations/089_AppFactory.ts`;
  `apps/server/src/persistence/{Services,Layers}/AppFactoryRepository.ts`
- Modify: `packages/contracts/src/ws.ts`, `packages/contracts/src/rpc.ts`,
  `apps/server/src/serverLayers.ts`, `apps/server/src/wsRpc.ts`

## Test Plan (write BEFORE implementation)

Test files (Vitest, follow existing apps/server test conventions; run scoped
via `bun run test`):

- `packages/contracts/src/appFactory.test.ts` — schema decode round-trips
- `apps/server/src/appFactory/ScreensdesignClient.test.ts`
- `apps/server/src/appFactory/CatalogSync.test.ts`
- `apps/server/src/persistence/AppFactoryRepository.test.ts`

All from **real probed payloads** (fixtures captured 2026-07-28), not
imagined shapes.

### Edge cases — payload mapping (client + contracts)

| Case                                                                  | Expected                                         |
| --------------------------------------------------------------------- | ------------------------------------------------ |
| `rating_value: "4.50"` is a string                                    | decode to number 4.5                             |
| screen `timestamp: "3.066"` is a string                               | decode to number 3.066                           |
| `revenue_list: []`, sparse months, future months                      | preserved as-is, no crash                        |
| `avs.screens: []`, `latest_appobvideo_id: null`, `url: null`          | nulls preserved                                  |
| 401                                                                   | `TokenInvalid` error, no retry                   |
| 403 (Pro-gated param)                                                 | distinct `ProGated` error                        |
| 429 with `Retry-After`                                                | backoff honoring header, bounded attempts        |
| timeout / malformed JSON / HTML error page (observed: nginx 404 page) | `SyncFailed` with context, never decoded as data |
| `next: null` on last page                                             | pagination terminates                            |

### Edge cases — CatalogSync

| Case                                                | Expected                                                      |
| --------------------------------------------------- | ------------------------------------------------------------- |
| crash after page N                                  | resume from cursor; zero duplicate rows (idempotent upsert)   |
| second sync started while running                   | rejected — single-flight guard                                |
| app vanished upstream (full sync or refreshApp 404) | row kept, `removed_at` set; history/revenue preserved         |
| revenue months changed since last sync              | months fully replaced per app (server is source of truth)     |
| incremental hits known max id                       | stops early, records 0 new rows                               |
| 401 mid-sync                                        | abort; `af_sync_runs.status = token_invalid`; all data intact |

### Edge cases — repository

- upsert same `sd_id` twice → one row, latest fields win
- pin twice → no-op; unpin non-pinned → no-op; note on unpinned app → error
- `af_sync_runs` newest-first ordering for Data tab

## Implementation Steps

0. **Write the failing tests above first** — each must fail for the right
   reason (decode error / missing method), not trivially.
1. Contracts schemas + WS_METHODS + RPC group entries; export from contracts.
2. Migration 088 + repository (CRUD, upsert, sync-run log).
3. ScreensdesignClient with secret lookup; map responses → schema types.
4. CatalogSync 3 modes: **full** = paginate `/v1/apps/` to the end (follow
   `next`), upsert apps + revenue points — catches new apps and changed
   fields; **incremental** = same walk but stop when id ≤ max local (cheap
   daily auto); **refreshApp(sd_id)** = re-fetch `/v1/apps/{id}/` + its
   videos/screens (invalidate that app's caches). All modes record
   af_sync_runs and emit progress.
5. Lazy screens: on `getAppDetail`, fetch videos then screens per video on
   cache miss; store; respect `is_blurry`.
6. RPC handlers in `wsRpc.ts`; wire layer in `serverLayers.ts`.
7. 401 handling: mark sync failed with `token_invalid`, keep all data.

## Todo List

- [ ] edge-case catalog reviewed/extended with user before coding
- [ ] tests written first, failing for the right reason (Red)
- [ ] contracts/appFactory.ts + ws.ts + rpc.ts compile
- [ ] migration 089+090 apply cleanly on fresh + existing dev DB
- [ ] client auth via ServerSecretStore (no token in logs/responses)
- [ ] full mirror completes (all catalog rows + revenue) with progress + resume
- [ ] full re-sync updates changed rows (revenue/rating/updated) and adds new apps
- [ ] refreshApp re-fetches one app incl. videos/screens
- [ ] detail lazy-loads videos/screens; second view is cache-hit
- [ ] 401 path: sync fails visibly, data intact

## Success Criteria

- Fresh dev instance: paste token → sync → 2,621 rows in `af_apps`, revenue
  rows in `af_revenue_monthly`; `bun typecheck` green; restart resumes
  incremental sync without refetching all.

## Risk Assessment

- Token invalid mid-sync → sync aborts gracefully, status surfaced (tested).
- Payload shape drift → keep `raw_json` per app for forensics.
- Long first sync (~15 min at polite rate) → progress + cancel + resume.

## Security Considerations

- Token only in ServerSecretStore; never in RPC payloads, logs, or web state.
- Outbound calls via shared `outboundHttp` policy (allowlist api.screensdesign.com).

## Next Steps

- Phase 02 consumes `listApps`/`getAppDetail`; phase 03 adds Settings UI for
  `setToken`/`testToken`.
