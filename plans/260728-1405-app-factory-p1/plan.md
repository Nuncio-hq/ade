# App Factory — P1 Research Tool (plan overview)

> Brainstorm-locked 2026-07-28. Research: screensdesign API probed live (token
> works, free tier), GetAppNiche docs verified, codebase integration map done.

## Goal

Sidebar section "App Factory" in ADE: find iOS apps worth cloning (market +
UX data), analyze them, compare shortlist. Clone execution is **deferred**
(P2+, see DECISIONS 2026-07-28).

## Locked decisions

- **Data**: screensdesign API mirror (catalog ~2,600+ apps and growing —
  2,621 observed at probe time 2026-07-28; free tier token) — P1.
  GetAppNiche (5,000 credits/mo) — P2. iTunes Lookup enrichment — P2/P3.
- **Freshness**: user-triggered update at 3 levels — auto incremental daily
  (new apps), manual full sync (upsert everything: new + changed rows),
  per-app refresh on detail. Estimates >30d get a stale badge — data never
  silently old.
- **Cost model**: P1 needs $0. Subscriptions later, sprint-based
  (screensdesign Weekly $19 / GetAppNiche trial→monthly); cache-forever in
  SQLite; snapshot mode with data-age badges after lapse.
- **UX**: table-first, dense, 4 tabs (Discover / Rising / Watchlist / Data),
  compare view (2-3 apps) in P1.
- **Secrets**: screensdesign token in `ServerSecretStore`, never env/localStorage.
- **Method: TDD.** Every unit starts with failing tests (Red → Green →
  Refactor). Each phase file has a "Test Plan (write BEFORE implementation)"
  section with an edge-case catalog — review/extend it before writing any
  implementation code. Run scoped with `bun run test` (never `bun test`).
  Note: 36 web tests already fail on main (upstream-inherited) — our new
  tests must be green independently of those.

## Architecture (Pull Requests / Automations pattern)

- `packages/contracts/src/appFactory.ts` + `WS_METHODS.appFactory*` + RPC group
- `apps/server/src/appFactory/{Services,Layers}/` — `ScreensdesignClient`
  (via `outboundHttp`/`fetchJson`), `CatalogSync` (full upsert mirror +
  incremental + per-app refresh), repository; SQLite migration
  `089_AppFactory.ts` + `090_AppFactoryDetailFetchedAt.ts`; wire `serverLayers.ts`, `wsRpc.ts`
- `apps/web`: routes `_chat.app-factory*.tsx`, `components/appFactory/*`,
  sidebar `SidebarPrimaryAction`
- Clone handoff later: deterministic facts pack + `/ade-app-clone` skill in
  `harness/`; OMP session does synthesis (no server-side LLM calls).

## Phases

| Phase                                                  | File                                                                     | Status  |
| ------------------------------------------------------ | ------------------------------------------------------------------------ | ------- |
| 01 Data layer (contracts, server module, sync, SQLite) | [phase-01-data-layer.md](phase-01-data-layer.md)                         | pending |
| 02 Web UI (4 tabs, detail, compare, screens filmstrip) | [phase-02-web-ui.md](phase-02-web-ui.md)                                 | pending |
| 03 States, settings panel, verification, docs          | [phase-03-states-settings-verify.md](phase-03-states-settings-verify.md) | pending |

## Key API facts (probed 2026-07-28)

- `GET /v1/apps/` — full catalog (2,621 apps at probe time, grows
  continuously), 10/page; free filters: `name`, `category`,
  `developer`; Pro-gated (403): `paywall_type`, `revenue_gte` → mirror local,
  filter in SQL.
- `GET /v1/apps/{id}/` — detail + `revenue_list` monthly + `avs` (paywall_type,
  onboarding_step_count, has_onboarding_with_quiz).
- `GET /v1/appvideos/?app={id}` — recordings (bunny.net embed, blur_starts_at,
  app_version, recording_date, duration).
- `GET /v1/appvideoscreens/?app_video={id}` — frames: `timestamp`, `labels`
  (onboarding/paywall), `is_blurry` (free tier: blurred from paywall onward),
  image URLs (CDN no auth).
- `GET /v1/me/` — account + Pro status. No rate limit observed (~35 reqs).

## Non-goals (P1)

- No clone/agent handoff, no LLM anywhere, no GetAppNiche, no Android,
  no continuous competitor monitoring (research-per-sprint, not Sensor Tower).

## Risks

- Token expiry → sync must handle 401, UI keeps snapshot browsable.
- Upstream-merge conflicts at wiring points (`serverLayers.ts`, `wsRpc.ts`,
  contracts, `Sidebar.tsx`) — keep diffs minimal, note in commits.
- ToS: personal research use; polite sync rate; no redistribution.
