// ---------------------------------------------------------------------------
// Maps live workflow runtime state into a CcReviewUiSnapshot (Spec2 §6).
// Pure function — no Pi runtime dependency.
// ---------------------------------------------------------------------------

import { mergeRollupFindings, type CcReviewFindingsRollup, type ReviewFinding } from "../../structured.ts";
import type { Task } from "../dependencies.ts";
import type { BatchTaskExecution, CcReviewLogEntry, TaskResult } from "../types.ts";
import type { CcReviewDisplayState } from "../ui.ts";
import {
  buildUiSnapshot,
  generateFindingId,
  type AttemptUiRecord,
  type CcReviewUiSnapshot,
  type FindingUiRecord,
  type TaskUiStatus,
} from "./model.ts";

export interface WorkflowUiSource {
  workflowRunId: string;
  goal: string;
  displayState: CcReviewDisplayState;
  currentPhase: string;
  checkpointCreatedAt: string;
  completedAt?: string;
  currentTaskIndex: number;
  tasks: Task[];
  taskStatuses: Array<TaskUiStatus | undefined>;
  taskModels: Array<{ configured?: string; effective?: string } | undefined>;
  batchTaskExecutions: BatchTaskExecution[];
  taskResults: TaskResult[];
  collectedTaskFindings: ReviewFinding[][];
  findingsRollup: CcReviewFindingsRollup;
  liveLogs: readonly CcReviewLogEntry[];
  retryState?: { attempt: number; maxAttempts: number };
  persistedLogPath: string;
  artifactRunDir: string;
}

function isTerminalDisplayState(displayState: CcReviewDisplayState): boolean {
  return (
    displayState === "complete" ||
    displayState === "failed" ||
    displayState === "cancelled" ||
    displayState === "timeout"
  );
}

function mapFindingsToUiRecords(
  runId: string,
  collectedTaskFindings: ReviewFinding[][],
): FindingUiRecord[] {
  const merged = mergeRollupFindings(collectedTaskFindings);
  return merged.map((finding, seq) => ({
    ...finding,
    confidence: String(finding.confidence),
    id: generateFindingId(runId, undefined, finding.file, finding.line, finding.priority, seq),
  }));
}

function buildAttempts(source: WorkflowUiSource): AttemptUiRecord[] {
  if (!source.retryState || source.currentTaskIndex < 0) return [];
  return [
    {
      id: `${source.workflowRunId}:retry:${source.currentTaskIndex}:${source.retryState.attempt}`,
      kind: "worker",
      taskIndex: source.currentTaskIndex,
      attempt: source.retryState.attempt,
      maxAttempts: source.retryState.maxAttempts,
    },
  ];
}

function resolveTaskTimestamps(
  source: WorkflowUiSource,
): {
  taskStartedAt: Array<string | undefined>;
  taskCompletedAt: Array<string | undefined>;
  taskArtifactPaths: Array<string | undefined>;
  taskResultSummaries: Array<string | undefined>;
  taskAttemptedModels: Array<string[] | undefined>;
} {
  const taskStartedAt: Array<string | undefined> = [];
  const taskCompletedAt: Array<string | undefined> = [];
  const taskArtifactPaths: Array<string | undefined> = [];
  const taskResultSummaries: Array<string | undefined> = [];
  const taskAttemptedModels: Array<string[] | undefined> = [];

  for (let index = 0; index < source.tasks.length; index++) {
    const batchExecution = source.batchTaskExecutions.find((entry) => entry.taskIndex === index);
    const taskResult = source.taskResults[index];

    taskStartedAt[index] = batchExecution?.startedAt;
    taskArtifactPaths[index] = taskResult?.artifactPath;
    taskAttemptedModels[index] = taskResult?.attemptedModels;
    taskResultSummaries[index] =
      taskResult?.reviewResult?.summary ??
      (taskResult?.effectiveVerdict ? `Verdict: ${taskResult.effectiveVerdict}` : undefined);
  }

  return {
    taskStartedAt,
    taskCompletedAt,
    taskArtifactPaths,
    taskResultSummaries,
    taskAttemptedModels,
  };
}

/**
 * Build an immutable UI snapshot from workflow runtime fields.
 */
export function buildRuntimeUiSnapshot(source: WorkflowUiSource): CcReviewUiSnapshot {
  const timestamps = resolveTaskTimestamps(source);
  const completedAt =
    source.completedAt ??
    (isTerminalDisplayState(source.displayState) ? new Date().toISOString() : undefined);

  return buildUiSnapshot({
    runId: source.workflowRunId,
    goal: source.goal,
    displayState: source.displayState,
    phase: source.currentPhase,
    startedAt: source.checkpointCreatedAt,
    completedAt,
    currentTaskIndex: source.currentTaskIndex,
    tasks: source.tasks,
    taskStatuses: source.taskStatuses,
    taskModels: source.taskModels,
    taskStartedAt: timestamps.taskStartedAt,
    taskCompletedAt: timestamps.taskCompletedAt,
    taskArtifactPaths: timestamps.taskArtifactPaths,
    taskResultSummaries: timestamps.taskResultSummaries,
    taskAttemptedModels: timestamps.taskAttemptedModels,
    findings: mapFindingsToUiRecords(source.workflowRunId, source.collectedTaskFindings),
    findingsRollup: source.findingsRollup,
    logs: source.liveLogs,
    attempts: buildAttempts(source),
    persistedLogPath: source.persistedLogPath,
    artifactRunDir: source.artifactRunDir,
  });
}
