// FILE: fenceRenderers.test.ts
// Purpose: Covers the fence renderer registry lookup contract.

import { describe, expect, it } from "vitest";
import { getFenceRenderer } from "./fenceRenderers";

describe("getFenceRenderer", () => {
  it("resolves mermaid fences case-insensitively", () => {
    expect(getFenceRenderer("mermaid")).not.toBeNull();
    expect(getFenceRenderer("Mermaid")).not.toBeNull();
    expect(getFenceRenderer("MERMAID")).not.toBeNull();
  });

  it("leaves ordinary code fences to the plain code path", () => {
    expect(getFenceRenderer("ts")).toBeNull();
    expect(getFenceRenderer("text")).toBeNull();
    expect(getFenceRenderer("")).toBeNull();
  });
});
