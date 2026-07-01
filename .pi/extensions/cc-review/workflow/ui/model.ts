// ---------------------------------------------------------------------------
// UI data model: snapshot and overlay state (Spec2 §6, §7).
//
// The UI never directly reads or modifies WorkflowRuntime. Instead, the
// runtime generates an immutable snapshot on each change, and the controller
// renders from it. This keeps the rendering layer pure and testable.
// ---------------------------------------------------------------------------

import type { CcReviewLogEntry } from "../types.ts";
import type { CcReviewFindingsRollup, TaskStatus } from "../../structured.ts";
import type { Task } from "../dependencies.ts";
import type { CcReviewDisplayState } from "../ui.ts";

export type { CcReviewDisplayState };

export type TaskUiStatus = TaskStatus | "running" | "pending";

export interface TaskUiRecord {
  index: number;
  title: string;
  activeForm?: string;
  description: string;
  acceptanceCriteria?: string;
  status: TaskUiStatus;
  configuredModel?: string;
  effectiveModel?: string;
  startedAt?: string;
  completedAt?: string;
  tokenUsage?: { input?: number; output?: number; total?: number };
  resultSummary?: string;
  artifactPath?: string;
  /** P1-3: models attempted during execution, if >1 was used. */
  attemptedModels?: string[];
}

export interface FindingUiRecord {
  id: string;
  taskIndex?: number;
  reviewer?: string;
  validationStatus?: "passed" | "failed" | "not_run";
  artifactPath?: string;
  priority?: string;
  file?: string;
  line?: number;
  message?: string;
  status?: string;
  confidence?: string;
  evidence?: string;
  suggestedFix?: string;
}

export interface AttemptUiRecord {
  id: string;
  kind: "worker" | "reviewer" | "validation";
  taskIndex?: number;
  attempt: number;
  maxAttempts: number;
  startedAt?: string;
  completedAt?: string;
  reason?: string;
  outcome?: string;
}

export interface CcReviewUiSnapshot {
  runId: string;
  goal: string;
  displayState: CcReviewDisplayState;
  phase: string;
  startedAt: string;
  completedAt?: string;
  currentTaskIndex: number;
  tasks: TaskUiRecord[];
  findings: FindingUiRecord[];
  logs: readonly CcReviewLogEntry[];
  attempts: AttemptUiRecord[];
  findingsRollup: CcReviewFindingsRollup;
  persistedLogPath: string;
  artifactRunDir: string;
}

export type OverlayView =
  | "tasks"
  | "files"
  | "findings"
  | "logs"
  | "attempts"
  | "reviewer"
  | "validation";

export type OverlayFocusedPanel = "navigation" | "content";

export type SeverityFilter = "all" | "P0" | "P1" | "P2" | "P3";

export interface OverlayState {
  isOpen: boolean;
  view: OverlayView;
  focusedPanel: OverlayFocusedPanel;
  selectedTaskIndex: number;
  selectedFile?: string;
  selectedFindingId?: string;
  selectedLogId?: string;
  selectedAttemptId?: string;
  severityFilter: SeverityFilter;
  logSeverityFilter: string;
  logSources?: string[];
  scrollOffset: number;
}

// ---------------------------------------------------------------------------
// Snapshot builder: maps runtime state to an immutable UI snapshot.
// ---------------------------------------------------------------------------

export interface SnapshotBuilderInput {
  runId: string;
  goal: string;
  displayState: CcReviewDisplayState;
  phase: string;
  startedAt: string;
  completedAt?: string;
  currentTaskIndex: number;
  tasks: Task[];
  taskStatuses: Array<TaskUiStatus | undefined>;
  taskModels: Array<{ configured?: string; effective?: string } | undefined>;
  taskStartedAt: Array<string | undefined>;
  taskCompletedAt: Array<string | undefined>;
  taskArtifactPaths: Array<string | undefined>;
  taskResultSummaries: Array<string | undefined>;
  taskAttemptedModels: Array<string[] | undefined>;
  findings: FindingUiRecord[];
  findingsRollup: CcReviewFindingsRollup;
  logs: readonly CcReviewLogEntry[];
  attempts: AttemptUiRecord[];
  persistedLogPath: string;
  artifactRunDir: string;
}

/**
 * Generate a stable finding id from run id, task index, file, line, priority,
 * and sequence number. Stable across snapshot updates so selection persists.
 */
export function generateFindingId(
  runId: string,
  taskIndex: number | undefined,
  file: string | undefined,
  line: number | undefined,
  priority: string | undefined,
  seq: number,
): string {
  return [runId, taskIndex ?? "_", file ?? "_", line ?? "_", priority ?? "_", seq].join(":");
}

/**
 * Convert a task title to a conservative active form.
 * Does NOT change the original task title — only derives a display hint.
 */
export function toActiveForm(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return "Working…";
  const lower = trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
  // If it already ends with "ing" or looks like an action, use as-is.
  if (/ing$/i.test(trimmed)) return lower + "…";
  // Otherwise, prefix with a generic action verb.
  return `Working on ${lower}…`;
}

/**
 * Build an immutable UI snapshot from runtime state.
 * Pure function — no side effects, no Pi runtime dependency.
 */
export function buildUiSnapshot(input: SnapshotBuilderInput): CcReviewUiSnapshot {
  const tasks: TaskUiRecord[] = input.tasks.map((task, index) => {
    const status = input.taskStatuses[index] ?? "pending";
    const modelState = input.taskModels[index];
    return {
      index,
      title: task.title,
      activeForm: toActiveForm(task.title),
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      status,
      configuredModel: modelState?.configured,
      effectiveModel: modelState?.effective,
      startedAt: input.taskStartedAt[index],
      completedAt: input.taskCompletedAt[index],
      resultSummary: input.taskResultSummaries[index],
      artifactPath: input.taskArtifactPaths[index],
      attemptedModels: input.taskAttemptedModels[index],
    };
  });

  return {
    runId: input.runId,
    goal: input.goal,
    displayState: input.displayState,
    phase: input.phase,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    currentTaskIndex: input.currentTaskIndex,
    tasks,
    findings: input.findings,
    logs: input.logs,
    attempts: input.attempts,
    findingsRollup: input.findingsRollup,
    persistedLogPath: input.persistedLogPath,
    artifactRunDir: input.artifactRunDir,
  };
}

/**
 * Create the default overlay state (closed, tasks view, no selection).
 */
export function createDefaultOverlayState(): OverlayState {
  return {
    isOpen: false,
    view: "tasks",
    focusedPanel: "navigation",
    selectedTaskIndex: 0,
    severityFilter: "all",
    logSeverityFilter: "info",
    scrollOffset: 0,
  };
}

/**
 * Determine the default selected task when opening the overlay.
 * Priority: first running task → first pending task → first blocker → last task.
 */
export function resolveDefaultSelectedTaskIndex(snapshot: CcReviewUiSnapshot): number {
  const running = snapshot.tasks.find((t) => t.status === "running");
  if (running) return running.index;

  const pending = snapshot.tasks.find((t) => t.status === "pending");
  if (pending) return pending.index;

  // First blocker (failed/validation_failed)
  const blocker = snapshot.tasks.find(
    (t) => t.status === "failed" || t.status === "validation_failed",
  );
  if (blocker) return blocker.index;

  // Last task
  if (snapshot.tasks.length > 0) {
    return snapshot.tasks[snapshot.tasks.length - 1]!.index;
  }
  return 0;
}
