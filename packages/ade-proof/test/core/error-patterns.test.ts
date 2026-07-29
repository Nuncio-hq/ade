import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { scanErrors, stripAnsi } from "../../src/core/error-patterns.js";

function fixture(name: string): readonly string[] {
  return readFileSync(new URL(`fixtures/logs/${name}`, import.meta.url), "utf-8").split("\n");
}

describe("stripAnsi", () => {
  it("removes color codes", () => {
    expect(stripAnsi("\u001b[31mError\u001b[0m")).toBe("Error");
  });
});

describe("scanErrors", () => {
  it("detects a JavaScript error and one stack block", () => {
    const lines = fixture("node-error.log");
    const errors = scanErrors(lines, "server");
    const js = errors.filter((e) => e.pattern === "js-error");
    expect(js.length).toBe(1);
    expect(js[0]?.line).toContain("Cannot find module");
  });

  it("does not match '0 errors' or 'error-free' false positives", () => {
    const lines = fixture("node-error.log");
    const errors = scanErrors(lines, "server");
    expect(errors.some((e) => e.line.includes("0 errors"))).toBe(false);
    expect(errors.some((e) => e.line.includes("error-free"))).toBe(false);
  });

  it("detects a Python error", () => {
    const lines = fixture("python-error.log");
    const errors = scanErrors(lines, "server");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.pattern === "py-error")).toBe(true);
  });

  it("strips ANSI before matching", () => {
    const lines = fixture("ansi-error.log");
    const errors = scanErrors(lines, "server");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.line).toBe("Error: connection refused");
  });
});
