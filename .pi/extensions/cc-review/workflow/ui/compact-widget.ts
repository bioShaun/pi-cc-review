// ---------------------------------------------------------------------------
// Compact widget renderer (Spec2 §5.1, §9, §10).
//
// Pure rendering function for the compact widget. Takes a snapshot and
// produces lines of text. No Pi runtime dependency — fully unit-testable.
//
// Responsive rules:
//   < 50 cols: current task, phase, finding count, latest exception
//   50-89: 3 tasks, model or duration, finding summary
//   >= 90: 5 tasks, model, duration, categorized summary
// ---------------------------------------------------------------------------

import type { CcReviewUiSnapshot, TaskUiRecord } from "./model.ts";
import {
  countTasksByStatus,
  getLatestExceptionLog,
} from "./selectors.ts";
import type { CcReviewFindingsRollup } from "../../structured.ts";
import { truncateWidgetLine } from "../ui.ts";

export interface CompactWidgetRenderOptions {
  width: number;
  /** Spinner frame for running tasks. Tests use a fixed frame like "▸". */
  spinnerFrame?: string;
  /** Whether color is enabled. When false, no color tokens. */
  colorEnabled?: boolean;
}

export interface CompactWidgetRenderResult {
  lines: string[];
  /** Width that was used for rendering. */
  width: number;
}

const STATUS_ICONS: Record<string, string> = {
  pending: "○",
  running: "▸", // default spinner frame for tests
  completed: "✔",
  completed_with_warnings: "⚠",
  failed: "✘",
  validation_failed: "✖",
  cancelled: "⊘",
  skipped: "↪",
  review_blocked: "⛔",
};

function getStatusIcon(status: string, spinnerFrame?: string): string {
  if (status === "running") return spinnerFrame ?? "▸";
  return STATUS_ICONS[status] ?? "○";
}

function formatDuration(startedAt?: string, completedAt?: string): string | undefined {
  if (!startedAt) return undefined;
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - start;
  if (ms < 0) return undefined;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  if (minutes < 60) return `${minutes}m${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function truncateLine(text: string, maxWidth: number): string {
  return truncateWidgetLine(text, maxWidth);
}

function formatFindingsRollupCompact(rollup: CcReviewFindingsRollup): string {
  const parts: string[] = [];
  if (rollup.unfixedP0 > 0) parts.push(`${rollup.unfixedP0} P0`);
  if (rollup.unfixedP1 > 0) parts.push(`${rollup.unfixedP1} P1`);
  if (rollup.unfixedP2P3 > 0) parts.push(`${rollup.unfixedP2P3} P2/P3`);
  return parts.length > 0 ? parts.join(" · ") : "none";
}

function formatPhaseLabel(snapshot: CcReviewUiSnapshot): string {
  const phaseMap: Record<string, string> = {
    initializing: "Initializing",
    planning: "Planning",
    executing: "Executing",
    reviewing: "Reviewing",
    retrying: "Retrying",
    warning: "Warning",
    failed: "Failed",
    cancelled: "Cancelled",
    timeout: "Timeout",
    completed: "Completed",
  };
  return phaseMap[snapshot.displayState] ?? snapshot.displayState;
}

function formatHeader(snapshot: CcReviewUiSnapshot, width: number): string {
  const counts = countTasksByStatus(snapshot.tasks);
  const phase = formatPhaseLabel(snapshot);
  const progress = `${counts.completed + counts.failed}/${counts.total}`;
  const header = `● CC Review  ${progress} · ${phase}`;
  return truncateLine(header, width);
}

function formatTaskLine(task: TaskUiRecord, width: number, spinnerFrame?: string): string {
  const icon = getStatusIcon(task.status, spinnerFrame);
  const num = `${task.index + 1}`;
  const title = task.activeForm ?? task.title;
  let suffix = "";
  if (task.status === "running") {
    const parts: string[] = [];
    if (task.effectiveModel) {
      const modelShort = task.effectiveModel.split("/").pop() ?? task.effectiveModel;
      parts.push(modelShort);
    }
    const duration = formatDuration(task.startedAt);
    if (duration) parts.push(duration);
    suffix = parts.length > 0 ? `  ${parts.join(" · ")}` : "";
  } else if (task.status === "completed" || task.status === "completed_with_warnings") {
    const duration = formatDuration(task.startedAt, task.completedAt);
    if (duration) suffix = `  ${duration}`;
  }
  const line = `  ${icon} ${num}  ${title}${suffix}`;
  return truncateLine(line, width);
}

function getVisibleTasks(
  tasks: TaskUiRecord[],
  currentTaskIndex: number,
  width: number,
): TaskUiRecord[] {
  if (tasks.length === 0) return [];
  if (width < 50) {
    // Only show current task
    const current = tasks.find((t) => t.index === currentTaskIndex) ?? tasks[0];
    return current ? [current] : [];
  }
  if (width < 90) {
    // Show up to 3 tasks around the current
    const currentPosition = Math.max(0, tasks.findIndex((task) => task.index === currentTaskIndex));
    const start = Math.max(0, Math.min(currentPosition - 1, tasks.length - 3));
    return tasks.slice(start, start + 3);
  }
  // Show up to 5 tasks around the current
  const currentPosition = Math.max(0, tasks.findIndex((task) => task.index === currentTaskIndex));
  const start = Math.max(0, Math.min(currentPosition - 2, tasks.length - 5));
  return tasks.slice(start, start + 5);
}

/**
 * Render the compact widget from a snapshot.
 * Pure function — no side effects, no Pi runtime dependency.
 */
export function renderCompactWidget(
  snapshot: CcReviewUiSnapshot,
  options: CompactWidgetRenderOptions,
): CompactWidgetRenderResult {
  const { width, spinnerFrame } = options;
  const lines: string[] = [];

  // Header (always present)
  lines.push(formatHeader(snapshot, width));

  // Task window
  const visibleTasks = getVisibleTasks(snapshot.tasks, snapshot.currentTaskIndex, width);
  for (const task of visibleTasks) {
    lines.push(formatTaskLine(task, width, spinnerFrame));
  }

  // Findings summary (>= 50 cols)
  if (width >= 50) {
    const findingsLine = formatFindingsRollupCompact(snapshot.findingsRollup);
    lines.push(truncateLine(`  Findings  ${findingsLine}`, width));
  } else {
    // Narrow: just count
    const total = (snapshot.findingsRollup.unfixedP0 ?? 0) + (snapshot.findingsRollup.unfixedP1 ?? 0) +
      (snapshot.findingsRollup.unfixedP2P3 ?? 0);
    if (total > 0) {
      lines.push(truncateLine(`  Findings ${total}`, width));
    }
  }

  // Latest exception (always shown if present, Error priority)
  const exception = getLatestExceptionLog(snapshot.logs);
  if (exception) {
    const icon = exception.severity === "error" ? "⚠" : "⚠";
    const msg = exception.message.split("\n")[0] ?? "";
    lines.push(truncateLine(`  ${icon} ${msg}`, width));
  }

  // Footer (>= 50 cols)
  if (width >= 50) {
    lines.push(truncateLine("  Enter details · L logs · ? help", width));
  }

  return { lines, width };
}
