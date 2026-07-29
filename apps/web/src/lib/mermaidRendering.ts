// FILE: mermaidRendering.ts
// Purpose: Lazy mermaid host for chat fence rendering — strict security, theme-aware
//          rendering to SVG strings serialized behind one chain (initialize() is
//          global config), with an LRU cache that also records parse failures so
//          invalid agent output isn't re-parsed on every transcript re-render.
// Layer: web chat markdown helper
// Exports: MermaidRenderState, renderMermaidSvg, getCachedMermaidSvg, useMermaidSvg

import type { Mermaid } from "mermaid";
import { useEffect, useState } from "react";

export type MermaidRenderState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly svg: string }
  | { readonly status: "invalid" };

/** UI theme variant as resolved by useTheme. */
export type MermaidUiTheme = "light" | "dark";

type MermaidTheme = "dark" | "neutral";

// The mermaid bundle is ~2MB minified: never import it statically. The promise
// is shared so a transcript full of diagrams loads the module once.
let mermaidPromise: Promise<Mermaid> | null = null;

function getMermaidPromise(): Promise<Mermaid> {
  mermaidPromise ??= import("mermaid").then((module) => module.default);
  return mermaidPromise;
}

// Rendered SVG keyed by (theme, source); null records a parse/render failure.
// Layout (dagre) is expensive and transcripts re-render aggressively, so both
// successes and failures are memoized, LRU-capped by entry count.
const SVG_CACHE_MAX_ENTRIES = 64;
const svgCache = new Map<string, string | null>();

function svgCacheKey(code: string, theme: MermaidTheme): string {
  return `${theme}\u0000${code}`;
}

function readSvgCache(key: string): string | null | undefined {
  if (!svgCache.has(key)) {
    return undefined;
  }
  const value = svgCache.get(key) ?? null;
  // Re-insert to mark as most recently used.
  svgCache.delete(key);
  svgCache.set(key, value);
  return value;
}

function writeSvgCache(key: string, value: string | null): void {
  svgCache.delete(key);
  svgCache.set(key, value);
  if (svgCache.size > SVG_CACHE_MAX_ENTRIES) {
    const oldest = svgCache.keys().next().value;
    if (oldest !== undefined) {
      svgCache.delete(oldest);
    }
  }
}

// initialize() mutates mermaid's global config and render() reads it, so renders
// with different themes would race each other; every render runs through this chain.
let renderChain: Promise<unknown> = Promise.resolve();
let initializedTheme: MermaidTheme | null = null;
let renderSequence = 0;

async function renderUncached(code: string, theme: MermaidTheme): Promise<string | null> {
  const id = `ade-mermaid-${++renderSequence}`;
  try {
    const mermaid = await getMermaidPromise();
    if (initializedTheme !== theme) {
      // securityLevel "strict" sanitizes labels and disables click/script bindings —
      // diagram source is model output and must stay inert. Never relax to "loose".
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme });
      initializedTheme = theme;
    }
    await mermaid.parse(code);
    const { svg } = await mermaid.render(id, code);
    return svg;
  } catch {
    // mermaid can leave its temporary render/error element behind on failure;
    // drop it so invalid diagrams don't accumulate DOM nodes. (document is
    // absent under SSR/node tests — rendering only ever runs client-side.)
    if (typeof document !== "undefined") {
      document.getElementById(`d${id}`)?.remove();
      document.getElementById(id)?.remove();
    }
    return null;
  }
}

/** Renders mermaid source to an SVG string; null means invalid source. Cached. */
export function renderMermaidSvg(code: string, theme: MermaidUiTheme): Promise<string | null> {
  const mermaidTheme: MermaidTheme = theme === "dark" ? "dark" : "neutral";
  const key = svgCacheKey(code, mermaidTheme);
  const chained = renderChain.then(async () => {
    const cached = readSvgCache(key);
    if (cached !== undefined) {
      return cached;
    }
    const svg = await renderUncached(code, mermaidTheme);
    writeSvgCache(key, svg);
    return svg;
  });
  renderChain = chained.catch(() => undefined);
  return chained;
}

/** Sync cache read; undefined = not rendered yet, null = known-invalid source. */
export function getCachedMermaidSvg(
  code: string,
  theme: MermaidUiTheme,
): string | null | undefined {
  return readSvgCache(svgCacheKey(code, theme === "dark" ? "dark" : "neutral"));
}

function stateFromCache(cached: string | null | undefined): MermaidRenderState {
  if (cached === undefined) {
    return { status: "loading" };
  }
  return cached === null ? { status: "invalid" } : { status: "ready", svg: cached };
}

function sameRenderState(a: MermaidRenderState, b: MermaidRenderState): boolean {
  if (a.status !== b.status) {
    return false;
  }
  return a.status !== "ready" || b.status !== "ready" || a.svg === b.svg;
}

/**
 * Resolves mermaid source to a render state. Starts from the cache synchronously
 * (no loading flash when a settled transcript re-mounts) and renders lazily
 * otherwise. Never call while the source block is still streaming — partial
 * diagrams fail parse on every keystroke for nothing.
 */
export function useMermaidSvg(code: string, theme: MermaidUiTheme): MermaidRenderState {
  const [state, setState] = useState<MermaidRenderState>(() =>
    stateFromCache(getCachedMermaidSvg(code, theme)),
  );

  useEffect(() => {
    const next = stateFromCache(getCachedMermaidSvg(code, theme));
    if (next.status !== "loading") {
      setState((previous) => (sameRenderState(previous, next) ? previous : next));
      return;
    }
    let cancelled = false;
    setState((previous) => (previous.status === "loading" ? previous : { status: "loading" }));
    void renderMermaidSvg(code, theme).then((svg) => {
      if (cancelled) {
        return;
      }
      setState(svg === null ? { status: "invalid" } : { status: "ready", svg });
    });
    return () => {
      cancelled = true;
    };
  }, [code, theme]);

  return state;
}
