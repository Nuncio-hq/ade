// FILE: localStorageStub.ts
// Purpose: Installs a functional in-memory localStorage before any test module
// evaluates. Node >= 22 defines a global localStorage getter that returns
// undefined unless --localstorage-file is passed, and zustand's persist
// middleware resolves its storage once at store creation — so tests cannot
// repair it afterwards from a beforeEach. Only installs when no working
// localStorage exists, so real browser runs (vitest browser mode) keep theirs.
// Kept writable/configurable so test files that swap in their own memory
// storage keep working.
// Layer: Test setup

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
  };
}

let existing: Storage | undefined;
try {
  existing = globalThis.localStorage;
} catch {
  existing = undefined;
}

if (existing === undefined) {
  Object.defineProperty(globalThis, "localStorage", {
    value: createMemoryStorage(),
    configurable: true,
    writable: true,
  });
}
