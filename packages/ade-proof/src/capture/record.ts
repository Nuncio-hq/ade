import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProofResult, RecordRequest } from "../core/types.js";
import { RECORD_MAX_DURATION_MS } from "../core/types.js";
import {
  applyStorageState,
  closeBrowser,
  ensureBrowser,
  injectStyle,
  navigateAndSettle,
  setViewport,
  validateStorageState,
} from "./web-shared.js";

export async function recordWeb(req: RecordRequest): Promise<ProofResult<void>> {
  if (req.durationMs > RECORD_MAX_DURATION_MS) {
    return {
      ok: false,
      error: {
        code: "record-too-long",
        message: `Requested duration ${req.durationMs}ms exceeds the ${RECORD_MAX_DURATION_MS}ms cap.`,
        details: { maxDurationMs: RECORD_MAX_DURATION_MS, requestedMs: req.durationMs },
      },
    };
  }

  if (req.storageStatePath) {
    const state = await validateStorageState(req.storageStatePath);
    if (!state.ok) return state as ProofResult<void>;
  }

  const browserRes = await ensureBrowser();
  if (!browserRes.ok) return browserRes as ProofResult<void>;

  const page = await browserRes.value.newPage();
  try {
    await setViewport(page);
    if (req.storageStatePath) {
      const state = await validateStorageState(req.storageStatePath);
      if (state.ok) await applyStorageState(page, state.value, req.url);
    }

    const nav = await navigateAndSettle(page, req.url);
    if (!nav.ok) return nav as ProofResult<void>;

    await injectStyle(page);
    const recorder = await page.screencast({
      path: req.outFile as `${string}.webm`,
      format: "webm",
    });

    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, req.durationMs);
    await promise;
    clearTimeout(timer);

    await recorder.stop();
    return { ok: true, value: undefined };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: {
        code: "navigation-failed",
        message: `Could not record ${req.url}: ${reason}`,
        details: { url: req.url },
      },
    };
  } finally {
    await page.close();
  }
}
