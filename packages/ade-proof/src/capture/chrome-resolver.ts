import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import type { ProofResult } from "../core/types.js";

export interface ChromeResolverEnv {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: string;
  readonly exists: (p: string) => boolean;
  readonly which: (name: string) => string | undefined;
}

function defaultWhich(name: string): string | undefined {
  try {
    const out = execSync(`which ${name} 2>/dev/null`, { encoding: "utf8" }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function macOSProbePaths(): string[] {
  return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Arc.app/Contents/MacOS/Arc",
  ];
}

function linuxProbePaths(
  which: (name: string) => string | undefined,
  probedPaths: string[],
): string[] {
  const names = ["chromium", "google-chrome", "chromium-browser", "google-chrome-stable", "chrome"];
  const found: string[] = [];
  for (const name of names) {
    probedPaths.push(`which:${name}`);
    const path = which(name);
    if (path) {
      probedPaths.push(path);
      found.push(path);
    }
  }
  return found;
}

export function resolveChrome(options?: Partial<ChromeResolverEnv>): ProofResult<string> {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const exists = options?.exists ?? existsSync;
  const which = options?.which ?? defaultWhich;

  const probedPaths: string[] = [];

  const envChrome = env.NUNCIO_ADE_PROOF_CHROME;
  if (envChrome) {
    probedPaths.push(envChrome);
    if (exists(envChrome)) {
      return { ok: true, value: envChrome };
    }
  }

  const platformPaths =
    platform === "darwin" ? macOSProbePaths() : linuxProbePaths(which, probedPaths);
  if (platform === "darwin") {
    probedPaths.push(...platformPaths);
  }
  for (const p of platformPaths) {
    if (exists(p)) {
      return { ok: true, value: p };
    }
  }

  return {
    ok: false,
    error: {
      code: "chrome-not-found",
      message: `Could not find a Chrome/Chromium binary. Set NUNCIO_ADE_PROOF_CHROME to the path of a Chrome executable, or install Chrome/Chromium for ${platform}.`,
      details: { probedPaths },
    },
  };
}
