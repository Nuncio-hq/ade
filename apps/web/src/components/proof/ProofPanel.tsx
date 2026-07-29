// FILE: ProofPanel.tsx
// Purpose: Right-dock proof panel: session list, step gallery, video, summary, red flags.
// Layer: Web right-dock pane
// Depends on: react-query, ChatMarkdown, DockPaneHeader, proofApi, proofTypes

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { CameraIcon, RefreshCwIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import ChatMarkdown from "~/components/ChatMarkdown";
import { DockPaneHeader } from "~/components/chat/DockPaneHeader";
import { PanelStateMessage } from "~/components/chat/PanelStateMessage";
import { DOCK_HEADER_ICON_BUTTON_CLASS } from "~/components/chat/chatHeaderControls";
import { Alert } from "~/components/ui/alert";
import { IconButton } from "~/components/ui/icon-button";
import { fetchProofSessions, fetchProofSummary, proofFileUrl } from "./proofApi";
import { ProofStepThumbnail } from "./ProofStepThumbnail";
import { formatStartedAt, redFlagMessages, sessionDisplayTitle } from "./proofPanelUtils";

interface ProofPanelProps {
  workspaceRoot: string | null;
  onClose?: (() => void) | undefined;
}

export default function ProofPanel(props: ProofPanelProps) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const sessionsQuery = useQuery({
    queryKey: ["proof", "sessions", props.workspaceRoot],
    queryFn: () => fetchProofSessions(props.workspaceRoot),
    enabled: !!props.workspaceRoot,
    refetchOnWindowFocus: false,
  });

  const sessions = sessionsQuery.data?.sessions ?? [];
  const selectedSession = useMemo(() => {
    if (selectedSessionId) {
      return sessions.find((s) => s.id === selectedSessionId) ?? sessions[0] ?? null;
    }
    return sessions[0] ?? null;
  }, [sessions, selectedSessionId]);

  const summaryRelPath = selectedSession ? `.ade/proof/${selectedSession.id}/SUMMARY.md` : null;
  const summaryQuery = useQuery({
    queryKey: ["proof", "summary", props.workspaceRoot, summaryRelPath],
    queryFn: () => fetchProofSummary(props.workspaceRoot!, summaryRelPath!),
    enabled: !!props.workspaceRoot && !!summaryRelPath,
    refetchOnWindowFocus: false,
  });

  const flags = useMemo(
    () => (selectedSession ? redFlagMessages(selectedSession) : []),
    [selectedSession],
  );

  if (!props.workspaceRoot) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <DockPaneHeader title="Proof" onClose={props.onClose} closeLabel="Close proof panel" />
        <PanelStateMessage>Proof is unavailable without a workspace.</PanelStateMessage>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <DockPaneHeader
        title="Proof"
        onClose={props.onClose}
        closeLabel="Close proof panel"
        actions={
          <IconButton
            size="icon-xs"
            variant="ghost"
            label="Refresh proof sessions"
            tooltip="Refresh proof sessions"
            className={DOCK_HEADER_ICON_BUTTON_CLASS}
            onClick={() => sessionsQuery.refetch()}
          >
            <RefreshCwIcon className="size-3.5" />
          </IconButton>
        }
      />

      {sessionsQuery.error instanceof Error ? (
        <Alert variant="error" size="sm" className="m-2 text-destructive">
          {sessionsQuery.error.message}
        </Alert>
      ) : null}

      <div
        className={cn(
          "flex shrink-0 flex-col gap-1 overflow-y-auto border-b border-[var(--color-border)] px-2 py-2",
          sessions.length > 0 ? "max-h-[40%]" : "flex-1",
        )}
      >
        {sessionsQuery.isLoading && sessions.length === 0 ? (
          <PanelStateMessage density="compact" fill="flex">
            Loading proof sessions...
          </PanelStateMessage>
        ) : null}
        {sessions.length === 0 && !sessionsQuery.isLoading ? (
          <PanelStateMessage density="compact" fill="flex">
            No proof sessions found for this workspace.
          </PanelStateMessage>
        ) : null}
        {sessions.map((session) => {
          const isSelected = session.id === selectedSession?.id;
          const flagCount = redFlagMessages(session).length;
          return (
            <button
              key={session.id}
              type="button"
              onClick={() => setSelectedSessionId(session.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px]",
                isSelected
                  ? "bg-sidebar-accent text-foreground"
                  : "hover:bg-[var(--color-background-elevated-secondary)] text-muted-foreground",
              )}
            >
              <CameraIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{sessionDisplayTitle(session)}</span>
              {session.finishedAt ? (
                <span className="shrink-0 text-[10px] text-muted-foreground/70">stopped</span>
              ) : (
                <span className="shrink-0 text-[10px] text-[var(--color-text-accent)]">active</span>
              )}
              {flagCount > 0 ? (
                <span className="shrink-0 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive">
                  {flagCount}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {!selectedSession ? (
          <PanelStateMessage density="compact" fill="flex">
            Select a proof session to view details.
          </PanelStateMessage>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-medium text-foreground">
                {sessionDisplayTitle(selectedSession)}
              </h3>
              <p className="text-[11px] text-muted-foreground">
                {formatStartedAt(selectedSession.startedAt)}
                {selectedSession.serverCmd ? ` · ${selectedSession.serverCmd}` : null}
              </p>
            </div>

            {flags.length > 0 ? (
              <Alert variant="warning" size="sm" className="text-warning">
                <ul className="list-disc space-y-0.5 pl-4 text-[11px]">
                  {flags.map((flag, index) => (
                    <li key={index}>{flag}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}

            {selectedSession.video ? (
              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted-foreground">Recording</span>
                <video
                  controls
                  src={proofFileUrl(props.workspaceRoot, selectedSession.video)}
                  className="w-full rounded-md border border-[var(--color-border)]"
                />
              </div>
            ) : null}

            {selectedSession.steps.length > 0 ? (
              <div className="grid grid-cols-2 gap-2">
                {selectedSession.steps.map((step, index) => (
                  <ProofStepThumbnail key={index} step={step} cwd={props.workspaceRoot!} />
                ))}
              </div>
            ) : null}

            {summaryQuery.isLoading ? (
              <p className="text-[11px] text-muted-foreground/70">Loading summary...</p>
            ) : summaryQuery.data ? (
              <div className="rounded-md border border-[var(--color-border)] p-3">
                <ChatMarkdown text={summaryQuery.data} cwd={props.workspaceRoot ?? undefined} />
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
