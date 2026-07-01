import * as path from "node:path";

import type { CcReviewSummaryMeta, TaskStatus } from "../structured.ts";
import { buildSummaryMeta, sortReviewFindings } from "../structured.ts";
import type { Task } from "./dependencies.ts";
import { formatResumeInstructions } from "./checkpoint.ts";
import { summarizeValidationParseFailures } from "./validation.ts";
import type { BatchReviewResult, TaskResult } from "./types.ts";
import type { TaskModelState } from "./ui.ts";

export interface CcReviewTaskOutcomeCounts {
  completed: number;
  warnings: number;
  failed: number;
  total: number;
}

export function countCcReviewTaskOutcomesFromSummary(summary: string): CcReviewTaskOutcomeCounts {
  const counts: CcReviewTaskOutcomeCounts = { completed: 0, warnings: 0, failed: 0, total: 0 };
  const statusMatches = summary.matchAll(/\*\*?Status:\*\*?\s*(.+)$/gim);
  for (const match of statusMatches) {
    counts.total += 1;
    const status = match[1].trim().toLowerCase();
    if (
      status.includes("blocked by reviewer") ||
      status.includes("review blocked")
    ) {
      counts.failed += 1;
    } else if (status.includes("failed") || status.includes("validation failed") || status.includes("cancelled")) {
      counts.failed += 1;
    } else if (status.includes("warning") || status.includes("skipped")) {
      counts.warnings += 1;
    } else if (status.includes("completed")) {
      counts.completed += 1;
    } else {
      counts.warnings += 1;
    }
  }
  return counts;
}

export function formatCcReviewSummaryHeadline(counts: CcReviewTaskOutcomeCounts): string {
  if (counts.total === 0) return "CC Review report ready";
  return `${counts.completed} \u5b8c\u6210 \u00b7 ${counts.warnings} \u8b66\u544a \u00b7 ${counts.failed} \u5931\u8d25`;
}

export type CcReviewSummaryBadge = "success" | "warning" | "failed" | "cancelled";

export function classifyCcReviewSummary(summary: string): CcReviewSummaryBadge {
  const text = summary || "";
  if (/workflow was cancelled or timed out/i.test(text)) return "cancelled";
  if (/blocked by reviewer/i.test(text)) return "failed";
  if (/terminated early due to an unrecoverable/i.test(text)) return "failed";
  if (/completed partially|reported warnings|completed with warnings/i.test(text)) return "warning";
  if (/successfully accomplished/i.test(text)) return "success";
  return "warning";
}

export function resolveDisplayedTaskModel(modelState: TaskModelState | undefined): string | undefined {
  return modelState?.effective || modelState?.configured;
}

export function shouldShowUnknownTaskModel(status: TaskStatus | "running" | "pending", modelState: TaskModelState | undefined): boolean {
  if (resolveDisplayedTaskModel(modelState)) return false;
  return status !== "pending" && status !== "running";
}

function formatTaskModelState(configuredModel: string | undefined, effectiveModel: string | undefined): TaskModelState | undefined {
  if (!configuredModel && !effectiveModel) return undefined;
  return {
    configured: configuredModel || undefined,
    effective: effectiveModel || undefined,
  };
}

export function setTaskConfiguredModel(taskModels: TaskModelState[], index: number, configuredModel: string | undefined): void {
  if (!configuredModel) return;
  const current = taskModels[index];
  taskModels[index] = {
    configured: current?.configured || configuredModel,
    effective: current?.effective,
  };
}

export function setTaskEffectiveModel(taskModels: TaskModelState[], index: number, effectiveModel: string | undefined): void {
  if (!effectiveModel) return;
  const current = taskModels[index];
  taskModels[index] = {
    configured: current?.configured,
    effective: effectiveModel,
  };
}

function formatTaskStatusText(taskResult: TaskResult): string {
  if (taskResult.status === "skipped") return "Skipped (not executed)";
  if (taskResult.status === "cancelled") return "Cancelled / Timed out (interrupted)";
  if (taskResult.status === "failed") return `Failed (subagent exit ${taskResult.executionCode})`;
  if (taskResult.status === "validation_failed") return `Validation Failed (${taskResult.validationError})`;
  if (taskResult.status === "review_blocked") {
    const reason = taskResult.blockReason ? `, reason: ${taskResult.blockReason}` : "";
    return `Blocked by reviewer (${taskResult.effectiveVerdict ?? "block"}${reason})`;
  }
  if (taskResult.effectiveVerdict === "ship" && taskResult.reviewCode === 0) {
    return "Completed and reviewed";
  }
  if (taskResult.effectiveVerdict === "ship_with_warnings") {
    const reviewLabel = taskResult.reviewWarningName || "review";
    return `Completed with warnings (${reviewLabel} exit ${taskResult.reviewCode})`;
  }
  if (taskResult.effectiveVerdict) {
    let text = `Completed (${taskResult.effectiveVerdict})`;
    if (
      taskResult.reportedVerdict &&
      taskResult.reportedVerdict !== taskResult.effectiveVerdict
    ) {
      text += ` [reported: ${taskResult.reportedVerdict} → effective: ${taskResult.effectiveVerdict}]`;
    }
    if (taskResult.reviewerExitDiagnostic) text += ` — ${taskResult.reviewerExitDiagnostic}`;
    return text;
  }
  if (taskResult.executionCode === 0 && taskResult.reviewCode === 0) return "Completed and reviewed";
  return `Completed with warnings (subagent exit ${taskResult.executionCode}, ${taskResult.reviewWarningName || "review"} exit ${taskResult.reviewCode})`;
}

export function buildSummaryReport(
  goal: string,
  taskResults: TaskResult[],
  tasks: Task[],
  options?: {
    concurrency?: number;
    runId?: string;
    artifactDir?: string;
    parseFailureLines?: string[];
    batchReviewResult?: BatchReviewResult;
    termination?: "failed" | "cancelled";
  }
): string {
  const results = [...taskResults];
  for (let j = results.length; j < tasks.length; j++) {
    results.push({
      title: tasks[j].title,
      description: tasks[j].description,
      executionCode: -1,
      reviewCode: -1,
      status: "skipped",
    });
  }

  const hasReviewBlocked = results.some((task) => task.status === "review_blocked");
  const failedOrHalted = results.some((task) => task.status === "failed" || task.status === "validation_failed" || task.status === "review_blocked");
  const hasWarnings = results.some((task) =>
    task.executionCode !== 0 ||
    task.reviewCode !== 0 ||
    task.validationError ||
    task.status === "failed" ||
    task.status === "validation_failed" ||
    task.status === "review_blocked" ||
    task.status === "skipped" ||
    task.status === "cancelled" ||
    task.status === "completed_with_warnings"
  );
  const hasSkipped = results.some((task) => task.status === "skipped");
  const hasCancelled = results.some((task) => task.status === "cancelled");

  let summaryMarkdown = `## 🏆 CC Review Orchestrator Report\n\n`;
  if (options?.termination === "cancelled" || hasCancelled) {
    summaryMarkdown += `The workflow was cancelled or timed out before completion.\n\n`;
  } else if (hasReviewBlocked) {
    summaryMarkdown += `The workflow was blocked by reviewer findings before completion.\n\n`;
  } else if (failedOrHalted) {
    summaryMarkdown += `The workflow terminated early due to an unrecoverable task execution or validation failure.\n\n`;
  } else if (options?.termination === "failed" && tasks.length === 0) {
    summaryMarkdown += `The workflow failed during planning before any tasks were created.\n\n`;
  } else if (options?.termination === "failed") {
    summaryMarkdown += `The workflow terminated early due to an unrecoverable workflow failure.\n\n`;
  } else if (hasSkipped) {
    summaryMarkdown += `The workflow completed partially; some tasks were skipped.\n\n`;
  } else if (hasWarnings) {
    summaryMarkdown += `The workflow finished, but one or more task subprocesses reported warnings.\n\n`;
  } else {
    summaryMarkdown += `The overarching goal has been successfully accomplished!\n\n`;
  }

  summaryMarkdown += `**Goal:** ${goal}\n\n`;
  summaryMarkdown += `### 📋 Completed & Partial Tasks\n\n`;

  for (let i = 0; i < results.length; i++) {
    const taskResult = results[i];
    summaryMarkdown += `${i + 1}. **${taskResult.title}**\n`;
    summaryMarkdown += `   - *Description:* ${taskResult.description}\n`;
    summaryMarkdown += `   - *Status:* ${formatTaskStatusText(taskResult)}\n`;
    if (taskResult.artifactPath) {
      summaryMarkdown += `   - *Artifact:* \`${taskResult.artifactPath}\`\n`;
    }
    const displayedModel = resolveDisplayedTaskModel(formatTaskModelState(taskResult.configuredModel, taskResult.effectiveModel));
    if (displayedModel) {
      summaryMarkdown += `   - *Model:* \`${displayedModel}\`\n`;
    }
    if (taskResult.effectiveVerdict && taskResult.reviewResult?.summary) {
      summaryMarkdown += `   - *Review Summary:* ${taskResult.reviewResult.summary}\n`;
    }
    summaryMarkdown += `\n`;
  }

  // Use batch review result findings when available (after-all mode, R8);
  // otherwise fall back to per-task reviewResult findings (per-task mode).
  const batchFindings = options?.batchReviewResult?.reviewResult?.findings ?? [];
  const rollupFindings = sortReviewFindings(
    batchFindings.length > 0
      ? batchFindings
      : results.flatMap((taskResult) => taskResult.reviewResult?.findings ?? [])
  );
  if (rollupFindings.length > 0) {
    summaryMarkdown += `### 🔎 Review Findings\n\n`;
    for (const finding of rollupFindings) {
      const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "workspace";
      summaryMarkdown += `- **[${finding.priority}]** ${location} — ${finding.message} (${finding.status}, confidence ${finding.confidence})\n`;
    }
    summaryMarkdown += `\n`;
  }

  const allUnresolved: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const taskResult = results[i];
    if (taskResult.status === "skipped") {
      allUnresolved.push(`Task Skipped: "${taskResult.title}" - Description: ${taskResult.description}`);
    } else if (taskResult.status === "cancelled") {
      allUnresolved.push(`Task Cancelled: "${taskResult.title}" - Interrupted before completion`);
    } else if (taskResult.status === "failed") {
      allUnresolved.push(`Task Failed: "${taskResult.title}" - Error: Subagent exited with code ${taskResult.executionCode}`);
    } else if (taskResult.status === "validation_failed") {
      allUnresolved.push(`Task Validation Failed: "${taskResult.title}" - Reason: ${taskResult.validationError}`);
    } else if (taskResult.status === "review_blocked") {
      allUnresolved.push(`Task Blocked by Reviewer: "${taskResult.title}" - ${taskResult.blockReason ?? taskResult.effectiveVerdict ?? "block"}`);
    }

    if (taskResult.unresolvedItems && taskResult.unresolvedItems.length > 0) {
      for (const item of taskResult.unresolvedItems) {
        allUnresolved.push(`In Task "${taskResult.title}": ${item}`);
      }
    }
  }

  if (allUnresolved.length > 0) {
    summaryMarkdown += `### ⚠️ Unresolved Items\n\n`;
    for (const unresolved of allUnresolved) {
      summaryMarkdown += `- ${unresolved}\n`;
    }
    summaryMarkdown += `\n`;
  }

  if (failedOrHalted || hasCancelled || hasReviewBlocked) {
    summaryMarkdown += `### 💡 Suggested Actionable Steps to Recover\n\n`;
    summaryMarkdown += `1. **Review the Error/Validation Details**: Examine task artifacts and review findings in the report above.\n`;
    summaryMarkdown += `2. **Perform Manual Fixes**: Resolve the issue in workspace files directly.\n`;
    if (options?.runId && options?.artifactDir) {
      summaryMarkdown += `3. **Resume Execution**: ${formatResumeInstructions(path.dirname(options.artifactDir), options.runId).replace(/\n/g, "\n   ")}\n\n`;
    } else {
      summaryMarkdown += `3. **Resume Execution**: Restart the workflow for remaining tasks after fixes.\n\n`;
    }
  }

  const parseFailures = options?.parseFailureLines ?? summarizeValidationParseFailures(taskResults);
  if (parseFailures.length > 0) {
    summaryMarkdown += `### 📐 Structured Report Parse Failures\n\n`;
    for (const line of parseFailures) {
      summaryMarkdown += `- ${line}\n`;
    }
    summaryMarkdown += `\n`;
  }

  if (options?.artifactDir) {
    summaryMarkdown += `### 📁 Run Artifacts\n\nStructured artifacts and checkpoint: \`${options.artifactDir}\`\n\n`;
  }

  summaryMarkdown += `### ⚙️ Execution Configuration\n\n`;
  summaryMarkdown += `- *Worker concurrency:* ${options?.concurrency ?? "auto"}\n\n`;

  return summaryMarkdown;
}

export function buildCcReviewSummaryMeta(
  taskResults: TaskResult[],
  options?: { concurrency?: number; batchReviewResult?: BatchReviewResult }
): CcReviewSummaryMeta {
  return buildSummaryMeta(taskResults, options);
}
