// FILE: storageOriginMigration.ts
// Purpose: Imports NuncioADE browser state before renderer stores hydrate after a desktop origin move.

import type { NuncioADEStorageSnapshot } from "@nuncio/contracts";

const MAX_SNAPSHOT_ENTRIES = 2_048;
const MAX_SNAPSHOT_KEY_LENGTH = 512;
const MAX_SNAPSHOT_VALUE_LENGTH = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

// Key prefixes written by the pre-rebrand identity. Kept forever so installs
// upgrading across the rename self-migrate; rebrand-exempt pins the literals.
export const LEGACY_STORAGE_KEY_PREFIXES = ["synara:", "synara."] as const; // rebrand-exempt
const CURRENT_STORAGE_KEY_PREFIXES = ["nuncioade:", "nuncioade."] as const;

function isCanonicalStorageKey(key: string): boolean {
  return CURRENT_STORAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function getLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function importNuncioADEStorageSnapshot(
  snapshot: NuncioADEStorageSnapshot | null,
  storage = getLocalStorage(),
): boolean {
  if (!snapshot || !storage || snapshot.version !== 1 || !snapshot.entries) return false;
  const entries = Object.entries(snapshot.entries);
  if (entries.length > MAX_SNAPSHOT_ENTRIES) return false;

  try {
    if (
      !Number.isFinite(Date.parse(snapshot.exportedAt)) ||
      new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_SNAPSHOT_BYTES
    ) {
      return false;
    }
    for (const [key, value] of entries) {
      if (
        !isCanonicalStorageKey(key) ||
        key.length > MAX_SNAPSHOT_KEY_LENGTH ||
        typeof value !== "string" ||
        value.length > MAX_SNAPSHOT_VALUE_LENGTH
      ) {
        return false;
      }
    }
    for (const [key, value] of entries) {
      if (storage.getItem(key) === null) storage.setItem(key, value);
    }
    return true;
  } catch {
    return false;
  }
}

export function migrateLegacyStorageKeyPrefixes(storage = getLocalStorage()): number {
  if (!storage) return 0;
  try {
    const renames: Array<{ from: string; to: string }> = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key) continue;
      const legacyIndex = LEGACY_STORAGE_KEY_PREFIXES.findIndex((prefix) => key.startsWith(prefix));
      if (legacyIndex === -1) continue;
      renames.push({
        from: key,
        to: `${CURRENT_STORAGE_KEY_PREFIXES[legacyIndex]}${key.slice(LEGACY_STORAGE_KEY_PREFIXES[legacyIndex]!.length)}`,
      });
    }
    let migrated = 0;
    for (const { from, to } of renames) {
      const value = storage.getItem(from);
      if (value === null) continue;
      if (storage.getItem(to) === null) storage.setItem(to, value);
      storage.removeItem(from);
      migrated += 1;
    }
    return migrated;
  } catch {
    return 0;
  }
}

export function bootstrapNuncioADEStorageOriginMigration(): void {
  migrateLegacyStorageKeyPrefixes();
  const bridge = globalThis.window?.desktopBridge?.storageMigration;
  if (!bridge) return;

  try {
    const snapshot = bridge.readSnapshot();
    if (snapshot && importNuncioADEStorageSnapshot(snapshot)) {
      void bridge.acknowledgeSnapshot().catch(() => undefined);
    }
  } catch {
    // Keep the snapshot for a later retry if preload or storage is unavailable.
  }
}

bootstrapNuncioADEStorageOriginMigration();
