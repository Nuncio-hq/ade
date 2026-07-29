import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";

import { resolveAllowedLocalPreviewFile } from "./localImageFiles.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveAllowedLocalPreviewFile", () => {
  it("allows images inside the current workspace", async () => {
    const workspace = makeTempDir("nuncioade-image-workspace-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const imagePath = path.join(workspace, "preview.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: imagePath,
      cwd: workspace,
    });

    assert.equal(result?.path, realpathSync(imagePath));
    assert.equal(result?.fileName, "preview.png");
  });

  it("allows images inside Codex generated_images without a cwd", async () => {
    const codexHome = makeTempDir("nuncioade-codex-home-");
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const imageDir = path.join(codexHome, "generated_images", "provider-thread");
      const imagePath = path.join(imageDir, "call.png");
      mkdirSync(imageDir, { recursive: true });
      writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: imagePath,
        cwd: null,
      });

      assert.equal(result?.path, realpathSync(imagePath));
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
    }
  });

  it("allows images written to the NUNCIO_HOME codex-home-overlay generated_images root", async () => {
    // Codex app-server is launched with CODEX_HOME pointing at a NuncioADE overlay
    // directory (see resolveNuncioADECodexHomeOverlayPath). Generated images therefore
    // live under <NUNCIO_HOME>/codex-home-overlay/generated_images/<thread>/<call>.png,
    // which sits outside both the user's `~/.codex` source home and any workspace
    // root. The allowlist must still serve them.
    //
    // We anchor the fake homes inside the worktree (process.cwd() resolves to
    // apps/server/ when vitest runs) so neither path falls under os.tmpdir(); that
    // way only the overlay candidate can satisfy the allowlist.
    const fakeRoot = path.join(process.cwd(), `.test-codex-overlay-${process.pid}-${Date.now()}`);
    const sourceHome = path.join(fakeRoot, "source", ".codex");
    const nuncioadeHome = path.join(fakeRoot, "nuncioade", "runtime");
    const overlayImageDir = path.join(
      nuncioadeHome,
      "codex-home-overlay",
      "generated_images",
      "thread-overlay",
    );
    const imagePath = path.join(overlayImageDir, "call.png");
    mkdirSync(overlayImageDir, { recursive: true });
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const previousNuncioADEHome = process.env.NUNCIO_HOME;
    process.env.NUNCIO_HOME = nuncioadeHome;
    try {
      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: imagePath,
        cwd: null,
        codexHomePath: sourceHome,
      });

      assert.equal(result?.path, realpathSync(imagePath));
    } finally {
      if (previousNuncioADEHome === undefined) {
        delete process.env.NUNCIO_HOME;
      } else {
        process.env.NUNCIO_HOME = previousNuncioADEHome;
      }
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it("allows PDFs inside the current workspace", async () => {
    const workspace = makeTempDir("nuncioade-pdf-workspace-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const pdfPath = path.join(workspace, "docs", "spec.pdf");
    mkdirSync(path.dirname(pdfPath), { recursive: true });
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: pdfPath,
      cwd: workspace,
    });

    assert.equal(result?.path, realpathSync(pdfPath));
    assert.equal(result?.fileName, "spec.pdf");
    assert.equal(result?.sizeBytes, 8);
  });

  it("allows PDFs inside a per-thread scratch workspace without a cwd", async () => {
    // Sessions that start before a project workspace exists run in
    // <tmpdir>/nuncioade-codex-workspaces/<threadId>; files agents create there
    // are workspace-equivalent, so documents must be servable from that root.
    const scratchRoot = path.join(os.tmpdir(), "nuncioade-codex-workspaces");
    const threadDir = path.join(scratchRoot, `test-thread-${process.pid}-${Date.now()}`);
    const pdfPath = path.join(threadDir, "viewer-test.pdf");
    mkdirSync(threadDir, { recursive: true });
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));
    try {
      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: pdfPath,
        cwd: null,
      });

      assert.equal(result?.path, realpathSync(pdfPath));
      assert.equal(result?.fileName, "viewer-test.pdf");
      assert.equal(result?.sizeBytes, 8);
    } finally {
      // Remove only the per-thread dir — the shared scratch root may belong
      // to a live server.
      rmSync(threadDir, { recursive: true, force: true });
    }
  });

  it("rejects PDFs outside the workspace even under the temp-dir image roots", async () => {
    // Temp/generated-image roots exist for agent-produced images in chat
    // markdown; documents must only ever be served from the workspace.
    const tempDir = makeTempDir("nuncioade-pdf-outside-");
    const pdfPath = path.join(tempDir, "leak.pdf");
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: pdfPath,
      cwd: null,
    });

    assert.equal(result, null);
  });

  it("still allows images under the temp-dir roots without a workspace", async () => {
    const tempDir = makeTempDir("nuncioade-image-tmp-root-");
    const imagePath = path.join(tempDir, "clip.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: imagePath,
      cwd: null,
    });

    assert.equal(result?.path, realpathSync(imagePath));
  });

  it("allows ade-proof artifacts of a foreign git repo (outside cwd workspace and temp roots)", async () => {
    // Home-based dir: NOT under the temp roots, so only the .ade/proof branch can allow it.
    const repo = mkdtempSync(path.join(os.homedir(), ".nuncioade-test-proof-"));
    tempDirs.push(repo);
    writeFileSync(path.join(repo, ".git"), "gitdir: elsewhere");
    const proofDir = path.join(repo, ".ade", "proof", "20260729-000000-x");
    mkdirSync(proofDir, { recursive: true });
    const imagePath = path.join(proofDir, "step-01.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const foreignWorkspace = makeTempDir("nuncioade-foreign-ws-");

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: imagePath,
      cwd: foreignWorkspace,
    });

    assert.equal(result?.path, realpathSync(imagePath));
  });

  it("does not let the ade-proof branch serve repo files outside .ade/proof", async () => {
    const repo = mkdtempSync(path.join(os.homedir(), ".nuncioade-test-proof-"));
    tempDirs.push(repo);
    writeFileSync(path.join(repo, ".git"), "gitdir: elsewhere");
    const imagePath = path.join(repo, "docs.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: imagePath,
      cwd: makeTempDir("nuncioade-foreign-ws-"),
    });

    assert.equal(result, null);
  });

  it("requires the .git marker exactly at the .ade/proof parent", async () => {
    const outer = mkdtempSync(path.join(os.homedir(), ".nuncioade-test-proof-"));
    tempDirs.push(outer);
    writeFileSync(path.join(outer, ".git"), "gitdir: elsewhere");
    // .ade/proof nested one level BELOW the git root's child dir with no .git of its own
    const proofDir = path.join(outer, "sub", ".ade", "proof");
    mkdirSync(proofDir, { recursive: true });
    const imagePath = path.join(proofDir, "step-01.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: imagePath,
      cwd: makeTempDir("nuncioade-foreign-ws-"),
    });

    assert.equal(result, null);
  });

  it("rejects unsupported paths", async () => {
    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: "/etc/hosts",
      cwd: null,
    });

    assert.equal(result, null);
  });
});
