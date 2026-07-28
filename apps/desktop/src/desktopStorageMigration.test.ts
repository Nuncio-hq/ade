import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  acknowledgeNuncioADEStorageSnapshot,
  readNuncioADEStorageSnapshot,
  saveNuncioADEStorageSnapshot,
  NUNCIO_STORAGE_SNAPSHOT_MAX_BYTES,
  validateNuncioADEStorageSnapshot,
} from "./desktopStorageMigration";

const snapshot = (exportedAt = "2026-07-09T00:00:00.000Z") => ({
  version: 1 as const,
  exportedAt,
  entries: {
    "nuncioade:theme": "dark",
    "nuncioade.openUsage.enabled": "true",
  },
});

describe("desktopStorageMigration", () => {
  it("round-trips atomically and acknowledges the snapshot", async () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "nuncioade-storage-migration-"));
    const target = Path.join(directory, "snapshot.json");
    try {
      await expect(saveNuncioADEStorageSnapshot(target, snapshot())).resolves.toBe(true);
      expect(readNuncioADEStorageSnapshot(target)).toEqual(snapshot());
      expect(FS.readdirSync(directory)).toEqual(["snapshot.json"]);

      await acknowledgeNuncioADEStorageSnapshot(target);
      expect(readNuncioADEStorageSnapshot(target)).toBeNull();
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed, disallowed, and oversized snapshots", () => {
    expect(validateNuncioADEStorageSnapshot({ version: 1 })).toBeNull();
    expect(
      validateNuncioADEStorageSnapshot({
        ...snapshot(),
        entries: { "foreign:theme": "dark" },
      }),
    ).toBeNull();
    expect(
      validateNuncioADEStorageSnapshot({
        ...snapshot(),
        entries: { "nuncioade:large": "x".repeat(NUNCIO_STORAGE_SNAPSHOT_MAX_BYTES) },
      }),
    ).toBeNull();
  });

  it("accepts renderer snapshots containing large composer drafts", () => {
    const largeDraft = "x".repeat(2 * 1024 * 1024);

    expect(
      validateNuncioADEStorageSnapshot({
        ...snapshot(),
        entries: { "nuncioade:composer-drafts:v1": largeDraft },
      })?.entries["nuncioade:composer-drafts:v1"],
    ).toBe(largeDraft);
  });

  it("does not replace a newer snapshot with an older export", async () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "nuncioade-storage-migration-"));
    const target = Path.join(directory, "snapshot.json");
    try {
      await saveNuncioADEStorageSnapshot(target, snapshot("2026-07-09T01:00:00.000Z"));
      await expect(
        saveNuncioADEStorageSnapshot(target, snapshot("2026-07-09T00:00:00.000Z")),
      ).resolves.toBe(false);
      expect(readNuncioADEStorageSnapshot(target)?.exportedAt).toBe("2026-07-09T01:00:00.000Z");
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats missing and malformed files as absent", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "nuncioade-storage-migration-"));
    const target = Path.join(directory, "snapshot.json");
    try {
      expect(readNuncioADEStorageSnapshot(target)).toBeNull();
      FS.writeFileSync(target, "not json");
      expect(readNuncioADEStorageSnapshot(target)).toBeNull();
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
