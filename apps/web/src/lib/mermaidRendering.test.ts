// FILE: mermaidRendering.test.ts
// Purpose: Covers the mermaid render pipeline's caching contract — success and
//          failure memoization and per-theme initialization/keying.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { initializeMock, parseMock, renderMock } = vi.hoisted(() => ({
  initializeMock: vi.fn(),
  parseMock: vi.fn(),
  renderMock: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: { initialize: initializeMock, parse: parseMock, render: renderMock },
}));

// The module memoizes renders in module state; each test gets a fresh instance.
async function loadFreshModule() {
  vi.resetModules();
  return await import("./mermaidRendering");
}

describe("renderMermaidSvg", () => {
  beforeEach(() => {
    initializeMock.mockReset();
    parseMock.mockReset();
    renderMock.mockReset();
  });

  it("renders once and serves repeats from the cache", async () => {
    const { renderMermaidSvg, getCachedMermaidSvg } = await loadFreshModule();
    parseMock.mockResolvedValue(true);
    renderMock.mockResolvedValue({ svg: "<svg>ok</svg>" });

    expect(getCachedMermaidSvg("graph TD; a-->b", "light")).toBeUndefined();
    await expect(renderMermaidSvg("graph TD; a-->b", "light")).resolves.toBe("<svg>ok</svg>");
    await expect(renderMermaidSvg("graph TD; a-->b", "light")).resolves.toBe("<svg>ok</svg>");

    expect(renderMock).toHaveBeenCalledTimes(1);
    expect(getCachedMermaidSvg("graph TD; a-->b", "light")).toBe("<svg>ok</svg>");
  });

  it("caches parse failures so invalid source is not re-parsed", async () => {
    const { renderMermaidSvg, getCachedMermaidSvg } = await loadFreshModule();
    parseMock.mockRejectedValue(new Error("nope"));

    await expect(renderMermaidSvg("not a diagram", "light")).resolves.toBeNull();
    await expect(renderMermaidSvg("not a diagram", "light")).resolves.toBeNull();

    expect(parseMock).toHaveBeenCalledTimes(1);
    expect(renderMock).not.toHaveBeenCalled();
    // null (known-invalid) must stay distinguishable from undefined (never rendered).
    expect(getCachedMermaidSvg("not a diagram", "light")).toBeNull();
  });

  it("re-initializes per theme and keys the cache by theme", async () => {
    const { renderMermaidSvg } = await loadFreshModule();
    parseMock.mockResolvedValue(true);
    renderMock
      .mockResolvedValueOnce({ svg: "<svg>light</svg>" })
      .mockResolvedValueOnce({ svg: "<svg>dark</svg>" });

    await expect(renderMermaidSvg("graph TD; a-->b", "light")).resolves.toBe("<svg>light</svg>");
    await expect(renderMermaidSvg("graph TD; a-->b", "dark")).resolves.toBe("<svg>dark</svg>");

    expect(renderMock).toHaveBeenCalledTimes(2);
    expect(initializeMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ securityLevel: "strict", theme: "neutral" }),
    );
    expect(initializeMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ securityLevel: "strict", theme: "dark" }),
    );
  });
});
