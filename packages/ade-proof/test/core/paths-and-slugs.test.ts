import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveWorkspaceRoot, slugify } from "../../src/core/paths-and-slugs.js";
import { unwrap, unwrapErr } from "./test-helpers.js";

describe("slugify", () => {
  it("replaces spaces with hyphens", () => {
    expect(slugify("hello world")).toBe("hello-world");
  });

  it("handles unicode and diacritics", () => {
    expect(slugify("Über Café")).toBe("uber-cafe");
  });

  it("removes special characters", () => {
    expect(slugify("foo/bar!baz")).toBe("foo-bar-baz");
  });

  it("is URL-safe (no spaces)", () => {
    const out = slugify("hello world test");
    expect(out).not.toMatch(/\s/);
    expect(out).toBe("hello-world-test");
  });
});

describe("resolveWorkspaceRoot", () => {
  let base: string;
  let repo: string;
  let worktree: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "ade-proof-git-"));
    repo = join(base, "repo");
    worktree = join(base, "wt");
    execSync(`mkdir -p ${repo}/sub && git init ${repo}`, { stdio: "ignore" });
    execSync(`git -C ${repo} config user.email "t@t" && git -C ${repo} config user.name "t"`, {
      stdio: "ignore",
    });
    writeFileSync(join(repo, "a.txt"), "a");
    execSync(`git -C ${repo} add a.txt && git -C ${repo} commit -m init`, { stdio: "ignore" });
    execSync(`git -C ${repo} worktree add ${worktree}`, { stdio: "ignore" });
    execSync(`mkdir -p ${worktree}/deep`, { stdio: "ignore" });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("resolves a subdirectory to the git root", async () => {
    const result = await resolveWorkspaceRoot(join(repo, "sub"));
    expect(unwrap(result)).toBe(realpathSync(repo));
  });

  it("resolves a git worktree to the worktree root", async () => {
    const result = await resolveWorkspaceRoot(join(worktree, "deep"));
    expect(unwrap(result)).toBe(realpathSync(worktree));
  });

  it("returns an error outside a git repo", async () => {
    const nonGit = mkdtempSync(join(tmpdir(), "not-git-"));
    const result = await resolveWorkspaceRoot(nonGit);
    expect(unwrapErr(result).code).toBe("invalid-manifest");
    rmSync(nonGit, { recursive: true, force: true });
  });
});

describe("resolveWorkspaceRoot edge cases", () => {
  it("resolves a workspace path containing spaces and unicode", async () => {
    const base = mkdtempSync(join(tmpdir(), "ade-proof-edge-"));
    const spaceRepo = join(base, "my repo こんにちは");
    execSync(`mkdir -p "${spaceRepo}/sub" && git init "${spaceRepo}"`, { stdio: "ignore" });
    execSync(
      `git -C "${spaceRepo}" config user.email "t@t" && git -C "${spaceRepo}" config user.name "t"`,
      { stdio: "ignore" },
    );
    writeFileSync(join(spaceRepo, "a.txt"), "a");
    execSync(`git -C "${spaceRepo}" add a.txt && git -C "${spaceRepo}" commit -m init`, {
      stdio: "ignore",
    });

    const result = await resolveWorkspaceRoot(join(spaceRepo, "sub"));
    expect(unwrap(result)).toBe(realpathSync(spaceRepo));

    rmSync(base, { recursive: true, force: true });
  });
});
