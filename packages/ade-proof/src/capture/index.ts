import type { CaptureBackend, ProofResult, ProofTarget, RecordRequest } from "../core/types.js";
import { macosBackend } from "./macos.js";
import { recordWeb } from "./record.js";
import { startDevServer } from "./server-runner.js";
import { webBackend } from "./web.js";

export {
  type CaptureBackend,
  type CaptureMeta,
  type CaptureRequest,
  type RecordRequest,
} from "../core/types.js";

export function getBackend(target: ProofTarget): CaptureBackend | undefined {
  if (target === "web") return webBackend;
  if (target === "macos") return macosBackend;
  return undefined;
}

export { recordWeb, startDevServer };
