import type { Page } from "puppeteer-core";
import type {
  CaptureBackend,
  CaptureMeta,
  CaptureRequest,
  ProofResult,
  ProofTarget,
} from "../core/types.js";
import { FULL_PAGE_MAX_HEIGHT_PX } from "../core/types.js";
import {
  applyStorageState,
  attachConsoleListener,
  closeBrowser,
  ensureBrowser,
  ensureOutputDir,
  injectStyle,
  navigateAndSettle,
  setViewport,
  validateStorageState,
} from "./web-shared.js";

export const target: ProofTarget = "web";

async function screenshotFullPage(page: Page, outFile: string): Promise<{ truncated: boolean }> {
  const size = (await page.evaluate(() => ({
    width: Math.max(document.documentElement.scrollWidth, 1280),
    height: document.documentElement.scrollHeight,
  }))) as { width: number; height: number };

  const truncated = size.height > FULL_PAGE_MAX_HEIGHT_PX;
  const clipHeight = Math.min(size.height, FULL_PAGE_MAX_HEIGHT_PX);

  await page.screenshot({
    path: outFile,
    type: "png",
    clip: { x: 0, y: 0, width: size.width, height: clipHeight },
    captureBeyondViewport: true,
  });

  return { truncated };
}

export async function capture(req: CaptureRequest): Promise<ProofResult<CaptureMeta>> {
  if (req.target !== "web") {
    return {
      ok: false,
      error: {
        code: "unsupported-target",
        message: `web backend cannot capture target "${req.target}"`,
        details: { target: req.target },
      },
    };
  }

  if (!req.url) {
    return {
      ok: false,
      error: {
        code: "navigation-failed",
        message: "web capture requires a --url",
        details: {},
      },
    };
  }

  if (req.storageStatePath) {
    const state = await validateStorageState(req.storageStatePath);
    if (!state.ok) return state as ProofResult<CaptureMeta>;
  }

  const browserRes = await ensureBrowser();
  if (!browserRes.ok) return browserRes as ProofResult<CaptureMeta>;

  const page = await browserRes.value.newPage();
  const consoleLines: string[] = [];
  try {
    await setViewport(page);
    attachConsoleListener(page, consoleLines);
    if (req.storageStatePath) {
      const state = await validateStorageState(req.storageStatePath);
      if (state.ok) await applyStorageState(page, state.value, req.url);
    }

    const nav = await navigateAndSettle(page, req.url);
    if (!nav.ok) return nav as ProofResult<CaptureMeta>;

    await injectStyle(page);

    const finalUrl = page.url();
    const httpStatus = nav.value.response?.status();

    await ensureOutputDir(req.outFile);

    let truncated = false;
    if (req.selector) {
      const el = await page.$(req.selector);
      if (!el) {
        return {
          ok: false,
          error: {
            code: "selector-not-found",
            message: `Selector not found: ${req.selector}`,
            details: { selector: req.selector },
          },
        };
      }
      await el.screenshot({ path: req.outFile, type: "png" });
    } else if (req.fullPage) {
      ({ truncated } = await screenshotFullPage(page, req.outFile));
    } else {
      await page.screenshot({ path: req.outFile, type: "png", fullPage: false });
    }

    const meta: CaptureMeta = {
      finalUrl,
      consoleLines,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(truncated ? { truncated } : {}),
    };
    return { ok: true, value: meta };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: {
        code: "navigation-failed",
        message: `web capture failed for ${req.url}: ${reason}`,
        details: { url: req.url },
      },
    };
  } finally {
    await page.close();
  }
}

export const webBackend: CaptureBackend = { target, capture };
