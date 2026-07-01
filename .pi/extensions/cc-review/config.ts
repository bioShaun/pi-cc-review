import os from "node:os";

export type CcReviewLogSeverity = "debug" | "info" | "warning" | "error";
const SUPPORTED_LOG_SEVERITIES: readonly CcReviewLogSeverity[] = ["debug", "info", "warning", "error"];

export const DEFAULT_TASK_TIMEOUT_MS = 1800000;

export interface ResolveSubagentTaskTimeoutOptions {
  flag?: string | number;
  env?: NodeJS.ProcessEnv;
}

export interface ResolveSubagentTaskTimeoutResult {
  timeoutMs: number;
  source: "flag" | "env" | "default";
  invalidInput?: { source: "flag" | "env"; raw: string };
}

function parseTimeoutCandidate(raw: unknown): number | undefined {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : undefined;
  }
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

export function resolveSubagentTaskTimeout(
  options: ResolveSubagentTaskTimeoutOptions = {}
): ResolveSubagentTaskTimeoutResult {
  if (options.flag !== undefined && options.flag !== null) {
    const parsed = parseTimeoutCandidate(options.flag);
    if (parsed !== undefined) {
      return { timeoutMs: parsed, source: "flag" };
    }
    return {
      timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
      source: "default",
      invalidInput: {
        source: "flag",
        raw: typeof options.flag === "string" ? options.flag : String(options.flag),
      },
    };
  }

  const env = options.env ?? process.env;
  const rawEnv = env.CC_REVIEW_TASK_TIMEOUT_MS;
  if (typeof rawEnv === "string" && rawEnv.trim() !== "") {
    const parsed = parseTimeoutCandidate(rawEnv);
    if (parsed !== undefined) {
      return { timeoutMs: parsed, source: "env" };
    }
    return {
      timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
      source: "default",
      invalidInput: { source: "env", raw: rawEnv },
    };
  }

  return { timeoutMs: DEFAULT_TASK_TIMEOUT_MS, source: "default" };
}

export const DEFAULT_CONCURRENCY = 4;

export interface ComputeDefaultAutoConcurrencyOptions {
  /** Injected CPU count; if omitted or invalid, the function falls back to `fallbackCpuCount` (or 4). */
  cpuCount?: number;
  /** Optional number of planned tasks; when provided, the auto concurrency is capped by this count. */
  taskCount?: number;
  /** Fallback CPU count when no valid `cpuCount` is supplied. Defaults to 4. */
  fallbackCpuCount?: number;
  /** Minimum allowed concurrency; defaults to 1. */
  minConcurrency?: number;
  /** Maximum allowed concurrency; defaults to 8. */
  maxConcurrency?: number;
}

export const AUTO_CONCURRENCY_DEFAULT_MIN = 1;
export const AUTO_CONCURRENCY_DEFAULT_MAX = 8;
export const AUTO_CONCURRENCY_FALLBACK_CPU_COUNT = 4;

/** Optional override via CC_REVIEW_CPU_COUNT; otherwise uses os.cpus().length. */
export function readAvailableCpuCount(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CC_REVIEW_CPU_COUNT;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw.trim());
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return os.cpus().length;
}

/**
 * Pure, testable default concurrency policy.
 *
 * When no explicit concurrency is configured, the orchestrator uses this
 * strategy to derive a safe default from the available CPUs and the planned
 * task count. The returned value is always a positive integer bounded by
 * `[minConcurrency, maxConcurrency]` (default `[1, 8]`) and further capped by
 * `taskCount` when it is provided and smaller than the CPU-based bound.
 *
 * Testability is built in: callers can inject `cpuCount` (and any other
 * parameter) so tests do not depend on the machine they run on.
 */
export function computeDefaultAutoConcurrency(
  options: ComputeDefaultAutoConcurrencyOptions = {}
): number {
  const minConcurrency =
    options.minConcurrency !== undefined &&
    Number.isInteger(options.minConcurrency) &&
    options.minConcurrency >= 1
      ? options.minConcurrency
      : AUTO_CONCURRENCY_DEFAULT_MIN;

  const maxConcurrency =
    options.maxConcurrency !== undefined &&
    Number.isInteger(options.maxConcurrency) &&
    options.maxConcurrency >= minConcurrency
      ? options.maxConcurrency
      : AUTO_CONCURRENCY_DEFAULT_MAX;

  let rawCpuCount = options.cpuCount;
  const cpuCountProvided = rawCpuCount !== undefined;
  if (!cpuCountProvided) {
    rawCpuCount = options.fallbackCpuCount ?? AUTO_CONCURRENCY_FALLBACK_CPU_COUNT;
  } else if (
    typeof rawCpuCount !== "number" ||
    !Number.isFinite(rawCpuCount) ||
    rawCpuCount <= 0
  ) {
    // Invalid injected CPU count degrades to the configured minimum so the
    // policy stays safe and predictable in tests.
    rawCpuCount = minConcurrency;
  }

  let autoConcurrency = Math.max(
    minConcurrency,
    Math.min(Math.floor(rawCpuCount), maxConcurrency)
  );

  if (
    options.taskCount !== undefined &&
    typeof options.taskCount === "number" &&
    Number.isFinite(options.taskCount) &&
    options.taskCount > 0
  ) {
    autoConcurrency = Math.min(autoConcurrency, Math.floor(options.taskCount));
  }

  // Ensure taskCount capping never drops below the configured minimum.
  return Math.max(minConcurrency, autoConcurrency);
}

export interface ResolveCcReviewConcurrencyOptions {
  flag?: string | number;
  env?: NodeJS.ProcessEnv;
  cpuCount?: number;
  taskCount?: number;
}

export interface ResolveCcReviewConcurrencyResult {
  concurrency: number;
  source: "flag" | "env" | "default";
  invalidInput?: { source: "flag" | "env"; raw: string };
}

export function resolveCcReviewConcurrency(
  options: ResolveCcReviewConcurrencyOptions = {}
): ResolveCcReviewConcurrencyResult {
  const autoConcurrency = computeDefaultAutoConcurrency({
    cpuCount: options.cpuCount,
    taskCount: options.taskCount,
    fallbackCpuCount: AUTO_CONCURRENCY_FALLBACK_CPU_COUNT,
    minConcurrency: AUTO_CONCURRENCY_DEFAULT_MIN,
    maxConcurrency: AUTO_CONCURRENCY_DEFAULT_MAX,
  });

  if (options.flag !== undefined && options.flag !== null) {
    const raw = options.flag;
    const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (Number.isInteger(parsed) && parsed >= 1) {
      return { concurrency: parsed, source: "flag" };
    }
    return {
      concurrency: autoConcurrency,
      source: "default",
      invalidInput: {
        source: "flag",
        raw: String(options.flag),
      },
    };
  }

  const env = options.env ?? process.env;
  const rawEnv = env.CC_REVIEW_CONCURRENCY;
  if (typeof rawEnv === "string" && rawEnv.trim() !== "") {
    const parsed = Number(rawEnv.trim());
    if (Number.isInteger(parsed) && parsed >= 1) {
      return { concurrency: parsed, source: "env" };
    }
    return {
      concurrency: autoConcurrency,
      source: "default",
      invalidInput: { source: "env", raw: rawEnv },
    };
  }

  return { concurrency: autoConcurrency, source: "default" };
}

export const CC_REVIEW_NEST_DEPTH_ENV = "CC_REVIEW_NEST_DEPTH";
export const CC_REVIEW_MAX_NEST_DEPTH = 1;

export class CcReviewNestDepthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CcReviewNestDepthError";
  }
}

export function readCcReviewNestDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CC_REVIEW_NEST_DEPTH_ENV];
  if (raw === undefined || raw === "") return 0;
  const parsed = Number(String(raw).trim());
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

export function assertCcReviewNestAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (readCcReviewNestDepth(env) >= CC_REVIEW_MAX_NEST_DEPTH) {
    throw new CcReviewNestDepthError(
      "cc_review cannot run inside an active CC Review workflow. Nested invocation is blocked to prevent runaway subprocess output. Complete the current task with targeted file edits and `node --test --test-name-pattern=\"...\"` instead."
    );
  }
}

/** Increments CC_REVIEW_NEST_DEPTH for the current process and returns a restore function. */
export function enterCcReviewWorkflowNest(env: NodeJS.ProcessEnv = process.env): () => void {
  assertCcReviewNestAllowed(env);
  const previous = env[CC_REVIEW_NEST_DEPTH_ENV];
  env[CC_REVIEW_NEST_DEPTH_ENV] = String(readCcReviewNestDepth(env) + 1);
  return () => {
    if (previous === undefined) {
      delete env[CC_REVIEW_NEST_DEPTH_ENV];
    } else {
      env[CC_REVIEW_NEST_DEPTH_ENV] = previous;
    }
  };
}

// ---------------------------------------------------------------------------
// resolvePhaseTimeoutMs: resolver for planner/reviewer subprocess timeouts.
// Previously planning and review phases had NO timeout, so a stuck
// claude/codex could hang forever with no recovery and no signal (see P0-4).
//
// Precedence: `env.CC_REVIEW_PLANNER_TIMEOUT_MS` / `CC_REVIEW_REVIEWER_TIMEOUT_MS`
//           > default.
// Invalid input falls back to the default. 0 means "no timeout".
// ---------------------------------------------------------------------------
export const DEFAULT_PLANNER_TIMEOUT_MS = 600000; // 10 min
export const DEFAULT_REVIEWER_TIMEOUT_MS = 600000; // 10 min

export function resolvePlannerTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return resolvePhaseTimeoutFromEnv(env, "CC_REVIEW_PLANNER_TIMEOUT_MS", DEFAULT_PLANNER_TIMEOUT_MS);
}

export function resolveReviewerTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return resolvePhaseTimeoutFromEnv(env, "CC_REVIEW_REVIEWER_TIMEOUT_MS", DEFAULT_REVIEWER_TIMEOUT_MS);
}

function resolvePhaseTimeoutFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

// ---------------------------------------------------------------------------
// resolveMaxReviewRepairRounds: resolver for the reviewer-block repair loop
// bound (see P1-1). On a reviewer "block" verdict, the orchestrator re-dispatches
// the worker with the reviewer's findings as feedback, then re-reviews, up
// to this many rounds before hard-failing.
//
// Precedence: explicit `flag` (tool param / slash flag
// `--review-repair-rounds`) > `env.CC_REVIEW_MAX_REPAIR_ROUNDS` > default 1.
// One repair round is enabled by default so after-all review can inspect first,
// then expose a separate, observable repair lifecycle.
// ---------------------------------------------------------------------------
export const DEFAULT_MAX_REVIEW_REPAIR_ROUNDS = 1;

export interface ResolveMaxReviewRepairRoundsOptions {
  flag?: string | number;
  env?: NodeJS.ProcessEnv;
}

export function resolveMaxReviewRepairRounds(
  options: ResolveMaxReviewRepairRoundsOptions = {}
): number {
  if (options.flag !== undefined && options.flag !== null) {
    const parsedFlag = Number(options.flag);
    return Number.isInteger(parsedFlag) && parsedFlag >= 0
      ? parsedFlag
      : DEFAULT_MAX_REVIEW_REPAIR_ROUNDS;
  }
  const env = options.env ?? process.env;
  const raw = env.CC_REVIEW_MAX_REPAIR_ROUNDS;
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_MAX_REVIEW_REPAIR_ROUNDS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_MAX_REVIEW_REPAIR_ROUNDS;
  return parsed;
}

// ---------------------------------------------------------------------------
// resolveCcReviewLogLevel: pure precedence resolver for the user-visible
// minimum log severity. The resolved level drives the compact widget live-log
// slice and the onUpdate delta stream. The persisted JSONL log is intentionally
// NOT gated by this resolver — workflow-logs.jsonl always records the full
// history so users can post-mortem after the TUI clears.
//
// Precedence: explicit `flag` (slash flag / tool param `--log-level` / `logLevel`)
//            > `env.CC_REVIEW_LOG_LEVEL`
//            > default `info`.
//
// Invalid input (unknown severity, non-string, empty/whitespace flag) is
// surfaced as `invalidInput` so the caller can emit a single warning log
// entry; the resolver itself never throws and always returns a usable level.
// Empty env (unset, '', whitespace-only) is treated as "not provided" rather
// than invalid, matching the user expectation that omitting the env var
// leaves the default alone.
// ---------------------------------------------------------------------------
export interface ResolveCcReviewLogLevelOptions {
  /** Explicit flag value from the slash command / tool param (e.g. `--log-level warning`). */
  flag?: string;
  /** Environment to read `CC_REVIEW_LOG_LEVEL` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface ResolveCcReviewLogLevelResult {
  level: CcReviewLogSeverity;
  source: "flag" | "env" | "default";
  invalidInput?: { source: "flag" | "env"; raw: string };
}

function parseLogSeverityCandidate(raw: unknown): CcReviewLogSeverity | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return undefined;
  if (trimmed === "warn") return "warning";
  if (trimmed === "fatal") return "error";
  return SUPPORTED_LOG_SEVERITIES.includes(trimmed as CcReviewLogSeverity)
    ? (trimmed as CcReviewLogSeverity)
    : undefined;
}

export function resolveCcReviewLogLevel(
  options: ResolveCcReviewLogLevelOptions = {}
): ResolveCcReviewLogLevelResult {
  // 1) Explicit flag wins. Even an empty/whitespace string here is treated as
  //    invalid input — the user typed `--log-level` explicitly, so silently
  //    falling through would mask a typo.
  if (options.flag !== undefined && options.flag !== null) {
    const parsed = parseLogSeverityCandidate(options.flag);
    if (parsed !== undefined) {
      return { level: parsed, source: "flag" };
    }
    return {
      level: "info",
      source: "default",
      invalidInput: { source: "flag", raw: typeof options.flag === "string" ? options.flag : String(options.flag) },
    };
  }

  // 2) Environment fallback. Unset / empty / whitespace-only env is treated
  //    as "not provided" (NOT invalidInput) — env vars are commonly empty.
  const env = options.env ?? process.env;
  const rawEnv = env.CC_REVIEW_LOG_LEVEL;
  if (typeof rawEnv === "string" && rawEnv.trim() !== "") {
    const parsed = parseLogSeverityCandidate(rawEnv);
    if (parsed !== undefined) {
      return { level: parsed, source: "env" };
    }
    return {
      level: "info",
      source: "default",
      invalidInput: { source: "env", raw: rawEnv },
    };
  }

  return { level: "info", source: "default" };
}

// ---------------------------------------------------------------------------
// resolveCcReviewLogSources: pure precedence resolver for the user-visible
// log sources filtering.
//
// Precedence: explicit `flag` (slash flag / tool param `--log-sources` / `logSources`)
//            > `env.CC_REVIEW_LOG_SOURCES`
//            > default `all` (undefined).
// ---------------------------------------------------------------------------
export interface ResolveCcReviewLogSourcesOptions {
  /** Explicit flag value from the slash command / tool param (e.g. `--log-sources planner,subagent`). */
  flag?: string;
  /** Environment to read `CC_REVIEW_LOG_SOURCES` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface ResolveCcReviewLogSourcesResult {
  sources: string[] | undefined;
  source: "flag" | "env" | "default";
  invalidInput?: { source: "flag" | "env"; raw: string };
}

const SUPPORTED_LOG_SOURCES = ["planner", "subagent", "reviewer", "cc-review"];

function parseLogSourcesCandidate(raw: unknown): { sources: string[]; hasInvalid: boolean } | undefined {
  if (typeof raw !== "string") return undefined;
  const parts = raw.split(",").map(p => p.trim());
  const sources: string[] = [];
  let hasInvalid = false;
  for (const part of parts) {
    if (part === "") continue;
    const lower = part.toLowerCase();
    if (SUPPORTED_LOG_SOURCES.includes(lower)) {
      sources.push(lower);
    } else {
      hasInvalid = true;
    }
  }
  return { sources, hasInvalid };
}

export function resolveCcReviewLogSources(
  options: ResolveCcReviewLogSourcesOptions = {}
): ResolveCcReviewLogSourcesResult {
  // 1) Explicit flag wins.
  if (options.flag !== undefined && options.flag !== null) {
    const parsed = parseLogSourcesCandidate(options.flag);
    if (parsed !== undefined) {
      if (parsed.hasInvalid) {
        return {
          sources: undefined,
          source: "default",
          invalidInput: { source: "flag", raw: String(options.flag) },
        };
      }
      return { sources: parsed.sources, source: "flag" };
    }
    return {
      sources: undefined,
      source: "default",
      invalidInput: { source: "flag", raw: String(options.flag) },
    };
  }

  // 2) Environment fallback.
  const env = options.env ?? process.env;
  const rawEnv = env.CC_REVIEW_LOG_SOURCES;
  if (typeof rawEnv === "string" && rawEnv.trim() !== "") {
    const parsed = parseLogSourcesCandidate(rawEnv);
    if (parsed !== undefined) {
      if (parsed.hasInvalid) {
        return {
          sources: undefined,
          source: "default",
          invalidInput: { source: "env", raw: rawEnv },
        };
      }
      return { sources: parsed.sources, source: "env" };
    }
    return {
      sources: undefined,
      source: "default",
      invalidInput: { source: "env", raw: rawEnv },
    };
  }

  return { sources: undefined, source: "default" };
}

// ---------------------------------------------------------------------------
// resolveCcReviewWidgetLogLines: pure precedence resolver for the user-visible
// live-log tail length.
//
// Precedence: explicit `flag` (slash flag / tool param `widgetLogLines`)
//            > `env.CC_REVIEW_WIDGET_LOG_LINES`
//            > default `5`.
// ---------------------------------------------------------------------------
export interface ResolveCcReviewWidgetLogLinesOptions {
  /** Explicit flag value from the slash command / tool param (e.g. `--widget-log-lines 10`). */
  flag?: any;
  /** Environment to read `CC_REVIEW_WIDGET_LOG_LINES` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface ResolveCcReviewWidgetLogLinesResult {
  lines: number;
  source: "flag" | "env" | "default";
  invalidInput?: { source: "flag" | "env"; raw: string };
}

export function resolveCcReviewWidgetLogLines(
  options: ResolveCcReviewWidgetLogLinesOptions = {}
): ResolveCcReviewWidgetLogLinesResult {
  // 1) Explicit flag wins.
  if (options.flag !== undefined && options.flag !== null) {
    const parsed = Number(options.flag);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return { lines: parsed, source: "flag" };
    }
    return {
      lines: 5,
      source: "default",
      invalidInput: { source: "flag", raw: String(options.flag) },
    };
  }

  // 2) Environment fallback.
  const env = options.env ?? process.env;
  const rawEnv = env.CC_REVIEW_WIDGET_LOG_LINES;
  if (typeof rawEnv === "string" && rawEnv.trim() !== "") {
    const parsed = Number(rawEnv);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return { lines: parsed, source: "env" };
    }
    return {
      lines: 5,
      source: "default",
      invalidInput: { source: "env", raw: rawEnv },
    };
  }

  return { lines: 5, source: "default" };
}

// ---------------------------------------------------------------------------
// resolveCcReviewChecklistWindow: pure precedence resolver for the user-visible
// task checklist window size.
//
// Precedence: explicit `flag` (slash flag / tool param `checklistWindow`)
//            > `env.CC_REVIEW_CHECKLIST_WINDOW`
//            > default `8`.
// ---------------------------------------------------------------------------
export interface ResolveCcReviewChecklistWindowOptions {
  /** Explicit flag value from the slash command / tool param (e.g. `--checklist-window 10`). */
  flag?: any;
  /** Environment to read `CC_REVIEW_CHECKLIST_WINDOW` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface ResolveCcReviewChecklistWindowResult {
  window: number;
  source: "flag" | "env" | "default";
  invalidInput?: { source: "flag" | "env"; raw: string };
}

export function resolveCcReviewChecklistWindow(
  options: ResolveCcReviewChecklistWindowOptions = {}
): ResolveCcReviewChecklistWindowResult {
  // 1) Explicit flag wins.
  if (options.flag !== undefined && options.flag !== null) {
    const parsed = Number(options.flag);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return { window: parsed, source: "flag" };
    }
    return {
      window: 8,
      source: "default",
      invalidInput: { source: "flag", raw: String(options.flag) },
    };
  }

  // 2) Environment fallback.
  const env = options.env ?? process.env;
  const rawEnv = env.CC_REVIEW_CHECKLIST_WINDOW;
  if (typeof rawEnv === "string" && rawEnv.trim() !== "") {
    const parsed = Number(rawEnv);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return { window: parsed, source: "env" };
    }
    return {
      window: 8,
      source: "default",
      invalidInput: { source: "env", raw: rawEnv },
    };
  }

  return { window: 8, source: "default" };
}

// ---------------------------------------------------------------------------
// DEVELOPMENT RECORD: CLI Parameters, Execution Logs, and Worker Concurrency Boundaries
//
// 1. Execution Log File:
//    - Log file path generation: `path.join(workflowCwd, WORKFLOW_LOG_FILE)` where `WORKFLOW_LOG_FILE` is defined as "workflow-logs.jsonl" (defined in `.pi/extensions/cc-review/workflow.ts`).
//    - Timing and preservation: The log is appended via `appendPersistedLogEntry` and does NOT truncate/wipe previous runs (history is preserved, and a run-boundary header is logged at startup).
//    - Rotation behavior: If log size exceeds `WORKFLOW_LOG_MAX_LINES_DEFAULT` (2000 lines), it keeps only the most recent `WORKFLOW_LOG_TRUNCATE_KEEP` (1500) lines and prepends a rotation marker entry.
//
// 2. Worker Parallel/Concurrency Orchestration:
//    - Parameter names: `--concurrency` / `--concurrency-limit` command arguments, `concurrency` / `concurrencyLimit` parameter keys, and `CC_REVIEW_CONCURRENCY` environment variable.
//    - Default value: dynamically computed from `os.cpus().length` by `computeDefaultAutoConcurrency` (bounded by [1, 8] and capped by the planned task count). `DEFAULT_CONCURRENCY` is retained as a fallback for explicit callers.
//    - Resolution: Handled in `resolveCcReviewConcurrency` in `.pi/extensions/cc-review/config.ts`.
//    - Effect Location: Used in `runCcReviewWorkflow` in `.pi/extensions/cc-review/workflow.ts` to coordinate `runWithConcurrencyLimit(resolvedConcurrency, batch, ...)` during parallel subagent task executions.
//
// 3. Command Help and Hints Generation:
//    - Slash command registration: registered in `ccReviewExtension` in `.pi/extensions/cc-review/workflow.ts` using `pi.registerCommand("cc-review", { description, handler })`.
//    - Tool registration: registered in `ccReviewExtension` in `.pi/extensions/cc-review/workflow.ts` using `pi.registerTool({ name: "cc_review", description, parameters, execute })`.
//    - Tool parameters descriptions: structured in `CcReviewParams` in `.pi/extensions/cc-review/workflow.ts`.
//
// 4. Test Files:
//    - `tests/cc-review-ui.test.ts` (e.g. CLI arg parsing, UI state and windowing, log source/level resolution).
//    - `tests/cc-review-behavior.test.ts` (e.g. concurrency limit, after-all / per-task orchestration behavior, subagent prompt injection, retry loops, log file writing and rotation).
//    - `tests/cc-review-structured.test.ts` (e.g. subagent schema parsing, structured artifact outputs).
//    - `tests/cc-review-static.test.mjs` (e.g. static validation of help/descriptions, providers configuration).
// ---------------------------------------------------------------------------

