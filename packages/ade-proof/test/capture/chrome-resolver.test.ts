import { describe, expect, test } from "vitest";
import { resolveChrome } from "../../src/capture/chrome-resolver.js";

describe("chrome-resolver", () => {
  test("env NUNCIO_ADE_PROOF_CHROME wins and is probed first", () => {
    const exists = (p: string) => p === "/custom/chrome";
    const res = resolveChrome({
      exists,
      platform: "darwin",
      env: { NUNCIO_ADE_PROOF_CHROME: "/custom/chrome" },
      which: () => undefined,
    });
    expect(res).toEqual({ ok: true, value: "/custom/chrome" });
  });

  test("macOS probe order: Chrome before Canary before Chromium before Edge before Brave before Arc", () => {
    const order: string[] = [];
    const exists = (p: string) => {
      order.push(p);
      return p.includes("Microsoft Edge");
    };
    const res = resolveChrome({
      exists,
      platform: "darwin",
      env: {},
      which: () => undefined,
    });
    expect(res.ok).toBe(true);
    expect((res as { ok: true; value: string }).value).toContain("Microsoft Edge");
    expect(order.slice(0, 4)).toEqual([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]);
  });

  test("linux uses which results after env", () => {
    const res = resolveChrome({
      exists: () => true,
      platform: "linux",
      env: {},
      which: (name) => (name === "chromium" ? "/usr/bin/chromium" : undefined),
    });
    expect(res).toEqual({ ok: true, value: "/usr/bin/chromium" });
  });

  test("chrome-not-found lists every probed path", () => {
    const probed: string[] = [];
    const res = resolveChrome({
      exists: (p) => {
        probed.push(p);
        return false;
      },
      platform: "linux",
      env: {},
      which: (name) => {
        probed.push(`which:${name}`);
        return undefined;
      },
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe("chrome-not-found");
    const details = !res.ok ? res.error.details : undefined;
    expect(details?.probedPaths).toEqual(probed);
  });
});
