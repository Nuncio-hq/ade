import { describe, expect, test } from "vitest";
import { writeFile, unlink } from "node:fs/promises";
import { validateStorageState } from "../../src/capture/web-shared.js";

describe("storage-state validation", () => {
  test("invalid JSON returns storage-state-invalid", async () => {
    const path = `/tmp/ade-proof-bad-storage-${Date.now()}.json`;
    await writeFile(path, "not json");
    try {
      const res = await validateStorageState(path);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("storage-state-invalid");
    } finally {
      await unlink(path).catch(() => {});
    }
  });

  test("missing required cookie fields returns storage-state-invalid", async () => {
    const path = `/tmp/ade-proof-bad-cookie-${Date.now()}.json`;
    await writeFile(path, JSON.stringify({ cookies: [{ value: "only-value" }] }));
    try {
      const res = await validateStorageState(path);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("storage-state-invalid");
    } finally {
      await unlink(path).catch(() => {});
    }
  });

  test("valid cookies and localStorage are accepted", async () => {
    const path = `/tmp/ade-proof-good-storage-${Date.now()}.json`;
    const data = {
      cookies: [{ name: "session", value: "abc123", domain: "example.com" }],
      localStorage: [{ name: "token", value: "secret" }],
    };
    await writeFile(path, JSON.stringify(data));
    try {
      const res = await validateStorageState(path);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.cookies).toHaveLength(1);
        expect(res.value.localStorage).toHaveLength(1);
      }
    } finally {
      await unlink(path).catch(() => {});
    }
  });
});
