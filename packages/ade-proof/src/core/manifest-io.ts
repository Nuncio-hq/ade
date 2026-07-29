import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { err, ok } from "./result-helpers.js";
import {
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  type ProofManifest,
  type ProofResult,
} from "./types.js";

const stepSchema = z.object({
  ts: z.string().datetime(),
  label: z.string(),
  target: z.enum(["web", "macos", "electron", "ios-sim", "android"]),
  file: z.string(),
  url: z.string().optional(),
  finalUrl: z.string().optional(),
  httpStatus: z.number().int().optional(),
  truncated: z.boolean().optional(),
  windowTitle: z.string().optional(),
});

const logErrorSchema = z.object({
  source: z.enum(["console", "server"]),
  pattern: z.string(),
  line: z.string(),
});

const manifestSchema = z
  .object({
    version: z.literal(MANIFEST_VERSION),
    id: z.string(),
    description: z.string().optional(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().optional(),
    serverCmd: z.string().optional(),
    steps: z.array(stepSchema),
    errors: z.array(logErrorSchema),
    video: z.string().optional(),
  })
  .passthrough();

export async function writeManifestAtomic(
  manifest: ProofManifest,
  dir: string,
): Promise<ProofResult<void>> {
  const parse = manifestSchema.safeParse(manifest);
  if (!parse.success) {
    return err("invalid-manifest", `Manifest validation failed: ${parse.error.message}`);
  }
  const path = `${dir}/${MANIFEST_FILENAME}`;
  const tmp = `${path}.tmp`;
  try {
    await mkdir(dirname(tmp), { recursive: true });
    await writeFile(tmp, JSON.stringify(manifest, null, 2) + "\n");
    await rename(tmp, path);
    return ok(undefined);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err("disk-write-failed", `Could not write manifest to ${path}: ${reason}`);
  }
}

export async function readManifest(dir: string): Promise<ProofResult<ProofManifest>> {
  const path = `${dir}/${MANIFEST_FILENAME}`;
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const result = manifestSchema.safeParse(parsed);
    if (!result.success) {
      return err("invalid-manifest", `Invalid manifest at ${path}: ${result.error.message}`);
    }
    return ok(result.data as ProofManifest);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err("invalid-manifest", `Could not read manifest at ${path}: ${reason}`);
  }
}
