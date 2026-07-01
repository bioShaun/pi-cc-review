// ---------------------------------------------------------------------------
// Long-running and needs-attention control events (P2-2).
//
// Borrowed from pi-subagents' `subagent-control.ts`. CC Review has timeouts
// and streamed logs, but it does not distinguish:
//   * active but long-running (productive, just slow)
//   * idle / needs attention (no activity for a while)
//   * repeated tool failures before timeout
//
// This module tracks last observed subagent activity and emits typed control
// events so the UI can render compact labels and the logs can record them.
//
// Design:
//   * `SubagentActivityTracker` records timestamps of observed activity.
//   * `classifySubagentControlState` returns the current control state.
//   * Events are deduplicated per task/run so the UI is not spammed.
//   * The tracker is pure (no Pi runtime dependency) so it can be unit-tested.
// ---------------------------------------------------------------------------

export type SubagentControlState =
  | "active"           // recently observed activity
  | "active_long_running" // active but exceeding the long-running threshold
  | "needs_attention"  // no activity for the idle threshold
  | "idle"            // not started or completed
  | "completed";

export type SubagentControlEvent =
  | "active_long_running"
  | "needs_attention"
  | "repeated_tool_failures";

export interface SubagentControlThresholds {
  /** Ms without activity before transitioning to needs_attention. */
  idleMs: number;
  /** Ms of continuous activity before transitioning to active_long_running. */
  longRunningMs: number;
  /** Number of consecutive tool failures before emitting repeated_tool_failures. */
  toolFailureThreshold: number;
}

export const DEFAULT_CONTROL_THRESHOLDS: SubagentControlThresholds = {
  idleMs: 60_000,        // 1 minute
  longRunningMs: 300_000, // 5 minutes
  toolFailureThreshold: 3,
};

export interface SubagentActivityTracker {
  /** Task index this tracker monitors. */
  taskIndex: number;
  /** ISO timestamp when the task started. */
  startedAt: string;
  /** Last observed activity timestamp (ms epoch). */
  lastActivityMs: number;
  /** Consecutive tool failures since last success. */
  consecutiveToolFailures: number;
  /** Last emitted control event (for deduplication). */
  lastEmittedEvent: SubagentControlEvent | undefined;
  /** Whether the task has completed. */
  completed: boolean;
}

export function createSubagentActivityTracker(
  taskIndex: number,
  startedAt: string = new Date().toISOString(),
  thresholds?: Partial<SubagentControlThresholds>,
): SubagentActivityTracker & { thresholds: SubagentControlThresholds } {
  // Initialize lastActivityMs from startedAt so the idle timer reflects the
  // true elapsed time since the task began, not the tracker creation moment.
  const startedMs = new Date(startedAt).getTime();
  const now = Date.now();
  return {
    taskIndex,
    startedAt,
    lastActivityMs: Number.isFinite(startedMs) ? startedMs : now,
    consecutiveToolFailures: 0,
    lastEmittedEvent: undefined,
    completed: false,
    thresholds: { ...DEFAULT_CONTROL_THRESHOLDS, ...thresholds },
  };
}

/**
 * Record observed activity (tool call, text delta, etc.) on the tracker.
 * Resets the idle timer and, if successful, resets the failure counter.
 * Also resets the dedup state so control events can re-fire after the
 * subagent recovers from an idle/stuck period.
 */
export function recordActivity(
  tracker: SubagentActivityTracker,
  options: { timestamp?: number; toolSuccess?: boolean } = {},
): void {
  tracker.lastActivityMs = options.timestamp ?? Date.now();
  if (options.toolSuccess === true) {
    tracker.consecutiveToolFailures = 0;
  }
  // Reset dedup so needs_attention/long_running can fire again if the
  // subagent stalls a second time.
  tracker.lastEmittedEvent = undefined;
}

/**
 * Record a tool failure on the tracker.
 */
export function recordToolFailure(
  tracker: SubagentActivityTracker,
  options: { timestamp?: number } = {},
): void {
  tracker.consecutiveToolFailures++;
  tracker.lastActivityMs = options.timestamp ?? Date.now();
}

/**
 * Mark the tracker as completed.
 */
export function markCompleted(tracker: SubagentActivityTracker): void {
  tracker.completed = true;
}

/**
 * Classify the current control state of a subagent based on its tracker
 * and the current time. Does not emit events — callers use
 * `emitControlEvent` to get deduplicated events.
 */
export function classifySubagentControlState(
  tracker: SubagentActivityTracker,
  thresholds: SubagentControlThresholds = DEFAULT_CONTROL_THRESHOLDS,
  nowMs: number = Date.now(),
): SubagentControlState {
  if (tracker.completed) return "completed";
  const elapsed = nowMs - tracker.lastActivityMs;
  const totalElapsed = nowMs - new Date(tracker.startedAt).getTime();

  if (elapsed >= thresholds.idleMs) return "needs_attention";
  if (totalElapsed >= thresholds.longRunningMs) return "active_long_running";
  return "active";
}

/**
 * Determine which control event (if any) should be emitted for a tracker.
 * Returns undefined when no new event is warranted (deduplication).
 */
export function emitControlEvent(
  tracker: SubagentActivityTracker,
  thresholds: SubagentControlThresholds = DEFAULT_CONTROL_THRESHOLDS,
  nowMs: number = Date.now(),
): SubagentControlEvent | undefined {
  if (tracker.completed) return undefined;

  // Repeated tool failures take priority — they indicate a stuck loop.
  if (tracker.consecutiveToolFailures >= thresholds.toolFailureThreshold) {
    if (tracker.lastEmittedEvent !== "repeated_tool_failures") {
      tracker.lastEmittedEvent = "repeated_tool_failures";
      return "repeated_tool_failures";
    }
    return undefined;
  }

  const state = classifySubagentControlState(tracker, thresholds, nowMs);
  if (state === "needs_attention") {
    if (tracker.lastEmittedEvent !== "needs_attention") {
      tracker.lastEmittedEvent = "needs_attention";
      return "needs_attention";
    }
    return undefined;
  }
  if (state === "active_long_running") {
    if (tracker.lastEmittedEvent !== "active_long_running") {
      tracker.lastEmittedEvent = "active_long_running";
      return "active_long_running";
    }
    return undefined;
  }

  // Reset dedup when activity resumes so the same event can fire again later.
  if (state === "active" && tracker.lastEmittedEvent) {
    tracker.lastEmittedEvent = undefined;
  }
  return undefined;
}

/**
 * Format a control event as a compact, human-readable label for the
 * widget/status line.
 */
export function formatControlEventLabel(event: SubagentControlEvent): string {
  switch (event) {
    case "active_long_running":
      return "long-running";
    case "needs_attention":
      return "idle · needs attention";
    case "repeated_tool_failures":
      return "repeated tool failures";
    default:
      return "";
  }
}

/**
 * Format a control state as a compact status label.
 */
export function formatControlStateLabel(state: SubagentControlState): string {
  switch (state) {
    case "active":
      return "";
    case "active_long_running":
      return "long-running";
    case "needs_attention":
      return "needs attention";
    case "idle":
      return "idle";
    case "completed":
      return "done";
    default:
      return "";
  }
}

/**
 * Build a structured log entry payload for a control event.
 * Used by the logging path to persist typed control events.
 */
export function buildControlEventLogPayload(
  tracker: SubagentActivityTracker,
  event: SubagentControlEvent,
  thresholds: SubagentControlThresholds = DEFAULT_CONTROL_THRESHOLDS,
  nowMs: number = Date.now(),
): Record<string, unknown> {
  return {
    controlEvent: event,
    taskIndex: tracker.taskIndex,
    elapsedMs: nowMs - new Date(tracker.startedAt).getTime(),
    idleMs: nowMs - tracker.lastActivityMs,
    consecutiveToolFailures: tracker.consecutiveToolFailures,
    thresholds: {
      idleMs: thresholds.idleMs,
      longRunningMs: thresholds.longRunningMs,
      toolFailureThreshold: thresholds.toolFailureThreshold,
    },
  };
}
