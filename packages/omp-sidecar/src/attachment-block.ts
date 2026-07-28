// FILE: attachment-block.ts
// Purpose: Build a prompt text block for file attachments passed by absolute path.
// Layer: Sidecar engine (OMP)
// Exports: buildAttachmentPromptBlock

import { basename } from "node:path";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(2)} ${units[i] ?? "B"}`;
}

function mimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "txt":
    case "md":
      return "text/plain";
    case "json":
      return "application/json";
    case "js":
    case "ts":
    case "jsx":
    case "tsx":
      return "text/plain";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function quotePromptValue(value: string): string {
  return JSON.stringify(value);
}

/** Builds the `<attached_files>` prompt block from absolute file paths. */
export function buildAttachmentPromptBlock(
  paths: ReadonlyArray<string> | undefined,
): string | null {
  const lines: string[] = [];
  for (const path of paths ?? []) {
    const file = Bun.file(path);
    const size = file.size;
    const name = basename(path);
    const mimeType = file.type || mimeFromPath(path);
    lines.push(`- ${quotePromptValue(name)} - ${mimeType} - ${formatBytes(size)} - ${path}`);
  }
  if (lines.length === 0) {
    return null;
  }
  return [
    "<attached_files>",
    "The user attached the following file(s), saved on disk. Read/extract them with your tools as needed; do not assume their contents.",
    ...lines,
    "</attached_files>",
  ].join("\n");
}

export function buildPromptText(input: {
  readonly input?: string;
  readonly attachmentPaths?: ReadonlyArray<string>;
}): string {
  const text = input.input ?? "";
  const fileBlock = buildAttachmentPromptBlock(input.attachmentPaths);
  return fileBlock ? `${text}${text ? "\n\n" : ""}${fileBlock}` : text;
}
