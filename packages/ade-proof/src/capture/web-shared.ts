import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import puppeteer from "puppeteer-core";
import type { Browser, CookieParam, HTTPResponse, Page } from "puppeteer-core";
import { z } from "zod";
import type { ProofResult } from "../core/types.js";
import { PAGE_LOAD_TIMEOUT_MS, PAGE_SETTLE_DELAY_MS } from "../core/types.js";
import { resolveChrome } from "./chrome-resolver.js";

let browser: Browser | undefined;

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = undefined;
  }
}

export async function ensureBrowser(): Promise<ProofResult<Browser>> {
  if (browser) return { ok: true, value: browser };

  const chrome = resolveChrome();
  if (!chrome.ok) return chrome as ProofResult<Browser>;

  try {
    browser = await puppeteer.launch({
      executablePath: chrome.value,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--hide-scrollbars",
        "--mute-audio",
        "--disable-background-timer-throttling",
        "--force-color-profile=srgb",
      ],
    });
    return { ok: true, value: browser };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: {
        code: "chrome-not-found",
        message: `Launched Chrome at ${chrome.value} but it failed: ${reason}`,
        details: { chromePath: chrome.value },
      },
    };
  }
}

export async function setViewport(page: Page): Promise<void> {
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
}

export async function injectStyle(page: Page): Promise<void> {
  const css = `
    *, *::before, *::after {
      animation: none !important;
      transition: none !important;
    }
    * {
      caret-color: transparent !important;
    }
  `;
  await page.addStyleTag({ content: css });
}

export function attachConsoleListener(page: Page, lines: string[]): void {
  page.on("console", (msg) => lines.push(msg.text()));
}

const CookieSchema = z
  .object({
    name: z.string(),
    value: z.string(),
    url: z.string().optional(),
    domain: z.string().optional(),
    path: z.string().optional(),
    expires: z.number().optional(),
    httpOnly: z.boolean().optional(),
    secure: z.boolean().optional(),
    sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
  })
  .passthrough();

const StorageItemSchema = z.object({
  name: z.string(),
  value: z.string(),
});

const StorageStateSchema = z
  .object({
    cookies: z.array(CookieSchema).optional(),
    localStorage: z.array(StorageItemSchema).optional(),
  })
  .passthrough();

export type StorageState = z.infer<typeof StorageStateSchema>;

export async function validateStorageState(
  storageStatePath: string,
): Promise<ProofResult<StorageState>> {
  let raw: string;
  try {
    raw = await readFile(storageStatePath, "utf8");
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: {
        code: "storage-state-invalid",
        message: `Could not read storage state file ${storageStatePath}: ${reason}`,
        details: { path: storageStatePath },
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: {
        code: "storage-state-invalid",
        message: `Storage state file is not valid JSON: ${reason}`,
        details: { path: storageStatePath },
      },
    };
  }

  const result = StorageStateSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "storage-state-invalid",
        message: `Storage state file must have optional "cookies" and "localStorage" arrays: ${result.error.message}`,
        details: { path: storageStatePath },
      },
    };
  }

  return { ok: true, value: result.data };
}

function toCookieParam(c: Record<string, unknown>, pageUrl: string): CookieParam {
  const out: Record<string, unknown> = {
    name: c.name,
    value: c.value,
    url: c.url !== undefined ? c.url : pageUrl,
  };
  for (const key of [
    "domain",
    "path",
    "expires",
    "httpOnly",
    "secure",
    "sameSite",
    "priority",
    "sourceScheme",
  ] as const) {
    const v = c[key];
    if (v !== undefined) out[key] = v;
  }
  return out as unknown as CookieParam;
}

export async function applyStorageState(
  page: Page,
  storageState: StorageState,
  pageUrl: string,
): Promise<void> {
  if (storageState.cookies?.length) {
    const cookies: CookieParam[] = storageState.cookies.map((c) => toCookieParam(c, pageUrl));
    await page.setCookie(...cookies);
  }
  if (storageState.localStorage?.length) {
    const items = storageState.localStorage;
    await page.evaluateOnNewDocument((items) => {
      try {
        for (const item of items) {
          localStorage.setItem(item.name, item.value);
        }
      } catch {
        // localStorage may be unavailable (e.g. about:blank); ignore
      }
    }, items);
  }
}

export async function navigateAndSettle(
  page: Page,
  url: string,
): Promise<ProofResult<{ response: HTTPResponse | null }>> {
  const start = Date.now();
  let response: HTTPResponse | null;
  try {
    response = await page.goto(url, {
      waitUntil: "load",
      timeout: PAGE_LOAD_TIMEOUT_MS,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: {
        code: "navigation-failed",
        message: `Could not navigate to ${url}: ${reason}`,
        details: { url },
      },
    };
  }

  const elapsed = Date.now() - start;
  const remaining = Math.max(0, PAGE_LOAD_TIMEOUT_MS - elapsed);
  const settle = Math.min(PAGE_SETTLE_DELAY_MS, remaining);
  if (settle > 0) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, settle);
    await promise;
  }

  return { ok: true, value: { response } };
}

export async function ensureOutputDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}
