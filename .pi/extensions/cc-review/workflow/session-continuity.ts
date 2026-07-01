import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Session-file continuity for fallback subagent execution (P1-1).
//
// CC Review's fallback subagent execution is sessionless by default
// (`--no-session`). That limits context continuity across sequential tasks:
// Task 2 has no shared conversation history with Task 1, so it must rediscover
// structure that Task 1 already established.
//
// This module adds optional per-task session files. When continuity is
// enabled (env `CC_REVIEW_SESSION_CONTINUITY=1`), the fallback executor
// passes `--session <file>` instead of `--no-session`. Each task gets a
// distinct session file so parallel siblings never share mutable state.
//
// Design:
//   * Default OFF — `--no-session` remains the default until behavior is
//     proven stable. Gated by `CC_REVIEW_SESSION_CONTINUITY`.
//   * Per-task session files live under `<artifactRunDir>/sessions/`.
//   * File naming: `task-<index>-<runId>.session.json` so sequential tasks
//     can chain (Task N reads Task N-1's session if `chainSessions` is set)
//     while parallel tasks stay independent.
//   * Session paths are returned to the caller so they can be persisted in
//     task artifacts and checkpoint metadata.
// ---------------------------------------------------------------------------

export const CC_REVIEW_SESSION_CONTINUITY_ENV = "CC_REVIEW_SESSION_CONTINUITY";
export const CC_REVIEW_SESSION_CHAIN_ENV = "CC_REVIEW_SESSION_CHAIN";

export interface SessionContinuityOptions {
  env?: NodeJS.ProcessEnv;
}

export interface SessionContinuityConfig {
  /** Whether session-file continuity is enabled (replaces --no-session with --session). */
  enabled: boolean;
  /** Whether sequential tasks should chain (Task N reuses Task N-1's session file). */
  chain: boolean;
}

export function resolveSessionContinuity(
  options: SessionContinuityOptions = {},
): SessionContinuityConfig {
  const env = options.env ?? process.env;
  const parseBool = (raw: string | undefined): boolean => {
    if (raw === undefined || raw === "") return false;
    const normalized = String(raw).trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  };
  return {
    enabled: parseBool(env[CC_REVIEW_SESSION_CONTINUITY_ENV]),
    chain: parseBool(env[CC_REVIEW_SESSION_CHAIN_ENV]),
  };
}

export interface SessionFileResolution {
  /** Absolute path to the session file, or undefined if continuity is disabled. */
  sessionPath: string | undefined;
  /** Prior session path to chain from (sequential mode), or undefined. */
  priorSessionPath: string | undefined;
  /** The CLI flag to pass: `--session <path>` or `--no-session`. */
  flag: string[];
}

/**
 * Select the single predecessor session that a task can safely inherit.
 * Legacy plans without dependency metadata retain their ordered semantics.
 * Explicitly independent tasks and tasks with multiple predecessors start a
 * fresh session because a linear Pi session cannot merge multiple histories.
 */
export function resolvePriorTaskSessionPath(
  taskIndex: number,
  dependsOn: readonly number[] | undefined,
  taskSessionPaths: readonly (string | undefined)[],
): string | undefined {
  if (taskIndex <= 0) return undefined;
  if (dependsOn === undefined) return taskSessionPaths[taskIndex - 1];
  if (dependsOn.length !== 1) return undefined;
  const dependencyIndex = dependsOn[0]! - 1;
  if (dependencyIndex < 0 || dependencyIndex >= taskSessionPaths.length) return undefined;
  return taskSessionPaths[dependencyIndex];
}

/**
 * Resolve the session file path for a task.
 *
 * @param artifactRunDir  The per-run artifact directory (e.g. cc-review-artifacts/run-<id>).
 * @param taskIndex       0-based task index.
 * @param workflowRunId   Stable workflow run id (used in filename for correlation).
 * @param config          Session continuity config.
 * @param priorSessionPath  Session path from the previous sequential task (for chaining).
 */
export function resolveTaskSessionFile(
  artifactRunDir: string,
  taskIndex: number,
  workflowRunId: string,
  config: SessionContinuityConfig,
  priorSessionPath?: string,
): SessionFileResolution {
  if (!config.enabled) {
    return { sessionPath: undefined, priorSessionPath: undefined, flag: ["--no-session"] };
  }

  const sessionsDir = path.join(artifactRunDir, "sessions");
  // Ensure the directory exists; ignore errors (the spawn will fail loudly if
  // the path is unwritable, which is the right signal).
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
  } catch {
    // ignore — best-effort; pi will create the file on write
  }

  const safeRunId = workflowRunId.replace(/[^\w.-]+/g, "_");
  const sessionPath = path.join(sessionsDir, `task-${taskIndex}-${safeRunId}.session.json`);

  // When chaining is enabled and a prior session exists, reuse it so Task N
  // inherits Task N-1's conversation context. Parallel siblings each get
  // their own file (the orchestrator passes the prior path only for
  // sequential tasks).
  const effectivePrior = config.chain ? priorSessionPath : undefined;

  if (effectivePrior && fs.existsSync(effectivePrior)) {
    // Chain: point at the prior session file so pi loads its history.
    return {
      sessionPath: effectivePrior,
      priorSessionPath: effectivePrior,
      flag: ["--session", effectivePrior],
    };
  }

  return {
    sessionPath,
    priorSessionPath: undefined,
    flag: ["--session", sessionPath],
  };
}

/**
 * Build a stable, human-readable label for a session path suitable for
 * inclusion in task artifacts and summaries.
 */
export function describeSessionPath(sessionPath: string | undefined): string | undefined {
  if (!sessionPath) return undefined;
  return `session:${path.basename(sessionPath)}`;
}
