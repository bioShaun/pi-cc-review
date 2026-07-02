import * as fs from "node:fs";
import * as path from "node:path";

import { getArtifactRunDir, WORKFLOW_ARTIFACT_DIR, type TaskStatus } from "../structured.ts";
import type { Task } from "./dependencies.ts";
import type { BatchReviewResult, BatchTaskExecution, TaskResult } from "./types.ts";
import type { WorkflowRunStateBuffer } from "./session.ts";

export const CHECKPOINT_FILE_NAME = "checkpoint.json";
export const PLAN_FILE_NAME = "plan.json";

export interface WorkflowCheckpoint {
  schemaVersion: 1;
  runId: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  reviewProvider: string;
  reviewMode: string;
  tasks: Task[];
  taskResults: TaskResult[];
  /** 0-based indices of tasks whose successful result can be reused on resume. */
  completedTaskIndices: number[];
  /** Last phase reached before interruption. */
  phase: "planning" | "executing" | "reviewing" | "complete" | "failed" | "cancelled";
  /** Optional resume hint when workflow stopped mid-run. */
  resumeHint?: string;
  stateBuffer?: WorkflowRunStateBuffer;
  /** Persisted after-all execution snapshots for resume (after-all mode only). */
  batchTaskExecutions?: BatchTaskExecution[];
  /** Persisted batch review result for resume (after-all mode only). */
  batchReviewResult?: BatchReviewResult;
}

export interface WorkflowPlanArtifact {
  schemaVersion: 1;
  runId: string;
  goal: string;
  createdAt: string;
  reviewProvider: string;
  reviewMode: string;
  tasks: Task[];
}

export function getCheckpointPath(cwd: string, runId: string): string {
  return path.join(getArtifactRunDir(cwd, runId), CHECKPOINT_FILE_NAME);
}

export function getPlanArtifactPath(cwd: string, runId: string): string {
  return path.join(getArtifactRunDir(cwd, runId), PLAN_FILE_NAME);
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

export function writePlanArtifact(cwd: string, plan: WorkflowPlanArtifact): string {
  const filePath = getPlanArtifactPath(cwd, plan.runId);
  writeJsonAtomic(filePath, plan);
  return filePath;
}

export function writeCheckpoint(cwd: string, checkpoint: WorkflowCheckpoint): string {
  const filePath = getCheckpointPath(cwd, checkpoint.runId);
  writeJsonAtomic(filePath, { ...checkpoint, updatedAt: new Date().toISOString() });
  return filePath;
}

export function loadCheckpoint(cwd: string, runId: string): WorkflowCheckpoint | undefined {
  const filePath = getCheckpointPath(cwd, runId);
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as WorkflowCheckpoint;
    if (raw.schemaVersion !== 1 || !Array.isArray(raw.tasks)) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

export function loadPlanArtifact(cwd: string, runId: string): WorkflowPlanArtifact | undefined {
  const filePath = getPlanArtifactPath(cwd, runId);
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as WorkflowPlanArtifact;
    if (raw.schemaVersion !== 1 || !Array.isArray(raw.tasks)) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

export function listResumableRunIds(cwd: string): string[] {
  const artifactsRoot = path.join(cwd, WORKFLOW_ARTIFACT_DIR);
  if (!fs.existsSync(artifactsRoot)) return [];
  const runIds: string[] = [];
  for (const entry of fs.readdirSync(artifactsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const checkpointPath = path.join(artifactsRoot, entry.name, CHECKPOINT_FILE_NAME);
    if (fs.existsSync(checkpointPath)) {
      runIds.push(entry.name);
    }
  }
  return runIds.sort();
}

export function isTaskReusableOnResume(status: TaskStatus | undefined): boolean {
  return status === "completed" || status === "completed_with_warnings";
}

/** Tasks to skip when resuming: only successful results are reusable. */
export function resolveTasksToSkipOnResume(
  checkpoint: WorkflowCheckpoint,
  fromTask?: number
): Set<number> {
  const skip = new Set<number>();

  // Preserve compatibility with old checkpoints that only recorded completion
  // indices, but let an explicit task result override a corrupt legacy index.
  for (const index of checkpoint.completedTaskIndices) {
    if (checkpoint.taskResults[index]?.status === undefined) {
      skip.add(index);
    }
  }
  for (let i = 0; i < checkpoint.taskResults.length; i++) {
    if (isTaskReusableOnResume(checkpoint.taskResults[i]?.status)) {
      skip.add(i);
    } else if (checkpoint.taskResults[i]?.status !== undefined) {
      skip.delete(i);
    }
  }

  // --from-task is an explicit override: tasks before it are skipped and every
  // task from that index onward is rerun, even if an old checkpoint says done.
  if (fromTask !== undefined && Number.isInteger(fromTask) && fromTask >= 0) {
    for (let i = 0; i < checkpoint.tasks.length; i++) {
      if (i < fromTask) skip.add(i);
      else skip.delete(i);
    }
  }
  return skip;
}

/**
 * Rebuild the sparse, task-indexed execution array from its compact checkpoint
 * representation. Parallel cancellation can leave gaps, so array position is
 * not a reliable substitute for taskIndex.
 */
export function restoreBatchTaskExecutions(
  executions: readonly BatchTaskExecution[] | undefined
): BatchTaskExecution[] {
  const restored: BatchTaskExecution[] = [];
  for (const execution of executions ?? []) {
    if (execution && Number.isInteger(execution.taskIndex) && execution.taskIndex >= 0) {
      restored[execution.taskIndex] = execution;
    }
  }
  return restored;
}

export function formatResumeInstructions(cwd: string, runId: string): string {
  const artifactDir = getArtifactRunDir(cwd, runId);
  return (
    `To continue this run after fixing blockers or interruptions:\n` +
    `- Slash command: \`/cc-review --resume ${runId} <goal>\`\n` +
    `- Tool param: \`resumeRunId: "${runId}"\` with the same goal\n` +
    `- Artifacts: \`${artifactDir}\``
  );
}
