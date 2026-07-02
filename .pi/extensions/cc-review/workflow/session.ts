import * as fs from "node:fs";
import * as path from "node:path";

import { getArtifactRunDir } from "../structured.ts";
import type { SubagentStructuredReport } from "../structured.ts";
import type { TaskResult } from "./types.ts";

export const STATE_BUFFER_FILE_NAME = "run-state.json";

/** Compact per-run state injected into subsequent task prompts (session continuity). */
export interface WorkflowRunStateBuffer {
  schemaVersion: 1;
  runId: string;
  updatedAt: string;
  filesTouched: string[];
  keyDecisions: string[];
  unresolvedItems: string[];
}

export function getStateBufferPath(cwd: string, runId: string): string {
  return path.join(getArtifactRunDir(cwd, runId), STATE_BUFFER_FILE_NAME);
}

export function emptyStateBuffer(runId: string): WorkflowRunStateBuffer {
  return {
    schemaVersion: 1,
    runId,
    updatedAt: new Date().toISOString(),
    filesTouched: [],
    keyDecisions: [],
    unresolvedItems: [],
  };
}

export function loadStateBuffer(cwd: string, runId: string): WorkflowRunStateBuffer {
  const filePath = getStateBufferPath(cwd, runId);
  if (!fs.existsSync(filePath)) return emptyStateBuffer(runId);
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as WorkflowRunStateBuffer;
    if (raw.schemaVersion !== 1) return emptyStateBuffer(runId);
    return {
      schemaVersion: 1,
      runId,
      updatedAt: raw.updatedAt ?? new Date().toISOString(),
      filesTouched: Array.isArray(raw.filesTouched) ? raw.filesTouched : [],
      keyDecisions: Array.isArray(raw.keyDecisions) ? raw.keyDecisions : [],
      unresolvedItems: Array.isArray(raw.unresolvedItems) ? raw.unresolvedItems : [],
    };
  } catch {
    return emptyStateBuffer(runId);
  }
}

export function persistStateBuffer(cwd: string, buffer: WorkflowRunStateBuffer): string {
  const filePath = getStateBufferPath(cwd, buffer.runId);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const next = { ...buffer, updatedAt: new Date().toISOString() };
  fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
  return filePath;
}

function appendUnique(target: string[], values: string[], maxItems: number): void {
  for (const value of values) {
    const item = value.trim();
    if (!item || target.includes(item)) continue;
    target.push(item);
    if (target.length > maxItems) target.shift();
  }
}

export function mergeTaskResultIntoStateBuffer(
  buffer: WorkflowRunStateBuffer,
  taskResult: TaskResult,
  structuredReport?: SubagentStructuredReport | null
): WorkflowRunStateBuffer {
  const next = { ...buffer, filesTouched: [...buffer.filesTouched], keyDecisions: [...buffer.keyDecisions], unresolvedItems: [...buffer.unresolvedItems] };
  const succeeded =
    taskResult.status === "completed" ||
    taskResult.status === "completed_with_warnings";

  if (structuredReport?.filesChanged?.length) {
    appendUnique(next.filesTouched, structuredReport.filesChanged, 40);
  }
  if (succeeded && structuredReport?.summary?.trim()) {
    appendUnique(next.keyDecisions, [`${taskResult.title}: ${structuredReport.summary.trim()}`], 20);
  } else if (succeeded && taskResult.title) {
    appendUnique(next.keyDecisions, [`${taskResult.title}: completed`], 20);
  }
  if (structuredReport?.unresolvedItems?.length) {
    appendUnique(next.unresolvedItems, structuredReport.unresolvedItems, 30);
  } else if (taskResult.unresolvedItems?.length) {
    appendUnique(next.unresolvedItems, taskResult.unresolvedItems, 30);
  }

  return next;
}

/** Rebuild derived state after a task result is replaced during retry/resume. */
export function rebuildStateBufferFromTaskResults(
  runId: string,
  taskResults: readonly (TaskResult | undefined)[]
): WorkflowRunStateBuffer {
  let buffer = emptyStateBuffer(runId);
  for (const result of taskResults) {
    if (!result) continue;
    buffer = mergeTaskResultIntoStateBuffer(
      buffer,
      result,
      result.structuredReport
    );
  }
  return buffer;
}

const MAX_STATE_BUFFER_PROMPT_CHARS = 2000;

/** Render state buffer for injection into subagent prompts. */
export function formatStateBufferForPrompt(buffer: WorkflowRunStateBuffer): string {
  const sections: string[] = ["Workflow Run State (from prior tasks in this run):"];
  if (buffer.filesTouched.length > 0) {
    sections.push(`Files touched: ${buffer.filesTouched.slice(-15).join(", ")}`);
  }
  if (buffer.keyDecisions.length > 0) {
    sections.push("Key decisions:");
    for (const decision of buffer.keyDecisions.slice(-8)) {
      sections.push(`- ${decision}`);
    }
  }
  if (buffer.unresolvedItems.length > 0) {
    sections.push("Unresolved from prior tasks:");
    for (const item of buffer.unresolvedItems.slice(-8)) {
      sections.push(`- ${item}`);
    }
  }
  let text = sections.join("\n");
  if (text.length > MAX_STATE_BUFFER_PROMPT_CHARS) {
    text = text.slice(0, MAX_STATE_BUFFER_PROMPT_CHARS - 3) + "...";
  }
  return text.length > sections[0].length ? text : "";
}
