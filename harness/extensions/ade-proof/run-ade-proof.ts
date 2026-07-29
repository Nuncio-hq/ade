import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExecResult, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export interface ShotResult {
  /** Workspace-relative path to the captured PNG. */
  relPath: string;
  /** Absolute filesystem path. */
  absPath: string;
  /** Human-readable label. */
  label: string;
}

interface ProofSuccess<T> {
  ok: true;
  value: T;
}

interface ProofFailure {
  ok: false;
  error: { code: string; message: string };
}

type ProofJson<T> = ProofSuccess<T> | ProofFailure;

function parseCliJson<T>(stdout: string): ProofJson<T> {
  const text = stdout.trim();
  const newline = text.lastIndexOf("\n");
  const lastLine = newline >= 0 ? text.slice(newline + 1) : text;
  try {
    return JSON.parse(lastLine) as ProofJson<T>;
  } catch {
    throw new Error(`Could not parse ade-proof JSON output: ${text.slice(0, 200)}`);
  }
}

export interface RunShotOptions {
  target: "web" | "macos";
  label: string;
  url?: string;
  selector?: string;
  fullPage?: boolean;
  windowTitle?: string;
  cwd: string;
  exec: (
    command: string,
    args: string[],
    options?: { cwd?: string; timeout?: number },
  ) => Promise<ExecResult>;
}

export async function runAdeProofShot(opts: RunShotOptions): Promise<ShotResult> {
  const cli = await resolveAdeProofCliPath();
  const args = [cli, "shot", "--target", opts.target, "--label", opts.label, "--json"];

  if (opts.url) args.push("--url", opts.url);
  if (opts.selector) args.push("--selector", opts.selector);
  if (opts.fullPage) args.push("--full-page");
  if (opts.windowTitle) args.push("--window", opts.windowTitle);

  const result = await opts.exec("bun", args, { cwd: opts.cwd, timeout: 120_000 });
  if (result.code !== 0) {
    throw new Error(
      `ade-proof shot failed (exit ${result.code}): ${result.stderr || result.stdout}`,
    );
  }

  const parsed = parseCliJson<{ file: string; [k: string]: unknown }>(result.stdout);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }

  const relPath = parsed.value.file;
  const absPath = resolve(opts.cwd, relPath);
  return { relPath, absPath, label: opts.label };
}

export async function readImageBase64(absPath: string): Promise<string> {
  const buf = await readFile(absPath);
  return buf.toString("base64");
}
