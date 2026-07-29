import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import type * as FSPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, writeManifestAtomic } from "../../src/core/manifest-io.js";
import {
  MANIFEST_VERSION,
  type ProofLogError,
  type ProofManifest,
  type ProofStep,
} from "../../src/core/types.js";
import { unwrap, unwrapErr } from "./test-helpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FSPromises>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

function makeManifest(
  props: {
    version?: 1;
    id?: string;
    description?: string;
    startedAt?: string;
    finishedAt?: string;
    serverCmd?: string;
    steps?: ProofStep[];
    errors?: ProofLogError[];
  } = {},
): ProofManifest {
  return {
    version: props.version ?? MANIFEST_VERSION,
    id: props.id ?? "20260729-153000-test",
    startedAt: props.startedAt ?? "2026-07-29T15:30:00.000Z",
    steps: props.steps ?? [],
    errors: props.errors ?? [],
    ...(props.description ? { description: props.description } : {}),
    ...(props.finishedAt ? { finishedAt: props.finishedAt } : {}),
    ...(props.serverCmd ? { serverCmd: props.serverCmd } : {}),
  };
}

describe("manifest schema", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ade-proof-manifest-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("accepts a valid manifest", async () => {
    const manifest = makeManifest();
    unwrap(await writeManifestAtomic(manifest, dir));
    const read = unwrap(await readManifest(dir));
    expect(read.version).toBe(MANIFEST_VERSION);
    expect(read.id).toBe(manifest.id);
  });

  it("rejects an invalid version", async () => {
    const manifest = makeManifest({ version: 2 as 1 });
    const write = await writeManifestAtomic(manifest, dir);
    expect(write.ok).toBe(false);
    expect(unwrapErr(write).code).toBe("invalid-manifest");
  });

  it("rejects an invalid startedAt", async () => {
    const manifest = makeManifest({ startedAt: "not-a-date" });
    const write = await writeManifestAtomic(manifest, dir);
    expect(write.ok).toBe(false);
    expect(unwrapErr(write).code).toBe("invalid-manifest");
  });

  it("ignores unknown keys (forward compat)", async () => {
    const manifest = { ...makeManifest(), extraKey: "keep me" };
    unwrap(await writeManifestAtomic(manifest, dir));
    unwrap(await readManifest(dir));
    const raw: unknown = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8"));
    expect(raw).toMatchObject({ extraKey: "keep me" });
  });
});

describe("atomic write", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ade-proof-atomic-"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(makeManifest()));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("uses manifest.json.tmp and renames", async () => {
    const manifest = makeManifest({ id: "20260729-153000-atomic" });
    unwrap(await writeManifestAtomic(manifest, dir));
    expect(readdirSync(dir)).not.toContain("manifest.json.tmp");
    expect(readFileSync(join(dir, "manifest.json"), "utf-8")).toContain("atomic");
  });

  it("does not corrupt existing manifest if rename fails", async () => {
    const manifest = makeManifest({ id: "20260729-153000-new" });
    vi.mocked(rename).mockRejectedValueOnce(new Error("disk full"));
    const original = readFileSync(join(dir, "manifest.json"), "utf-8");
    const write = await writeManifestAtomic(manifest, dir);
    expect(write.ok).toBe(false);
    expect(unwrapErr(write).code).toBe("disk-write-failed");
    const after = readFileSync(join(dir, "manifest.json"), "utf-8");
    expect(after).toBe(original);
    expect(after).not.toContain("new");
  });
});
