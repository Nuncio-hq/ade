// FILE: MermaidFenceBlock.tsx
// Purpose: Renders ```mermaid fences as inline SVG diagrams with a source toggle
//          and a fit-to-screen expand dialog. Invalid source falls back silently
//          to the plain highlighted code block — agent-emitted mermaid breaks often.
// Layer: Web chat presentation component
// Exports: MermaidFenceBlock (default)

import { CodeIcon, PanelExpandIcon } from "~/lib/icons";
import { useState } from "react";
import type { FenceRendererProps } from "../lib/fenceRenderers";
import { useMermaidSvg } from "../lib/mermaidRendering";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "./ui/dialog";
import { IconButton } from "./ui/icon-button";

function MermaidFenceBlock({ code, fence, theme, source }: FenceRendererProps) {
  const [showSource, setShowSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const render = useMermaidSvg(code, theme);

  if (render.status === "invalid") {
    // Invalid diagrams keep the ordinary code block chrome with no diagram
    // affordances; the transcript never breaks on bad agent output.
    return (
      <MarkdownCodeBlock code={code} fence={fence}>
        {source}
      </MarkdownCodeBlock>
    );
  }

  const diagramVisible = !showSource && render.status === "ready";
  const headerActions = (
    <>
      {diagramVisible ? (
        <IconButton
          className="chat-markdown-codeblock__action"
          onClick={() => setExpanded(true)}
          title="Expand diagram"
          label="Expand diagram"
          size="icon-xs"
          variant="ghost"
        >
          <PanelExpandIcon className="size-3" />
        </IconButton>
      ) : null}
      <IconButton
        className="chat-markdown-codeblock__action"
        onClick={() => setShowSource((previous) => !previous)}
        title={showSource ? "Show diagram" : "Show source"}
        label={showSource ? "Show diagram" : "Show source"}
        aria-pressed={showSource}
        data-active={showSource ? "true" : "false"}
        size="icon-xs"
        variant="ghost"
      >
        <CodeIcon className="size-3" />
      </IconButton>
    </>
  );

  return (
    <>
      <MarkdownCodeBlock code={code} fence={fence} headerActions={headerActions}>
        {diagramVisible ? (
          <div
            className="chat-markdown-mermaid"
            // Trusted output: produced by mermaid with securityLevel "strict"
            // (same trust level as the shiki-highlighted HTML path).
            dangerouslySetInnerHTML={{ __html: render.svg }}
          />
        ) : (
          // Loading (pre-first-render) and explicit source view both show the
          // highlighted source; the diagram swaps in once the SVG resolves.
          source
        )}
      </MarkdownCodeBlock>
      {render.status === "ready" ? (
        <Dialog open={expanded} onOpenChange={setExpanded}>
          <DialogPopup className="max-w-[min(94vw,1400px)]">
            <DialogHeader className="gap-1 p-4 pr-12">
              <DialogTitle className="text-base">Diagram</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <div
                className="chat-markdown-mermaid chat-markdown-mermaid--expanded"
                dangerouslySetInnerHTML={{ __html: render.svg }}
              />
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      ) : null}
    </>
  );
}

export default MermaidFenceBlock;
