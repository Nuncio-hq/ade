import { describe, expect, test } from "vitest";
import { parseWindowList } from "../../src/capture/macos.js";

const FIXTURE = JSON.stringify([
  {
    kCGWindowNumber: 1,
    kCGWindowOwnerName: "Safari",
    kCGWindowName: "Hello World",
    kCGWindowLayer: 0,
    kCGWindowAlpha: 1,
  },
  {
    kCGWindowNumber: 2,
    kCGWindowOwnerName: "Finder",
    kCGWindowName: "Documents",
    kCGWindowLayer: 0,
    kCGWindowAlpha: 1,
  },
  {
    kCGWindowNumber: 3,
    kCGWindowOwnerName: "Control Centre",
    kCGWindowLayer: 25,
    kCGWindowAlpha: 1,
  },
  { kCGWindowNumber: 4, kCGWindowOwnerName: "Ghostty", kCGWindowLayer: 0, kCGWindowAlpha: 0 },
]);

describe("macos window-list parser", () => {
  test("filters layer 0 and visible only", () => {
    const all = parseWindowList(FIXTURE);
    expect(all.map((w) => w.id)).toEqual([1, 2]);
  });

  test("matches owner substring", () => {
    const hits = parseWindowList(FIXTURE, "Safari");
    expect(hits).toHaveLength(1);
    const first = hits[0];
    if (!first) throw new Error("expected one hit");
    expect(first.owner).toBe("Safari");
    expect(first.title).toBe("Hello World");
  });

  test("matches title substring", () => {
    const hits = parseWindowList(FIXTURE, "World");
    expect(hits).toHaveLength(1);
    const first = hits[0];
    if (!first) throw new Error("expected one hit");
    expect(first.id).toBe(1);
  });

  test("matches owner or title case-insensitively", () => {
    const hits = parseWindowList(FIXTURE, "documents");
    expect(hits).toHaveLength(1);
    const first = hits[0];
    if (!first) throw new Error("expected one hit");
    expect(first.owner).toBe("Finder");
  });

  test("excludes non-visible and non-layer-0", () => {
    const hits = parseWindowList(FIXTURE, "Control");
    expect(hits).toHaveLength(0);
  });

  test("returns multiple matches for ambiguous queries", () => {
    const hits = parseWindowList(FIXTURE, "o");
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });
});
