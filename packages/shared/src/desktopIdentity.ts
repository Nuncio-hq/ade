// FILE: desktopIdentity.ts
// Purpose: Defines the canonical desktop application identity across packaging and runtime.

export const NUNCIO_DESKTOP_SCHEME = "nuncioade";
export const NUNCIO_DESKTOP_ORIGIN = `${NUNCIO_DESKTOP_SCHEME}://app`;
export const NUNCIO_DESKTOP_ENTRY_URL = `${NUNCIO_DESKTOP_ORIGIN}/index.html`;
export const NUNCIO_DESKTOP_UPDATE_CHANNEL = "nuncioade";
export const NUNCIO_PRODUCTION_BUNDLE_ID = "com.emanueledipietro.nuncioade";
export const NUNCIO_DEVELOPMENT_BUNDLE_ID = `${NUNCIO_PRODUCTION_BUNDLE_ID}.dev`;
export const NUNCIO_CANARY_BUNDLE_ID = `${NUNCIO_PRODUCTION_BUNDLE_ID}.canary`;
export const NUNCIO_CANARY_DESKTOP_SCHEME = "nuncioade-canary";
export const NUNCIO_CANARY_DESKTOP_ORIGIN = `${NUNCIO_CANARY_DESKTOP_SCHEME}://app`;
export const NUNCIO_CANARY_DESKTOP_ENTRY_URL = `${NUNCIO_CANARY_DESKTOP_ORIGIN}/index.html`;

export type NuncioADEDesktopFlavor = "production" | "development" | "canary";

export interface NuncioADEDesktopIdentity {
  readonly flavor: NuncioADEDesktopFlavor;
  readonly displayName: string;
  readonly bundleId: string;
  readonly scheme: string;
  readonly origin: string;
  readonly entryUrl: string;
  readonly userDataDirectoryName: string;
  readonly defaultHomeDirectoryName: string;
  readonly usesScriptedUpdates: boolean;
}

export function resolveNuncioADEDesktopFlavor(input: {
  readonly isDevelopment: boolean;
  readonly requestedFlavor?: string | undefined;
}): NuncioADEDesktopFlavor {
  if (input.requestedFlavor?.trim().toLowerCase() === "canary") {
    return "canary";
  }
  return input.isDevelopment ? "development" : "production";
}

export function nuncioadeDesktopIdentity(flavor: NuncioADEDesktopFlavor): NuncioADEDesktopIdentity {
  if (flavor === "canary") {
    return {
      flavor,
      displayName: "NuncioADE Canary",
      bundleId: NUNCIO_CANARY_BUNDLE_ID,
      scheme: NUNCIO_CANARY_DESKTOP_SCHEME,
      origin: NUNCIO_CANARY_DESKTOP_ORIGIN,
      entryUrl: NUNCIO_CANARY_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "nuncioade-canary",
      defaultHomeDirectoryName: ".nuncioade-canary",
      usesScriptedUpdates: true,
    };
  }
  if (flavor === "development") {
    return {
      flavor,
      displayName: "NuncioADE (Dev)",
      bundleId: NUNCIO_DEVELOPMENT_BUNDLE_ID,
      scheme: NUNCIO_DESKTOP_SCHEME,
      origin: NUNCIO_DESKTOP_ORIGIN,
      entryUrl: NUNCIO_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "nuncioade-dev",
      defaultHomeDirectoryName: ".nuncioade",
      usesScriptedUpdates: false,
    };
  }
  return {
    flavor,
    displayName: "NuncioADE",
    bundleId: NUNCIO_PRODUCTION_BUNDLE_ID,
    scheme: NUNCIO_DESKTOP_SCHEME,
    origin: NUNCIO_DESKTOP_ORIGIN,
    entryUrl: NUNCIO_DESKTOP_ENTRY_URL,
    userDataDirectoryName: "nuncioade",
    defaultHomeDirectoryName: ".nuncioade",
    usesScriptedUpdates: false,
  };
}

export function nuncioadeBundleId(isDevelopment: boolean): string {
  return nuncioadeDesktopIdentity(isDevelopment ? "development" : "production").bundleId;
}
