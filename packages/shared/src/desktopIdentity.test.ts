import { describe, expect, it } from "vitest";

import {
  resolveNuncioADEDesktopFlavor,
  NUNCIO_CANARY_BUNDLE_ID,
  NUNCIO_CANARY_DESKTOP_ENTRY_URL,
  NUNCIO_CANARY_DESKTOP_ORIGIN,
  NUNCIO_DESKTOP_ENTRY_URL,
  NUNCIO_DESKTOP_ORIGIN,
  NUNCIO_DESKTOP_UPDATE_CHANNEL,
  NUNCIO_DEVELOPMENT_BUNDLE_ID,
  NUNCIO_PRODUCTION_BUNDLE_ID,
  nuncioadeBundleId,
  nuncioadeDesktopIdentity,
} from "./desktopIdentity";

describe("desktopIdentity", () => {
  it("uses the exact canonical production and development bundle IDs", () => {
    expect(NUNCIO_PRODUCTION_BUNDLE_ID).toBe("com.nuncio.ade");
    expect(NUNCIO_DEVELOPMENT_BUNDLE_ID).toBe("com.nuncio.ade.dev");
    expect(nuncioadeBundleId(false)).toBe(NUNCIO_PRODUCTION_BUNDLE_ID);
    expect(nuncioadeBundleId(true)).toBe(NUNCIO_DEVELOPMENT_BUNDLE_ID);
  });

  it("uses the exact packaged renderer origin and entry URL", () => {
    expect(NUNCIO_DESKTOP_ORIGIN).toBe("nuncioade://app");
    expect(NUNCIO_DESKTOP_ENTRY_URL).toBe("nuncioade://app/index.html");
  });

  it("uses the isolated NuncioADE desktop update channel", () => {
    expect(NUNCIO_DESKTOP_UPDATE_CHANNEL).toBe("nuncioade");
  });

  it("gives Canary a fully separate desktop identity and storage profile", () => {
    expect(NUNCIO_CANARY_BUNDLE_ID).toBe("com.nuncio.ade.canary");
    expect(NUNCIO_CANARY_DESKTOP_ORIGIN).toBe("nuncioade-canary://app");
    expect(NUNCIO_CANARY_DESKTOP_ENTRY_URL).toBe("nuncioade-canary://app/index.html");
    expect(nuncioadeDesktopIdentity("canary")).toEqual({
      flavor: "canary",
      displayName: "NuncioADE Canary",
      bundleId: NUNCIO_CANARY_BUNDLE_ID,
      scheme: "nuncioade-canary",
      origin: NUNCIO_CANARY_DESKTOP_ORIGIN,
      entryUrl: NUNCIO_CANARY_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "nuncioade-canary",
      defaultHomeDirectoryName: ".nuncioade-canary",
      usesScriptedUpdates: true,
    });
  });

  it("selects Canary explicitly without changing normal dev and production defaults", () => {
    expect(resolveNuncioADEDesktopFlavor({ isDevelopment: false })).toBe("production");
    expect(resolveNuncioADEDesktopFlavor({ isDevelopment: true })).toBe("development");
    expect(
      resolveNuncioADEDesktopFlavor({ isDevelopment: false, requestedFlavor: " canary " }),
    ).toBe("canary");
    expect(resolveNuncioADEDesktopFlavor({ isDevelopment: true, requestedFlavor: "canary" })).toBe(
      "canary",
    );
  });
});
