import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

import {
  type BlockReason,
  type CcReviewFindingsPayload,
  type CcReviewFindingsRollup,
  type CcReviewSummaryMeta,
  type ReviewFinding,
  type ReviewResult,
  type ReviewVerdict,
  type SchemaParseStatus,
  type SubagentStructuredReport,
  type TaskArtifact,
  type TaskStatus,
  type VerificationCommand,
  buildFindingsPayload,
  buildSummaryMeta,
  deriveEffectiveVerdict,
  emptyFindingsRollup,
  formatFindingsRollupLine,
  formatTaskArtifactFileName,
  generateWorkflowRunId,
  isExecutionGateHaltError,
  loadVerificationPlan,
  mapEffectiveVerdictToTaskStatus,
  mergeRollupFindings,
  parseReviewResult,
  parseSubagentStructuredReport,
  reviewRequiresPostFixValidation,
  runPostReviewValidation,
  snapshotWorkspace,
  sortReviewFindings,
  updateFindingsRollup,
  validateStructuredSubagentReport,
  workspaceSnapshotChanged,
  writeTaskArtifact,
  type RunVerificationCommand,
  WORKFLOW_ARTIFACT_DIR,
} from "./cc-review-structured.ts";

export {
  buildFindingsPayload,
  deriveEffectiveVerdict,
  extractBalancedJsonObject,
  formatTaskArtifactFileName,
  generateWorkflowRunId,
  isExecutionGateHaltError,
  loadVerificationPlan,
  mapEffectiveVerdictToTaskStatus,
  parseReviewResult,
  parseSubagentStructuredReport,
  sortReviewFindings,
  snapshotWorkspace,
  validateStructuredSubagentReport,
  workspaceSnapshotChanged,
  writeTaskArtifact,
  WORKFLOW_ARTIFACT_DIR,
} from "./cc-review-structured.ts";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");

interface ExtensionAPI {
  registerCommand(name: string, config: any): void;
  registerTool(config: any): void;
  registerMessageRenderer?(customType: string, renderer: any): void;
  sendMessage?(message: any): Promise<void>;
}

// Strip ANSI color escape codes for clean TUI text
function stripAnsi(str: string): string {
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

// Helper to pause with AbortSignal support
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error("Workflow aborted by user"));
    }
    const timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Workflow aborted by user"));
    };

    if (signal) {
      signal.addEventListener("abort", onAbort);
    }
  });
}

// Emit structured trace event for observability
//
// By default we only write traces to the workspace-local `workflow-trace.jsonl`
// file. Writing the same JSON to process.stderr (the previous behavior) made
// every trace event leak into pi's TUI as raw JSON noise such as
//   {"type":"workflow_trace","event":"workflow_start",...}
// which is hostile to users and overlaps with the rendered widget.
//
// Set CC_REVIEW_TRACE_STDERR=1 to opt back in to the streaming behavior when
// running outside pi (e.g. piping into a log aggregator).
function emitTrace(ctx: any, event: string, payload: Record<string, any> = {}) {
  const traceObj = {
    type: "workflow_trace",
    event,
    ...payload,
    timestamp: new Date().toISOString(),
  };
  const traceLine = JSON.stringify(traceObj) + "\n";

  if (process.env.CC_REVIEW_TRACE_STDERR === "1") {
    try {
      process.stderr.write(traceLine);
    } catch {
      // ignore
    }
  }

  // Write to a trace file in the workspace directory
  try {
    const cwd = ctx?.cwd || process.cwd();
    const traceFilePath = path.join(cwd, "workflow-trace.jsonl");
    fs.appendFileSync(traceFilePath, traceLine, "utf8");
  } catch {
    // ignore
  }
}

// Extract the first balanced JSON object from a noisy stdout buffer. Used for
// planner backends (e.g. claude) that cannot guarantee JSON-only stdout. The
// codex planner uses --output-schema and writes to a file, so it doesn't need this.
// Returns undefined if no balanced JSON object is found.
function extractJsonObject(raw: string): string | undefined {
  if (!raw) return undefined;
  // Prefer ```json ... ``` blocks if present, then fall back to scanning the raw buffer.
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fenceMatch ? [fenceMatch[1], raw] : [raw];
  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (escape) { escape = false; continue; }
      if (inString && ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return candidate.substring(start, i + 1);
      }
    }
  }
  return undefined;
}

// Check if an error message indicates a transient failure
function isTransientError(error: any): boolean {
  if (!error) return false;
  const msg = typeof error === "string" ? error : (error.message || String(error));
  const lower = msg.toLowerCase();
  return (
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("429") ||
    lower.includes("timeout") ||
    lower.includes("etimedout") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("network") ||
    lower.includes("fetch failed") ||
    lower.includes("500") ||
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("504") ||
    lower.includes("overloaded") ||
    lower.includes("service unavailable") ||
    lower.includes("try again")
  );
}

// Params schema for the tool
const CcReviewParams = {
  type: "object",
  properties: {
    goal: {
      type: "string",
      description: "The overarching goal for CC Review to accomplish using Codex planning and Pi subagents",
    },
    reviewProvider: {
      type: "string",
      description: "Optional review backend for this run. Supported values: codex or claude. Omit to use CC_REVIEW_PROVIDER or the default Codex reviewer.",
    },
    logLevel: {
      type: "string",
      description: "Optional minimum log severity for compact surfaces (widget + onUpdate). Supported values: debug, info, warning, error (aliases: warn, fatal). Omit to use CC_REVIEW_LOG_LEVEL or the default 'info'. Persisted workflow-logs.jsonl is never filtered.",
    },
  },
  required: ["goal"],
  additionalProperties: false,
};

interface CcReviewExecuteParams {
  goal: string;
  reviewProvider?: string;
  logLevel?: string;
}

interface Task {
  title: string;
  description: string;
  acceptanceCriteria: string;
}

interface ProcessResult {
  code: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  combinedOutput: string;
  output?: string;
}

type CcReviewLogSeverity = "debug" | "info" | "warning" | "error";

export interface CcReviewLogEntry {
  /** Stable display identifier; callers may provide one or normalization derives one deterministically. */
  id: string;
  /** ISO-8601 timestamp used by renderers and trace correlation. */
  timestamp: string;
  severity: CcReviewLogSeverity;
  /** Logical producer, such as planner, reviewer, subagent, or cc-review. */
  source: string;
  /** Plugin identifier retained for display surfaces that group multiple plugins. */
  pluginId: string;
  message: string;
  /** Optional structured context kept out of the compact default display. */
  details?: unknown;
  /** Monotonic sequence assigned by the display path to disambiguate interleaved logs. */
  sequence: number;
}

type CcReviewStructuredLogInput = Partial<Omit<CcReviewLogEntry, "severity">> & {
  severity?: CcReviewLogSeverity | string;
};

type CcReviewLogInput = string | CcReviewStructuredLogInput;

interface CcReviewLogNormalizationOptions {
  sequence?: number;
  now?: () => Date;
  defaultSource?: string;
  defaultPluginId?: string;
}

const DEFAULT_LOG_SOURCE = "cc-review";
const DEFAULT_LOG_PLUGIN_ID = "cc-review";
const SUPPORTED_LOG_SEVERITIES: readonly CcReviewLogSeverity[] = ["debug", "info", "warning", "error"];
const DEFAULT_LOG_MESSAGE_WRAP_WIDTH = 96;

const LOG_SEVERITY_RENDER_META: Record<CcReviewLogSeverity, { icon: string; label: string }> = {
  debug: { icon: "🔎", label: "DEBUG" },
  info: { icon: "ℹ", label: "INFO" },
  warning: { icon: "⚠", label: "WARN" },
  error: { icon: "✖", label: "ERROR" },
};

interface CcReviewLogRenderOptions {
  maxMessageWidth?: number;
  includeTimestamp?: boolean;
  includeSource?: boolean;
}

function normalizeLogSeverity(rawSeverity: unknown): CcReviewLogSeverity {
  if (typeof rawSeverity !== "string") return "info";
  const severity = rawSeverity.trim().toLowerCase();
  if (severity === "warn") return "warning";
  if (severity === "fatal") return "error";
  return SUPPORTED_LOG_SEVERITIES.includes(severity as CcReviewLogSeverity)
    ? (severity as CcReviewLogSeverity)
    : "info";
}

function stableLogHash(parts: readonly string[]): string {
  let hash = 2166136261;
  const input = parts.join("\u001f");
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeOptionalText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = stripAnsi(value).trim();
  return trimmed || fallback;
}

function inferLegacyLogSeverity(label: string): CcReviewLogSeverity {
  const normalizedLabel = label.trim().toLowerCase();
  if (normalizedLabel.includes("debug")) return "debug";
  if (
    normalizedLabel.includes("error") ||
    normalizedLabel.includes("failure") ||
    normalizedLabel.includes("failed") ||
    normalizedLabel.includes("halted")
  ) {
    return "error";
  }
  if (
    normalizedLabel.includes("warn") ||
    normalizedLabel.includes("timeout") ||
    normalizedLabel.includes("transient") ||
    normalizedLabel.includes("retry")
  ) {
    return "warning";
  }
  return "info";
}

function inferLegacyLogSource(label: string): string {
  const normalizedLabel = label.trim().toLowerCase();
  if (normalizedLabel.includes("planner")) return "planner";
  if (normalizedLabel.includes("reviewer") || normalizedLabel.includes("review")) return "reviewer";
  if (normalizedLabel.includes("subagent")) return "subagent";
  return DEFAULT_LOG_SOURCE;
}

function parseLegacyLogInput(input: string): CcReviewStructuredLogInput {
  const cleaned = stripAnsi(input).trim();
  const prefixedLogMatch = cleaned.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (!prefixedLogMatch) {
    return { message: cleaned };
  }

  const label = prefixedLogMatch[1].trim();
  const message = prefixedLogMatch[2].trim();
  return {
    severity: inferLegacyLogSeverity(label),
    source: inferLegacyLogSource(label),
    message: message || cleaned,
  };
}

export function normalizeCcReviewLogEntry(
  input: CcReviewLogInput,
  options: CcReviewLogNormalizationOptions = {}
): CcReviewLogEntry {
  const structuredInput: CcReviewStructuredLogInput = typeof input === "string" ? parseLegacyLogInput(input) : input;
  const sequence = Number.isSafeInteger(options.sequence)
    ? Number(options.sequence)
    : Number.isSafeInteger(structuredInput.sequence)
      ? Number(structuredInput.sequence)
      : 0;
  const timestamp = normalizeOptionalText(
    structuredInput.timestamp,
    (options.now ?? (() => new Date()))().toISOString()
  );
  const severity = normalizeLogSeverity(structuredInput.severity);
  const source = normalizeOptionalText(structuredInput.source, options.defaultSource ?? DEFAULT_LOG_SOURCE);
  const pluginId = normalizeOptionalText(structuredInput.pluginId, options.defaultPluginId ?? DEFAULT_LOG_PLUGIN_ID);
  const message = typeof structuredInput.message === "string" ? stripAnsi(structuredInput.message).trim() : "";
  const suppliedId = typeof structuredInput.id === "string" ? structuredInput.id.trim() : "";
  const id = suppliedId || `cc-review-log-${sequence}-${stableLogHash([timestamp, severity, source, pluginId, message])}`;

  const entry: CcReviewLogEntry = {
    id,
    timestamp,
    severity,
    source,
    pluginId,
    message,
    sequence,
  };
  if (structuredInput.details !== undefined) {
    entry.details = structuredInput.details;
  }
  return entry;
}

function formatCcReviewLogTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "unknown-time";
  }
  const isoTimestamp = date.toISOString();
  return `${isoTimestamp.slice(0, 10)} ${isoTimestamp.slice(11, 19)}Z`;
}

function normalizeRenderableLogMessage(message: string): string {
  const cleaned = stripAnsi(message).replace(/\s+/g, " ").trim();
  return cleaned || "(empty message)";
}

function wrapLogMessage(message: string, maxWidth: number): string[] {
  const width = Math.max(16, Math.floor(maxWidth));
  const words = message.split(/\s+/).filter(Boolean);
  const wrappedLines: string[] = [];
  let currentLine = "";

  const flushCurrentLine = () => {
    if (currentLine) {
      wrappedLines.push(currentLine);
      currentLine = "";
    }
  };

  for (const word of words) {
    if (word.length > width) {
      flushCurrentLine();
      let remaining = word;
      while (remaining.length > width) {
        wrappedLines.push(remaining.slice(0, width));
        remaining = remaining.slice(width);
      }
      currentLine = remaining;
      continue;
    }

    if (!currentLine) {
      currentLine = word;
    } else if (currentLine.length + 1 + word.length <= width) {
      currentLine += ` ${word}`;
    } else {
      flushCurrentLine();
      currentLine = word;
    }
  }

  flushCurrentLine();
  return wrappedLines.length > 0 ? wrappedLines : ["(empty message)"];
}

export function renderCcReviewLogEntry(
  entry: CcReviewLogEntry,
  options: CcReviewLogRenderOptions = {}
): string[] {
  const severityMeta = LOG_SEVERITY_RENDER_META[entry.severity] ?? LOG_SEVERITY_RENDER_META.info;
  const source = normalizeOptionalText(entry.source, entry.pluginId || DEFAULT_LOG_SOURCE);
  const contextParts = [
    options.includeTimestamp === false ? "" : formatCcReviewLogTimestamp(entry.timestamp),
    options.includeSource === false ? "" : `[${source}]`,
  ].filter(Boolean);
  const prefix = `${severityMeta.icon} ${severityMeta.label.padEnd(5)} ${contextParts.join(" ")}: `;
  const messageLines = wrapLogMessage(
    normalizeRenderableLogMessage(entry.message),
    options.maxMessageWidth ?? DEFAULT_LOG_MESSAGE_WRAP_WIDTH
  );
  const continuationPrefix = " ".repeat(prefix.length);

  return messageLines.map((line, index) => (index === 0 ? `${prefix}${line}` : `${continuationPrefix}${line}`));
}

function renderCcReviewLogEntries(entries: readonly CcReviewLogEntry[], options: CcReviewLogRenderOptions = {}): string[] {
  return entries.flatMap((entry) => renderCcReviewLogEntry(entry, options));
}

// Defined severity ordering used by `filterCcReviewLogEntries`. Lower rank is
// less severe. Mirrors LOG_SEVERITY_ROLLUP_ORDER's intent but encodes a numeric
// threshold so callers can express "warning or worse" as a single comparison.
const LOG_SEVERITY_RANK: Record<CcReviewLogSeverity, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
};

export interface FilterCcReviewLogEntriesOptions {
  /** Drop entries below this severity rank (`debug<info<warning<error`). */
  minSeverity?: CcReviewLogSeverity;
  /** Keep only entries whose `source` exactly matches an item in the allow-list. */
  sources?: readonly string[];
}

// Pure helper: return a new array of entries that satisfy an optional minimum
// severity and/or an optional source allow-list. Defaults to pass-through when
// no options (or an empty `{}` / `undefined`) are supplied, so widget callers
// can wire it in safely before any user-facing controls exist (reference
// pattern #8 in docs/log-display-reference-patterns.md). An empty allow-list
// (`sources: []`) intentionally yields an empty result, matching the "no
// sources enabled" toggle semantics. Unknown severities on input entries are
// treated as `info`, mirroring the existing summarizeLogSeverities convention.
export function filterCcReviewLogEntries(
  entries: readonly CcReviewLogEntry[] | null | undefined,
  options: FilterCcReviewLogEntriesOptions | undefined = {}
): CcReviewLogEntry[] {
  if (!entries || entries.length === 0) return [];
  const opts: FilterCcReviewLogEntriesOptions = options ?? {};
  const minRank =
    opts.minSeverity !== undefined && LOG_SEVERITY_RANK[opts.minSeverity] !== undefined
      ? LOG_SEVERITY_RANK[opts.minSeverity]
      : undefined;
  const allowedSources = opts.sources;
  const sourceSet = Array.isArray(allowedSources) ? new Set(allowedSources) : undefined;
  // Fast-path: no filters configured → pass-through copy.
  if (minRank === undefined && sourceSet === undefined) {
    return entries.slice();
  }
  const result: CcReviewLogEntry[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (minRank !== undefined) {
      const entrySeverity = SUPPORTED_LOG_SEVERITIES.includes(entry.severity as CcReviewLogSeverity)
        ? (entry.severity as CcReviewLogSeverity)
        : "info";
      if (LOG_SEVERITY_RANK[entrySeverity] < minRank) continue;
    }
    if (sourceSet !== undefined && !sourceSet.has(entry.source)) {
      continue;
    }
    result.push(entry);
  }
  return result;
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

// Display order for the severity rollup line: error first (most actionable),
// then warning, then info/debug. Mirrors the visual priority of
// LOG_SEVERITY_RENDER_META without re-encoding icons.
const LOG_SEVERITY_ROLLUP_ORDER: readonly CcReviewLogSeverity[] = ["error", "warning", "info", "debug"];

// Singular/plural pairs for the rollup line. "info" and "debug" are treated as
// mass nouns in TUI rollups (e.g. `5 info`), matching the prompt's example.
const LOG_SEVERITY_ROLLUP_LABELS: Record<CcReviewLogSeverity, { singular: string; plural: string }> = {
  error: { singular: "error", plural: "errors" },
  warning: { singular: "warning", plural: "warnings" },
  info: { singular: "info", plural: "info" },
  debug: { singular: "debug", plural: "debug" },
};

export interface SummarizeLogSeveritiesOptions {
  maxWidth?: number;
}

// Pure helper: counts entries by severity across the bounded liveLogs buffer
// and returns a single compact, width-bounded rollup line for the widget.
// - Mixed severities  → `Σ 1 error · 2 warnings · 5 info` (zero counts omitted)
// - Only info/debug   → `Σ no issues` (optionally suffixed with counts)
// - Empty input       → `Σ no logs`
// The output is always passed through `truncateForWidget` so a misconfigured
// caller cannot blow past the compact widget width.
export function summarizeLogSeverities(
  entries: readonly CcReviewLogEntry[] | null | undefined,
  options: SummarizeLogSeveritiesOptions = {}
): string {
  const maxWidth = options.maxWidth ?? WIDGET_MAX_WIDTH_DEFAULT;
  if (!entries || entries.length === 0) {
    return truncateForWidget("\u03a3 no logs", maxWidth);
  }

  const counts: Record<CcReviewLogSeverity, number> = { debug: 0, info: 0, warning: 0, error: 0 };
  for (const entry of entries) {
    const severity = entry && SUPPORTED_LOG_SEVERITIES.includes(entry.severity as CcReviewLogSeverity)
      ? (entry.severity as CcReviewLogSeverity)
      : "info";
    counts[severity] += 1;
  }

  const segments: string[] = [];
  for (const severity of LOG_SEVERITY_ROLLUP_ORDER) {
    const count = counts[severity];
    if (count <= 0) continue;
    const labels = LOG_SEVERITY_ROLLUP_LABELS[severity];
    segments.push(`${count} ${count === 1 ? labels.singular : labels.plural}`);
  }

  const hasIssue = counts.error > 0 || counts.warning > 0;
  let body: string;
  if (!hasIssue) {
    // Neutral 'no issues' style line when only info/debug entries are present.
    body = segments.length > 0 ? `\u03a3 no issues \u00b7 ${segments.join(" \u00b7 ")}` : "\u03a3 no issues";
  } else {
    body = `\u03a3 ${segments.join(" \u00b7 ")}`;
  }
  return truncateForWidget(body, maxWidth);
}

// ---------------------------------------------------------------------------
// Widget display helpers (learned from pi examples: todo.ts uses truncateToWidth,
// truncated-tool.ts persists full output to a file and surfaces the path).
// We intentionally don't import @earendil-works/pi-tui here so the extension
// stays runnable in test environments without pi's TUI runtime.
// ---------------------------------------------------------------------------

const WIDGET_MAX_WIDTH_DEFAULT = 96;
const WIDGET_CHECKLIST_WINDOW = 8;
const WIDGET_LIVE_LOG_LINES = 5;
const WORKFLOW_LOG_FILE = "workflow-logs.jsonl";
const WORKFLOW_LOG_MAX_LINES_DEFAULT = 2000;
const WORKFLOW_LOG_TRUNCATE_KEEP = 1500;

// ANSI-naive width truncation with ellipsis. Sufficient because cc-review widget
// lines are plain text (we strip ANSI when normalizing log messages).
export function truncateForWidget(value: string, maxWidth: number = WIDGET_MAX_WIDTH_DEFAULT): string {
  const width = Math.max(8, Math.floor(maxWidth));
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return value.slice(0, width - 1) + "\u2026"; // single-char ellipsis
}

// Default character cap for `previewWidgetText`. The compact widget should
// never display long raw goals/prompts verbatim (see
// docs/plugin-log-surface-audit.md gap #4); the persisted log file and the
// final markdown summary keep the full text.
export const WIDGET_PREVIEW_MAX_LENGTH_DEFAULT = 80;

// Pure helper: produce a bounded single-line preview of long user-supplied
// text (typically the workflow goal or a task title) for compact widget
// surfaces. Collapses any run of whitespace/newlines/tabs into a single
// space, trims, then caps the result to `maxLength` characters with a
// single-char ellipsis (`\u2026`). Short, already-single-line inputs are
// returned unchanged. This is intentionally character-bounded (not
// width-bounded) so the outer `truncateForWidget` still owns terminal width
// safety and the two helpers compose without surprise.
export function previewWidgetText(
  value: string | null | undefined,
  maxLength: number = WIDGET_PREVIEW_MAX_LENGTH_DEFAULT
): string {
  if (value === null || value === undefined) return "";
  const collapsed = String(value).replace(/\s+/g, " ").trim();
  const cap = Math.max(1, Math.floor(maxLength));
  if (collapsed.length <= cap) return collapsed;
  if (cap <= 1) return collapsed.slice(0, cap);
  return collapsed.slice(0, cap - 1) + "\u2026"; // single-char ellipsis
}

export interface ChecklistWindowResult {
  startIndex: number;
  endIndex: number; // exclusive
  hiddenBefore: number;
  hiddenAfter: number;
}

// Pick a sliding window of tasks centered on the current task index when the
// total count exceeds `maxVisible`, preserving the head when no execution has
// started yet. Mirrors todo.ts's bounded list with a '... N more' affordance.
export function computeChecklistWindow(
  total: number,
  currentIndex: number,
  maxVisible: number = WIDGET_CHECKLIST_WINDOW
): ChecklistWindowResult {
  const visible = Math.max(1, Math.floor(maxVisible));
  if (total <= visible) {
    return { startIndex: 0, endIndex: total, hiddenBefore: 0, hiddenAfter: 0 };
  }
  // Before tasks start, anchor to the head so users see the full upcoming plan.
  if (currentIndex < 0) {
    return { startIndex: 0, endIndex: visible, hiddenBefore: 0, hiddenAfter: total - visible };
  }
  const half = Math.floor(visible / 2);
  let start = Math.max(0, currentIndex - half);
  let end = start + visible;
  if (end > total) {
    end = total;
    start = Math.max(0, end - visible);
  }
  return {
    startIndex: start,
    endIndex: end,
    hiddenBefore: start,
    hiddenAfter: total - end,
  };
}

// Mark whether the widget should surface a warning/cancelled state distinct from
// regular execution. Derived from data we already track in runCcReviewWorkflow.
export type CcReviewDisplayState =
  | "initializing"
  | "planning"
  | "executing"
  | "reviewing"
  | "retrying"
  | "warning"
  | "cancelled"
  | "timeout"
  | "complete";

// Minimal theme surface for widget coloring. Matches pi's Theme.fg contract
// without importing @earendil-works/pi-tui at module load time.
export interface CcReviewWidgetTheme {
  fg: (color: string, text: string) => string;
}

const PLAIN_WIDGET_THEME: CcReviewWidgetTheme = {
  fg: (_color, text) => text,
};

let truncateToWidthFn: ((text: string, width: number) => string) | null | undefined;

function getTruncateToWidth(): ((text: string, width: number) => string) | undefined {
  if (truncateToWidthFn === undefined) {
    try {
      const piTui = require("@earendil-works/pi-tui");
      truncateToWidthFn = typeof piTui?.truncateToWidth === "function" ? piTui.truncateToWidth : null;
    } catch {
      truncateToWidthFn = null;
    }
  }
  return truncateToWidthFn ?? undefined;
}

// Width-safe truncation for widget lines. Uses pi-tui's truncateToWidth when
// available (ANSI-aware); falls back to the plain-text helper for tests/headless.
export function truncateWidgetLine(text: string, maxWidth: number = WIDGET_MAX_WIDTH_DEFAULT): string {
  const width = Math.max(8, Math.floor(maxWidth));
  const trunc = getTruncateToWidth();
  if (trunc) return trunc(text, width);
  return truncateForWidget(text, width);
}

export interface CcReviewWidgetState {
  goal: string;
  tasks: readonly { title: string; status?: TaskStatus }[];
  currentTaskIndex: number;
  displayState: CcReviewDisplayState;
  currentPhase: string;
  retryState?: { attempt: number; maxAttempts: number };
  lastTaskWarning?: string;
  liveLogs: readonly CcReviewLogEntry[];
  resolvedLogLevel: CcReviewLogSeverity;
  persistedLogPath: string;
  findingsRollup: CcReviewFindingsRollup;
  taskStatuses?: readonly (TaskStatus | undefined)[];
}

export interface BuildCcReviewWidgetLinesOptions {
  width?: number;
  theme?: CcReviewWidgetTheme;
}

function severityThemeColor(severity: CcReviewLogSeverity): string {
  if (severity === "error") return "error";
  if (severity === "warning") return "warning";
  if (severity === "info") return "muted";
  return "dim";
}

function colorizeSeverityRollup(
  entries: readonly CcReviewLogEntry[] | null | undefined,
  theme: CcReviewWidgetTheme
): string {
  if (!entries || entries.length === 0) {
    return theme.fg("dim", "\u03a3 no logs");
  }

  const counts: Record<CcReviewLogSeverity, number> = { debug: 0, info: 0, warning: 0, error: 0 };
  for (const entry of entries) {
    const severity = entry && SUPPORTED_LOG_SEVERITIES.includes(entry.severity as CcReviewLogSeverity)
      ? (entry.severity as CcReviewLogSeverity)
      : "info";
    counts[severity] += 1;
  }

  const segments: string[] = [];
  for (const severity of LOG_SEVERITY_ROLLUP_ORDER) {
    const count = counts[severity];
    if (count <= 0) continue;
    const labels = LOG_SEVERITY_ROLLUP_LABELS[severity];
    const label = `${count} ${count === 1 ? labels.singular : labels.plural}`;
    segments.push(theme.fg(severityThemeColor(severity), label));
  }

  const hasIssue = counts.error > 0 || counts.warning > 0;
  if (!hasIssue) {
    if (segments.length > 0) {
      return `${theme.fg("success", "\u03a3 no issues")} ${theme.fg("dim", "\u00b7")} ${segments.join(` ${theme.fg("dim", "\u00b7")} `)}`;
    }
    return theme.fg("success", "\u03a3 no issues");
  }
  return `${theme.fg("muted", "\u03a3")} ${segments.join(` ${theme.fg("dim", "\u00b7")} `)}`;
}

// Merge the current phase label with the live-log severity rollup on one line.
export function formatPhaseSeverityLine(
  phase: string,
  liveLogs: readonly CcReviewLogEntry[] | null | undefined,
  options: { theme?: CcReviewWidgetTheme } = {}
): string {
  const theme = options.theme ?? PLAIN_WIDGET_THEME;
  const phasePart = theme.fg("accent", `\u26a1 ${phase}`);
  const rollupPart = colorizeSeverityRollup(liveLogs, theme);
  return `${phasePart} ${theme.fg("dim", "\u00b7")} ${rollupPart}`;
}

export function buildCcReviewWidgetLines(
  state: CcReviewWidgetState,
  options: BuildCcReviewWidgetLinesOptions = {}
): string[] {
  const width = options.width ?? WIDGET_MAX_WIDTH_DEFAULT;
  const theme = options.theme ?? PLAIN_WIDGET_THEME;
  const findingsRollup = state.findingsRollup ?? emptyFindingsRollup();
  const lines: string[] = [];

  lines.push(
    truncateWidgetLine(
      `${theme.fg("accent", "\ud83c\udfaf")} ${theme.fg("text", "Goal:")} ${theme.fg("muted", previewWidgetText(state.goal))}`,
      width
    )
  );
  lines.push(truncateWidgetLine(theme.fg("borderMuted", "\u2501".repeat(Math.min(50, width))), width));

  if (state.tasks.length === 0) {
    const waiting =
      state.displayState === "planning"
        ? theme.fg("warning", "  \u2699 Planning tasks\u2026")
        : theme.fg("dim", "  \u23f3 Waiting for planner output\u2026");
    lines.push(truncateWidgetLine(waiting, width));
  } else {
    const window = computeChecklistWindow(state.tasks.length, state.currentTaskIndex, WIDGET_CHECKLIST_WINDOW);
    if (window.hiddenBefore > 0) {
      lines.push(
        truncateWidgetLine(
          theme.fg("dim", `  \u2026 ${window.hiddenBefore} earlier task${window.hiddenBefore === 1 ? "" : "s"}`),
          width
        )
      );
    }
    for (let i = window.startIndex; i < window.endIndex; i++) {
      const task = state.tasks[i];
      const taskStatus = state.taskStatuses?.[i];
      let marker: string;
      let titleColor = "text";
      if (taskStatus === "review_blocked") {
        marker = theme.fg("error", "\u26d4");
        titleColor = "error";
      } else if (taskStatus === "failed" || taskStatus === "validation_failed") {
        marker = theme.fg("error", "\u2718");
        titleColor = "error";
      } else if (i < state.currentTaskIndex) {
        marker = theme.fg("success", "\u2714");
        titleColor = "dim";
      } else if (i === state.currentTaskIndex) {
        marker = theme.fg("accent", "\u25b8");
      } else {
        marker = theme.fg("dim", "\u2610");
        titleColor = "muted";
      }
      const title = previewWidgetText(task.title, width - 16);
      const taskLabel = theme.fg("muted", `[Task ${i + 1}/${state.tasks.length}]`);
      const styledTitle = theme.fg(titleColor, title);
      lines.push(truncateWidgetLine(`  ${marker} ${taskLabel} ${styledTitle}`, width));
    }
    if (window.hiddenAfter > 0) {
      lines.push(
        truncateWidgetLine(
          theme.fg("dim", `  \u2026 ${window.hiddenAfter} later task${window.hiddenAfter === 1 ? "" : "s"}`),
          width
        )
      );
    }
  }

  lines.push(truncateWidgetLine(theme.fg("borderMuted", "\u2501".repeat(Math.min(50, width))), width));
  lines.push(truncateWidgetLine(formatPhaseSeverityLine(state.currentPhase, state.liveLogs, { theme }), width));
  lines.push(truncateWidgetLine(theme.fg("muted", formatFindingsRollupLine(findingsRollup)), width));

  if (state.displayState === "warning" && state.lastTaskWarning) {
    lines.push(
      truncateWidgetLine(
        `${theme.fg("warning", "\u26a0 Warning:")} ${theme.fg("warning", state.lastTaskWarning)}`,
        width
      )
    );
  } else if (state.displayState === "cancelled") {
    lines.push(truncateWidgetLine(theme.fg("error", "\u26d4 Cancelled by user"), width));
  } else if (state.displayState === "timeout") {
    lines.push(truncateWidgetLine(theme.fg("error", "\u23f1 Timed out"), width));
  }

  lines.push(truncateWidgetLine(theme.fg("text", "\ud83d\udcdd Live Logs:"), width));
  if (state.liveLogs.length === 0) {
    lines.push(truncateWidgetLine(theme.fg("dim", "   (No logs yet \u2014 waiting for activity)"), width));
  } else {
    const filteredLiveLogs = filterCcReviewLogEntries(state.liveLogs, { minSeverity: state.resolvedLogLevel });
    const recentLogs = filteredLiveLogs.slice(-WIDGET_LIVE_LOG_LINES);
    for (const entry of recentLogs) {
      const rendered = renderCcReviewLogEntry(entry, { maxMessageWidth: width - 4 });
      const color = severityThemeColor(entry.severity);
      for (const line of rendered) {
        lines.push(truncateWidgetLine(`   ${theme.fg(color, line)}`, width));
      }
    }
  }

  lines.push(
    `${theme.fg("muted", "\ud83d\udcc4 Full log:")} ${theme.fg("dim", state.persistedLogPath)}`
  );
  return lines;
}

export interface CcReviewStatusState {
  tasks: readonly unknown[];
  currentTaskIndex: number;
  displayState: CcReviewDisplayState;
  retryState?: { attempt: number; maxAttempts: number };
  currentPhase?: string;
}

export function buildCcReviewStatusText(state: CcReviewStatusState): string {
  const total = state.tasks.length;
  let body: string;

  if (state.displayState === "complete" || (total > 0 && state.currentTaskIndex >= total)) {
    body = `Task ${total}/${total} Complete`;
  } else if (state.displayState === "planning" || state.displayState === "initializing") {
    body = total > 0 ? `Task 0/${total} Planning` : "Planning";
  } else if (total > 0 && state.currentTaskIndex >= 0) {
    body = `Task ${state.currentTaskIndex + 1}/${total}`;
    if (state.displayState === "reviewing") body += " Reviewing";
    else if (state.displayState === "executing") body += " Executing";
    else if (state.displayState === "retrying") body += " Retrying";
    else if (state.displayState === "warning") body += " Warning";
  } else {
    body = state.currentPhase ?? "Running";
  }

  let text = `[CC Review] ${body}`;
  if (state.retryState) {
    text += ` \u27f3${state.retryState.attempt}/${state.retryState.maxAttempts}`;
  }
  return text;
}

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

export interface PersistedLogState {
  filePath: string;
  appendedLineCount: number;
}

// Append a normalized log entry to a bounded JSONL file in the workspace, so
// users can inspect the full session after the compact TUI is cleared. Bounded
// like pi's truncated-tool: when the file passes WORKFLOW_LOG_MAX_LINES_DEFAULT,
// keep only the most recent WORKFLOW_LOG_TRUNCATE_KEEP lines + a rotation marker.
export function appendPersistedLogEntry(
  state: PersistedLogState,
  entry: CcReviewLogEntry,
  options: { maxLines?: number; keepLines?: number } = {}
): PersistedLogState {
  const maxLines = options.maxLines ?? WORKFLOW_LOG_MAX_LINES_DEFAULT;
  const keepLines = options.keepLines ?? WORKFLOW_LOG_TRUNCATE_KEEP;
  const line = JSON.stringify(entry) + "\n";
  try {
    fs.appendFileSync(state.filePath, line, "utf8");
  } catch {
    return state;
  }
  const nextCount = state.appendedLineCount + 1;
  if (nextCount <= maxLines) {
    return { filePath: state.filePath, appendedLineCount: nextCount };
  }
  // Rotate: keep tail to bound disk usage. Best-effort; failure leaves the file as-is.
  try {
    const existing = fs.readFileSync(state.filePath, "utf8");
    const lines = existing.split("\n");
    // Drop trailing empty entry from final newline
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const tail = lines.slice(-keepLines);
    const rotationMarker = JSON.stringify({
      type: "cc_review_log_rotation",
      droppedLineCount: lines.length - tail.length,
      timestamp: new Date().toISOString(),
    });
    fs.writeFileSync(state.filePath, [rotationMarker, ...tail].join("\n") + "\n", "utf8");
    return { filePath: state.filePath, appendedLineCount: tail.length + 1 };
  } catch {
    return { filePath: state.filePath, appendedLineCount: nextCount };
  }
}

type ReviewProvider = "codex" | "claude";
type ReviewProviderSource = "reviewProvider" | "CC_REVIEW_PROVIDER";

interface ReviewPromptContext {
  task: Task;
}

interface ReviewProviderConfig {
  provider: ReviewProvider;
  mode: "subprocess";
  command: string;
  label: string;
  warningName: string;
  credentialEnvKeys: readonly string[];
  modelEnvKey?: string;
  buildArgs(context: ReviewPromptContext): string[];
}

interface ReviewBackendFactory {
  provider: ReviewProvider;
  credentialEnvKeys: readonly string[];
  modelEnvKey?: string;
  initialize(env?: NodeJS.ProcessEnv): ReviewProviderConfig;
}

const SUPPORTED_REVIEW_PROVIDERS: readonly ReviewProvider[] = ["codex", "claude"];

function buildReviewPrompt(task: Task): string {
  return [
    `Review the changes in the workspace for task: '${task.title}'.`,
    `Task description: '${task.description}'.`,
    "Identify bugs, compile/syntax errors, incomplete features, or logical flaws.",
    "If issues are found, fix them directly in-place in the workspace files and verify your fixes.",
    "If you applied fixes, include postFixValidation with status passed or failed and brief evidence.",
    "End your final response with one JSON object (prose allowed above it) using this shape:",
    '{"verdict":"ship|ship_with_warnings|block","summary":"...","findings":[{"priority":"P0|P1|P2|P3","confidence":0.0,"file":"optional/path","line":1,"message":"...","status":"fixed|unfixed|not_applicable"}],"postFixValidation":{"status":"passed|failed","evidence":"..."}}',
    "postFixValidation is required when any finding has status fixed.",
  ].join(" ");
}

const REVIEW_BACKEND_FACTORIES: Record<ReviewProvider, ReviewBackendFactory> = {
  codex: {
    provider: "codex",
    credentialEnvKeys: ["CODEX_API_KEY", "OPENAI_API_KEY"],
    modelEnvKey: "CODEX_MODEL",
    initialize: (env: NodeJS.ProcessEnv = process.env) => {
      // Auth is handled by the codex CLI itself (login session or env). No preflight gate.
      const credentialEnvKeys = ["CODEX_API_KEY", "OPENAI_API_KEY"] as const;
      return {
        provider: "codex",
        mode: "subprocess",
        command: "codex",
        label: "Codex reviewer",
        warningName: "codex review",
        credentialEnvKeys,
        modelEnvKey: "CODEX_MODEL",
        buildArgs: ({ task }) => buildCodexReviewArgs(task, env),
      };
    },
  },
  claude: {
    provider: "claude",
    credentialEnvKeys: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
    modelEnvKey: "CLAUDE_MODEL",
    initialize: (env: NodeJS.ProcessEnv = process.env) => {
      // Auth is handled by the claude CLI itself (Claude Code login or env). No preflight gate.
      const credentialEnvKeys = ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"] as const;
      return {
        provider: "claude",
        mode: "subprocess",
        command: "claude",
        label: "Claude reviewer",
        warningName: "claude review",
        credentialEnvKeys,
        modelEnvKey: "CLAUDE_MODEL",
        buildArgs: ({ task }) => buildClaudeReviewArgs(task, env),
      };
    },
  },
};

function readTrimmedEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function buildCodexReviewArgs(task: Task, env: NodeJS.ProcessEnv = process.env): string[] {
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  const model = readTrimmedEnv(env, "CODEX_MODEL");
  if (model) {
    args.push("--model", model);
  }
  args.push(buildReviewPrompt(task));
  return args;
}

function buildClaudeReviewArgs(task: Task, env: NodeJS.ProcessEnv = process.env): string[] {
  const args = [
    "-p",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
  ];
  const model = readTrimmedEnv(env, "CLAUDE_MODEL");
  if (model) {
    args.push("--model", model);
  }
  args.push(buildReviewPrompt(task));
  return args;
}

function normalizeReviewProvider(rawProvider: string, providerSource: ReviewProviderSource): ReviewProvider {
  const normalizedProvider = rawProvider.trim().toLowerCase();
  if (SUPPORTED_REVIEW_PROVIDERS.includes(normalizedProvider as ReviewProvider)) {
    return normalizedProvider as ReviewProvider;
  }

  throw new Error(
    `Invalid ${providerSource} value "${rawProvider}". Supported review providers: ${SUPPORTED_REVIEW_PROVIDERS.join(", ")}.`
  );
}

function initializeSelectedReviewBackend(provider: ReviewProvider, env: NodeJS.ProcessEnv = process.env): ReviewProviderConfig {
  return REVIEW_BACKEND_FACTORIES[provider].initialize(env);
}

function resolveReviewProviderConfig(explicitProvider?: string, env: NodeJS.ProcessEnv = process.env): ReviewProviderConfig {
  const providerSource: ReviewProviderSource = explicitProvider !== undefined ? "reviewProvider" : "CC_REVIEW_PROVIDER";
  const rawProvider = explicitProvider !== undefined ? explicitProvider : env.CC_REVIEW_PROVIDER;
  const normalizedProvider = rawProvider === undefined ? "codex" : normalizeReviewProvider(rawProvider, providerSource);
  return initializeSelectedReviewBackend(normalizedProvider, env);
}

interface SubagentResult {
  code: number;
}

interface TaskResult {
  title: string;
  description: string;
  executionCode: number;
  reviewCode: number;
  output?: string;
  validationError?: string;
  unresolvedItems?: string[];
  reviewWarningName?: string;
  artifactPath?: string;
  structuredReport?: SubagentStructuredReport;
  schemaParseStatus?: SchemaParseStatus;
  reviewResult?: ReviewResult;
  reportedVerdict?: ReviewVerdict | null;
  effectiveVerdict?: ReviewVerdict;
  blockReason?: BlockReason;
  reviewerExitDiagnostic?: string;
  status?: TaskStatus;
}

class WorkflowError extends Error {
  summary: string;
  constructor(message: string, summary: string) {
    super(message);
    this.name = "WorkflowError";
    this.summary = summary;
  }
}

interface SubagentToolResult {
  content?: Array<{ type: string; text?: string }>;
  details?: {
    results?: Array<{
      agent?: string;
      exitCode?: number;
      stderr?: string;
      errorMessage?: string;
    }>;
  };
  isError?: boolean;
}

interface SubagentValidation {
  valid: boolean;
  error?: string;
  unresolvedItems?: string[];
  structuredReport?: SubagentStructuredReport;
  schemaParseStatus?: SchemaParseStatus;
}

interface RunCcReviewWorkflowOptions {
  reviewProvider?: string;
  logLevel?: string;
  validationCommands?: VerificationCommand[];
}

type SubagentToolExecutor = (
  toolName: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  onUpdate?: (partial: any) => void,
  ctx?: any
) => Promise<SubagentToolResult>;

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

function registerCcReviewFindingsRenderer(pi: ExtensionAPI): void {
  if (typeof pi.registerMessageRenderer !== "function") return;

  let piTui: any;
  try {
    piTui = require("@earendil-works/pi-tui");
  } catch {
    return;
  }
  const BoxCtor = piTui?.Box;
  const TextCtor = piTui?.Text;
  if (typeof BoxCtor !== "function" || typeof TextCtor !== "function") return;

  try {
    pi.registerMessageRenderer("cc-review-findings", (message: any, opts: any, theme: any) => {
      const expanded = !!opts?.expanded;
      const content = (message?.content ?? {}) as CcReviewFindingsPayload;
      const kindLabel = content.kind === "rollup" ? "Rollup" : `Task ${(content.taskIndex ?? 0) + 1}`;
      const partial = content.partial ? " (partial run)" : "";
      const verdictColor =
        content.effectiveVerdict === "block"
          ? "error"
          : content.effectiveVerdict === "ship_with_warnings"
            ? "warning"
            : "success";
      let text = `${theme.fg(verdictColor, `[CC Review Findings ${kindLabel}${partial}]`)} ${content.effectiveVerdict}`;
      if (content.blockReason) {
        text += ` ${theme.fg("dim", `(${content.blockReason})`)}`;
      }
      if (expanded) {
        text += `\n${content.summary}`;
        for (const finding of content.findings ?? []) {
          const color =
            finding.priority === "P0" || finding.priority === "P1"
              ? "error"
              : finding.priority === "P2"
                ? "warning"
                : "muted";
          const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "workspace";
          text += `\n- ${theme.fg(color, `[${finding.priority}]`)} ${location}: ${finding.message} (${finding.status})`;
        }
        if (content.artifactPath) {
          text += `\n${theme.fg("dim", `Artifact: ${content.artifactPath}`)}`;
        }
      } else {
        text += `\n${theme.fg("dim", "  (expand for finding cards)")}`;
      }
      const box = new BoxCtor(1, 1, (t: string) => theme.bg("customMessageBg", t));
      box.addChild(new TextCtor(text, 0, 0));
      return box;
    });
  } catch {
    // ignore registration errors
  }
}

function registerCcReviewSummaryRenderer(pi: ExtensionAPI): void {
  if (typeof pi.registerMessageRenderer !== "function") return;

  let piTui: any;
  try {
    piTui = require("@earendil-works/pi-tui");
  } catch {
    return;
  }
  const BoxCtor = piTui?.Box;
  const TextCtor = piTui?.Text;
  if (typeof BoxCtor !== "function" || typeof TextCtor !== "function") return;

  const BADGE_PALETTE: Record<CcReviewSummaryBadge, { label: string; color: string }> = {
    success: { label: "OK", color: "success" },
    warning: { label: "WARN", color: "warning" },
    failed: { label: "FAIL", color: "error" },
    cancelled: { label: "CANCELLED", color: "error" },
  };

  try {
    pi.registerMessageRenderer("cc-review-summary", (message: any, opts: any, theme: any) => {
      const expanded = !!opts?.expanded;
      const content = typeof message?.content === "string" ? message.content : "";
      const meta = message?.meta as CcReviewSummaryMeta | undefined;
      const badge = classifyCcReviewSummary(content);
      const palette = BADGE_PALETTE[badge];
      const prefix = theme.fg(palette.color, `[CC Review ${palette.label}]`);
      let headline = extractCcReviewSummaryHeadline(content);
      if (expanded && meta?.topBlockers?.length) {
        const blocker = meta.topBlockers[0];
        headline += ` · top blocker: [${blocker.priority}] ${truncateForWidget(blocker.message, 60)}`;
      }
      let text = `${prefix} ${headline}`;
      if (expanded && content) {
        text += `\n\n${content}`;
      } else if (!expanded) {
        text += `\n${theme.fg("dim", "  (expand for full report)")}`;
      }
      const box = new BoxCtor(1, 1, (t: string) => theme.bg("customMessageBg", t));
      box.addChild(new TextCtor(text, 0, 0));
      return box;
    });
  } catch {
    // ignore registration errors: this is best-effort UI polish.
  }
}

function extractCcReviewSummaryHeadline(summary: string): string {
  const counts = countCcReviewTaskOutcomesFromSummary(summary);
  const headline = formatCcReviewSummaryHeadline(counts);
  return truncateForWidget(headline, 120);
}

export default function ccReviewExtension(pi: ExtensionAPI) {
  // Register the slash command
  pi.registerCommand("cc-review", {
    description: "Run CC Review to plan, execute via Pi subagents, and review tasks step-by-step. Use --provider claude or --provider codex to select the planner+reviewer backend; when omitted, set CC_REVIEW_PROVIDER or fall back to codex. Use --log-level <debug|info|warning|error> (or the CC_REVIEW_LOG_LEVEL env fallback) to filter the compact widget + onUpdate surfaces; the persisted workflow-logs.jsonl is never filtered.",
    handler: async (args: string, ctx: any) => {
      const parsedArgs = parseCcReviewCommandArgs(args);
      if (parsedArgs.error) {
        ctx?.ui?.notify?.(parsedArgs.error, "error");
        return;
      }

      let goal = parsedArgs.goal;
      if (!goal) {
        goal = ((await ctx?.ui?.input?.("Enter the overarching goal to accomplish:")) ?? "").trim();
        if (!goal) {
          ctx?.ui?.notify?.("Goal cannot be empty", "error");
          return;
        }
      }

      ctx?.ui?.notify?.(`Starting CC Review for goal: "${goal}"`, "info");
      try {
        const workflowResult = await runCcReviewWorkflow(pi, goal, ctx, undefined, undefined, {
          reviewProvider: parsedArgs.reviewProvider,
          logLevel: parsedArgs.logLevel,
        });
        ctx?.ui?.notify?.("CC Review completed.", "info");
        
        // Output the final summary to the main session
        await pi.sendMessage?.({
          customType: "cc-review-summary",
          content: workflowResult.summary,
          meta: workflowResult.meta,
          display: true,
        });
      } catch (err: any) {
        ctx?.ui?.notify?.(`CC Review failed: ${err.message}`, "error");
        if (err instanceof WorkflowError || err.summary) {
          await pi.sendMessage?.({
            customType: "cc-review-summary",
            content: err.summary,
            display: true,
          });
        }
      }
    },
  });

  // Register a custom message renderer for the cc-review-summary payload so the
  // final report appears with a severity badge in the TUI (learned from pi's
  // example message-renderer.ts). Registration is best-effort: if the host pi
  // build doesn't expose registerMessageRenderer or the pi-tui primitives, this
  // is a no-op and the summary still displays as default markdown.
  registerCcReviewSummaryRenderer(pi);
  registerCcReviewFindingsRenderer(pi);

  // Register the tool
  pi.registerTool({
    name: "cc_review",
    label: "CC Review",
    description: "Run CC Review: break down a goal, execute through subagents, review/fix with the configured provider, and progress sequentially. Pass reviewProvider as codex or claude (controls both planner and reviewer), or omit it to use CC_REVIEW_PROVIDER / the codex default. Pass logLevel (debug|info|warning|error) to filter compact widget + onUpdate surfaces, or omit it to use CC_REVIEW_LOG_LEVEL / the info default. The persisted workflow-logs.jsonl is never filtered.",
    parameters: CcReviewParams,
    async execute(_toolCallId: string, params: CcReviewExecuteParams, signal?: AbortSignal, onUpdate?: (update: any) => void, ctx?: any) {
      onUpdate?.({ content: [{ type: "text", text: "Starting CC Review..." }] });
      
      try {
        const workflowResult = await runCcReviewWorkflow(pi, params.goal, ctx, onUpdate, signal, {
          reviewProvider: params.reviewProvider,
          logLevel: params.logLevel,
        });
        return {
          content: [{ type: "text", text: workflowResult.summary }],
          details: { goal: params.goal, status: "completed", meta: workflowResult.meta },
        };
      } catch (err: any) {
        const summary = err.summary || `Workflow failed: ${err.message}`;
        return {
          content: [{ type: "text", text: summary }],
          details: { goal: params.goal, status: "failed", error: err.message },
          isError: true,
        };
      }
    },
  });
}

function splitCommandLine(input: string): string[] {
  const tokens: string[] = [];
  const tokenPattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(input)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    tokens.push(token.replace(/\\(["'\\])/g, "$1"));
  }
  return tokens;
}

function parseCcReviewCommandArgs(args: string): { goal: string; reviewProvider?: string; logLevel?: string; error?: string } {
  const hasProviderFlag = /(?:^|\s)--(?:review-)?provider(?:=|\s|$)/.test(args);
  const hasLogLevelFlag = /(?:^|\s)--log-level(?:=|\s|$)/.test(args);
  if (!hasProviderFlag && !hasLogLevelFlag) {
    return { goal: args.trim() };
  }

  const tokens = splitCommandLine(args);
  const goalTokens: string[] = [];
  let reviewProvider: string | undefined;
  let logLevel: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const equalsProviderMatch = token.match(/^--(?:review-)?provider=(.*)$/);
    if (equalsProviderMatch) {
      reviewProvider = equalsProviderMatch[1];
      if (!reviewProvider) {
        return { goal: "", error: "Invalid --provider value \"\". Supported review providers: codex, claude." };
      }
      continue;
    }

    if (token === "--provider" || token === "--review-provider") {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { goal: "", error: `Invalid ${token} value "${value ?? ""}". Supported review providers: codex, claude.` };
      }
      reviewProvider = value;
      i++;
      continue;
    }

    const equalsLogLevelMatch = token.match(/^--log-level=(.*)$/);
    if (equalsLogLevelMatch) {
      logLevel = equalsLogLevelMatch[1];
      if (!logLevel) {
        return { goal: "", error: "Invalid --log-level value \"\". Supported log levels: debug, info, warning, error." };
      }
      continue;
    }

    if (token === "--log-level") {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { goal: "", error: `Invalid ${token} value "${value ?? ""}". Supported log levels: debug, info, warning, error.` };
      }
      logLevel = value;
      i++;
      continue;
    }

    goalTokens.push(token);
  }

  return {
    goal: goalTokens.join(" ").trim(),
    reviewProvider,
    logLevel,
  };
}

// Helper to summarize the parent workflow goal/context rather than copying wholesale
function summarizeParentContext(goal: string): string {
  const clean = goal.trim();
  if (clean.length <= 150) {
    return clean;
  }
  // Try to split on sentence boundaries
  const sentences = clean.split(/[.!?。！？]\s+/);
  let summary = "";
  for (const s of sentences) {
    const hasSentenceEnd =
      s.endsWith(".") ||
      s.endsWith("?") ||
      s.endsWith("!") ||
      s.endsWith("。") ||
      s.endsWith("！") ||
      s.endsWith("？");
    const sentence = hasSentenceEnd ? `${s} ` : `${s}. `;
    if ((summary + sentence).length > 150) {
      if (!summary) {
        summary = s.substring(0, 147) + "...";
      }
      break;
    }
    summary += sentence;
  }
  return summary.trim();
}

function buildSubagentTaskPrompt(task: Task, parentContextSummary: string): string {
  return [
    `Parent Workflow Context (Summary): ${parentContextSummary}`,
    `Task: ${task.title}`,
    `Description:\n${task.description}`,
    `Acceptance Criteria:\n${task.acceptanceCriteria}`,
    "Work only on this task's stated scope in the current workspace directory.",
    "Verify the acceptance criteria before reporting completion.",
    "End your final response with one JSON object (prose allowed above it) using this shape:",
    '{"status":"completed|partial|blocked","summary":"...","filesChanged":["path"],"unresolvedItems":[],"acceptanceCriteria":[{"criterion":"...","status":"met|not_met|unknown","evidence":"..."}]}',
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Subagent executor
//
// Earlier versions of this extension relied on a private `pi.toolManager.executeTool`
// API to invoke the `subagent` tool registered by the `_subagent` extension. That
// API is not part of the public ExtensionAPI surface and is not available at
// runtime, so any call into it threw
//   "The _subagent integration is unavailable: pi.toolManager.executeTool is not registered"
// and aborted the whole workflow before the first task could run.
//
// Instead we now mirror what `_subagent` itself does internally: discover the
// agent's markdown definition, write its system prompt to a temp file, and
// spawn `pi --mode json -p --no-session ...` as a subprocess, parsing the
// NDJSON event stream to recover the final assistant text and exit code.
// This uses only documented pi CLI flags (see docs/json.md and docs/extensions.md)
// and therefore stays independent of pi's internal tool-manager wiring.
// ---------------------------------------------------------------------------

interface DiscoveredAgent {
  name: string;
  model?: string;
  tools?: string[];
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

function parseAgentFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  // Minimal YAML frontmatter parser matching the `key: value` shape used by
  // pi agent files. Supports comments and blank lines but not nested structures
  // (which agent files don't use anyway).
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: {}, body: content };
  }
  const header = content.substring(3, end);
  const bodyStart = content.indexOf("\n", end + 4);
  const body = bodyStart === -1 ? "" : content.substring(bodyStart + 1);
  const frontmatter: Record<string, string> = {};
  for (const rawLine of header.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.substring(0, idx).trim();
    let value = line.substring(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) frontmatter[key] = value;
  }
  return { frontmatter, body };
}

function loadAgentFromDir(dir: string, agentName: string, source: "user" | "project"): DiscoveredAgent | undefined {
  const filePath = path.join(dir, `${agentName}.md`);
  if (!fs.existsSync(filePath)) return undefined;
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
  const { frontmatter, body } = parseAgentFrontmatter(content);
  if (!frontmatter.name) return undefined;
  const tools = frontmatter.tools
    ? frontmatter.tools.split(",").map((t) => t.trim()).filter(Boolean)
    : undefined;
  return {
    name: frontmatter.name,
    model: frontmatter.model || undefined,
    tools,
    systemPrompt: body,
    source,
    filePath,
  };
}

function applyAgentModelOverride(agent: DiscoveredAgent): DiscoveredAgent {
  const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  if (!fs.existsSync(settingsPath)) return agent;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const override = settings?.subagents?.agentOverrides?.[agent.name];
    if (override?.model) {
      return { ...agent, model: override.model };
    }
  } catch {
    // ignore malformed settings
  }
  return agent;
}

// Built-in fallback definition for the `generator` subagent. CC Review previously
// hard-required ~/.pi/agent/agents/generator.md, which made the extension fail
// for any user who didn't install that agent (goal #1: minimize external plugin
// dependencies). The prompt below is intentionally lightweight: it gives the
// subagent a single, focused responsibility and avoids the sprint-contract
// workflow some users layer on top of their own generator.md. Users who have
// their own generator.md still take precedence via discoverAgent().
const BUILTIN_GENERATOR_PROMPT = [
  "You are CC Review's built-in generator subagent.",
  "",
  "Scope rules:",
  "- Implement exactly the single task in the prompt; do not invent or pre-stage other work.",
  "- Operate in the current workspace directory using the tools available to you.",
  "- Do not consult or rely on external contract files (e.g. sprint-contract.json, eval-report.json). They may be left over from unrelated workflows.",
  "- Read only the files you need to understand the change; avoid speculative exploration.",
  "",
  "Process:",
  "1. Restate the task in one sentence (privately) and identify the smallest set of files to change.",
  "2. Make the change directly. Add or update focused tests covering the acceptance criteria when tests exist or are mentioned in the criteria.",
  "3. Verify the acceptance criteria before reporting completion (run targeted commands; do not run the whole test suite if a focused subset suffices).",
  "4. Reply with a one-paragraph summary: what changed, where, and how the criteria were verified.",
  "",
  "Failure protocol:",
  "- If a step is genuinely blocked, reply with \"ERROR: <one-sentence reason>\" and stop.",
  "- Do not loop or stall: if the same operation has failed twice, report the error instead of retrying indefinitely.",
].join("\n");

export function buildBuiltinGeneratorAgent(): DiscoveredAgent {
  return {
    name: "generator",
    model: undefined,
    tools: undefined,
    systemPrompt: BUILTIN_GENERATOR_PROMPT,
    source: "user",
    filePath: "<builtin>",
  };
}

export function discoverAgent(
  agentName: string,
  agentScope: "user" | "project" | "both",
  cwd: string,
): DiscoveredAgent | undefined {
  const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
  const projectDir = path.join(cwd, ".pi", "agents");

  let agent: DiscoveredAgent | undefined;
  if (agentScope === "project" || agentScope === "both") {
    agent = loadAgentFromDir(projectDir, agentName, "project");
  }
  if (!agent && (agentScope === "user" || agentScope === "both")) {
    agent = loadAgentFromDir(userDir, agentName, "user");
  }
  if (!agent && agentName === "generator") {
    // Last-resort built-in so the workflow runs without any user-installed agent.
    return buildBuiltinGeneratorAgent();
  }
  return agent ? applyAgentModelOverride(agent) : undefined;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  // Prefer the same pi binary that runs the current process, falling back to
  // the `pi` on PATH. Mirrors `_subagent`'s logic so we don't accidentally pick
  // up a different pi install when running under bun-compiled binaries.
  //
  // We only re-use `process.argv[1]` when it actually points at a pi entry
  // script. In production this extension runs inside pi so argv[1] is the pi
  // script; in test harnesses argv[1] could be an unrelated file, which would
  // make us launch the wrong program.
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  const looksLikePiScript =
    !!currentScript &&
    !isBunVirtualScript &&
    fs.existsSync(currentScript) &&
    (/(^|[\/\\])pi(\.[cm]?[jt]s)?$/i.test(currentScript) ||
      currentScript.includes("pi-coding-agent") ||
      currentScript.includes("@earendil-works"));
  if (looksLikePiScript) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

// Build a compact, non-sensitive one-line summary of a subagent tool execution
// for the live progress stream. Shows the tool plus a short, bounded hint
// (command for bash, path for file tools) without dumping raw args.
export function summarizeSubagentToolActivity(event: any): string {
  const toolName = typeof event?.toolName === "string" && event.toolName ? event.toolName : "tool";
  const args = event?.args && typeof event.args === "object" ? event.args : {};
  const clip = (value: unknown): string => {
    const text = stripAnsi(String(value ?? "")).replace(/\s+/g, " ").trim();
    return text.length > 80 ? `${text.slice(0, 79)}…` : text;
  };
  let hint = "";
  if (typeof args.command === "string") hint = clip(args.command);
  else if (typeof args.path === "string") hint = clip(args.path);
  else if (typeof args.file_path === "string") hint = clip(args.file_path);
  else if (typeof args.pattern === "string") hint = clip(args.pattern);
  else if (typeof args.query === "string") hint = clip(args.query);
  return hint ? `⚙ ${toolName}: ${hint}` : `⚙ ${toolName}`;
}

async function runPiAgentSubprocess(
  agent: DiscoveredAgent,
  task: string,
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: any) => void) | undefined,
): Promise<SubagentToolResult> {
  // Write the agent system prompt to a temp file we can pass via
  // --append-system-prompt. pi accepts either text or a file path there.
  let tmpDir: string | null = null;
  let tmpPromptPath: string | null = null;
  if (agent.systemPrompt.trim()) {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cc-review-subagent-"));
    tmpPromptPath = path.join(tmpDir, `prompt-${agent.name.replace(/[^\w.-]+/g, "_")}.md`);
    await fs.promises.writeFile(tmpPromptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
  }

  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
  if (tmpPromptPath) args.push("--append-system-prompt", tmpPromptPath);
  args.push(`Task: ${task}`);

  const invocation = getPiInvocation(args);
  // Debug: log invocation when CC_REVIEW_DEBUG is set
  if (process.env.CC_REVIEW_DEBUG) {
    try {
      process.stderr.write(`[cc-review] spawning: ${invocation.command} ${invocation.args.map((a) => JSON.stringify(a)).join(" ")}\n`);
    } catch {
      // ignore
    }
  }
  let finalAssistantText = "";
  let stderrBuf = "";
  let wasAborted = false;

  const exitCode: number = await new Promise<number>((resolve) => {
    const proc = childProcess.spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: any;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }
      // Surface live in-task progress. Without this, the subagent subprocess is
      // silent for the whole (often multi-minute) execution and the user "sees
      // no task progress" until the single final message_end. Forwarding each
      // tool the subagent runs gives a real-time activity stream through the
      // orchestrator's onUpdate -> [Subagent] live log path.
      if (event?.type === "tool_execution_start" && onUpdate) {
        const progress = summarizeSubagentToolActivity(event);
        if (progress) {
          try {
            onUpdate({ content: [{ type: "text", text: progress }] });
          } catch {
            // ignore observer errors
          }
        }
        return;
      }
      if (event?.type === "tool_execution_end" && event.isError && onUpdate) {
        const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
        try {
          onUpdate({ content: [{ type: "text", text: `⚠ ${toolName} failed` }] });
        } catch {
          // ignore observer errors
        }
        return;
      }
      if (event?.type === "message_end" && event.message?.role === "assistant") {
        const parts = Array.isArray(event.message.content) ? event.message.content : [];
        for (const part of parts) {
          if (part?.type === "text" && typeof part.text === "string" && part.text) {
            finalAssistantText = part.text;
            if (onUpdate) {
              try {
                onUpdate({ content: [{ type: "text", text: stripAnsi(part.text) }] });
              } catch {
                // ignore observer errors
              }
            }
          }
        }
      }
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf-8");
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.substring(0, nl);
        stdoutBuf = stdoutBuf.substring(nl + 1);
        handleLine(line);
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf-8");
    });

    const onAbort = () => {
      wasAborted = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      // SIGKILL fallback if the child refuses to exit
      setTimeout(() => {
        try {
          if (proc.exitCode === null) proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 2000);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.on("error", (err: Error) => {
      stderrBuf += `\n[spawn error] ${err.message}`;
      resolve(1);
    });
    proc.on("close", (code) => {
      if (stdoutBuf.trim()) handleLine(stdoutBuf);
      stdoutBuf = "";
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(typeof code === "number" ? code : (wasAborted ? 130 : 1));
    });
  });

  // Clean up temp prompt file
  if (tmpDir) {
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  const stderr = stderrBuf.trim();
  const isError = exitCode !== 0 || wasAborted;
  const textOut = finalAssistantText.trim() || (isError ? (stderr || `pi subprocess exited with code ${exitCode}`) : "");

  return {
    content: [{ type: "text", text: textOut }],
    details: {
      results: [
        {
          agent: agent.name,
          exitCode,
          stderr: stderr || undefined,
          errorMessage: isError ? (stderr || (wasAborted ? "Subagent aborted" : `pi subprocess exited with code ${exitCode}`)) : undefined,
        },
      ],
    },
    isError,
  };
}

function getSubagentExecutor(pi: ExtensionAPI): SubagentToolExecutor {
  // If a future pi runtime (or a test harness) exposes a way to invoke the
  // already-registered `subagent` tool directly via `pi.toolManager.executeTool`,
  // prefer it: it shares pi's in-process tool runtime and observability.
  //
  // Real pi (current public ExtensionAPI) does NOT expose this surface, so we
  // fall back to spawning `pi --mode json -p --no-session ...` as a subprocess,
  // mirroring what `_subagent` does internally. The previous version of this
  // function threw on the missing API and aborted the whole workflow before
  // task #1 could run; this resilient lookup is the actual fix.
  const toolManager = (pi as unknown as { toolManager?: { executeTool?: SubagentToolExecutor } }).toolManager;
  if (toolManager?.executeTool) {
    return toolManager.executeTool.bind(toolManager);
  }

  return async (_toolName, params, signal, onUpdate, ctx) => {
    const agentName = String(params.agent ?? "");
    const task = String(params.task ?? "");
    const agentScope = ((params.agentScope as "user" | "project" | "both") ?? "user");
    const cwd = (typeof params.cwd === "string" && params.cwd) || ctx?.cwd || process.cwd();

    if (!agentName || !task) {
      const errorMessage = "Subagent call missing required `agent` or `task` parameter";
      return {
        content: [{ type: "text", text: errorMessage }],
        details: { results: [{ exitCode: 1, errorMessage }] },
        isError: true,
      };
    }

    const agent = discoverAgent(agentName, agentScope, cwd);
    if (!agent) {
      const errorMessage = `Unknown agent "${agentName}" (scope=${agentScope}). Expected an agent markdown file under ~/.pi/agent/agents/ or <cwd>/.pi/agents/.`;
      return {
        content: [{ type: "text", text: errorMessage }],
        details: { results: [{ agent: agentName, exitCode: 1, errorMessage }] },
        isError: true,
      };
    }

    return runPiAgentSubprocess(agent, task, cwd, signal, onUpdate);
  };
}

function extractSubagentText(result: SubagentToolResult): string {
  return result.content
    ?.map((c) => (c.type === "text" && c.text ? c.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim() || "";
}

function getSubagentExitCode(result: SubagentToolResult): number {
  const detailCode = result.details?.results?.[0]?.exitCode;
  if (typeof detailCode === "number") {
    return detailCode;
  }
  return result.isError ? 1 : 0;
}

function appendUnique(target: string[], values: Array<string | undefined>) {
  for (const value of values) {
    const item = value?.trim();
    if (item && !target.includes(item)) {
      target.push(item);
    }
  }
}

function validateSubagentOutput(result: SubagentToolResult, task: Task): SubagentValidation {
  if (!result) {
    return {
      valid: false,
      error: "No result returned from subagent",
      unresolvedItems: ["No result returned from subagent"],
      schemaParseStatus: "absent",
    };
  }
  const subagentResultDetail = result.details?.results?.[0];
  const textContent = extractSubagentText(result);

  if (result.isError) {
    const error = subagentResultDetail?.errorMessage || subagentResultDetail?.stderr || textContent || "Subagent flagged an execution error (isError: true)";
    return {
      valid: false,
      error,
      unresolvedItems: [error],
      schemaParseStatus: "absent",
    };
  }

  if (subagentResultDetail && typeof subagentResultDetail.exitCode === "number" && subagentResultDetail.exitCode !== 0) {
    const error = subagentResultDetail.errorMessage || subagentResultDetail.stderr || `Subagent process exited with non-zero code ${subagentResultDetail.exitCode}`;
    return {
      valid: false,
      error,
      unresolvedItems: [error],
      schemaParseStatus: "absent",
    };
  }

  if (!textContent) {
    return {
      valid: false,
      error: "Subagent returned empty or missing text content",
      unresolvedItems: ["Subagent returned empty or missing text content"],
      schemaParseStatus: "absent",
    };
  }

  const structured = parseSubagentStructuredReport(textContent);
  if (structured.status === "parsed" && structured.report) {
    const structuredValidation = validateStructuredSubagentReport(structured.report);
    return {
      ...structuredValidation,
      structuredReport: structured.report,
      schemaParseStatus: structured.status,
    };
  }
  if (structured.status === "invalid_schema") {
    return {
      valid: false,
      error: "Subagent structured report failed schema validation",
      unresolvedItems: ["Invalid structured subagent JSON schema"],
      schemaParseStatus: structured.status,
    };
  }

  const unresolvedItems: string[] = [];
  const lines = textContent.split("\n");
  for (const line of lines) {
    const lowerLine = line.toLowerCase();
    if (lowerLine.includes("todo:") || lowerLine.includes("fixme:") || lowerLine.includes("unresolved:") || lowerLine.includes("pending:")) {
      unresolvedItems.push(line.trim());
    } else if (
      (lowerLine.includes("could not") || lowerLine.includes("failed to") || lowerLine.includes("unable to")) &&
      !lowerLine.includes("no issues found") &&
      !lowerLine.includes("zero")
    ) {
      unresolvedItems.push(line.trim());
    }
  }

  const criteriaList = task.acceptanceCriteria.split("\n").map(c => c.trim()).filter(Boolean);
  for (const crit of criteriaList) {
    const critEscaped = crit.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    const rx = new RegExp(`(failed|not met|pending|todo|unresolved|skip).*${critEscaped}`, "i");
    if (rx.test(textContent)) {
      unresolvedItems.push(`Acceptance Criterion Unresolved: "${crit}"`);
    }
  }

  return {
    valid: unresolvedItems.length === 0,
    error: unresolvedItems.length > 0 ? "Subagent reported unresolved work" : undefined,
    unresolvedItems: unresolvedItems.length > 0 ? unresolvedItems : undefined,
    schemaParseStatus: structured.status === "absent" ? "fallback_text" : structured.status,
  };
}

// Surface the absolute path of the persisted workflow log file in the summary.
// Mirrors pi's truncated-tool.ts pattern: when the compact widget/status is
// cleared, users can still open the JSONL to inspect the full run.
function appendPersistedLogPathToSummary(summary: string, persistedLogPath: string | undefined): string {
  if (!persistedLogPath) return summary;
  const trimmed = summary.replace(/\s+$/, "");
  return `${trimmed}\n\n### 📄 Persisted Workflow Log\n\nFull human-readable JSONL log available at: \`${persistedLogPath}\`\n`;
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

function buildSummaryReport(goal: string, taskResults: TaskResult[], tasks: Task[]): string {
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
  if (hasCancelled) {
    summaryMarkdown += `The workflow was cancelled or timed out before completion.\n\n`;
  } else if (hasReviewBlocked) {
    summaryMarkdown += `The workflow was blocked by reviewer findings before completion.\n\n`;
  } else if (failedOrHalted) {
    summaryMarkdown += `The workflow terminated early due to an unrecoverable task execution or validation failure.\n\n`;
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
    if (taskResult.effectiveVerdict && taskResult.reviewResult?.summary) {
      summaryMarkdown += `   - *Review Summary:* ${taskResult.reviewResult.summary}\n`;
    }
    summaryMarkdown += `\n`;
  }

  const rollupFindings = sortReviewFindings(
    results.flatMap((taskResult) => taskResult.reviewResult?.findings ?? [])
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
    summaryMarkdown += `3. **Resume Execution**: Restart the workflow for remaining tasks after fixes.\n\n`;
  }

  return summaryMarkdown;
}

export function buildCcReviewSummaryMeta(taskResults: TaskResult[]): CcReviewSummaryMeta {
  return buildSummaryMeta(taskResults);
}

export interface CcReviewWorkflowResult {
  summary: string;
  meta: CcReviewSummaryMeta;
}

/**
 * Runs the complete CC Review orchestration.
 */
async function runCcReviewWorkflow(
  pi: ExtensionAPI,
  goal: string,
  ctx: any,
  onUpdate?: (partial: any) => void,
  signal?: AbortSignal,
  options: RunCcReviewWorkflowOptions = {}
): Promise<CcReviewWorkflowResult> {
  const reviewProviderConfig = resolveReviewProviderConfig(options.reviewProvider);
  const logLevelResolution = resolveCcReviewLogLevel({ flag: options.logLevel, env: process.env });
  const resolvedLogLevel: CcReviewLogSeverity = logLevelResolution.level;

  // Trace workflow start
  emitTrace(ctx, "workflow_start", {
    goalLength: goal.length,
    reviewProvider: reviewProviderConfig.provider,
    logLevel: resolvedLogLevel,
  });

  // FLOW NOTE: This orchestrator manages the lifecycle of:
  // Trigger -> Phase 1 (Plan tasks via selected provider) -> Phase 2 (Iterative loop: Part A: execute in subagent, Part B: review with configured provider) -> Phase 3 (Wrap up)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-"));
  const schemaPath = path.join(tempDir, "workflow-schema.json");
  const outputPath = path.join(tempDir, "workflow-output.json");

  const activeProcesses = new Set<any>();
  let currentTaskIndex = -1;
  let tasks: Task[] = [];
  const taskResults: TaskResult[] = [];
  let currentPhase = "Initializing";
  let displayState: CcReviewDisplayState = "initializing";
  let retryState: { attempt: number; maxAttempts: number } | undefined;
  let lastTaskWarning: string | undefined;
  const liveLogs: CcReviewLogEntry[] = [];
  let logSequence = 0;

  const workflowCwd: string = ctx?.cwd || process.cwd();
  let persistedLogState: PersistedLogState = {
    filePath: path.join(workflowCwd, WORKFLOW_LOG_FILE),
    appendedLineCount: 0,
  };
  // Reset prior session file so the persisted log reflects only this run.
  try { fs.rmSync(persistedLogState.filePath, { force: true }); } catch { /* ignore */ }

  const workflowRunId = generateWorkflowRunId();
  const verificationPlanLoad = loadVerificationPlan(workflowCwd, options.validationCommands);
  if (verificationPlanLoad.error) {
    throw new WorkflowError(verificationPlanLoad.error, verificationPlanLoad.error);
  }
  const verificationPlan = verificationPlanLoad.plan;
  let findingsRollup = emptyFindingsRollup();
  const taskStatuses: Array<TaskStatus | undefined> = [];
  const collectedTaskFindings: ReviewFinding[][] = [];
  let rollupEmitted = false;
  let reviewedTaskCount = 0;

  const emitFindingsMessage = async (payload: CcReviewFindingsPayload) => {
    if (typeof pi.sendMessage === "function") {
      await pi.sendMessage({ customType: "cc-review-findings", display: true, content: payload });
    }
  };

  const runVerificationCommand: RunVerificationCommand = (command) =>
    new Promise((resolve) => {
      const startedAt = new Date().toISOString();
      const proc = childProcess.spawn(command.command, command.args, {
        cwd: workflowCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      if (command.timeoutMs) {
        timer = setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
        }, command.timeoutMs);
      }
      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({
          command: command.command,
          args: command.args,
          exitCode: timedOut ? 124 : (code ?? 1),
          stdout,
          stderr,
          timedOut,
          startedAt,
          completedAt: new Date().toISOString(),
        });
      });
      proc.on("error", () => {
        if (timer) clearTimeout(timer);
        resolve({
          command: command.command,
          args: command.args,
          exitCode: 1,
          stdout,
          stderr,
          timedOut,
          startedAt,
          completedAt: new Date().toISOString(),
        });
      });
    });

  const writeTaskArtifactForIndex = (input: {
    taskIndex: number;
    task: Task;
    startedAt: string;
    completedAt: string;
    execution: TaskArtifact["execution"];
    review: TaskArtifact["review"];
    validation: TaskArtifact["validation"];
    postReviewValidation: TaskArtifact["postReviewValidation"];
    workflow: TaskArtifact["workflow"];
  }): string =>
    writeTaskArtifact(workflowCwd, workflowRunId, {
      schemaVersion: 1,
      runId: workflowRunId,
      taskIndex: input.taskIndex,
      task: {
        title: input.task.title,
        description: input.task.description,
        acceptanceCriteria: input.task.acceptanceCriteria,
      },
      execution: input.execution,
      review: input.review,
      validation: input.validation,
      postReviewValidation: input.postReviewValidation,
      workflow: input.workflow,
      timestamps: { startedAt: input.startedAt, completedAt: input.completedAt },
    });

  // Explicit, testable state transition helpers to normalize state handling
  const getTaskOrThrow = (index: number) => {
    const task = tasks[index];
    if (!task) {
      throw new Error(`Invalid workflow task index ${index}`);
    }
    return task;
  };

  const transitionToPlanning = () => {
    currentTaskIndex = -1;
    displayState = "planning";
    retryState = undefined;
    currentPhase = `Planning Tasks via ${reviewProviderConfig.label}`;
    log({
      severity: "info",
      source: "planner",
      message: `Planning workflow with ${reviewProviderConfig.label}...`,
    });
  };

  const setPlannedTasks = (plannedTasks: Task[]) => {
    tasks = plannedTasks;
    currentTaskIndex = -1;
    retryState = undefined;
    log(`Workflow planned: ${tasks.length} tasks generated.`);
  };

  const transitionToExecuting = (index: number) => {
    const task = getTaskOrThrow(index);
    currentTaskIndex = index;
    displayState = "executing";
    retryState = undefined;
    currentPhase = `Executing Task ${index + 1}/${tasks.length}: ${task.title}`;
    log(`Starting execution of Task: "${task.title}"`);
    log(`Description: ${task.description}`);
  };

  const transitionToReviewing = (index: number) => {
    const task = getTaskOrThrow(index);
    currentTaskIndex = index;
    displayState = "reviewing";
    retryState = undefined;
    currentPhase = `Reviewing Task ${index + 1}/${tasks.length}: ${task.title}`;
    log(`Invoking ${reviewProviderConfig.label} to review and fix any issues for: "${task.title}"`);
  };

  const noteRetry = (attempt: number, maxAttempts: number) => {
    retryState = { attempt, maxAttempts };
    displayState = "retrying";
  };

  const clearRetry = () => {
    retryState = undefined;
    if (displayState === "retrying") {
      displayState = currentTaskIndex < 0 ? "planning" : "executing";
    }
  };

  const noteReviewWarning = (warningMessage: string) => {
    lastTaskWarning = warningMessage;
    displayState = "warning";
  };

  const transitionToComplete = () => {
    currentTaskIndex = tasks.length;
    displayState = "complete";
    currentPhase = "Complete";
    log("Workflow finished!");
  };

  const recordTaskResult = (result: TaskResult) => {
    taskResults.push(result);
  };

  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw new Error("Workflow aborted by user");
    }
  };

  const buildWidgetState = (): CcReviewWidgetState => ({
    goal,
    tasks: tasks.map((task, index) => ({ title: task.title, status: taskStatuses[index] })),
    currentTaskIndex,
    displayState,
    currentPhase,
    retryState,
    lastTaskWarning,
    liveLogs,
    resolvedLogLevel,
    persistedLogPath: persistedLogState.filePath,
    findingsRollup,
    taskStatuses,
  });

  const refreshWorkflowUi = () => {
    if (ctx?.ui?.setWidget) {
      const widgetState = buildWidgetState();
      const uiTheme = ctx.ui.theme;
      if (uiTheme && typeof uiTheme.fg === "function") {
        ctx.ui.setWidget("cc-review-widget", (_tui: unknown, theme: CcReviewWidgetTheme) => ({
          render: (renderWidth: number) =>
            buildCcReviewWidgetLines(widgetState, { width: renderWidth, theme }),
          invalidate: () => {},
        }));
      } else {
        ctx.ui.setWidget(
          "cc-review-widget",
          buildCcReviewWidgetLines(widgetState, { width: WIDGET_MAX_WIDTH_DEFAULT })
        );
      }
    }

    const statusText = buildCcReviewStatusText({
      tasks,
      currentTaskIndex,
      displayState,
      retryState,
      currentPhase,
    });
    const uiTheme = ctx?.ui?.theme;
    if (uiTheme && typeof uiTheme.fg === "function") {
      ctx?.ui?.setStatus?.("cc-review-status", uiTheme.fg("accent", statusText));
    } else {
      ctx?.ui?.setStatus?.("cc-review-status", statusText);
    }
  };

  // Helper to log and update the widget & onUpdate stream.
  //
  // Display surfaces (rebuilt from pi examples — see truncated-tool.ts persisting
  // full output, todo.ts truncating to width, message-renderer.ts using severity
  // badges):
  // - Persisted JSONL log file: bounded, full history; surfaced as a path so
  //   users can `read`/`cat` it after the compact TUI is cleared.
  // - TUI widget: width-truncated, windowed checklist, explicit empty/warning
  //   /cancelled states, last N live log lines only.
  // - onUpdate stream: compact delta for the single new entry rather than a
  //   re-broadcast of the full goal/phase/last-5 markdown block. Phase changes
  //   still emit a one-line state header to give downstream consumers context.
  let lastSeenPhase: string | undefined;
  const log = (input: CcReviewLogInput) => {
    const entry = normalizeCcReviewLogEntry(input, { sequence: ++logSequence });
    if (!entry.message) return;
    liveLogs.push(entry);
    if (liveLogs.length > 50) {
      liveLogs.shift();
    }

    // Persist full log line to the workspace log file.
    persistedLogState = appendPersistedLogEntry(persistedLogState, entry);

    // Update TUI widget with explicit empty/warning/cancelled states.
    refreshWorkflowUi();

    // Emit a compact delta on the agent stream. Pi example pattern: keep tool
    // updates short so downstream LLMs aren't flooded by re-broadcast markdown.
    // The resolved log level gates this compact surface: entries below the
    // threshold are skipped here but they were ALREADY persisted to the JSONL
    // log a few lines above, so the on-disk record remains complete.
    if (onUpdate) {
      const entrySeverityForGate: CcReviewLogSeverity = SUPPORTED_LOG_SEVERITIES.includes(
        entry.severity as CcReviewLogSeverity
      )
        ? (entry.severity as CcReviewLogSeverity)
        : "info";
      const passesLogLevel = LOG_SEVERITY_RANK[entrySeverityForGate] >= LOG_SEVERITY_RANK[resolvedLogLevel];
      if (passesLogLevel) {
        const renderedDelta = renderCcReviewLogEntry(entry, { maxMessageWidth: 120 });
        const deltaLines: string[] = [...renderedDelta];
        if (currentPhase !== lastSeenPhase) {
          deltaLines.unshift(`▸ Phase: ${currentPhase}`);
          lastSeenPhase = currentPhase;
        }
        onUpdate({
          content: [{ type: "text", text: deltaLines.join("\n") }],
        });
      }
    }
  };

  // If the log-level resolver flagged an invalid user input (bad flag or bad
  // env var) emit EXACTLY ONE warning entry so the workflow can continue with
  // the safe `info` default instead of crashing. The warning itself is `warn`
  // severity so it survives the `warning`/`error` thresholds and appears on
  // every compact surface AND in the persisted log.
  if (logLevelResolution.invalidInput) {
    const { source: invalidSource, raw } = logLevelResolution.invalidInput;
    const rawDisplay = typeof raw === "string" ? raw : String(raw ?? "");
    log({
      severity: "warning",
      source: "cc-review",
      message:
        `Ignoring invalid log level ${JSON.stringify(rawDisplay)} from ${invalidSource}; ` +
        `falling back to default 'info'.`,
    });
  }

  // Clean up processes on abort
  const onAbort = () => {
    displayState = "cancelled";
    log({ severity: "warning", source: "cc-review", message: "Workflow aborted by user. Killing subprocesses..." });
    const pidsToKill: number[] = [];
    for (const proc of activeProcesses) {
      if (proc.pid) {
        pidsToKill.push(proc.pid);
        try {
          process.kill(-proc.pid, "SIGTERM");
        } catch {
          try {
            proc.kill("SIGTERM");
          } catch {
            // ignore
          }
        }
      }
    }

    setTimeout(() => {
      for (const pid of pidsToKill) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // ignore
          }
        }
      }
      activeProcesses.clear();
    }, 500);
  };

  if (signal) {
    signal.addEventListener("abort", onAbort);
  }

  const runProcess = (
    label: string,
    command: string,
    args: string[],
    onStdout: (data: Buffer) => void,
    onStderr: (data: Buffer) => void,
    timeoutMs?: number
  ): Promise<ProcessResult> => {
    throwIfAborted();

    return new Promise((resolve, reject) => {
      emitTrace(ctx, "tool_execution_start", {
        label,
        command,
        source: "subprocess",
      });

      const proc = childProcess.spawn(command, args, {
        cwd: ctx?.cwd ?? process.cwd(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        detached: true,
      });
      let settled = false;
      activeProcesses.add(proc);

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        activeProcesses.delete(proc);
        fn();
      };

      let timeoutTimer: NodeJS.Timeout | undefined;
      if (timeoutMs) {
        timeoutTimer = setTimeout(async () => {
          if (settled) return;
          log(`[Timeout] ${label} exceeded timeout of ${timeoutMs}ms. Killing process group...`);
          
          if (proc.pid) {
            try {
              process.kill(-proc.pid, "SIGTERM");
            } catch {
              try {
                proc.kill("SIGTERM");
              } catch {
                // ignore
              }
            }
            
            // Wait 500ms
            await new Promise((resolve) => setTimeout(resolve, 500));
            
            try {
              process.kill(-proc.pid, "SIGKILL");
            } catch {
              try {
                proc.kill("SIGKILL");
              } catch {
                // ignore
              }
            }
          }
          
          settle(() => {
            emitTrace(ctx, "failure", {
              phase: "subprocess_timeout",
              label,
              command,
              timeoutMs,
            });
            reject(new Error(`${label} timed out after ${timeoutMs}ms`));
          });
        }, timeoutMs);
      }

      let stdoutBuffer = "";
      let stderrBuffer = "";
      let combinedOutput = "";
      proc.stdout.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdoutBuffer += chunk;
        combinedOutput += chunk;
        onStdout(data);
      });
      proc.stderr.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderrBuffer += chunk;
        combinedOutput += chunk;
        onStderr(data);
      });

      proc.on("error", (err) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        settle(() => {
          emitTrace(ctx, "failure", {
            phase: "subprocess_start",
            label,
            command,
            error: err.message,
          });
          reject(new Error(`${label} failed to start: ${err.message}`));
        });
      });

      proc.on("close", (code, closeSignal) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        settle(() => {
          const exitCode = code ?? (closeSignal ? 1 : 0);
          emitTrace(ctx, "tool_execution_end", {
            label,
            command,
            source: "subprocess",
            exitCode,
            signal: closeSignal ?? undefined,
          });
          if (exitCode !== 0 || closeSignal) {
            emitTrace(ctx, "failure", {
              phase: "subprocess_exit",
              label,
              command,
              exitCode,
              signal: closeSignal ?? undefined,
            });
          }
          if (signal?.aborted) {
            reject(new Error("Workflow aborted by user"));
            return;
          }
          resolve({
            code: exitCode,
            exitCode,
            stdout: stdoutBuffer,
            stderr: stderrBuffer,
            combinedOutput,
            output: combinedOutput,
          });
        });
      });
    });
  };

  try {
    throwIfAborted();

    // Write out the task breakdown schema
    const schema = {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              acceptanceCriteria: { type: "string" },
            },
            required: ["title", "description", "acceptanceCriteria"],
            additionalProperties: false,
          },
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    };
    fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2), "utf8");

    // PHASE 1: Task breakdowns via the selected provider
    transitionToPlanning();

    const plannerPrompt = `Break down the following goal into a sequence of small, self-contained, and incremental implementation tasks: ${goal}. Ensure each task is tightly scoped, independent, and includes specific, verifiable acceptance criteria. Summarize any necessary parent workflow context for each task instead of copying the entire goal or parent context wholesale, so the subagent can execute the task with clear boundaries.`;
    const plannerProvider = reviewProviderConfig.provider;
    const plannerLabel = `${reviewProviderConfig.label.replace(/ reviewer$/i, "")} planner`;

    let plannerCommand: string;
    let plannerArgs: string[];
    let captureStdoutForPlanner = false;

    if (plannerProvider === "codex") {
      plannerCommand = "codex";
      plannerArgs = [
        "exec",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "--output-schema",
        schemaPath,
        "-o",
        outputPath,
      ];
      const codexModel = readTrimmedEnv(process.env, "CODEX_MODEL");
      if (codexModel) plannerArgs.push("--model", codexModel);
      plannerArgs.push(plannerPrompt);
    } else {
      // Claude has no native --output-schema. Ask for strict JSON in the prompt
      // and parse it from stdout. This keeps the workflow runnable for users
      // who only have the claude CLI installed (per goal #1: minimize external
      // plugin dependencies).
      captureStdoutForPlanner = true;
      plannerCommand = "claude";
      plannerArgs = ["-p", "--dangerously-skip-permissions", "--no-session-persistence"];
      const claudeModel = readTrimmedEnv(process.env, "CLAUDE_MODEL");
      if (claudeModel) plannerArgs.push("--model", claudeModel);
      const claudePlannerPrompt = [
        plannerPrompt,
        "",
        "Respond with ONLY a JSON object matching this schema (no markdown fences, no prose):",
        JSON.stringify({
          type: "object",
          properties: {
            tasks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  acceptanceCriteria: { type: "string" },
                },
                required: ["title", "description", "acceptanceCriteria"],
              },
            },
          },
          required: ["tasks"],
        }),
      ].join("\n");
      plannerArgs.push(claudePlannerPrompt);
    }

    const maxPlanRetries = 3;
    for (let attempt = 1; attempt <= maxPlanRetries; attempt++) {
      throwIfAborted();
      fs.rmSync(outputPath, { force: true });
      if (attempt > 1) {
        noteRetry(attempt, maxPlanRetries);
        log({
          severity: "warning",
          source: "planner",
          message: `Retrying planning with ${reviewProviderConfig.label} (attempt ${attempt}/${maxPlanRetries})...`,
        });
      } else {
        clearRetry();
      }

      emitTrace(ctx, "subagent_assignment", {
        role: "planner",
        agent: plannerProvider,
        attempt,
      });

      let plannerStdoutBuffer = "";
      const planResult = await runProcess(
        plannerLabel,
        plannerCommand,
        plannerArgs,
        (data) => {
          const chunk = data.toString();
          if (captureStdoutForPlanner) plannerStdoutBuffer += chunk;
          for (const line of chunk.split("\n")) {
            if (line.trim()) {
              log({
                severity: "info",
                source: "planner",
                message: line.trim(),
              });
            }
          }
        },
        (data) => {
          for (const line of data.toString().split("\n")) {
            if (line.trim()) {
              log({
                severity: "error",
                source: "planner",
                message: line.trim(),
              });
            }
          }
        }
      );

      if (planResult.code !== 0) {
        const errorMsg = `${reviewProviderConfig.label} task planning failed with exit code ${planResult.code}`;
        if (attempt < maxPlanRetries) {
          emitTrace(ctx, "retry", {
            phase: "planning",
            attempt,
            maxAttempts: maxPlanRetries,
            error: errorMsg,
          });
          const backoff = Math.pow(2, attempt) * 1000;
          log({
            severity: "warning",
            source: "planner",
            message: `Planning failed. Waiting ${backoff}ms before retrying...`,
          });
          await delay(backoff, signal);
          continue;
        }
        throw new Error(errorMsg);
      }

      let rawPlanJson: string | undefined;
      if (captureStdoutForPlanner) {
        rawPlanJson = extractJsonObject(plannerStdoutBuffer);
      } else if (fs.existsSync(outputPath)) {
        rawPlanJson = fs.readFileSync(outputPath, "utf8");
      }

      if (!rawPlanJson) {
        const errorMsg = `${reviewProviderConfig.label} failed to output the structured task list`;
        if (attempt < maxPlanRetries) {
          emitTrace(ctx, "retry", {
            phase: "planning",
            attempt,
            maxAttempts: maxPlanRetries,
            error: errorMsg,
          });
          const backoff = Math.pow(2, attempt) * 1000;
          log({
            severity: "warning",
            source: "planner",
            message: `Planning output missing. Waiting ${backoff}ms before retrying...`,
          });
          await delay(backoff, signal);
          continue;
        }
        throw new Error(errorMsg);
      }

      try {
        const outputData = JSON.parse(rawPlanJson);
        tasks = Array.isArray(outputData?.tasks) ? outputData.tasks : [];
        if (tasks.length === 0) {
          throw new Error(`${reviewProviderConfig.label} returned an empty task list`);
        }
        break;
      } catch (err: any) {
        if (attempt < maxPlanRetries) {
          emitTrace(ctx, "retry", {
            phase: "planning",
            attempt,
            maxAttempts: maxPlanRetries,
            error: err.message,
          });
          const backoff = Math.pow(2, attempt) * 1000;
          log({
            severity: "warning",
            source: "planner",
            message: `Planning parse/validation failed: ${err.message}. Waiting ${backoff}ms before retrying...`,
          });
          await delay(backoff, signal);
          continue;
        }
        throw err;
      }
    }

    setPlannedTasks(tasks);

    // PHASE 2: Task Execution Loop
    for (let i = 0; i < tasks.length; i++) {
      throwIfAborted();
      transitionToExecuting(i);
      const task = tasks[i];
      const taskStartedAt = new Date().toISOString();
      let cachedSubagentResult: SubagentToolResult = {};
      let structuredReport: SubagentStructuredReport | null = null;
      let schemaParseStatus: SchemaParseStatus = "absent";

      const summarizedParentContext = summarizeParentContext(goal);
      const subagentPrompt = buildSubagentTaskPrompt(task, summarizedParentContext);
      let subagentResult: SubagentResult = { code: 0 };
      let subagentOutputText = "";
      let validationError: string | undefined = undefined;
      let unresolvedItems: string[] | undefined = undefined;
      let taskStatus: TaskResult["status"] = "completed";
      let retryFeedback: string | undefined = undefined;
      const unresolvedItemsForFailedTask: string[] = [];

      const maxExecutionRetries = 2;
      for (let attempt = 1; attempt <= maxExecutionRetries; attempt++) {
        throwIfAborted();
        if (attempt > 1) {
          noteRetry(attempt, maxExecutionRetries);
          log(`Retrying task execution in subagent (attempt ${attempt}/${maxExecutionRetries})...`);
        } else {
          clearRetry();
        }

        const attemptPrompt = retryFeedback
          ? [
              subagentPrompt,
              "Previous attempt feedback:",
              retryFeedback,
              "Resolve the previous attempt's errors or unresolved items before reporting completion.",
            ].join("\n\n")
          : subagentPrompt;

        emitTrace(ctx, "subagent_assignment", {
          role: "executor",
          agent: "generator",
          taskIndex: i,
          attempt,
        });

        emitTrace(ctx, "tool_execution_start", {
          taskIndex: currentTaskIndex,
          toolName: "subagent",
          source: "_subagent",
        });

        const executeSubagentTool = getSubagentExecutor(pi);
        let result: SubagentToolResult = {};
        const maxTransientRetries = 3;
        let transientAttempt = 1;
        let transientDone = false;

        while (transientAttempt <= maxTransientRetries && !transientDone) {
          throwIfAborted();

          const taskAbortController = new AbortController();
          const onParentAbort = () => {
            taskAbortController.abort();
          };
          if (signal) {
            signal.addEventListener("abort", onParentAbort);
          }

          // Enforce a timeout for the long-running subagent tool call (5 minutes default)
          const subagentTimeoutMs = 300000;
          const timeoutTimer = setTimeout(() => {
            log(`[Timeout] Subagent task execution exceeded timeout of ${subagentTimeoutMs}ms. Aborting subagent...`);
            taskAbortController.abort(new Error(`Subagent execution timed out after ${subagentTimeoutMs}ms`));
          }, subagentTimeoutMs);

          try {
            result = await executeSubagentTool(
              "subagent",
              {
                agent: "generator",
                task: attemptPrompt,
                agentScope: "user",
                cwd: ctx?.cwd ?? process.cwd(),
              },
              taskAbortController.signal,
              (partial) => {
                const subagentText = partial?.content?.find(
                  (item: any) => item?.type === "text" && item.text
                )?.text;
                if (subagentText) {
                  log(`[Subagent] ${subagentText}`);
                }
                onUpdate?.(partial);
              },
              ctx
            );

            const subagentFailure = result.details?.results?.[0];
            const errorMsg = result.isError
              ? (subagentFailure?.errorMessage || subagentFailure?.stderr || extractSubagentText(result) || "Subagent execution error")
              : "";

            if (result.isError && isTransientError(errorMsg)) {
              if (transientAttempt < maxTransientRetries) {
                const backoff = Math.pow(2, transientAttempt) * 1000;
                log(`[Transient Error] Subagent tool call failed with transient error: "${errorMsg}". Retrying in ${backoff}ms... (Attempt ${transientAttempt}/${maxTransientRetries})`);
                await delay(backoff, signal);
                transientAttempt++;
                continue;
              }
            }
            transientDone = true;
          } catch (err: any) {
            if (signal?.aborted) {
              throw new Error("Workflow aborted by user");
            }
            const errorMessage = err?.message || String(err);
            if (isTransientError(errorMessage) && transientAttempt < maxTransientRetries) {
              const backoff = Math.pow(2, transientAttempt) * 1000;
              log(`[Transient Error] Subagent tool call threw transient exception: "${errorMessage}". Retrying in ${backoff}ms... (Attempt ${transientAttempt}/${maxTransientRetries})`);
              await delay(backoff, signal);
              transientAttempt++;
              continue;
            }
            emitTrace(ctx, "failure", {
              phase: "subagent_execution",
              taskIndex: currentTaskIndex,
              error: errorMessage,
            });
            result = {
              content: [{ type: "text", text: errorMessage }],
              details: { results: [{ exitCode: 1, errorMessage }] },
              isError: true,
            };
            transientDone = true;
          } finally {
            clearTimeout(timeoutTimer);
            if (signal) {
              signal.removeEventListener("abort", onParentAbort);
            }
          }
        }

        const resultCode = getSubagentExitCode(result);
        subagentResult = { code: resultCode };
        emitTrace(ctx, "tool_execution_end", {
          taskIndex: currentTaskIndex,
          toolName: "subagent",
          source: "_subagent",
          exitCode: resultCode,
        });

        subagentOutputText = extractSubagentText(result);

        // Validate subagent outputs
        const validation = validateSubagentOutput(result, task);
        structuredReport = validation.structuredReport ?? null;
        schemaParseStatus = validation.schemaParseStatus ?? "absent";
        cachedSubagentResult = result;
        if (!validation.valid) {
          validationError = validation.error || "Output validation failed";
          appendUnique(unresolvedItemsForFailedTask, validation.unresolvedItems || [validationError]);
          unresolvedItems = unresolvedItemsForFailedTask.length > 0 ? [...unresolvedItemsForFailedTask] : undefined;
          taskStatus = "validation_failed";
        } else {
          validationError = undefined;
          unresolvedItems = undefined;
          taskStatus = resultCode === 0 ? "completed" : "completed_with_warnings";
        }

        if (resultCode === 0 && validation.valid) {
          log(`[Subagent Execution Done] Task completed and validated.`);
          break;
        } else {
          const subagentFailure = result.details?.results?.[0];
          const errorMsg =
            validationError ||
            subagentFailure?.errorMessage ||
            subagentFailure?.stderr ||
            `Subagent process exited with code ${resultCode}`;
          if (attempt < maxExecutionRetries) {
            retryFeedback = [
              `Exit code: ${resultCode}`,
              `Error: ${errorMsg}`,
              unresolvedItems?.length ? `Unresolved items:\n${unresolvedItems.map((item) => `- ${item}`).join("\n")}` : undefined,
              subagentOutputText ? `Output:\n${subagentOutputText}` : undefined,
            ].filter(Boolean).join("\n\n");
            emitTrace(ctx, "retry", {
              phase: "execution",
              taskIndex: i,
              attempt,
              maxAttempts: maxExecutionRetries,
              error: errorMsg,
            });
          } else {
            log(`[Subagent Execution Failure] ${errorMsg}`);
            taskStatus = resultCode === 0 ? "validation_failed" : "failed";
          }
        }
      }

      // Early Termination Gate
      if (taskStatus === "failed" || taskStatus === "validation_failed") {
        log(`[Workflow Halted] Halting workflow due to unrecoverable task failure on: "${task.title}".`);
        const completedAt = new Date().toISOString();
        const artifactPath = writeTaskArtifactForIndex({
          taskIndex: i,
          task,
          startedAt: taskStartedAt,
          completedAt,
          execution: {
            exitCode: subagentResult.code,
            status: taskStatus,
            rawOutput: subagentOutputText,
            structuredReport,
            schemaParseStatus,
          },
          review: {
            provider: reviewProviderConfig.provider,
            reviewerExitCode: -1,
            stdout: "",
            stderr: "",
            combinedOutput: "",
            reviewParseStatus: "absent",
            reportedVerdict: null,
            effectiveVerdict: null,
            blockReason: null,
            fallbackApplied: false,
            result: null,
          },
          validation: {
            valid: false,
            error: validationError ?? "execution failed",
            unresolvedItems: unresolvedItems ?? [],
          },
          postReviewValidation: {
            required: false,
            workspaceChanged: false,
            passed: true,
            error: null,
            commands: [],
          },
          workflow: { haltedOnReview: false, haltedOnExecution: true },
        });
        taskStatuses[i] = taskStatus;
        recordTaskResult({
          title: task.title,
          description: task.description,
          executionCode: subagentResult.code,
          reviewCode: -1,
          output: subagentOutputText,
          validationError,
          unresolvedItems,
          status: taskStatus,
          artifactPath,
          structuredReport: structuredReport ?? undefined,
          schemaParseStatus,
        });
        throw new Error(`Task execution failed unrecoverably on: "${task.title}" (${validationError || "exit code " + subagentResult.code})`);
      }

      // Part B: Review and Fix with the configured review provider
      transitionToReviewing(i);

      emitTrace(ctx, "subagent_assignment", {
        role: "reviewer",
        agent: reviewProviderConfig.provider,
        taskIndex: i,
      });

      const reviewArgs = reviewProviderConfig.buildArgs({ task });
      const workspaceBeforeReview = snapshotWorkspace(workflowCwd);

      const reviewProcessResult = await runProcess(
        reviewProviderConfig.label,
        reviewProviderConfig.command,
        reviewArgs,
        (data) => {
          const lines = data.toString().split("\n");
          for (const line of lines) {
            if (line.trim()) log(`[${reviewProviderConfig.label}] ${line}`);
          }
        },
        (data) => {
          const lines = data.toString().split("\n");
          for (const line of lines) {
            if (line.trim()) log(`[${reviewProviderConfig.label} Error] ${line}`);
          }
        }
      );

      const workspaceAfterReview = snapshotWorkspace(workflowCwd);
      const workspaceChanged = workspaceSnapshotChanged(workspaceBeforeReview, workspaceAfterReview);
      const parsedReview = parseReviewResult(reviewProcessResult.combinedOutput);
      const reviewResultObject = parsedReview.result;
      const findings = reviewResultObject?.findings ?? [];
      const reportedVerdict = reviewResultObject?.verdict ?? null;
      const rerunValidation = validateSubagentOutput(cachedSubagentResult, task);
      const postReview = await runPostReviewValidation({
        reviewResult: reviewResultObject,
        workspaceChanged,
        verificationPlan,
        runCommand: runVerificationCommand,
        rerunSubagentValidationPassed: rerunValidation.valid,
      });
      const derived = deriveEffectiveVerdict({
        reportedVerdict,
        findings,
        reviewerExitCode: reviewProcessResult.exitCode,
        reviewParseStatus: parsedReview.status,
        ambiguousHighSeverity: parsedReview.ambiguousHighSeverity,
        postReviewValidationFailed: !postReview.passed,
      });
      const effectiveVerdict = derived.effectiveVerdict;
      taskStatus = mapEffectiveVerdictToTaskStatus(effectiveVerdict);
      let reviewerExitDiagnostic: string | undefined;
      if (reviewProcessResult.exitCode !== 0 && effectiveVerdict === "ship") {
        reviewerExitDiagnostic = `Reviewer exited non-zero (code ${reviewProcessResult.exitCode}) despite ship verdict`;
      }

      if (reviewProcessResult.exitCode !== 0 && effectiveVerdict === "ship_with_warnings") {
        const warningMessage = `${reviewProviderConfig.label} exited with code ${reviewProcessResult.exitCode}`;
        noteReviewWarning(warningMessage);
        log({ severity: "warning", source: "reviewer", message: `[Review Warning] ${warningMessage}` });
      } else if (effectiveVerdict === "ship") {
        log(`[Review Done] ${reviewProviderConfig.label} completed the review.`);
      } else if (effectiveVerdict === "ship_with_warnings") {
        log({
          severity: "warning",
          source: "reviewer",
          message: `[Review Warning] ${reviewProviderConfig.label} reported warnings.`,
        });
      }

      const completedAt = new Date().toISOString();
      const artifactPath = writeTaskArtifactForIndex({
        taskIndex: i,
        task,
        startedAt: taskStartedAt,
        completedAt,
        execution: {
          exitCode: subagentResult.code,
          status: taskStatus,
          rawOutput: subagentOutputText,
          structuredReport,
          schemaParseStatus,
        },
        review: {
          provider: reviewProviderConfig.provider,
          reviewerExitCode: reviewProcessResult.exitCode,
          stdout: reviewProcessResult.stdout,
          stderr: reviewProcessResult.stderr,
          combinedOutput: reviewProcessResult.combinedOutput,
          reviewParseStatus: parsedReview.status,
          reportedVerdict,
          effectiveVerdict,
          blockReason: derived.blockReason ?? null,
          fallbackApplied: derived.fallbackApplied,
          result: reviewResultObject,
        },
        validation: {
          valid: rerunValidation.valid,
          error: rerunValidation.error ?? null,
          unresolvedItems: rerunValidation.unresolvedItems ?? [],
        },
        postReviewValidation: {
          required: postReview.required,
          workspaceChanged: postReview.workspaceChanged,
          passed: postReview.passed,
          error: postReview.error,
          commands: postReview.commands,
        },
        workflow: {
          haltedOnReview: effectiveVerdict === "block",
          haltedOnExecution: false,
        },
      });

      await emitFindingsMessage(
        buildFindingsPayload({
          kind: "task",
          taskIndex: i,
          taskTitle: task.title,
          reportedVerdict,
          effectiveVerdict,
          blockReason: derived.blockReason,
          summary: reviewResultObject?.summary ?? `Review completed with ${effectiveVerdict}`,
          findings,
          artifactPath,
        })
      );
      collectedTaskFindings.push(findings);
      findingsRollup = updateFindingsRollup(findingsRollup, effectiveVerdict, findings);
      reviewedTaskCount += 1;
      taskStatuses[i] = taskStatus;
      refreshWorkflowUi();

      recordTaskResult({
        title: task.title,
        description: task.description,
        executionCode: subagentResult.code,
        reviewCode: reviewProcessResult.exitCode,
        output: subagentOutputText,
        validationError,
        unresolvedItems,
        reviewWarningName: reviewProviderConfig.warningName,
        status: taskStatus,
        artifactPath,
        structuredReport: structuredReport ?? undefined,
        schemaParseStatus,
        reviewResult: reviewResultObject ?? undefined,
        reportedVerdict,
        effectiveVerdict,
        blockReason: derived.blockReason,
        reviewerExitDiagnostic,
      });

      if (effectiveVerdict === "block") {
        log(`[Workflow Halted] Blocked by reviewer on: "${task.title}".`);
        const summary = appendPersistedLogPathToSummary(
          buildSummaryReport(goal, taskResults, tasks),
          persistedLogState.filePath
        );
        throw new WorkflowError(`Blocked by reviewer on: "${task.title}"`, summary);
      }
    }

    if (!rollupEmitted) {
      const rollupFindings = mergeRollupFindings(collectedTaskFindings);
      const lastArtifact =
        taskResults[taskResults.length - 1]?.artifactPath ??
        path.join(workflowCwd, WORKFLOW_ARTIFACT_DIR, workflowRunId);
      await emitFindingsMessage(
        buildFindingsPayload({
          kind: "rollup",
          partial: false,
          reportedVerdict: null,
          effectiveVerdict: rollupFindings.some(
            (finding) =>
              finding.status === "unfixed" && (finding.priority === "P0" || finding.priority === "P1")
          )
            ? "block"
            : "ship",
          summary: "Workflow review rollup",
          findings: rollupFindings,
          artifactPath: lastArtifact,
        })
      );
      rollupEmitted = true;
    }

    // PHASE 3: Wrap up
    transitionToComplete();

    // Construct the final report
    const hasWarnings = taskResults.some((task) => task.executionCode !== 0 || task.reviewCode !== 0 || task.validationError);

    emitTrace(ctx, "completion", {
      status: hasWarnings ? "warning" : "success",
      tasksCount: tasks.length,
    });

    return {
      summary: appendPersistedLogPathToSummary(buildSummaryReport(goal, taskResults, tasks), persistedLogState.filePath),
      meta: buildCcReviewSummaryMeta(taskResults),
    };
  } catch (err: any) {
    emitTrace(ctx, "failure", { error: err.message });
    const isTimeout = /timeout/i.test(err.message || "");
    const isCancelled =
      signal?.aborted ||
      err.message?.includes("aborted") ||
      err.message?.includes("timeout") ||
      err.message?.includes("cancel");

    if (!rollupEmitted && isExecutionGateHaltError(err.message || "")) {
      const rollupFindings = mergeRollupFindings(collectedTaskFindings);
      const lastArtifact =
        taskResults[taskResults.length - 1]?.artifactPath ??
        path.join(workflowCwd, WORKFLOW_ARTIFACT_DIR, workflowRunId);
      await emitFindingsMessage(
        buildFindingsPayload({
          kind: "rollup",
          partial: true,
          reportedVerdict: null,
          effectiveVerdict: "ship_with_warnings",
          summary: "Partial workflow review rollup",
          findings: rollupFindings,
          artifactPath: lastArtifact,
        })
      );
      rollupEmitted = true;
    }
    if (!rollupEmitted && isCancelled && reviewedTaskCount > 0) {
      const rollupFindings = mergeRollupFindings(collectedTaskFindings);
      const lastArtifact =
        taskResults[taskResults.length - 1]?.artifactPath ??
        path.join(workflowCwd, WORKFLOW_ARTIFACT_DIR, workflowRunId);
      await emitFindingsMessage(
        buildFindingsPayload({
          kind: "rollup",
          partial: true,
          reportedVerdict: null,
          effectiveVerdict: "ship_with_warnings",
          summary: "Partial workflow review rollup after cancellation",
          findings: rollupFindings,
          artifactPath: lastArtifact,
        })
      );
      rollupEmitted = true;
    }

    if (err instanceof WorkflowError) {
      throw err;
    }

    // Mark the currently executing/reviewing task as cancelled if it was interrupted
    if (isCancelled) {
      displayState = isTimeout ? "timeout" : "cancelled";
    }
    if (isCancelled && currentTaskIndex >= 0 && currentTaskIndex < tasks.length) {
      if (taskResults.length === currentTaskIndex) {
        taskResults.push({
          title: tasks[currentTaskIndex].title,
          description: tasks[currentTaskIndex].description,
          executionCode: -1,
          reviewCode: -1,
          status: "cancelled",
        });
      }
    }

    const summary = appendPersistedLogPathToSummary(
      buildSummaryReport(goal, taskResults, tasks),
      persistedLogState.filePath
    );
    throw new WorkflowError(err.message, summary);
  } finally {
    // Clean up temporary files
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }

    // Remove event listener on abort
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }

    // Clear UI widgets and status
    ctx?.ui?.setWidget?.("cc-review-widget", undefined);
    ctx?.ui?.setStatus?.("cc-review-status", undefined);
  }
}
