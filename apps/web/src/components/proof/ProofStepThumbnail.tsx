// FILE: ProofStepThumbnail.tsx
// Purpose: Renders one proof step with its screenshot and status badges.
// Layer: Web UI component

import { proofFileUrl } from "./proofApi";
import type { ProofStep } from "./proofTypes";

export interface ProofStepThumbnailProps {
  step: ProofStep;
  cwd: string;
}

export function ProofStepThumbnail(props: ProofStepThumbnailProps) {
  const src = proofFileUrl(props.cwd, props.step.file);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <img
        src={src}
        alt={props.step.label}
        loading="lazy"
        className="h-32 w-full rounded-md border border-[var(--color-border)] object-contain bg-muted/20"
      />
      <span className="truncate text-[11px] text-muted-foreground">{props.step.label}</span>
      {props.step.httpStatus && props.step.httpStatus >= 400 ? (
        <span className="text-[10px] text-destructive">HTTP {props.step.httpStatus}</span>
      ) : null}
      {props.step.url && props.step.finalUrl && props.step.url !== props.step.finalUrl ? (
        <span className="text-[10px] text-warning">Redirected</span>
      ) : null}
      {props.step.truncated ? <span className="text-[10px] text-warning">Truncated</span> : null}
    </div>
  );
}
