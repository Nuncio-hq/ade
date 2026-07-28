# Phase 02 — Web UI: 4 tabs, detail, compare, screens filmstrip

## Context Links

- Overview: [plan.md](plan.md); data contracts from phase 01
- UI templates: `routes/_chat.pull-requests*.tsx`, `routes/_chat.automations*.tsx`,
  `components/pullRequest/*`, `Sidebar.tsx` (~L5650 primary actions),
  `lib/pullRequestQueryOptions.ts`

## Overview

- Priority: second — after data layer
- Status: pending
- All App Factory screens in apps/web, dense pro-tool aesthetic, zero new
  visual identity (existing Tailwind v4 tokens + base-ui primitives)

## Key Insights

- Locked UX: **table-first**, **dense**, 4 tabs (Discover / Rising /
  Watchlist / Data), **compare view in P1** (2-3 apps from watchlist).
- Rising is a _saved preset_ over the same local dataset, not a separate
  pipeline: `released ≤ 12mo AND revenue slope > 0 AND advertised = true`.
- Client-side filter/sort over the full mirrored list (one `listApps` fetch)
  → zero-latency filtering; virtualization for 2,600+ rows.
- Screens are filmstrips grouped by flow stage (Onboarding → Paywall →
  In-app), timestamps shown; blur state is honest UI, not hidden.

## Requirements

- Functional: 4 tabs; search + faceted filters (category, paywall type,
  revenue range, released window, advertised, rating, onboarding steps);
  sortable columns; revenue sparkline per row; presets incl. Rising + user
  presets; pin to watchlist from any row; detail page (metadata, revenue
  chart, monetization card, screens filmstrip + lightbox, recordings list);
  compare 2-3 watchlist apps side-by-side; Data tab (sync status/history,
  row counts, token state, **Update data now** = full sync, incremental auto
  daily toggle); per-app **Refresh** action on detail page.
- Non-functional: lazy images (thumbs in lists, full in lightbox); virtualized
  table; skeleton loading; works with sync in progress.

## Architecture

```
routes/_chat.app-factory.tsx           layout + tabs + sync banner slot
routes/_chat.app-factory.index.tsx     Discover (table + filters + presets)
routes/_chat.app-factory.rising.tsx    Rising (preset applied)
routes/_chat.app-factory.watchlist.tsx Watchlist (+ "Compare" action)
routes/_chat.app-factory.compare.tsx   ?ids=a,b,c side-by-side
routes/_chat.app-factory.data.tsx      Data/sync/credits placeholder
routes/_chat.app-factory.$appId.tsx    Detail
components/appFactory/ AppTable, AppRow, Sparkline, FilterBar, PresetChips,
  RevenueChart, MonetizationCard, ScreensFilmstrip, ScreenLightbox,
  SourceBadge, SyncButton, EmptyStates
appFactoryStore.ts (filters, presets, selection) + appFactoryQueryOptions.ts
Sidebar.tsx: SidebarPrimaryAction "App Factory" (tabler building-factory)
```

## Related Code Files

- Create: the 7 route files; `components/appFactory/*` (~12 files);
  `appFactoryStore.ts`; `appFactoryQueryOptions.ts`
- Modify: `apps/web/src/components/Sidebar.tsx` (one entry),
  `apps/web/src/wsNativeApi.ts` (appFactory methods), routeTree (generated)

## Test Plan (write BEFORE implementation)

Logic-level tests only (Vitest); visual states verified manually in dogfood.
Keep tests free of the known 36 pre-existing web-test failures (avoid
zustand persist patterns that need localStorage in test env).

Test files:

- `apps/web/src/lib/appFactoryPredicates.test.ts` — filters, Rising preset, sorts
- `apps/web/src/lib/appFactorySparkline.test.ts` — series normalization
- `apps/web/src/appFactoryStore.test.ts` — filter state + URL sync

### Edge cases — Rising preset (`released ≤ 12mo AND slope > 0 AND advertised`)

| Case                                         | Expected                     |
| -------------------------------------------- | ---------------------------- |
| `revenue_list` has 1 month only              | excluded (not enough signal) |
| gaps between months (Sep, Nov — Oct missing) | slope over available points  |
| recent months all zero                       | slope 0 → not rising         |
| `released` exactly 12 months ago             | inclusive boundary           |
| `advertised` null/undefined                  | treated as false             |

### Edge cases — filters / sort / search

- combined category + revenue range + advertised intersect correctly
- revenue range edges inclusive; apps with null revenue excluded from ranges
- name search case- and diacritics-insensitive
- sort stable for equal values (fallback: name)

### Edge cases — sparkline / compare / store

- sparkline: all-zero series; single point; never negative (clamp)
- compare URL: 1 id → hint "pick 2-3"; unknown id → placeholder card;
  > 3 ids → first 3 + note
- store ↔ URL search params roundtrip; invalid values fall back to defaults

## Implementation Steps

0. **Write the failing tests above first** (predicates/sparkline/store are
   pure functions — ideal TDD targets).
1. wsNativeApi methods + query options + store skeleton.
2. Route layout + tabs + sidebar entry; empty Discover renders list rows.
3. AppTable (virtualized) + AppRow with sparkline (inline SVG); sorting.
4. FilterBar + presets (Rising default set); URL-synced filter state.
5. Detail page: header, stats, RevenueChart (SVG bars), MonetizationCard.
6. ScreensFilmstrip grouped by labels; blur overlay `🔒 ScreensDesign Pro`;
   ScreenLightbox with keyboard nav; recordings section.
7. Watchlist tab + compare route (columns: metadata, revenue chart,
   monetization, onboarding strip).
8. Data tab: sync status, af_sync_runs history, token state, "Update data
   now" (full sync) button + auto daily incremental toggle.
9. Detail page "Refresh" action (appFactory.refreshApp) next to the
   fetched-at badge.

## Todo List

- [ ] predicate/sparkline/store tests written first, failing (Red)
- [ ] sidebar entry navigates; tabs render
- [ ] table filters/sorts client-side instantly; Rising preset correct
- [ ] pin/unpin persists via RPC
- [ ] detail shows revenue chart + monetization card + filmstrip
- [ ] blur overlay on `is_blurry` frames; lightbox keyboard nav
- [ ] compare renders 2-3 apps from watchlist
- [ ] Data tab shows sync runs + token state + Update-data-now full sync
- [ ] detail Refresh re-fetches the app; fetched-at badge updates
- [ ] no new dependencies (SVG charts only); dark/light via tokens

## Success Criteria

- On dev instance: sync → Discover shows all apps → Rising surfaces apps like
  "Scroll The Bible" (released 2025-12, slope+, ads) → detail filmstrip shows
  onboarding sharp + paywall blurred (free tier) → pin 2 apps → compare.

## Risk Assessment

- Large list perf → virtualization + memoized rows; measure with 2,600 rows.
- Icon/screen image floods → lazy + thumbnail sizes only in lists.
- Filter state complexity → keep in one zustand store, URL-synced for share.

## Security Considerations

- No secrets reach web; RPC DTOs exclude raw_json by default.
- External images limited to media.screensdesign.com (CSP/img-src if enforced).

## Next Steps

- Phase 03: settings integrations panel, error/empty states polish, docs.
- P2: GetAppNiche enrich buttons + credit badge hook into Detail/Discover.
