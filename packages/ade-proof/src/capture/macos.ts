import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { CaptureBackend, CaptureMeta, CaptureRequest, ProofResult } from "../core/types.js";
import { isSolidImage } from "./png-solid.js";

export const target = "macos" as const;

interface WindowInfo {
  id: number;
  owner: string;
  title?: string;
}

const JXA_LIST_WINDOWS = `
ObjC.import('CoreGraphics')
var nil = $()
var unwrap = ObjC.deepUnwrap.bind(ObjC)
var bind = ObjC.bindFunction.bind($)
bind('CFMakeCollectable', ['id', ['void *']])
Ref.prototype._nsObject = function () { return unwrap($.CFMakeCollectable(this)); }
var all = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID)._nsObject()
var visible = all.filter(function (w) { return w.kCGWindowLayer === 0 && w.kCGWindowAlpha > 0 })
console.log(JSON.stringify(visible.map(function (w) {
  return { id: w.kCGWindowNumber, owner: w.kCGWindowOwnerName, title: w.kCGWindowName }
})))
`;

export function parseWindowList(stdout: string, query?: string): WindowInfo[] {
  const raw: Array<Record<string, unknown>> = JSON.parse(stdout);
  const filtered = raw.filter((w) => {
    if (w.kCGWindowLayer !== 0) return false;
    if (w.kCGWindowAlpha === 0) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    const owner = String(w.kCGWindowOwnerName || "").toLowerCase();
    const title = String(w.kCGWindowName || "").toLowerCase();
    return owner.includes(q) || title.includes(q);
  });
  return filtered.map((w) => {
    const out: WindowInfo = {
      id: Number(w.kCGWindowNumber),
      owner: String(w.kCGWindowOwnerName),
    };
    const title = w.kCGWindowName ? String(w.kCGWindowName) : undefined;
    if (title) out.title = title;
    return out;
  });
}

function candidateString(w: WindowInfo): string {
  return `${w.owner}: ${w.title || "<no title>"}`;
}

export async function capture(req: CaptureRequest): Promise<ProofResult<CaptureMeta>> {
  if (req.target !== "macos") {
    return {
      ok: false,
      error: {
        code: "unsupported-target",
        message: `macos backend cannot capture target "${req.target}"`,
        details: { target: req.target },
      },
    };
  }

  const query = req.windowTitle;
  if (!query) {
    return {
      ok: false,
      error: {
        code: "window-not-found",
        message: "macos capture requires --window / windowTitle",
        details: {},
      },
    };
  }

  const list = spawnSync("osascript", ["-l", "JavaScript", "-e", JXA_LIST_WINDOWS], {
    encoding: "utf8",
    timeout: 15000,
  });

  if (list.error || list.status !== 0) {
    return {
      ok: false,
      error: {
        code: "window-not-found",
        message: `Could not list macOS windows: ${list.stderr || list.error?.message || "unknown error"}`,
        details: {},
      },
    };
  }

  let all: WindowInfo[];
  let matches: WindowInfo[];
  try {
    all = parseWindowList(list.stdout);
    matches = parseWindowList(list.stdout, query);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: {
        code: "window-not-found",
        message: `Could not parse macOS window list: ${reason}`,
        details: { raw: list.stdout },
      },
    };
  }

  if (matches.length === 0) {
    return {
      ok: false,
      error: {
        code: "window-not-found",
        message: `No macOS window matches "${query}".`,
        details: { visibleTitles: all.map(candidateString) },
      },
    };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      error: {
        code: "window-ambiguous",
        message: `Multiple macOS windows match "${query}".`,
        details: { candidates: matches.map(candidateString) },
      },
    };
  }

  const win = matches[0];
  if (!win) {
    return {
      ok: false,
      error: {
        code: "window-not-found",
        message: `No macOS window matches "${query}".`,
        details: { visibleTitles: all.map(candidateString) },
      },
    };
  }
  await mkdir(dirname(req.outFile), { recursive: true });

  const screencapture = spawnSync("screencapture", ["-o", "-l", String(win.id), req.outFile], {
    encoding: "utf8",
    timeout: 30000,
  });

  const fileExists = existsSync(req.outFile);
  const fileSize = fileExists ? statSync(req.outFile).size : 0;

  if (screencapture.status !== 0 || fileSize === 0) {
    return {
      ok: false,
      error: {
        code: "screen-recording-denied",
        message:
          "Screen Recording permission is required. Grant it in System Settings > Privacy & Security > Screen Recording for the terminal running ade-proof.",
        details: {
          windowId: win.id,
          screencaptureStderr: screencapture.stderr,
        },
      },
    };
  }

  if (await isSolidImage(req.outFile)) {
    return {
      ok: false,
      error: {
        code: "screen-recording-denied",
        message:
          "Screen capture produced a solid image, which usually means Screen Recording permission is denied. Grant it in System Settings > Privacy & Security > Screen Recording.",
        details: { windowId: win.id },
      },
    };
  }

  return {
    ok: true,
    value: {
      windowTitle: candidateString(win),
    },
  };
}

export const macosBackend: CaptureBackend = { target, capture };
