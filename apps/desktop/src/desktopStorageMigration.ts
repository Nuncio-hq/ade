// FILE: desktopStorageMigration.ts
// Purpose: Persists a validated, origin-neutral browser-storage handoff for desktop upgrades.
// Layer: Desktop main-process utility

import * as FS from "node:fs";
import * as Path from "node:path";

import type { NuncioADEStorageSnapshot } from "@nuncio/contracts";

export const NUNCIO_STORAGE_SNAPSHOT_FILE_NAME = "nuncioade-storage-origin-v1.json";
export const NUNCIO_STORAGE_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
export const NUNCIO_STORAGE_SNAPSHOT_MAX_ENTRIES = 2_048;
export const NUNCIO_STORAGE_SNAPSHOT_MAX_KEY_LENGTH = 512;
export const NUNCIO_STORAGE_SNAPSHOT_MAX_VALUE_LENGTH = 16 * 1024 * 1024;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isNuncioADEStorageKey(key: string): boolean {
  return key.startsWith("nuncioade:") || key.startsWith("nuncioade.");
}

export function validateNuncioADEStorageSnapshot(value: unknown): NuncioADEStorageSnapshot | null {
  if (!isPlainRecord(value) || value.version !== 1 || !isPlainRecord(value.entries)) {
    return null;
  }
  if (typeof value.exportedAt !== "string" || !Number.isFinite(Date.parse(value.exportedAt))) {
    return null;
  }

  const entries = Object.entries(value.entries);
  if (entries.length > NUNCIO_STORAGE_SNAPSHOT_MAX_ENTRIES) {
    return null;
  }
  for (const [key, entryValue] of entries) {
    if (
      !isNuncioADEStorageKey(key) ||
      key.length === 0 ||
      key.length > NUNCIO_STORAGE_SNAPSHOT_MAX_KEY_LENGTH ||
      typeof entryValue !== "string" ||
      entryValue.length > NUNCIO_STORAGE_SNAPSHOT_MAX_VALUE_LENGTH
    ) {
      return null;
    }
  }

  const snapshot = value as unknown as NuncioADEStorageSnapshot;
  try {
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > NUNCIO_STORAGE_SNAPSHOT_MAX_BYTES) {
      return null;
    }
  } catch {
    return null;
  }
  return snapshot;
}

export function resolveNuncioADEStorageSnapshotPath(userDataPath: string): string {
  return Path.join(userDataPath, NUNCIO_STORAGE_SNAPSHOT_FILE_NAME);
}

export function readNuncioADEStorageSnapshot(snapshotPath: string): NuncioADEStorageSnapshot | null {
  try {
    const stats = FS.statSync(snapshotPath);
    if (!stats.isFile() || stats.size > NUNCIO_STORAGE_SNAPSHOT_MAX_BYTES) {
      return null;
    }
    return validateNuncioADEStorageSnapshot(JSON.parse(FS.readFileSync(snapshotPath, "utf8")));
  } catch {
    return null;
  }
}

export async function saveNuncioADEStorageSnapshot(
  snapshotPath: string,
  input: unknown,
): Promise<boolean> {
  const snapshot = validateNuncioADEStorageSnapshot(input);
  if (!snapshot) {
    return false;
  }

  const current = readNuncioADEStorageSnapshot(snapshotPath);
  if (current && Date.parse(current.exportedAt) > Date.parse(snapshot.exportedAt)) {
    return false;
  }

  const parentPath = Path.dirname(snapshotPath);
  const temporaryPath = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`;
  let handle: FS.promises.FileHandle | null = null;
  try {
    await FS.promises.mkdir(parentPath, { recursive: true });
    handle = await FS.promises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(snapshot)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await FS.promises.rename(temporaryPath, snapshotPath);
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
    await FS.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function acknowledgeNuncioADEStorageSnapshot(snapshotPath: string): Promise<void> {
  await FS.promises.rm(snapshotPath, { force: true }).catch(() => undefined);
}
