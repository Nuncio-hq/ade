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
    const lines = fixture("node-error.log.txt");
    const errors = scanErrors(lines, "server");
    const js = errors.filter((e) => e.pattern === "js-error");
    expect(js.length).toBe(1);
    expect(js[0]?.line).toContain("Cannot find module");
  });

  it("does not match '0 errors' or 'error-free' false positives", () => {
    const lines = fixture("node-error.log.txt");
    const errors = scanErrors(lines, "server");
    expect(errors.some((e) => e.line.includes("0 errors"))).toBe(false);
    expect(errors.some((e) => e.line.includes("error-free"))).toBe(false);
  });

  it("detects a Python error", () => {
    const lines = fixture("python-error.log.txt");
    const errors = scanErrors(lines, "server");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.pattern === "py-error")).toBe(true);
  });

  it("strips ANSI before matching", () => {
    const lines = fixture("ansi-error.log.txt");
    const errors = scanErrors(lines, "server");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.line).toBe("Error: connection refused");
  });

  it("detects browser console failed-resource lines (any HTTP status wording)", () => {
    const errors = scanErrors(
      [
        "Failed to load resource: the server responded with a status of 500 (Internal Server Error)",
      ],
      "console",
    );
    expect(errors.length).toBe(1);
    expect(errors[0]?.pattern).toBe("console-failed-resource");
    expect(errors[0]?.source).toBe("console");
  });

  it("detects uncaught browser errors and rejections", () => {
    const errors = scanErrors(
      ["Uncaught TypeError: x is not a function", "Uncaught (in promise) boom"],
      "console",
    );
    expect(errors.map((e) => e.pattern)).toEqual(["console-uncaught", "console-uncaught"]);
  });
});
