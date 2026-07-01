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

export interface ResolveCcReviewConcurrencyOptions {
  flag?: string | number;
  env?: NodeJS.ProcessEnv;
}

export interface ResolveCcReviewConcurrencyResult {
  concurrency: number;
  source: "flag" | "env" | "default";
  invalidInput?: { source: "flag" | "env"; raw: string };
}

export function resolveCcReviewConcurrency(
  options: ResolveCcReviewConcurrencyOptions = {}
): ResolveCcReviewConcurrencyResult {
  if (options.flag !== undefined && options.flag !== null) {
    const raw = options.flag;
    const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (Number.isInteger(parsed) && parsed >= 1) {
      return { concurrency: parsed, source: "flag" };
    }
    return {
      concurrency: DEFAULT_CONCURRENCY,
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
      concurrency: DEFAULT_CONCURRENCY,
      source: "default",
      invalidInput: { source: "env", raw: rawEnv },
    };
  }

  return { concurrency: DEFAULT_CONCURRENCY, source: "default" };
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
