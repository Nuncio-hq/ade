import type { StateStorage } from "zustand/middleware";

/**
 * Zustand's `createJSONStorage` calls its getter once, when the store module is
 * evaluated. A bare `localStorage` reference throws outside a browser, so the
 * storage resolves to `undefined` and every later persist write dies on
 * `undefined.setItem`.
 *
 * Resolving through `globalThis` on each call keeps persisted stores importable
 * from non-browser contexts, and lets tests swap `globalThis.localStorage`
 * between cases instead of being stuck with whatever existed at import time.
 */
function currentLocalStorage(): Storage | undefined {
  return typeof globalThis.localStorage === "undefined" ? undefined : globalThis.localStorage;
}

export function createLocalStorageStateStorage(): StateStorage {
  return {
    getItem: (name) => currentLocalStorage()?.getItem(name) ?? null,
    setItem: (name, value) => {
      currentLocalStorage()?.setItem(name, value);
    },
    removeItem: (name) => {
      currentLocalStorage()?.removeItem(name);
    },
  };
}
