// FILE: MarkdownCodeBlock.tsx
// Purpose: Shared chrome for fenced code blocks in chat markdown — header (language
//          or file reference), copy/soft-wrap actions, and an extension slot for
//          renderer-specific actions (e.g. the mermaid diagram/source toggle).
// Layer: Web chat presentation component
// Exports: MarkdownCodeBlock

import { CheckIcon, CopyIcon, TextWrapIcon } from "~/lib/icons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { copyTextToClipboard } from "../hooks/useCopyToClipboard";
import type { CodeFenceInfo } from "../lib/codeFence";
import { getFileIconName } from "../file-icons";
import { CentralIcon } from "~/lib/central-icons";
import { IconButton } from "./ui/icon-button";

function CodeBlockHeaderTitle({ fence }: { fence: CodeFenceInfo }) {
  if (fence.isFileReference && fence.fileName) {
    return (
      <span className="chat-markdown-codeblock__file" title={fence.filePath ?? fence.fileName}>
        <CentralIcon
          name={getFileIconName(fence.filePath ?? fence.fileName)}
          className="chat-markdown-codeblock__file-icon"
        />
        <span className="chat-markdown-codeblock__file-name">{fence.fileName}</span>
        {fence.directory ? (
          <span className="chat-markdown-codeblock__file-dir">{fence.directory}</span>
        ) : null}
        {fence.lineRange ? (
          <span className="chat-markdown-codeblock__file-lines">{fence.lineRange}</span>
        ) : null}
      </span>
    );
  }

  return <span className="chat-markdown-codeblock__lang">{fence.language}</span>;
}

export function MarkdownCodeBlock({
  code,
  fence,
  headerActions,
  children,
}: {
  code: string;
  fence: CodeFenceInfo;
  /** Extra action buttons rendered before the built-in wrap/copy actions. */
  headerActions?: ReactNode;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  const handleCopy = () => {
    void copyTextToClipboard(code)
      .then(() => {
        clearTimeout(copiedTimerRef.current ?? undefined);
        setCopied(true);
        copiedTimerRef.current = window.setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch(() => undefined);
  };
  const toggleWrap = () => setWrap((previous) => !previous);

  useEffect(
    () => () => {
      clearTimeout(copiedTimerRef.current ?? undefined);
      copiedTimerRef.current = null;
    },
    [],
  );

  return (
    <div className="chat-markdown-codeblock" data-wrap={wrap ? "true" : "false"}>
      <div className="chat-markdown-codeblock__header">
        <CodeBlockHeaderTitle fence={fence} />
        <div className="chat-markdown-codeblock__actions">
          {headerActions}
          <IconButton
            className="chat-markdown-codeblock__action"
            onClick={toggleWrap}
            title={wrap ? "Disable soft wrap" : "Enable soft wrap"}
            label={wrap ? "Disable soft wrap" : "Enable soft wrap"}
            aria-pressed={wrap}
            data-active={wrap ? "true" : "false"}
            size="icon-xs"
            variant="ghost"
          >
            <TextWrapIcon className="size-3" />
          </IconButton>
          <IconButton
            className="chat-markdown-codeblock__action"
            onClick={handleCopy}
            title={copied ? "Copied" : "Copy code"}
            label={copied ? "Copied" : "Copy code"}
            size="icon-xs"
            variant="ghost"
          >
            {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          </IconButton>
        </div>
      </div>
      <div className="chat-markdown-codeblock__body">{children}</div>
    </div>
  );
}
