import "../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import ChatMarkdown from "./ChatMarkdown";

const VALID_MERMAID = [
  "```mermaid",
  "flowchart LR",
  "  U[upstream tag] -->|merge| S[shadow branch]",
  "  S --> M[main]",
  "```",
].join("\n");

const INVALID_MERMAID = ["```mermaid", "flowchart LR", "  U[upstream --> (((", "```"].join("\n");

// The first diagram lazy-loads the ~2MB mermaid bundle through the vite dev
// server, so the initial wait is generous; later tests reuse the loaded module.
async function waitForDiagram(): Promise<SVGSVGElement> {
  return await vi.waitFor(
    () => {
      const svg = document.querySelector<SVGSVGElement>(".chat-markdown-mermaid svg");
      if (!svg) {
        throw new Error("diagram not rendered yet");
      }
      return svg;
    },
    { timeout: 30_000 },
  );
}

describe("ChatMarkdown mermaid fences (real mermaid)", () => {
  it("renders a settled mermaid fence to an inline SVG diagram", async () => {
    render(<ChatMarkdown text={VALID_MERMAID} cwd={undefined} isStreaming={false} />);

    const svg = await waitForDiagram();
    expect(svg.textContent).toContain("upstream tag");
    expect(svg.textContent).toContain("merge");
  });

  it("toggles between diagram and highlighted source", async () => {
    render(<ChatMarkdown text={VALID_MERMAID} cwd={undefined} isStreaming={false} />);
    await waitForDiagram();

    await page.getByLabelText("Show source").click();
    expect(document.querySelector(".chat-markdown-mermaid")).toBeNull();
    await expect.element(page.getByLabelText("Show diagram")).toBeVisible();

    await page.getByLabelText("Show diagram").click();
    await waitForDiagram();
  });

  it("expands the diagram into a dialog", async () => {
    render(<ChatMarkdown text={VALID_MERMAID} cwd={undefined} isStreaming={false} />);
    await waitForDiagram();

    await page.getByLabelText("Expand diagram").click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await vi.waitFor(() => {
      const expanded = document.querySelector(".chat-markdown-mermaid--expanded svg");
      if (!expanded) {
        throw new Error("expanded diagram not rendered yet");
      }
    });
  });

  it("falls back to the plain code block for invalid mermaid", async () => {
    render(<ChatMarkdown text={INVALID_MERMAID} cwd={undefined} isStreaming={false} />);

    // Anchor on the block existing first — a negative-only wait passes
    // vacuously before the component mounts.
    await vi.waitFor(() => {
      if (!document.querySelector(".chat-markdown-codeblock")) {
        throw new Error("code block not mounted yet");
      }
    });
    // Loading state still offers the toggle; once parse fails the block drops
    // every diagram affordance and keeps the ordinary code chrome.
    await vi.waitFor(() => {
      if (document.querySelector('[aria-label="Show source"]')) {
        throw new Error("still settling");
      }
    });
    expect(document.querySelector(".chat-markdown-mermaid")).toBeNull();
    expect(document.querySelector(".chat-markdown-codeblock")).not.toBeNull();
  });
});
