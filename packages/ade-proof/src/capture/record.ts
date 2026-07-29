import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProofResult, RecordRequest } from "../core/types.js";
import { RECORD_MAX_DURATION_MS } from "../core/types.js";
import {
  applyStorageState,
  closeBrowser,
  ensureBrowser,
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

    // NOTE: no injectStyle() here — freezing motion is right for screenshot
    // determinism but wrong for video. Chrome's screencast muxer only emits
    // on repaint, so a fully static page would produce a 0-byte file. The
    // timecode watermark below guarantees a repaint every 100 ms AND stamps
    // the recording with evidentiary elapsed time.
    const recorder = await page.screencast({
      path: req.outFile as `${string}.webm`,
      format: "webm",
    });

    const sweep = page.evaluate(async (ms) => {
      const badge = document.createElement("div");
      badge.style.cssText =
        "position:fixed;right:8px;bottom:8px;z-index:2147483647;" +
        "font:12px/1.6 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.55);" +
        "padding:0 6px;border-radius:4px;pointer-events:none";
      document.body.appendChild(badge);
      const start = performance.now();
      while (performance.now() - start < ms) {
        const elapsed = performance.now() - start;
        badge.textContent = `ade-proof ${(elapsed / 1000).toFixed(1)}s`;
        const t = elapsed / ms;
        // triangle wave: tour down the page, then back up
        const phase = t < 0.5 ? t * 2 : 2 - t * 2;
        const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
        scrollTo({ top: maxScroll * phase, behavior: "instant" as ScrollBehavior });
        const tick = Promise.withResolvers<void>();
        setTimeout(tick.resolve, 100);
        await tick.promise;
      }
      badge.remove();
      scrollTo({ top: 0 });
    }, req.durationMs);

    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, req.durationMs);
    await promise;
    clearTimeout(timer);
    await sweep.catch(() => undefined);

    await recorder.stop();

    const written = await stat(req.outFile).catch(() => undefined);
    if (!written || written.size === 0) {
      return {
        ok: false,
        error: {
          code: "disk-write-failed",
          message: `Recording produced an empty file at ${req.outFile}. Chrome emitted no frames; check that the page renders and ffmpeg is available.`,
          details: { outFile: req.outFile, bytes: written?.size ?? 0 },
        },
      };
    }
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
