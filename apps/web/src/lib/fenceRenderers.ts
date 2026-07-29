// FILE: fenceRenderers.ts
// Purpose: Registry mapping fenced-code-block languages to rich renderers. This is
//          the web half of the engine-generic diagram contract: every engine
//          communicates renderable content as a plain markdown fence, so adding a
//          renderer here lights it up for all providers with zero adapter changes.
// Layer: web chat markdown helper
// Exports: FenceRendererProps, FenceRenderer, getFenceRenderer

import type { ComponentType, ReactNode } from "react";
import MermaidFenceBlock from "../components/MermaidFenceBlock";
import type { CodeFenceInfo } from "./codeFence";

export interface FenceRendererProps {
  /** Dedented fence source. */
  readonly code: string;
  readonly fence: CodeFenceInfo;
  /** Resolved UI theme; renderers must restyle when it flips. */
  readonly theme: "light" | "dark";
  /**
   * Prebuilt syntax-highlighted source view. Renderers show it for their
   * source toggle and must fall back to it when the content doesn't render.
   */
  readonly source: ReactNode;
}

export interface FenceRenderer {
  readonly Component: ComponentType<FenceRendererProps>;
}

const FENCE_RENDERER_BY_LANGUAGE: Record<string, FenceRenderer> = {
  mermaid: { Component: MermaidFenceBlock },
};

/** Case-insensitive lookup; null when the fence should render as plain code. */
export function getFenceRenderer(language: string): FenceRenderer | null {
  return FENCE_RENDERER_BY_LANGUAGE[language.toLowerCase()] ?? null;
}
