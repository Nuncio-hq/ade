import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

// Node unit-test config only. Browser suites use vitest.browser*.config.ts and
// must not inherit this setupFiles entry (real Chromium already has localStorage;
// keeping the stub out of vite.config.ts also avoids mergeConfig pulling it into
// Playwright runs that hang CI on dependency optimization).
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      setupFiles: ["./src/test/localStorageStub.ts"],
    },
  }),
);
