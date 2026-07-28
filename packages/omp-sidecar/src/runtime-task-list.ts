// FILE: runtime-task-list.ts
// Purpose: Normalize OMP todo events into NuncioADE task-list items.
// Layer: Sidecar engine (OMP)
// Exports: normalizeRuntimeTaskStatus, makeRuntimeTaskListItem

import type { RuntimeTaskListItem, RuntimeTaskStatus } from "@nuncio/contracts";

export function normalizeRuntimeTaskStatus(value: unknown): RuntimeTaskStatus {
  if (value === "completed") {
    return "completed";
  }
  if (value === "in_progress" || value === "inProgress") {
    return "inProgress";
  }
  return "pending";
}

export function makeRuntimeTaskListItem(
  task: unknown,
  status: unknown,
): RuntimeTaskListItem | null {
  if (typeof task !== "string") {
    return null;
  }
  const normalizedTask = task.trim();
  if (normalizedTask.length === 0) {
    return null;
  }
  return {
    task: normalizedTask,
    status: normalizeRuntimeTaskStatus(status),
  };
}

export function nonEmptyRuntimeTaskListPayload(
  tasks: ReadonlyArray<RuntimeTaskListItem>,
): { readonly tasks: ReadonlyArray<RuntimeTaskListItem> } | null {
  return tasks.length > 0 ? { tasks } : null;
}
