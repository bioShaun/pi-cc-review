// ---------------------------------------------------------------------------
// UI selectors: pure functions for grouping, sorting, filtering, and
// default selection (Spec2 §6, §7).
//
// These do NOT import the Pi runtime — they operate on the immutable
// CcReviewUiSnapshot, so they can be unit-tested directly.
// ---------------------------------------------------------------------------

import type {
  CcReviewUiSnapshot,
  FindingUiRecord,
  SeverityFilter,
  TaskUiRecord,
} from "./model.ts";
import type { CcReviewLogEntry } from "../types.ts";

const PRIORITY_ORDER: Record<string, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

/**
 * Sort findings by priority (P0 first), then file, then line.
 * Stable across snapshot updates.
 */
export function sortFindings(findings: readonly FindingUiRecord[]): FindingUiRecord[] {
  return [...findings].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority ?? ""] ?? 99;
    const pb = PRIORITY_ORDER[b.priority ?? ""] ?? 99;
    if (pa !== pb) return pa - pb;
    const fa = a.file ?? "";
    const fb = b.file ?? "";
    if (fa !== fb) return fa.localeCompare(fb);
    const la = a.line ?? 0;
    const lb = b.line ?? 0;
    return la - lb;
  });
}

/**
 * Filter findings by severity.
 */
export function filterFindingsBySeverity(
  findings: readonly FindingUiRecord[],
  filter: SeverityFilter,
): FindingUiRecord[] {
  if (filter === "all") return [...findings];
  return findings.filter((f) => f.priority === filter);
}

/**
 * Group findings by file path.
 * Returns a map of file → findings (sorted within each group).
 */
export function groupFindingsByFile(
  findings: readonly FindingUiRecord[],
): Map<string, FindingUiRecord[]> {
  const groups = new Map<string, FindingUiRecord[]>();
  const sorted = sortFindings(findings);
  for (const finding of sorted) {
    const file = finding.file ?? "(no file)";
    const existing = groups.get(file);
    if (existing) {
      existing.push(finding);
    } else {
      groups.set(file, [finding]);
    }
  }
  return groups;
}

/**
 * Get the next or previous finding in the sorted list, wrapping around.
 */
export function findAdjacentFinding(
  findings: readonly FindingUiRecord[],
  currentId: string | undefined,
  direction: "next" | "previous",
): FindingUiRecord | undefined {
  if (findings.length === 0) return undefined;
  const sorted = sortFindings(findings);
  if (!currentId) return sorted[0];
  const idx = sorted.findIndex((f) => f.id === currentId);
  if (idx === -1) return sorted[0];
  if (direction === "next") {
    return sorted[(idx + 1) % sorted.length];
  }
  return sorted[(idx - 1 + sorted.length) % sorted.length];
}

/**
 * Get the next or previous file in the grouped findings.
 */
export function findAdjacentFile(
  findings: readonly FindingUiRecord[],
  currentFile: string | undefined,
  direction: "next" | "previous",
): string | undefined {
  const groups = groupFindingsByFile(findings);
  const files = [...groups.keys()];
  if (files.length === 0) return undefined;
  if (!currentFile) return files[0];
  const idx = files.indexOf(currentFile);
  if (idx === -1) return files[0];
  if (direction === "next") {
    return files[(idx + 1) % files.length];
  }
  return files[(idx - 1 + files.length) % files.length];
}

/**
 * Get findings for a specific file.
 */
export function getFindingsForFile(
  findings: readonly FindingUiRecord[],
  file: string,
): FindingUiRecord[] {
  return sortFindings(findings.filter((f) => (f.file ?? "(no file)") === file));
}

/**
 * Filter tasks by status.
 */
export function filterTasksByStatus(
  tasks: readonly TaskUiRecord[],
  statuses: TaskUiStatus[],
): TaskUiRecord[] {
  const set = new Set(statuses);
  return tasks.filter((t) => set.has(t.status));
}

/**
 * Get the highest unresolved finding severity from the snapshot.
 * Returns undefined when there are no findings.
 */
export function getHighestUnresolvedSeverity(
  snapshot: CcReviewUiSnapshot,
): string | undefined {
  const sorted = sortFindings(snapshot.findings);
  const unresolved = sorted.find((f) => {
    const status = f.status ?? "";
    return status !== "fixed" && status !== "resolved";
  });
  return unresolved?.priority;
}

/**
 * Get the latest warning or error log entry (error takes priority).
 */
export function getLatestExceptionLog(
  logs: readonly CcReviewLogEntry[],
): CcReviewLogEntry | undefined {
  const errors = logs.filter((l) => l.severity === "error");
  if (errors.length > 0) return errors[errors.length - 1];
  const warnings = logs.filter((l) => l.severity === "warning");
  if (warnings.length > 0) return warnings[warnings.length - 1];
  return undefined;
}

/**
 * Resolve the next selection when the currently selected item disappears
 * from the snapshot. Falls back to the adjacent item, then to the first item.
 */
export function resolveRetainedSelection(
  findings: readonly FindingUiRecord[],
  selectedId: string | undefined,
): string | undefined {
  if (!selectedId) return undefined;
  if (findings.some((f) => f.id === selectedId)) return selectedId;
  // Find the item that would have been adjacent to the deleted one.
  // Since we don't have the old list, just return the first available.
  return findings[0]?.id;
}

/**
 * Resolve the retained selected file when it disappears from findings.
 */
export function resolveRetainedFile(
  findings: readonly FindingUiRecord[],
  selectedFile: string | undefined,
): string | undefined {
  if (!selectedFile) return undefined;
  const groups = groupFindingsByFile(findings);
  if (groups.has(selectedFile)) return selectedFile;
  return [...groups.keys()][0];
}

/**
 * Count tasks by status for the compact widget header.
 */
export function countTasksByStatus(
  tasks: readonly TaskUiRecord[],
): { completed: number; running: number; pending: number; failed: number; total: number } {
  let completed = 0, running = 0, pending = 0, failed = 0;
  for (const t of tasks) {
    switch (t.status) {
      case "completed": case "completed_with_warnings": completed++; break;
      case "running": running++; break;
      case "pending": pending++; break;
      case "failed": case "validation_failed": case "cancelled": failed++; break;
    }
  }
  return { completed, running, pending, failed, total: tasks.length };
}

// Local type re-export for filterTasksByStatus
type TaskUiStatus = import("./model.ts").TaskUiStatus;
