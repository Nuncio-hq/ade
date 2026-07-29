import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  CaptureBackend,
  CaptureMeta,
  CaptureRequest,
  ProofResult,
  ProofTarget,
} from "../../src/core/types.js";
import { ok } from "../../src/core/result-helpers.js";

// 1x1 transparent PNG
const MIN_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

export class FakeCaptureBackend implements CaptureBackend {
  readonly target: ProofTarget;

  constructor(target: ProofTarget = "web") {
    this.target = target;
  }

  async capture(req: CaptureRequest): Promise<ProofResult<CaptureMeta>> {
    await mkdir(dirname(req.outFile), { recursive: true });
    await writeFile(req.outFile, Buffer.from(MIN_PNG, "base64"));
    const meta: CaptureMeta = {
      httpStatus: 200,
      truncated: false,
      consoleLines: [],
      ...(req.url ? { finalUrl: req.url } : {}),
    };
    return ok(meta);
  }
}
