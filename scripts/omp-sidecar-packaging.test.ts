// FILE: omp-sidecar-packaging.test.ts
// Purpose: Pins that every desktop platform ships the OMP Bun sidecar beside the
//          app. The engine SDK is Bun-only and cannot live in the asar, so a
//          missing extraResources entry silently ships an app whose OMP provider
//          has no engine at all.
// Layer: Release/build helper tests

import { describe, expect, it } from "vitest";

import {
  createDesktopPlatformBuildConfig,
  OMP_SIDECAR_DIST_DIR,
  OMP_SIDECAR_RESOURCE_DIR,
} from "./lib/desktop-platform-build-config.ts";

describe("OMP sidecar packaging", () => {
  it.each([
    ["mac", "dmg"],
    ["linux", "AppImage"],
    ["win", "nsis"],
  ] as const)("ships the sidecar directory on %s", (platform, target) => {
    const config = createDesktopPlatformBuildConfig({ platform, target });

    expect(config.extraResources).toEqual([
      { from: OMP_SIDECAR_DIST_DIR, to: OMP_SIDECAR_RESOURCE_DIR },
    ]);
  });

  it("keeps the sidecar out of the asar", () => {
    const config = createDesktopPlatformBuildConfig({ platform: "mac", target: "dmg" });

    // extraResources land in Contents/Resources/<to>, never inside app.asar —
    // Bun cannot read an asar archive, and the engine loads its native addon
    // from the executable's own directory.
    expect(config.asarUnpack).not.toContain(OMP_SIDECAR_DIST_DIR);
    expect(config.extraResources?.[0]?.to).toBe(OMP_SIDECAR_RESOURCE_DIR);
  });
});
