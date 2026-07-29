import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitignoreWarning, hasGitignoreAde, renderSummary } from "../../src/core/summary-writer.js";
import { MANIFEST_VERSION, type ProofManifest, type ProofStep } from "../../src/core/types.js";

function makeManifest(
  props: {
    description?: string;
    startedAt?: string;
    finishedAt?: string;
    steps?: ProofStep[];
    errors?: { source: "console" | "server"; pattern: string; line: string }[];
    video?: string;
  } = {},
): ProofManifest {
  return {
    version: MANIFEST_VERSION,
    id: "20260729-153000-test",
    startedAt: props.startedAt ?? "2026-07-29T15:30:00.000Z",
    steps: props.steps ?? [],
    errors: props.errors ?? [],
    ...(props.description ? { description: props.description } : {}),
    ...(props.finishedAt ? { finishedAt: props.finishedAt } : {}),
    ...(props.video ? { video: props.video } : {}),
  };
}

describe("renderSummary flags", () => {
  it("flags requestedUrl != finalUrl", () => {
    const manifest = makeManifest({
      steps: [
        {
          ts: "2026-07-29T15:30:01.000Z",
          label: "login",
          target: "web",
          file: "step-01-login.png",
          url: "http://localhost/login",
          finalUrl: "http://localhost/home",
        },
      ],
    });
    const out = renderSummary(manifest, []);
    expect(out).toContain("redirected");
    expect(out).toContain("http://localhost/login");
    expect(out).toContain("http://localhost/home");
  });

  it("flags httpStatus >= 400", () => {
    const manifest = makeManifest({
      steps: [
        {
          ts: "2026-07-29T15:30:01.000Z",
          label: "bad",
          target: "web",
          file: "step-01-bad.png",
          url: "http://localhost/missing",
          httpStatus: 404,
        },
      ],
    });
    const out = renderSummary(manifest, []);
    expect(out).toContain("HTTP 404");
  });

  it("flags truncated", () => {
    const manifest = makeManifest({
      steps: [
        {
          ts: "2026-07-29T15:30:01.000Z",
          label: "long",
          target: "web",
          file: "step-01-long.png",
          truncated: true,
        },
      ],
    });
    const out = renderSummary(manifest, []);
    expect(out).toContain("truncated");
  });

  it("warns when .gitignore does not ignore .ade/", () => {
    const manifest = makeManifest();
    const out = renderSummary(manifest, [
      'No .gitignore found at workspace root. Add ".ade/" to avoid committing artifacts.',
    ]);
    expect(out).toContain(".gitignore");
  });
});

describe("gitignore check", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ade-proof-gitignore-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports missing .gitignore", () => {
    expect(hasGitignoreAde(dir)).toBe(false);
    expect(gitignoreWarning(dir)).toContain('Add ".ade/"');
  });

  it("accepts .ade/", () => {
    writeFileSync(join(dir, ".gitignore"), ".ade/\n");
    expect(hasGitignoreAde(dir)).toBe(true);
    expect(gitignoreWarning(dir)).toBeUndefined();
  });

  it("accepts .ade", () => {
    writeFileSync(join(dir, ".gitignore"), ".ade\n");
    expect(hasGitignoreAde(dir)).toBe(true);
  });

  it("does not edit the user .gitignore file", () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    gitignoreWarning(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toBe("node_modules/\n");
  });
});
