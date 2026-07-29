import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExecResult, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveAdeProofCli } from "./resolve-cli.js";

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
  const cli = await resolveAdeProofCli();
  const shotArgs = [
    ...cli.prefixArgs,
    "shot",
    "--target",
    opts.target,
    "--label",
    opts.label,
    "--json",
  ];

  if (opts.url) shotArgs.push("--url", opts.url);
  if (opts.selector) shotArgs.push("--selector", opts.selector);
  if (opts.fullPage) shotArgs.push("--full-page");
  if (opts.windowTitle) shotArgs.push("--window", opts.windowTitle);

  let result = await opts.exec(cli.argv0, shotArgs, { cwd: opts.cwd, timeout: 120_000 });
  let parsed = parseShotOutput(result);

  // The CLI never implicitly starts a session (frozen contract). The
  // one-call agent UX lives here instead: start an explicit session named
  // after the label, then retry the shot exactly once.
  if (!parsed.ok && parsed.error.code === "no-active-session") {
    const started = await opts.exec(
      cli.argv0,
      [
        ...cli.prefixArgs,
        "start",
        "--slug",
        "agent",
        "--desc",
        `auto-started for: ${opts.label}`,
        "--json",
      ],
      { cwd: opts.cwd, timeout: 30_000 },
    );
    const startParsed = parseCliJson<unknown>(started.stdout);
    if (!startParsed.ok) throw new Error(startParsed.error.message);
    result = await opts.exec(cli.argv0, shotArgs, { cwd: opts.cwd, timeout: 120_000 });
    parsed = parseShotOutput(result);
  }

  if (!parsed.ok) throw new Error(parsed.error.message);

  const relPath = parsed.value.file;
  const absPath = resolve(opts.cwd, relPath);
  return { relPath, absPath, label: opts.label };
}

function parseShotOutput(result: ExecResult): ProofJson<{ file: string }> {
  if (result.code !== 0 && !result.stdout.trim()) {
    throw new Error(`ade-proof shot failed (exit ${result.code}): ${result.stderr}`);
  }
  return parseCliJson<{ file: string }>(result.stdout);
}

export async function readImageBase64(absPath: string): Promise<string> {
  const buf = await readFile(absPath);
  return buf.toString("base64");
}
