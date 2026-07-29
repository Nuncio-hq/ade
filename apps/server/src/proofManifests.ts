// FILE: proofManifests.ts
// Purpose: Resolve and read proof-of-work session manifests from disk.
// Layer: Server HTTP utility
// Exports: manifest Schema, resolveAllowedProofFile, readProofManifests
// Depends on: node fs, effect Schema

import fs from "node:fs/promises";
import nodePath from "node:path";

import { Schema } from "effect";

import { ProofManifest } from "./proofManifests.schema.ts";

const PROOF_DIR_NAME = ".ade/proof";
const MANIFEST_FILENAME = "manifest.json";
const ALLOWED_PROOF_EXTENSIONS: Record<string, true> = {
  png: true,
  webm: true,
  md: true,
  json: true,
};
function isPathInside(candidate: string, root: string): boolean {
  const relative = nodePath.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative));
}

async function realpathOrNull(candidate: string | undefined): Promise<string | null> {
  if (!candidate) {
    return null;
  }
  try {
    return await fs.realpath(candidate);
  } catch {
    return null;
  }
}

async function findGitRoot(startPath: string): Promise<string | null> {
  let current = nodePath.resolve(startPath);
  while (true) {
    try {
      const stat = await fs.stat(nodePath.join(current, ".git"));
      if (stat.isDirectory() || stat.isFile()) {
        return current;
      }
    } catch {
      // Keep walking until we hit the filesystem root.
    }

    const parent = nodePath.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function resolveWorkspaceRoot(cwd: string | null): Promise<string | null> {
  if (!cwd) {
    return null;
  }
  const realCwd = await realpathOrNull(cwd);
  if (!realCwd) {
    return null;
  }
  const gitRoot = await findGitRoot(realCwd);
  return (gitRoot ? await realpathOrNull(gitRoot) : realCwd) ?? null;
}

export async function resolveAllowedProofFile(input: {
  readonly requestedPath: string | null;
  readonly cwd: string | null;
}): Promise<{ path: string; fileName: string; sizeBytes: number } | null> {
  const requestedPath = input.requestedPath?.trim();
  if (!requestedPath || requestedPath.includes("\0")) {
    return null;
  }

  const resolvedRequestedPath = nodePath.isAbsolute(requestedPath)
    ? nodePath.resolve(requestedPath)
    : nodePath.resolve(input.cwd ?? process.cwd(), requestedPath);
  const realFilePath = await realpathOrNull(resolvedRequestedPath);
  if (!realFilePath) {
    return null;
  }

  const ext = nodePath.extname(realFilePath).slice(1).toLowerCase();
  if (!ALLOWED_PROOF_EXTENSIONS[ext]) {
    return null;
  }

  const workspaceRoot = await resolveWorkspaceRoot(input.cwd);
  if (!workspaceRoot) {
    return null;
  }
  const realProofDir = (await realpathOrNull(nodePath.join(workspaceRoot, PROOF_DIR_NAME))) ?? null;
  if (!realProofDir || !isPathInside(realFilePath, realProofDir)) {
    return null;
  }

  const stat = await fs.stat(realFilePath).catch(() => null);
  if (!stat?.isFile()) {
    return null;
  }

  return {
    path: realFilePath,
    fileName: nodePath.basename(realFilePath),
    sizeBytes: stat.size,
  };
}

export async function readProofManifests(input: {
  readonly cwd: string | null;
}): Promise<readonly ProofManifest[]> {
  const workspaceRoot = await resolveWorkspaceRoot(input.cwd);
  if (!workspaceRoot) {
    return [];
  }

  const realProofDir = await realpathOrNull(nodePath.join(workspaceRoot, PROOF_DIR_NAME));
  if (!realProofDir) {
    return [];
  }

  let entries: string[];
  try {
    entries = await fs.readdir(realProofDir);
  } catch {
    return [];
  }

  const manifests: ProofManifest[] = [];
  for (const entry of entries) {
    const sessionDir = nodePath.join(realProofDir, entry);
    const stat = await fs.stat(sessionDir).catch(() => null);
    if (!stat?.isDirectory()) {
      continue;
    }

    const manifestPath = nodePath.join(sessionDir, MANIFEST_FILENAME);
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, "utf-8");
    } catch {
      continue;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }

    try {
      const manifest = Schema.decodeUnknownSync(ProofManifest)(json);
      manifests.push(manifest);
    } catch {
      // Ignore malformed manifests so one bad session does not break the list.
    }
  }

  manifests.sort((a, b) => {
    const aStarted = a.startedAt ?? "";
    const bStarted = b.startedAt ?? "";
    return bStarted.localeCompare(aStarted);
  });

  return manifests;
}
