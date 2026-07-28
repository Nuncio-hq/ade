import { describe, expect, it, vi } from "vitest";

import {
  extractManagedCodexConfigSection,
  LEGACY_MANAGED_CODEX_CONFIG_BEGIN,
  LEGACY_MANAGED_CODEX_CONFIG_END,
  linkOrCopyCodexOverlayEntry,
  normalizeLegacyManagedCodexConfigMarkers,
  NUNCIO_MANAGED_CODEX_CONFIG_BEGIN,
  NUNCIO_MANAGED_CODEX_CONFIG_END,
  prioritizeCodexOverlayEntries,
} from "./codexProcessEnv";

describe("linkOrCopyCodexOverlayEntry", () => {
  it("copies auth.json when symlink creation is unavailable", async () => {
    const symlink = vi.fn(async () => {
      throw new Error("symlinks unavailable");
    });
    const copyFile = vi.fn(async () => undefined);

    await linkOrCopyCodexOverlayEntry(
      {
        entryName: "auth.json",
        sourcePath: "C:\\Users\\test\\.codex\\auth.json",
        targetPath: "C:\\Users\\test\\.nuncioade\\codex-home-overlay\\auth.json",
        type: "file",
      },
      { symlink, copyFile },
    );

    expect(symlink).toHaveBeenCalledWith(
      "C:\\Users\\test\\.codex\\auth.json",
      "C:\\Users\\test\\.nuncioade\\codex-home-overlay\\auth.json",
      "file",
    );
    expect(copyFile).toHaveBeenCalledWith(
      "C:\\Users\\test\\.codex\\auth.json",
      "C:\\Users\\test\\.nuncioade\\codex-home-overlay\\auth.json",
    );
  });

  it("keeps symlink failures visible for other overlay entries", async () => {
    const symlink = vi.fn(async () => {
      throw new Error("symlinks unavailable");
    });

    await expect(
      linkOrCopyCodexOverlayEntry(
        {
          entryName: "sessions",
          sourcePath: "C:\\Users\\test\\.codex\\sessions",
          targetPath: "C:\\Users\\test\\.nuncioade\\codex-home-overlay\\sessions",
          type: "dir",
        },
        { symlink, copyFile: vi.fn(async () => undefined) },
      ),
    ).rejects.toThrow("symlinks unavailable");
  });
});

describe("prioritizeCodexOverlayEntries", () => {
  it("prepares auth.json before entries whose symlinks may fail first", () => {
    expect(prioritizeCodexOverlayEntries(["sessions", "auth.json", "config.toml"])).toEqual([
      "auth.json",
      "sessions",
      "config.toml",
    ]);
  });
});

describe("managed codex config legacy markers", () => {
  it("extracts sections written with legacy markers", () => {
    const config = [
      "[model]",
      'model = "gpt-5"',
      "",
      LEGACY_MANAGED_CODEX_CONFIG_BEGIN,
      "[mcp_servers.browser]",
      'url = "http://localhost:1234"',
      LEGACY_MANAGED_CODEX_CONFIG_END,
      "",
    ].join("\n");

    expect(extractManagedCodexConfigSection(config)).toBe(
      '[mcp_servers.browser]\nurl = "http://localhost:1234"',
    );
  });

  it("normalizes legacy markers to the current identity, idempotently", () => {
    const legacyConfig = `${LEGACY_MANAGED_CODEX_CONFIG_BEGIN}\nfoo = 1\n${LEGACY_MANAGED_CODEX_CONFIG_END}`;
    const expected = `${NUNCIO_MANAGED_CODEX_CONFIG_BEGIN}\nfoo = 1\n${NUNCIO_MANAGED_CODEX_CONFIG_END}`;

    const normalized = normalizeLegacyManagedCodexConfigMarkers(legacyConfig);
    expect(normalized).toBe(expected);
    expect(normalizeLegacyManagedCodexConfigMarkers(normalized)).toBe(expected);
  });
});
