import { describe, expect, test } from "vitest";
import { recordWeb } from "../../src/capture/record.js";
import { RECORD_MAX_DURATION_MS } from "../../src/core/types.js";

describe("record", () => {
  test("duration above RECORD_MAX_DURATION_MS fails with record-too-long", async () => {
    const res = await recordWeb({
      url: "http://localhost:9999",
      durationMs: RECORD_MAX_DURATION_MS + 1,
      outFile: "/tmp/ade-proof-record-too-long.webm",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("record-too-long");
      expect(res.error.details?.maxDurationMs).toBe(RECORD_MAX_DURATION_MS);
    }
  });
});
