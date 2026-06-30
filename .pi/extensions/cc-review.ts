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
  extractBalancedJsonObject,
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
} from "./cc-review/structured.ts";

export {
  buildFindingsPayload,
  deriveEffectiveVerdict,
  emptyFindingsRollup,
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
} from "./cc-review/structured.ts";

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
    logSources: {
      type: "string",
      description: "Optional comma-separated list of compact-surface log sources to keep (planner, subagent, reviewer, cc-review). Omit to use CC_REVIEW_LOG_SOURCES or show all.",
    },
    reviewMode: {
      type: "string",
      description: "Optional review timing. Supported values: per-task or after-all. Omit to use CC_REVIEW_MODE or the default after-all mode.",
    },
    reviewRepairRounds: {
      type: "integer",
      minimum: 0,
      description: "Optional number of repair/re-review rounds after an initial block. 0 disables re-review. Omit to use CC_REVIEW_MAX_REPAIR_ROUNDS or the default 0.",
    },
    taskTimeoutMs: {
      type: "number",
      description: "Optional per-attempt subagent execution timeout in milliseconds. 0 disables the timeout. Omit to use CC_REVIEW_TASK_TIMEOUT_MS or the default 1800000 (30 min).",
    },
    widgetLogLines: {
      type: "number",
      description: "Optional log tail length for compact widget and onUpdate delta stream. Omit to use CC_REVIEW_WIDGET_LOG_LINES or the default 5.",
    },
    checklistWindow: {
      type: "number",
      description: "Optional task checklist window size for the compact widget. Omit to use CC_REVIEW_CHECKLIST_WINDOW or the default 8.",
    },
  },
  required: ["goal"],
  additionalProperties: false,
};

interface CcReviewExecuteParams {
  goal: string;
  reviewProvider?: string;
  logLevel?: string;
  logSources?: string;
  reviewMode?: string;
  reviewRepairRounds?: number;
  taskTimeoutMs?: number;
  widgetLogLines?: number;
  checklistWindow?: number;
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
  /** When set, caps each rendered line (prefix + message) to this visible budget. */
  maxLineWidth?: number;
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

export function inferSubprocessStreamSeverity(
  line: string,
  stream: "stdout" | "stderr" = "stderr"
): CcReviewLogSeverity {
  const normalized = stripAnsi(line).trim().toLowerCase();
  if (!normalized) return "info";

  if (
    /\b(fatal|panic|segfault|uncaught exception)\b/.test(normalized) ||
    /\berror:\s/.test(normalized) ||
    /^error\b/.test(normalized) ||
    /\b(exit(?:ed)? with code|exit code) [1-9]\d*/.test(normalized)
  ) {
    return "error";
  }

  if (/\bfailed\b/.test(normalized) && !/\bsucceeded\b/.test(normalized)) {
    return "error";
  }

  if (/\b(warn(?:ing)?|retrying|timed?\s*out|transient|rate[-\s]+limit(?:ed)?)\b/.test(normalized)) {
    return "warning";
  }

  return "info";
}

function clipSubprocessLogText(text: string, maxLength = 120): string {
  const cleaned = stripAnsi(text).replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  if (maxLength <= 1) return cleaned.slice(0, maxLength);
  return `${cleaned.slice(0, maxLength - 1)}…`;
}

function looksLikeJsonFragment(line: string): boolean {
  if (/^[\{\}\[\]],?\s*$/.test(line)) return true;
  if (/^"[^"]+"\s*:/.test(line)) return true;
  if (/^"(tasks|title|description|verdict|findings|summary|acceptanceCriteria|postFixValidation)"/.test(line)) {
    return true;
  }
  return false;
}

function structuredTextPreview(value: unknown, maxLength = 100): string {
  return typeof value === "string" ? clipSubprocessLogText(value, maxLength) : "";
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const args = input as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "pattern", "query", "url"]) {
    const preview = structuredTextPreview(args[key], 80);
    if (preview) return preview;
  }
  return "";
}

function summarizeCodexItem(eventType: string, item: Record<string, unknown>): string | null {
  const itemType = typeof item.type === "string" ? item.type : "item";
  const isStarted = eventType === "item.started";
  const isCompleted = eventType === "item.completed";
  const status = typeof item.status === "string" ? item.status : "";

  if (itemType === "reasoning") {
    const text = structuredTextPreview(item.text, 110);
    return text ? `Thinking: ${text}` : null;
  }

  if (itemType === "agent_message") {
    if (typeof item.text !== "string" || !item.text.trim()) return null;
    const nestedSummary = formatSubprocessStreamLine(item.text);
    if (nestedSummary && nestedSummary !== item.text.trim()) return nestedSummary;
    if (nestedSummary === null && /^[\[{]/.test(item.text.trim())) return null;
    return `Assistant: ${structuredTextPreview(item.text, 120)}`;
  }

  if (itemType === "command_execution") {
    const command = structuredTextPreview(item.command, 90) || "command";
    if (isStarted || status === "in_progress") return `Running command: ${command}`;
    const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
    if (exitCode !== undefined && exitCode !== 0) return `Command failed (exit ${exitCode}): ${command}`;
    return `Command completed: ${command}`;
  }

  if (itemType === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths = changes
      .map((change) =>
        change && typeof change === "object"
          ? structuredTextPreview((change as Record<string, unknown>).path, 50)
          : ""
      )
      .filter(Boolean);
    const preview = paths.slice(0, 3).join(", ");
    const suffix = paths.length > 3 ? ` (+${paths.length - 3} more)` : "";
    if (isStarted) return preview ? `Applying changes: ${preview}${suffix}` : "Applying file changes";
    return preview ? `Updated ${paths.length} file${paths.length === 1 ? "" : "s"}: ${preview}${suffix}` : "File changes applied";
  }

  if (itemType === "mcp_tool_call") {
    const tool =
      structuredTextPreview(item.tool, 60) ||
      structuredTextPreview(item.name, 60) ||
      "tool";
    const hint = summarizeToolInput(item.arguments ?? item.input);
    const action = isCompleted ? "Tool completed" : "Using tool";
    return hint ? `${action}: ${tool} — ${hint}` : `${action}: ${tool}`;
  }

  if (itemType === "web_search") {
    const query = structuredTextPreview(item.query, 90);
    return query ? `Searching the web: ${query}` : "Searching the web";
  }

  if (itemType === "todo_list") {
    const items = Array.isArray(item.items) ? item.items : [];
    const completed = items.filter(
      (todo) => todo && typeof todo === "object" && (todo as Record<string, unknown>).completed === true
    ).length;
    return `Plan updated: ${completed}/${items.length} completed`;
  }

  return null;
}

function summarizeStructuredSubprocessPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;

  if (obj.type === "workflow_trace" || obj.type === "cc_review_log_rotation") {
    return null;
  }

  if (Array.isArray(obj.tasks)) {
    const titles = obj.tasks
      .map((task) =>
        task && typeof task === "object" && typeof (task as { title?: unknown }).title === "string"
          ? (task as { title: string }).title
          : ""
      )
      .filter(Boolean);
    const preview = titles.slice(0, 3).join("; ");
    const suffix = titles.length > 3 ? ` (+${titles.length - 3} more)` : "";
    return `Planned ${titles.length} task${titles.length === 1 ? "" : "s"}: ${preview}${suffix}`;
  }

  if (typeof obj.verdict === "string") {
    const summary = typeof obj.summary === "string" ? clipSubprocessLogText(obj.summary, 80) : "";
    const findings = Array.isArray(obj.findings) ? obj.findings : [];
    const unfixed = findings.filter(
      (finding) =>
        finding &&
        typeof finding === "object" &&
        (finding as { status?: unknown }).status === "unfixed"
    ).length;
    const parts = [`Review: ${obj.verdict}`];
    if (summary) parts.push(summary);
    if (findings.length > 0) {
      parts.push(`${findings.length} finding${findings.length === 1 ? "" : "s"} (${unfixed} unfixed)`);
    }
    return parts.join(" — ");
  }

  if (typeof obj.type === "string") {
    // Codex `exec --json` lifecycle. Session bookkeeping is intentionally
    // hidden; work items are translated into concrete, scan-friendly actions.
    if (obj.type === "thread.started" || obj.type === "turn.started") return null;
    if (obj.type === "turn.completed") return "Codex turn completed";
    if (obj.type === "turn.failed") {
      const error =
        structuredTextPreview((obj.error as Record<string, unknown> | undefined)?.message, 100) ||
        structuredTextPreview(obj.message, 100);
      return error ? `Codex turn failed: ${error}` : "Codex turn failed";
    }
    if (
      (obj.type === "item.started" || obj.type === "item.updated" || obj.type === "item.completed") &&
      obj.item &&
      typeof obj.item === "object"
    ) {
      return summarizeCodexItem(obj.type, obj.item as Record<string, unknown>);
    }

    // Claude Code `--output-format stream-json` lifecycle.
    if (obj.type === "system" || obj.type === "user" || obj.type === "stream_event") return null;
    if (obj.type === "assistant") {
      const message = obj.message && typeof obj.message === "object"
        ? obj.message as Record<string, unknown>
        : undefined;
      const content = Array.isArray(message?.content) ? message.content : [];
      const summaries: string[] = [];
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const contentPart = part as Record<string, unknown>;
        if (contentPart.type === "tool_use") {
          const name = structuredTextPreview(contentPart.name, 60) || "tool";
          const hint = summarizeToolInput(contentPart.input);
          summaries.push(hint ? `Using tool: ${name} — ${hint}` : `Using tool: ${name}`);
        } else if (contentPart.type === "text") {
          if (typeof contentPart.text !== "string" || !contentPart.text.trim()) continue;
          const nestedSummary = formatSubprocessStreamLine(contentPart.text);
          if (nestedSummary && nestedSummary !== contentPart.text.trim()) summaries.push(nestedSummary);
          else if (!(nestedSummary === null && /^[\[{]/.test(contentPart.text.trim()))) {
            summaries.push(`Assistant: ${structuredTextPreview(contentPart.text, 120)}`);
          }
        }
      }
      return summaries.length > 0 ? summaries.slice(0, 2).join(" · ") : null;
    }
    if (obj.type === "result") {
      const failed = obj.is_error === true || obj.subtype === "error";
      const durationMs = typeof obj.duration_ms === "number" ? obj.duration_ms : undefined;
      const turns = typeof obj.num_turns === "number" ? obj.num_turns : undefined;
      const details = [
        durationMs !== undefined ? `${Math.max(0, durationMs / 1000).toFixed(1)}s` : "",
        turns !== undefined ? `${turns} turn${turns === 1 ? "" : "s"}` : "",
      ].filter(Boolean).join(", ");
      const resultText = structuredTextPreview(obj.result, 100);
      if (failed) return resultText ? `Claude failed: ${resultText}` : "Claude run failed";
      return `Claude run completed${details ? ` (${details})` : ""}`;
    }
    if (obj.type === "tool_progress") {
      const tool = structuredTextPreview(obj.tool_name ?? obj.name, 60) || "tool";
      return `${tool} is still running`;
    }
    if (obj.type === "rate_limit_event") return "Rate limited; waiting to retry";

    if (obj.type === "tool_call" || obj.type === "tool_use" || obj.type === "tool_execution_start") {
      const name =
        typeof obj.name === "string"
          ? obj.name
          : typeof obj.tool === "string"
            ? obj.tool
            : typeof obj.toolName === "string"
              ? obj.toolName
              : "tool";
      return `⚙ ${name}`;
    }
    if (obj.type === "message" || obj.type === "assistant" || obj.type === "stream_event" || obj.type === "message_end") {
      return null;
    }
  }

  if (typeof obj.command === "string") {
    return `exec ${clipSubprocessLogText(obj.command, 80)}`;
  }

  const error = structuredTextPreview(obj.error ?? obj.message, 110);
  return error ? `Provider message: ${error}` : null;
}

export function formatSubprocessStreamLine(rawLine: string): string | null {
  const line = stripAnsi(rawLine).trim();
  if (!line) return null;

  if (line.includes('"type":"workflow_trace"') || line.includes('"type": "workflow_trace"')) {
    return null;
  }

  if (line.startsWith("{") || line.startsWith("[")) {
    try {
      const parsed = JSON.parse(line);
      const summarized = summarizeStructuredSubprocessPayload(parsed);
      if (summarized !== null) return summarized;
      return null;
    } catch {
      // A provider JSON event should never leak to the human display merely
      // because it is malformed or belongs to a newer event schema.
      return null;
    }
  }

  if (looksLikeJsonFragment(line)) return null;

  return line;
}

export interface SubprocessStreamLogger {
  write(chunk: string | Buffer): void;
  flush(): void;
}

export function createSubprocessStreamLogger(
  logFn: (input: CcReviewLogInput) => void,
  stream: "stdout" | "stderr",
  source: "planner" | "reviewer"
): SubprocessStreamLogger {
  let remainder = "";
  const emitLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const message = formatSubprocessStreamLine(trimmed);
    if (message === null) return;
    logFn({
      severity: inferSubprocessStreamSeverity(message, stream),
      source,
      message,
    });
  };

  return {
    write(chunk: string | Buffer) {
      remainder += typeof chunk === "string" ? chunk : chunk.toString();
      let newlineIndex: number;
      while ((newlineIndex = remainder.indexOf("\n")) !== -1) {
        emitLine(remainder.slice(0, newlineIndex).replace(/\r$/, ""));
        remainder = remainder.slice(newlineIndex + 1);
      }
    },
    flush() {
      if (remainder) emitLine(remainder.replace(/\r$/, ""));
      remainder = "";
    },
  };
}

function extractCodexItemText(event: Record<string, unknown>): string {
  if (event.type !== "item.completed" || !event.item || typeof event.item !== "object") return "";
  const item = event.item as Record<string, unknown>;
  return item.type === "agent_message" && typeof item.text === "string" ? item.text : "";
}

// Extract the final assistant text from a claude `--output-format stream-json`
// NDJSON stream (see P0-3). When the output contains recognizable stream-json
// events (assistant message content or a final `result` event), the
// accumulated text is returned. When the output is plain text (e.g. from a
// test mock that does not emit stream-json), the original text is returned
// unchanged so callers keep working in both modes.
export function extractAssistantTextFromStream(stdout: string): string {
  if (!stdout) return stdout;
  const lines = stdout.split("\n");
  let hasStreamEvents = false;
  let finalText = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Only attempt JSON parsing on lines that look like JSON objects.
    if (!trimmed.startsWith("{")) continue;
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    // Claude stream-json: assistant message with content parts.
    if (event?.type === "assistant" && Array.isArray(event?.message?.content)) {
      hasStreamEvents = true;
      for (const part of event.message.content) {
        if (part?.type === "text" && typeof part.text === "string") {
          finalText += part.text;
        }
      }
    }
    // Claude stream-json: final result event overrides accumulated text.
    if (event?.type === "result" && typeof event?.result === "string") {
      hasStreamEvents = true;
      finalText = event.result;
    }
    // Codex --json: message events with text content (best-effort; shape varies
    // across versions, so we only match the common {type:"message",content:...}).
    if (event?.type === "message" && typeof event?.content === "string") {
      hasStreamEvents = true;
      finalText += event.content;
    }
    const codexItemText = extractCodexItemText(event);
    if (codexItemText) {
      hasStreamEvents = true;
      finalText += codexItemText;
    }
  }
  return hasStreamEvents && finalText ? finalText : stdout;
}

function isStderrChannelLabel(label: string): boolean {
  const normalizedLabel = label.trim().toLowerCase();
  return normalizedLabel.endsWith(" error") || normalizedLabel.endsWith(" failure");
}

function inferLegacyLogSeverity(label: string, message = ""): CcReviewLogSeverity {
  const normalizedLabel = label.trim().toLowerCase();
  if (normalizedLabel.includes("debug")) return "debug";
  if (isStderrChannelLabel(label)) {
    return inferSubprocessStreamSeverity(message, "stderr");
  }
  if (
    normalizedLabel.includes("failure") ||
    normalizedLabel.includes("failed") ||
    normalizedLabel.includes("halted")
  ) {
    return "error";
  }
  if (normalizedLabel.includes("error")) {
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
    severity: inferLegacyLogSeverity(label, message),
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

export function collapseConsecutiveLogEntries(
  entries: readonly CcReviewLogEntry[]
): CcReviewLogEntry[] {
  if (entries.length === 0) return [];
  const collapsed: CcReviewLogEntry[] = [];
  let currentGroup: CcReviewLogEntry[] = [entries[0]];

  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i];
    const prev = currentGroup[currentGroup.length - 1];
    const normPrev = normalizeRenderableLogMessage(prev.message);
    const normCurr = normalizeRenderableLogMessage(entry.message);

    if (normPrev === normCurr) {
      currentGroup.push(entry);
    } else {
      collapsed.push(mergeLogGroup(currentGroup));
      currentGroup = [entry];
    }
  }

  if (currentGroup.length > 0) {
    collapsed.push(mergeLogGroup(currentGroup));
  }

  return collapsed;
}

function mergeLogGroup(group: CcReviewLogEntry[]): CcReviewLogEntry {
  if (group.length === 1) return group[0];
  const lastEntry = group[group.length - 1];
  return {
    ...lastEntry,
    message: `${lastEntry.message} (x${group.length})`,
  };
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
  // Use visible column width (ANSI-aware, CJK-aware) rather than JS string
  // length so that wide characters in the icon or source label are counted
  // correctly.  This prevents the message portion from overflowing the terminal.
  const prefixVisibleWidth = measureVisibleWidth(prefix);
  const messageWrapWidth =
    options.maxLineWidth !== undefined
      ? Math.max(8, options.maxLineWidth - prefixVisibleWidth)
      : (options.maxMessageWidth ?? DEFAULT_LOG_MESSAGE_WRAP_WIDTH);
  const messageLines = wrapLogMessage(normalizeRenderableLogMessage(entry.message), messageWrapWidth);
  const continuationPrefix = " ".repeat(prefixVisibleWidth);

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
// resolveSubagentTaskTimeoutMs: pure resolver for the per-attempt subagent
// execution timeout. Previously this was hardcoded to 300000ms (5 min), which
// killed real coding subagent runs mid-flight (exitCode 143 / SIGTERM) and was
// the single most frequent failure in the trace (see P0-1).
//
// Precedence: explicit `flag` (tool param / slash flag `--task-timeout`)
//           > `env.CC_REVIEW_TASK_TIMEOUT_MS`
//           > default 1800000 (30 min).
//
// A value of 0 means "no timeout" — the timer is not installed at all. Invalid
// input (negative, NaN, non-numeric) falls back to the default so a typo never
// disables the safety net silently.
// ---------------------------------------------------------------------------
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
// the generator with the reviewer's findings as feedback, then re-reviews, up
// to this many rounds before hard-failing.
//
// Precedence: explicit `flag` (tool param / slash flag
// `--review-repair-rounds`) > `env.CC_REVIEW_MAX_REPAIR_ROUNDS` > default 0.
// Re-review is opt-in; the reviewer still fixes findings and validates within
// its initial review invocation.
// ---------------------------------------------------------------------------
export const DEFAULT_MAX_REVIEW_REPAIR_ROUNDS = 0;

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
// Heartbeat interval for subprocess progress logging (P0-3). Emits a "still
// running" log line at this cadence while any planner/reviewer subprocess is
// active, so the user can distinguish a working-but-slow run from a hang.
const SUBPROCESS_HEARTBEAT_MS = 30000;

// ANSI-naive width truncation with ellipsis. Sufficient because cc-review widget
// lines are plain text (we strip ANSI when normalizing log messages).
export function truncatePersistedLogPathForWidget(
  filePath: string,
  maxWidth: number = WIDGET_MAX_WIDTH_DEFAULT
): string {
  const width = Math.max(12, Math.floor(maxWidth));
  if (filePath.length <= width) return filePath;
  const base = path.basename(filePath);
  const ellipsis = "\u2026";
  const tailBudget = base.length + ellipsis.length;
  if (tailBudget >= width) {
    return truncateForWidget(base, width);
  }
  const headChars = width - tailBudget;
  return `${filePath.slice(0, headChars)}${ellipsis}${base}`;
}

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
  | "failed"
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
let visibleWidthFn: ((text: string) => number) | null | undefined;

function getVisibleWidth(): ((text: string) => number) | undefined {
  if (visibleWidthFn === undefined) {
    try {
      const piTui = require("@earendil-works/pi-tui");
      visibleWidthFn = typeof piTui?.visibleWidth === "function" ? piTui.visibleWidth : null;
    } catch {
      visibleWidthFn = null;
    }
  }
  return visibleWidthFn ?? undefined;
}

// ---------------------------------------------------------------------------
// Column-width primitives
// ---------------------------------------------------------------------------
// Terminal cells occupied by Unicode East-Asian Wide / Fullwidth characters.
// Sourced from Unicode EAW = W (Wide) or F (Fullwidth) classifications,
// with conservative ranges that cover CJK ideographs, Hangul, fullwidth ASCII,
// and common ideographic symbols.  This is the single source of truth used by
// all width-measuring and truncation functions below.

function charWidth(code: number): 1 | 2 {
  // Supplementary-plane characters (>U+FFFF, i.e. codepoints encoded as
  // surrogate pairs in UTF-16) are rendered 2 columns wide by virtually
  // every modern terminal.  This covers emoji, CJK Extension B–G, historic
  // scripts, and other wide symbols without needing an exhaustive range
  // table that would inevitably miss new Unicode additions.
  if (code > 0xFFFF) return 2;
  // BMP East-Asian Wide / Fullwidth ranges.
  // Hangul Jamo
  if (code >= 0x1100 && code <= 0x115F) return 2;
  if (code === 0x2329 || code === 0x232A) return 2;
  // CJK Radicals, Kangxi, Ideographic Desc, CJK Symbols…
  if (code >= 0x2E80 && code <= 0x3247 && code !== 0x303F) return 2;
  // Enclosed CJK, CJK Compat Forms, CJK Ext A
  if (code >= 0x3250 && code <= 0x4DBF) return 2;
  // CJK Unified Ideographs, Yi
  if (code >= 0x4E00 && code <= 0xA4C6) return 2;
  // Hangul Jamo Extended-A
  if (code >= 0xA960 && code <= 0xA97C) return 2;
  // Hangul Syllables
  if (code >= 0xAC00 && code <= 0xD7A3) return 2;
  // CJK Compatibility Ideographs
  if (code >= 0xF900 && code <= 0xFAFF) return 2;
  // Vertical forms
  if (code >= 0xFE10 && code <= 0xFE19) return 2;
  // CJK Compatibility Forms
  if (code >= 0xFE30 && code <= 0xFE6B) return 2;
  // Fullwidth ASCII, Halfwidth Katakana range
  if (code >= 0xFF01 && code <= 0xFF60) return 2;
  // Fullwidth signs
  if (code >= 0xFFE0 && code <= 0xFFE6) return 2;
  return 1;
}

/** Count visible columns in a plain (ANSI-free) or ANSI-containing string. */
function countColumns(plain: string): number {
  let cols = 0;
  for (const cp of plain) {
    cols += charWidth(cp.codePointAt(0) ?? 0);
  }
  return cols;
}

/**
 * Truncate a *plain* (ANSI-free) string to at most `maxCols` visible columns,
 * appending an ellipsis when truncation occurs.  Returns the original if it
 * already fits.
 */
function truncatePlainByColumn(plain: string, maxCols: number): string {
  if (countColumns(plain) <= maxCols) return plain;
  const budget = Math.max(0, maxCols - 1); // −1 for ellipsis
  let cols = 0;
  let cut = 0;
  for (const cp of plain) {
    const w = charWidth(cp.codePointAt(0) ?? 0);
    if (cols + w > budget) break;
    cols += w;
    cut += cp.length; // handles surrogate pairs correctly
  }
  return plain.slice(0, cut) + "\u2026";
}

/**
 * Truncate a string that may contain ANSI escape codes while preserving them.
 * Uses `measureVisibleWidth` for the width check (ANSI-aware when pi-tui is
 * available) and walks the raw string code-point by code-point, accumulating
 * visible column cost only for the printable portion, so ANSI sequences are
 * carried through transparently.
 */
function truncateAnsiByColumn(text: string, maxCols: number): string {
  if (measureVisibleWidth(text) <= maxCols) return text;
  const budget = Math.max(0, maxCols - 1);
  let cols = 0;
  let cut = 0;
  let inEscape = false;
  // Walk the string as an array of code-point strings so `.length` is
  // always 1 or 2 (surrogate pair), never slicing mid-codepoint.
  const chars = Array.from(text);
  for (const ch of chars) {
    if (inEscape) {
      cut += ch.length;
      if (ch === "m") inEscape = false;
      continue;
    }
    if (ch === "\x1b") {
      inEscape = true;
      cut += ch.length;
      continue;
    }
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (cols + w > budget) break;
    cols += w;
    cut += ch.length;
  }
  return text.slice(0, cut) + "\u2026";
}

// ---------------------------------------------------------------------------
// pi-tui integration
// ---------------------------------------------------------------------------

// Measure visible (column) width of a string, ANSI-aware when pi-tui is available.
// Falls back to our CJK-aware column counter in headless / test environments.
export function measureVisibleWidth(text: string): number {
  const vw = getVisibleWidth();
  if (vw) return vw(text);
  return countColumns(stripAnsi(text));
}

// Build a visibleWidth-aware truncation function when pi-tui is available but
// does not export truncateToWidth.  The returned function is ANSI-preserving.
function buildVisibleWidthTruncate(
  vw: (text: string) => number
): (text: string, maxWidth: number) => string {
  return (text: string, maxWidth: number): string => {
    if (vw(text) <= maxWidth) return text;
    // When pi-tui's visibleWidth signals overflow but pi-tui has no native
    // truncator, fall back to our ANSI-safe column truncation using the same
    // CJK-width table as `countColumns`.  The fallback cannot guarantee
    // absolute consistency with pi-tui's width model for exotic emoji /
    // grapheme clusters, but it handles the dominant crash case (CJK-heavy
    // log lines) safely and preserves ANSI colour codes.
    return truncateAnsiByColumn(text, maxWidth);
  };
}

function getTruncateToWidth(): ((text: string, width: number) => string) | undefined {
  if (truncateToWidthFn === undefined) {
    try {
      const piTui = require("@earendil-works/pi-tui");
      if (typeof piTui?.truncateToWidth === "function") {
        truncateToWidthFn = piTui.truncateToWidth;
      } else if (typeof piTui?.visibleWidth === "function") {
        truncateToWidthFn = buildVisibleWidthTruncate(piTui.visibleWidth);
      } else {
        truncateToWidthFn = null;
      }
    } catch {
      truncateToWidthFn = null;
    }
  }
  return truncateToWidthFn ?? undefined;
}

// Width-safe truncation for widget lines.  Uses pi-tui's truncateToWidth when
// available (ANSI-aware); falls back to a CJK-aware column truncation for
// headless / test environments.  The fallback operates on ANSI-stripped text
// because headless renderers do not emit colour codes.
export function truncateWidgetLine(text: string, maxWidth: number = WIDGET_MAX_WIDTH_DEFAULT): string {
  const width = Math.max(8, Math.floor(maxWidth));
  const trunc = getTruncateToWidth();
  if (trunc) return trunc(text, width);
  // Headless / test fallback: strip ANSI and truncate by columns.
  return truncatePlainByColumn(stripAnsi(text), width);
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
  resolvedLogSources?: string[];
  resolvedWidgetLogLines?: number;
  resolvedChecklistWindow?: number;
  persistedLogPath: string;
  findingsRollup: CcReviewFindingsRollup;
  taskStatuses?: readonly (TaskStatus | undefined)[];
}

export interface TaskVisuals {
  marker: string;
  markerColor: string;
  titleColor: string;
}

export function getTaskVisuals(status: TaskStatus | "running" | "pending"): TaskVisuals {
  switch (status) {
    case "completed":
      return {
        marker: "\u2714", // ✔
        markerColor: "success",
        titleColor: "dim",
      };
    case "completed_with_warnings":
      return {
        marker: "\u26a0", // ⚠️
        markerColor: "warning",
        titleColor: "warning",
      };
    case "failed":
      return {
        marker: "\u2718", // ✘
        markerColor: "error",
        titleColor: "error",
      };
    case "validation_failed":
      return {
        marker: "\u2716", // ✖
        markerColor: "error",
        titleColor: "error",
      };
    case "review_blocked":
      return {
        marker: "\u26d4", // ⛔
        markerColor: "error",
        titleColor: "error",
      };
    case "skipped":
      return {
        marker: "\u21aa", // ↪
        markerColor: "muted",
        titleColor: "dim",
      };
    case "cancelled":
      return {
        marker: "\u2298", // ⊘
        markerColor: "muted",
        titleColor: "dim",
      };
    case "running":
      return {
        marker: "\u25b8", // ▸
        markerColor: "accent",
        titleColor: "text",
      };
    case "pending":
    default:
      return {
        marker: "\u2610", // ☐
        markerColor: "dim",
        titleColor: "muted",
      };
  }
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
  const isCompact = width < 50;

  // 1. Goal Line
  if (isCompact) {
    lines.push(
      truncateWidgetLine(
        `${theme.fg("accent", "\ud83c\udfaf")} ${theme.fg("muted", previewWidgetText(state.goal, width - 4))}`,
        width
      )
    );
  } else {
    lines.push(
      truncateWidgetLine(
        `${theme.fg("accent", "\ud83c\udfaf")} ${theme.fg("text", "Goal:")} ${theme.fg("muted", previewWidgetText(state.goal))}`,
        width
      )
    );
  }

  // 2. Decorative Divider
  if (!isCompact) {
    lines.push(truncateWidgetLine(theme.fg("borderMuted", "\u2501".repeat(Math.min(50, width))), width));
  }

  // 3. Tasks List
  if (state.tasks.length === 0) {
    const waiting =
      state.displayState === "planning"
        ? theme.fg("warning", "  \u2699 Planning tasks\u2026")
        : theme.fg("dim", "  \u23f3 Waiting for planner output\u2026");
    lines.push(truncateWidgetLine(waiting, width));
  } else {
    const checklistWindowSize = isCompact ? 1 : (state.resolvedChecklistWindow ?? WIDGET_CHECKLIST_WINDOW);
    const window = computeChecklistWindow(
      state.tasks.length,
      state.currentTaskIndex,
      checklistWindowSize
    );
    if (!isCompact && window.hiddenBefore > 0) {
      lines.push(
        truncateWidgetLine(
          theme.fg("dim", `  \u2026 ${window.hiddenBefore} earlier task${window.hiddenBefore === 1 ? "" : "s"}`),
          width
        )
      );
    }
    for (let i = window.startIndex; i < window.endIndex; i++) {
      const task = state.tasks[i];
      let status: TaskStatus | "running" | "pending";
      const explicitStatus = state.taskStatuses?.[i] ?? task.status;
      if (explicitStatus) {
        status = explicitStatus;
      } else if (i < state.currentTaskIndex) {
        status = "completed";
      } else if (i === state.currentTaskIndex) {
        status = "running";
      } else {
        status = "pending";
      }

      const visuals = getTaskVisuals(status);
      const marker = theme.fg(visuals.markerColor, visuals.marker);
      const titleColor = visuals.titleColor;

      const title = previewWidgetText(task.title, width - 16);
      const taskLabel = theme.fg("muted", `[Task ${i + 1}/${state.tasks.length}]`);
      const styledTitle = theme.fg(titleColor, title);
      lines.push(truncateWidgetLine(`  ${marker} ${taskLabel} ${styledTitle}`, width));
    }
    if (!isCompact && window.hiddenAfter > 0) {
      lines.push(
        truncateWidgetLine(
          theme.fg("dim", `  \u2026 ${window.hiddenAfter} later task${window.hiddenAfter === 1 ? "" : "s"}`),
          width
        )
      );
    }
  }

  // 4. Decorative Divider
  if (!isCompact) {
    lines.push(truncateWidgetLine(theme.fg("borderMuted", "\u2501".repeat(Math.min(50, width))), width));
  }

  // 5. Phase / Severity Status (Always display)
  lines.push(truncateWidgetLine(formatPhaseSeverityLine(state.currentPhase, state.liveLogs, { theme }), width));

  // 6. Findings (Skip in compact mode)
  if (!isCompact) {
    lines.push(truncateWidgetLine(theme.fg("muted", formatFindingsRollupLine(findingsRollup)), width));
  }

  // 7. Exceptional/Error indicators (Prioritized, always kept)
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
  } else if (state.displayState === "failed") {
    lines.push(truncateWidgetLine(theme.fg("error", "\u2716 Workflow failed"), width));
  }

  // 8. Live Logs Section Header (Skip in compact mode)
  if (!isCompact) {
    if (state.resolvedLogSources !== undefined) {
      const sourcesText = state.resolvedLogSources.length > 0 ? state.resolvedLogSources.join(", ") : "none";
      lines.push(
        truncateWidgetLine(
          theme.fg("text", `\ud83d\udcdd Live Logs (sources: ${sourcesText}):`),
          width
        )
      );
    } else {
      lines.push(truncateWidgetLine(theme.fg("text", "\ud83d\udcdd Live Logs:"), width));
    }
  }

  // 9. Live Logs Tail
  if (state.liveLogs.length === 0) {
    if (!isCompact) {
      lines.push(truncateWidgetLine(theme.fg("dim", "   (No logs yet \u2014 waiting for activity)"), width));
    }
  } else {
    const filteredLiveLogs = filterCcReviewLogEntries(state.liveLogs, {
      minSeverity: state.resolvedLogLevel,
      sources: state.resolvedLogSources,
    });
    const totalCount = state.liveLogs.filter(e => e).length;
    const hiddenCount = totalCount - filteredLiveLogs.length;

    const collapsed = collapseConsecutiveLogEntries(filteredLiveLogs);
    filteredLiveLogs.length = 0;
    filteredLiveLogs.push(...collapsed);
    const defaultTailLength = isCompact ? 3 : 5;
    const tailLength = state.resolvedWidgetLogLines ?? defaultTailLength;
    const recentLogs = tailLength > 0 ? filteredLiveLogs.slice(-tailLength) : [];
    for (const entry of recentLogs) {
      // In compact mode, we omit timestamps and source tags to conserve narrow columns
      const rendered = isCompact
        ? renderCcReviewLogEntry(entry, { maxLineWidth: width - 3, includeTimestamp: false, includeSource: false })
        : renderCcReviewLogEntry(entry, { maxLineWidth: width - 3 });
      const color = severityThemeColor(entry.severity);
      for (const line of rendered) {
        // Defensively truncate the plain-text line before wrapping it in
        // ANSI codes and the 3-space indent.  renderCcReviewLogEntry uses
        // measureVisibleWidth for its wrap budget, but we guard here too in
        // case a single token (e.g. a URL or JSON blob) exceeds the budget.
        const safeLine = truncateWidgetLine(line, width - 3);
        lines.push(truncateWidgetLine(`   ${theme.fg(color, safeLine)}`, width));
      }
    }
    if (hiddenCount > 0) {
      const hintText = `${hiddenCount} log${hiddenCount === 1 ? "" : "s"} hidden`;
      const lineText = `   (${hintText})`;
      lines.push(truncateWidgetLine(theme.fg("dim", lineText), width));
    }
  }

  // 10. Persisted log path (Skip in compact mode)
  if (!isCompact) {
    lines.push(
      truncateWidgetLine(
        `${theme.fg("muted", "\ud83d\udcc4 Full log:")} ${theme.fg(
          "dim",
          truncatePersistedLogPathForWidget(state.persistedLogPath, Math.max(12, width - 14))
        )}`,
        width
      )
    );
  }
  return lines;
}

export interface CcReviewStatusState {
  tasks: readonly unknown[];
  currentTaskIndex: number;
  displayState: CcReviewDisplayState;
  retryState?: { attempt: number; maxAttempts: number };
  currentPhase?: string;
}

export function getStatusColorForDisplayState(displayState: CcReviewDisplayState): "accent" | "success" | "warning" | "error" {
  switch (displayState) {
    case "initializing":
    case "planning":
    case "executing":
    case "reviewing":
      return "accent";
    case "complete":
      return "success";
    case "retrying":
    case "warning":
      return "warning";
    case "cancelled":
    case "timeout":
    case "failed":
      return "error";
    default:
      return "accent";
  }
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
    else if (state.displayState === "failed") body += " Failed";
    else if (state.displayState === "cancelled") body += " Cancelled";
    else if (state.displayState === "timeout") body += " Timeout";
  } else {
    if (state.displayState === "cancelled") {
      body = "Cancelled";
    } else if (state.displayState === "timeout") {
      body = "Timeout";
    } else if (state.displayState === "failed") {
      body = "Failed";
    } else {
      body = state.currentPhase ?? "Running";
    }
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
type ReviewMode = "per-task" | "after-all";
type ReviewModeSource = "reviewMode" | "CC_REVIEW_MODE";

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
    // Stream JSONL events to stdout for live observability (P0-3). Without
    // this, codex buffers all output and the user sees nothing for the entire
    // review duration. The final text is recovered from the stream via
    // extractAssistantTextFromStream.
    "--json",
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
    // Stream NDJSON events to stdout for live observability (P0-3). Without
    // this, `claude -p` buffers all output and flushes only at the end, so
    // the user sees nothing for the entire review duration. The final text is
    // recovered from the stream via extractAssistantTextFromStream.
    "--output-format", "stream-json",
    "--verbose",
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

function normalizeReviewMode(rawMode: string, source: ReviewModeSource): ReviewMode {
  const normalized = rawMode.trim().toLowerCase();
  if (normalized === "per-task" || normalized === "after-all") {
    return normalized;
  }
  throw new Error(
    `Invalid ${source} value "${rawMode}". Supported review modes: per-task, after-all.`
  );
}

export function resolveReviewMode(
  explicitMode?: string,
  env: NodeJS.ProcessEnv = process.env
): ReviewMode {
  const source: ReviewModeSource = explicitMode !== undefined ? "reviewMode" : "CC_REVIEW_MODE";
  const rawMode = explicitMode !== undefined ? explicitMode : env.CC_REVIEW_MODE;
  return rawMode === undefined ? "after-all" : normalizeReviewMode(rawMode, source);
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

interface BatchTaskExecution {
  taskIndex: number;
  task: Task;
  startedAt: string;
  subagentResult: SubagentResult;
  subagentOutputText: string;
  cachedSubagentResult: SubagentToolResult;
  validationError?: string;
  unresolvedItems?: string[];
  structuredReport: SubagentStructuredReport | null;
  schemaParseStatus: SchemaParseStatus;
  result: TaskResult;
}

class WorkflowError extends Error {
  summary: string;
  meta?: CcReviewSummaryMeta;
  constructor(message: string, summary: string, meta?: CcReviewSummaryMeta) {
    super(message);
    this.name = "WorkflowError";
    this.summary = summary;
    this.meta = meta;
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
  logSources?: string;
  reviewMode?: string;
  reviewRepairRounds?: number;
  taskTimeoutMs?: number;
  widgetLogLines?: number;
  checklistWindow?: number;
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
      const content = (message?.details ?? {}) as CcReviewFindingsPayload;
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
      const meta = message?.details as CcReviewSummaryMeta | undefined;

      let badge: CcReviewSummaryBadge;
      if (meta && meta.taskOutcomes) {
        const outcomes = meta.taskOutcomes;
        if ((outcomes.cancelled ?? 0) > 0) {
          badge = "cancelled";
        } else if ((outcomes.failed ?? 0) > 0 || (outcomes.review_blocked ?? 0) > 0) {
          badge = "failed";
        } else if ((outcomes.warning ?? 0) > 0) {
          badge = "warning";
        } else if ((outcomes.completed ?? 0) > 0) {
          badge = "success";
        } else {
          badge = classifyCcReviewSummary(content);
        }
      } else {
        badge = classifyCcReviewSummary(content);
      }

      const palette = BADGE_PALETTE[badge];
      const prefix = theme.fg(palette.color, `[CC Review ${palette.label}]`);

      let headline = "";
      if (meta && meta.taskOutcomes) {
        const completed = meta.taskOutcomes.completed ?? 0;
        const warnings = meta.taskOutcomes.warning ?? 0;
        const failed = (meta.taskOutcomes.failed ?? 0) + (meta.taskOutcomes.review_blocked ?? 0);
        const total = completed + warnings + failed + (meta.taskOutcomes.cancelled ?? 0);
        const counts = { completed, warnings, failed, total };
        const rawHeadline = formatCcReviewSummaryHeadline(counts);
        headline = truncateForWidget(rawHeadline, 120);
      } else {
        headline = extractCcReviewSummaryHeadline(content);
      }

      if (!expanded && meta?.topBlockers?.length) {
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
    description: "Run CC Review to plan, execute via Pi subagents, and review either per task or once after all tasks. Use --review-mode per-task|after-all to select review timing; when omitted, set CC_REVIEW_MODE or fall back to after-all. Use --review-repair-rounds <n> to opt into repair/re-review rounds (default 0; CC_REVIEW_MAX_REPAIR_ROUNDS fallback). Use --provider claude or --provider codex to select the planner+reviewer backend; when omitted, set CC_REVIEW_PROVIDER or fall back to codex. Use --log-level <debug|info|warning|error> and --log-sources <planner,subagent,reviewer,cc-review> (or their CC_REVIEW_LOG_LEVEL / CC_REVIEW_LOG_SOURCES env fallbacks) to filter compact surfaces. Use --task-timeout <ms> (or the CC_REVIEW_TASK_TIMEOUT_MS env fallback; default 1800000, 0 disables) to configure the per-attempt subagent execution timeout.",
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
          logSources: parsedArgs.logSources,
          reviewMode: parsedArgs.reviewMode,
          reviewRepairRounds: parsedArgs.reviewRepairRounds,
          taskTimeoutMs: parsedArgs.taskTimeoutMs,
          widgetLogLines: parsedArgs.widgetLogLines,
          checklistWindow: parsedArgs.checklistWindow,
        });
        ctx?.ui?.notify?.("CC Review completed.", "info");
        
        // Output the final summary to the main session
        await pi.sendMessage?.({
          customType: "cc-review-summary",
          content: workflowResult.summary,
          details: workflowResult.meta,
          display: true,
        });
      } catch (err: any) {
        ctx?.ui?.notify?.(`CC Review failed: ${err.message}`, "error");
        if (err instanceof WorkflowError || err.summary) {
          await pi.sendMessage?.({
            customType: "cc-review-summary",
            content: err.summary,
            details: err.meta,
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
    description: "Run CC Review: plan a goal, execute tasks sequentially, then review/fix either per task or once after all tasks. Pass reviewMode as per-task or after-all, or omit it to use CC_REVIEW_MODE / the after-all default. Pass reviewRepairRounds as a non-negative integer to opt into repair/re-review rounds, or omit it to use CC_REVIEW_MAX_REPAIR_ROUNDS / the default 0. Pass reviewProvider as codex or claude, or omit it to use CC_REVIEW_PROVIDER / the codex default. Pass logLevel as debug|info|warning|error and logSources as a comma-separated planner,subagent,reviewer,cc-review allow-list, or omit them to use CC_REVIEW_LOG_LEVEL / CC_REVIEW_LOG_SOURCES. Pass taskTimeoutMs as a non-negative number of milliseconds (0 disables), or omit it to use CC_REVIEW_TASK_TIMEOUT_MS / the 1800000 (30 min) default.",
    parameters: CcReviewParams,
    async execute(_toolCallId: string, params: CcReviewExecuteParams, signal?: AbortSignal, onUpdate?: (update: any) => void, ctx?: any) {
      const renderDetails = {
        goal: params.goal,
        reviewProvider: (params.reviewProvider ?? process.env.CC_REVIEW_PROVIDER ?? "codex").trim().toLowerCase() || "codex",
        reviewMode: (params.reviewMode ?? process.env.CC_REVIEW_MODE ?? "after-all").trim().toLowerCase() || "after-all",
      };
      const renderUpdate = onUpdate
        ? (update: any) => onUpdate({ ...update, details: { ...renderDetails, ...update?.details } })
        : undefined;
      renderUpdate?.({ content: [{ type: "text", text: "Starting CC Review..." }] });

      try {
        const workflowResult = await runCcReviewWorkflow(pi, params.goal, ctx, renderUpdate, signal, {
          reviewProvider: params.reviewProvider,
          logLevel: params.logLevel,
          logSources: params.logSources,
          reviewMode: params.reviewMode,
          reviewRepairRounds: params.reviewRepairRounds,
          taskTimeoutMs: params.taskTimeoutMs,
          widgetLogLines: params.widgetLogLines,
          checklistWindow: params.checklistWindow,
        });
        return {
          content: [{ type: "text", text: workflowResult.summary }],
          details: { ...renderDetails, status: "completed", meta: workflowResult.meta },
        };
      } catch (err: any) {
        const summary = err.summary || `Workflow failed: ${err.message}`;
        return {
          content: [{ type: "text", text: summary }],
          details: { ...renderDetails, status: "failed", error: err.message, meta: err.meta },
          isError: true,
        };
      }
    },
    renderCall(args: any, theme: any, context: any) {
      let piTui: any;
      try {
        piTui = require("@earendil-works/pi-tui");
      } catch {
        return undefined;
      }
      const Text = piTui?.Text;
      if (!Text) return undefined;

      const goal = args?.goal || "";
      const goalPreview = previewWidgetText(goal, 40);
      const provider = args?.reviewProvider || "codex";
      const mode = args?.reviewMode || "after-all";

      let text = theme.fg("toolTitle", theme.bold("cc_review"));
      text += " " + theme.fg("muted", `"${goalPreview}"`);
      text += " " + theme.fg("dim", `[provider: ${provider}, mode: ${mode}]`);
      return new Text(text, 0, 0);
    },
    renderResult(result: any, options: any, theme: any) {
      let piTui: any;
      try {
        piTui = require("@earendil-works/pi-tui");
      } catch {
        return undefined;
      }
      const Text = piTui?.Text;
      if (!Text) return undefined;

      const { expanded, isPartial } = options || {};
      const details = result?.details;
      const goal = details?.goal || "";
      const goalPreview = previewWidgetText(goal, 40);
      const provider = details?.reviewProvider || "codex";
      const mode = details?.reviewMode || "after-all";

      if (isPartial) {
        let progressText = "Initializing...";
        if (result?.content) {
          for (let i = result.content.length - 1; i >= 0; i--) {
            const t = result.content[i]?.text;
            if (t && t.trim()) {
              const lines = t.trim().split("\n");
              const lastLine = lines[lines.length - 1].trim();
              if (lastLine) {
                progressText = lastLine;
                break;
              }
            }
          }
        }
        progressText = previewWidgetText(progressText, 60);

        let text = theme.fg("warning", "⟳ Running");
        text += " " + theme.fg("muted", ` "${goalPreview}"`);
        text += " " + theme.fg("dim", ` [provider: ${provider}, mode: ${mode}]`);
        text += " " + theme.fg("muted", ` | Progress: ${progressText}`);
        return new Text(text, 0, 0);
      }

      // Finished execution
      const isError = !!result?.isError;
      const errorMsg = details?.error || "";

      let statusText = "Success";
      let statusColor = "success";
      let statusIcon = "✓";

      if (isError) {
        if (/cancel|abort/i.test(errorMsg)) {
          statusText = "Cancelled";
          statusColor = "error";
          statusIcon = "🛑";
        } else {
          statusText = "Failed";
          statusColor = "error";
          statusIcon = "✖";
        }
      } else {
        // Check metadata for warnings/failures
        const meta = details?.meta as CcReviewSummaryMeta | undefined;
        if (meta && meta.taskOutcomes) {
          const outcomes = meta.taskOutcomes;
          if ((outcomes.cancelled ?? 0) > 0) {
            statusText = "Cancelled";
            statusColor = "error";
            statusIcon = "\ud83d\uded1";
          } else if ((outcomes.failed ?? 0) > 0 || (outcomes.review_blocked ?? 0) > 0) {
            statusText = "Failed";
            statusColor = "error";
            statusIcon = "✖";
          } else if ((outcomes.warning ?? 0) > 0) {
            statusText = "Warning";
            statusColor = "warning";
            statusIcon = "⚠";
          }
        } else {
          // Fallback to regex badge classification
          const contentText = result?.content?.[0]?.text || "";
          const badge = classifyCcReviewSummary(contentText);
          if (badge === "failed") {
            statusText = "Failed";
            statusColor = "error";
            statusIcon = "✖";
          } else if (badge === "warning") {
            statusText = "Warning";
            statusColor = "warning";
            statusIcon = "⚠";
          } else if (badge === "cancelled") {
            statusText = "Cancelled";
            statusColor = "error";
            statusIcon = "🛑";
          }
        }
      }

      let text = `${theme.fg(statusColor, `${statusIcon} ${statusText}`)}`;
      text += " " + theme.fg("muted", `"${goalPreview}"`);
      text += " " + theme.fg("dim", `[provider: ${provider}, mode: ${mode}]`);

      if (expanded) {
        const contentText = result?.content?.[0]?.text || "";
        if (contentText) {
          text += "\n" + contentText;
        }
      }

      return new Text(text, 0, 0);
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

export function parseCcReviewCommandArgs(args: string): { goal: string; reviewProvider?: string; logLevel?: string; logSources?: string; reviewMode?: string; reviewRepairRounds?: number; taskTimeoutMs?: number; widgetLogLines?: number; checklistWindow?: number; error?: string } {
  const hasProviderFlag = /(?:^|\s)--(?:review-)?provider(?:=|\s|$)/.test(args);
  const hasLogLevelFlag = /(?:^|\s)--log-level(?:=|\s|$)/.test(args);
  const hasLogSourcesFlag = /(?:^|\s)--log-sources(?:=|\s|$)/.test(args);
  const hasReviewModeFlag = /(?:^|\s)--review-mode(?:=|\s|$)/.test(args);
  const hasReviewRepairRoundsFlag = /(?:^|\s)--review-repair-rounds(?:=|\s|$)/.test(args);
  const hasTaskTimeoutFlag = /(?:^|\s)--task-timeout(?:=|\s|$)/.test(args);
  const hasWidgetLogLinesFlag = /(?:^|\s)--widget-log-lines(?:=|\s|$)/.test(args);
  const hasChecklistWindowFlag = /(?:^|\s)--checklist-window(?:=|\s|$)/.test(args);
  if (!hasProviderFlag && !hasLogLevelFlag && !hasLogSourcesFlag && !hasReviewModeFlag && !hasReviewRepairRoundsFlag && !hasTaskTimeoutFlag && !hasWidgetLogLinesFlag && !hasChecklistWindowFlag) {
    return { goal: args.trim() };
  }

  const tokens = splitCommandLine(args);
  const goalTokens: string[] = [];
  let reviewProvider: string | undefined;
  let logLevel: string | undefined;
  let logSources: string | undefined;
  let reviewMode: string | undefined;
  let reviewRepairRounds: number | undefined;
  let taskTimeoutMs: number | undefined;
  let widgetLogLines: number | undefined;
  let checklistWindow: number | undefined;

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

    const equalsLogSourcesMatch = token.match(/^--log-sources=(.*)$/);
    if (equalsLogSourcesMatch) {
      logSources = equalsLogSourcesMatch[1];
      continue;
    }

    if (token === "--log-sources") {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        logSources = "";
      } else {
        logSources = value;
        i++;
      }
      continue;
    }

    const equalsReviewModeMatch = token.match(/^--review-mode=(.*)$/);
    if (equalsReviewModeMatch) {
      reviewMode = equalsReviewModeMatch[1];
      if (!reviewMode) {
        return { goal: "", error: "Invalid --review-mode value \"\". Supported review modes: per-task, after-all." };
      }
      continue;
    }

    if (token === "--review-mode") {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { goal: "", error: `Invalid ${token} value "${value ?? ""}". Supported review modes: per-task, after-all.` };
      }
      reviewMode = value;
      i++;
      continue;
    }

    const equalsReviewRepairRoundsMatch = token.match(/^--review-repair-rounds=(.*)$/);
    if (equalsReviewRepairRoundsMatch) {
      const raw = equalsReviewRepairRoundsMatch[1];
      const parsed = Number(raw);
      if (raw === "" || !Number.isInteger(parsed) || parsed < 0) {
        return { goal: "", error: `Invalid --review-repair-rounds value "${raw}". Expected a non-negative integer.` };
      }
      reviewRepairRounds = parsed;
      continue;
    }

    if (token === "--review-repair-rounds") {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { goal: "", error: `Invalid ${token} value "${value ?? ""}". Expected a non-negative integer.` };
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { goal: "", error: `Invalid --review-repair-rounds value "${value}". Expected a non-negative integer.` };
      }
      reviewRepairRounds = parsed;
      i++;
      continue;
    }

    const equalsTaskTimeoutMatch = token.match(/^--task-timeout=(.*)$/);
    if (equalsTaskTimeoutMatch) {
      const raw = equalsTaskTimeoutMatch[1];
      const parsed = Number(raw);
      if (raw === "" || !Number.isFinite(parsed) || parsed < 0) {
        return { goal: "", error: `Invalid --task-timeout value "${raw}". Expected a non-negative number of milliseconds (0 disables).` };
      }
      taskTimeoutMs = Math.floor(parsed);
      continue;
    }

    if (token === "--task-timeout") {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { goal: "", error: `Invalid ${token} value "${value ?? ""}". Expected a non-negative number of milliseconds (0 disables).` };
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return { goal: "", error: `Invalid --task-timeout value "${value}". Expected a non-negative number of milliseconds (0 disables).` };
      }
      taskTimeoutMs = Math.floor(parsed);
      i++;
      continue;
    }

    const equalsWidgetLogLinesMatch = token.match(/^--widget-log-lines=(.*)$/);
    if (equalsWidgetLogLinesMatch) {
      const raw = equalsWidgetLogLinesMatch[1];
      const parsed = Number(raw);
      if (raw === "" || !Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
        return { goal: "", error: `Invalid --widget-log-lines value "${raw}". Expected a non-negative integer.` };
      }
      widgetLogLines = parsed;
      continue;
    }

    if (token === "--widget-log-lines") {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { goal: "", error: `Invalid ${token} value "${value ?? ""}". Expected a non-negative integer.` };
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
        return { goal: "", error: `Invalid --widget-log-lines value "${value}". Expected a non-negative integer.` };
      }
      widgetLogLines = parsed;
      i++;
      continue;
    }

    const equalsChecklistWindowMatch = token.match(/^--checklist-window=(.*)$/);
    if (equalsChecklistWindowMatch) {
      const raw = equalsChecklistWindowMatch[1];
      const parsed = Number(raw);
      if (raw === "" || !Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
        return { goal: "", error: `Invalid --checklist-window value "${raw}". Expected a non-negative integer.` };
      }
      checklistWindow = parsed;
      continue;
    }

    if (token === "--checklist-window") {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { goal: "", error: `Invalid ${token} value "${value ?? ""}". Expected a non-negative integer.` };
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
        return { goal: "", error: `Invalid --checklist-window value "${value}". Expected a non-negative integer.` };
      }
      checklistWindow = parsed;
      i++;
      continue;
    }

    goalTokens.push(token);
  }

  return {
    goal: goalTokens.join(" ").trim(),
    reviewProvider,
    logLevel,
    logSources,
    reviewMode,
    reviewRepairRounds,
    taskTimeoutMs,
    widgetLogLines,
    checklistWindow,
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

// ---------------------------------------------------------------------------
// buildRepairFeedback: produces a compact feedback string from a reviewer
// "block" verdict, to be injected into the generator's next attempt prompt
// during the repair loop (P1-1). Includes only structured fields: the verdict,
// block reason, reviewer summary, and unfixed findings with locations. This
// lets the generator address the reviewer's concrete findings instead of
// hard-failing the entire workflow on the first block.
// ---------------------------------------------------------------------------
export function buildRepairFeedback(
  reviewResult: ReviewResult | null,
  blockReason: BlockReason | undefined,
  findings: ReviewFinding[],
  postReviewValidation?: {
    error: string | null;
    commands: Array<{
      command: string;
      args: string[];
      exitCode: number;
      stderr: string;
      timedOut: boolean;
    }>;
  }
): string {
  const parts: string[] = [];
  parts.push(`Reviewer verdict: block (${blockReason ?? "explicit_block"})`);
  if (reviewResult?.summary) {
    parts.push(`Reviewer summary: ${reviewResult.summary}`);
  }
  const unfixed = findings.filter((f) => f.status === "unfixed");
  if (unfixed.length > 0) {
    parts.push("Unfixed findings to address:");
    for (const f of unfixed) {
      const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "workspace";
      parts.push(`- [${f.priority}] ${loc}: ${f.message}`);
    }
  }
  if (reviewResult?.postFixValidation?.status === "failed") {
    parts.push(`Post-fix validation failed: ${reviewResult.postFixValidation.evidence ?? "no evidence provided"}`);
  }
  if (postReviewValidation?.error) {
    parts.push(`Orchestrator post-review validation failed: ${postReviewValidation.error}`);
    for (const command of postReviewValidation.commands.filter(
      (result) => result.timedOut || result.exitCode !== 0
    )) {
      const invocation = [command.command, ...command.args].join(" ");
      const rawDiagnostic = command.stderr.trim();
      const diagnostic = rawDiagnostic.length > 2000
        ? `${rawDiagnostic.slice(0, 1999)}…`
        : rawDiagnostic;
      parts.push(
        `- ${invocation}: ${command.timedOut ? "timed out" : `exit code ${command.exitCode}`}` +
        (diagnostic ? `\n  ${diagnostic}` : "")
      );
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Cross-task handoff
//
// `buildPriorTaskHandoff` produces a compact, bounded "Prior Tasks (Handoff)"
// block that is injected into each subsequent task's subagent prompt so
// downstream generator runs can build on what earlier tasks delivered.
//
// Design constraints (per sprint contract):
//   * Includes ONLY structured fields: title, verdict (effectiveVerdict ?? status),
//     structuredReport.summary, filesChanged, unresolvedItems.
//   * NEVER includes raw model output (TaskResult.output), reviewer stdout/stderr,
//     log fragments, or `reviewResult.findings[*].message` (reviewer prose).
//   * Total length is hard-capped (default 4096 chars). When the natural
//     rendering exceeds the cap, the string is truncated and a stable marker
//     `… (truncated)` is appended so the generator knows context was elided.
//   * Per-task fields are also individually clipped (summary ≤ 400 chars,
//     filesChanged ≤ 12 items, unresolvedItems ≤ 8 items) to keep one large
//     task from starving later ones.
// ---------------------------------------------------------------------------

export interface PriorTaskHandoffOptions {
  /** Total handoff size cap. Defaults to 4096 chars. */
  maxSize?: number;
  /** Maximum number of prior tasks to include (most recent kept). Defaults to 6. */
  maxTasks?: number;
  /** Per-task summary character cap. Defaults to 400. */
  perTaskSummaryChars?: number;
  /** Per-task filesChanged cap. Defaults to 12. */
  perTaskMaxFiles?: number;
  /** Per-task unresolvedItems cap. Defaults to 8. */
  perTaskMaxUnresolved?: number;
}

export interface PriorTaskHandoffInput {
  title: string;
  status?: TaskStatus;
  effectiveVerdict?: ReviewVerdict;
  structuredReport?: SubagentStructuredReport;
  // NOTE: deliberately NOT typed to receive raw `output`, reviewer stdout/stderr,
  // or `reviewResult.findings`. Callers should pass only structured fields.
}

const PRIOR_HANDOFF_TRUNCATION_MARKER = "… (truncated)";
const PRIOR_HANDOFF_HEADER = "Prior Tasks (Handoff):";

function clipString(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return value.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function buildPriorTaskHandoff(
  priorTasks: readonly PriorTaskHandoffInput[],
  options: PriorTaskHandoffOptions = {}
): string {
  if (!Array.isArray(priorTasks) || priorTasks.length === 0) return "";
  const maxSize = Math.max(64, options.maxSize ?? 4096);
  const maxTasks = Math.max(1, options.maxTasks ?? 6);
  const perTaskSummaryChars = Math.max(40, options.perTaskSummaryChars ?? 400);
  const perTaskMaxFiles = Math.max(1, options.perTaskMaxFiles ?? 12);
  const perTaskMaxUnresolved = Math.max(1, options.perTaskMaxUnresolved ?? 8);

  // Keep the most recent N tasks if the caller passed too many — recent context
  // is more relevant for the next task. The original ordering of the kept slice
  // is preserved so Task indices read in chronological order.
  const tooMany = priorTasks.length > maxTasks;
  const visible = tooMany ? priorTasks.slice(priorTasks.length - maxTasks) : priorTasks.slice();
  const droppedCount = priorTasks.length - visible.length;

  const blocks: string[] = [];
  for (let i = 0; i < visible.length; i++) {
    const t = visible[i];
    if (!t || typeof t !== "object") continue;
    const title = clipString(collapseWhitespace(String(t.title ?? "(untitled task)")), 120);
    const verdict = t.effectiveVerdict ?? t.status ?? "unknown";
    const report = t.structuredReport;
    const reportStatus = report?.status ?? "unknown";
    const summarySource = report?.summary ? collapseWhitespace(report.summary) : "(no structured summary)";
    const summary = clipString(summarySource, perTaskSummaryChars);
    const files = (report?.filesChanged ?? []).filter(
      (f: string) => typeof f === "string" && f.length > 0
    );
    const filesShown = files.slice(0, perTaskMaxFiles).map((f: string) => clipString(f, 120));
    const filesOmitted = Math.max(0, files.length - filesShown.length);
    const unresolved = (report?.unresolvedItems ?? []).filter(
      (u: string) => typeof u === "string" && u.length > 0
    );
    const unresolvedShown = unresolved
      .slice(0, perTaskMaxUnresolved)
      .map((u: string) => clipString(collapseWhitespace(u), 200));
    const unresolvedOmitted = Math.max(0, unresolved.length - unresolvedShown.length);
    // Index reflects position within the visible window (which may have been
    // shifted forward when older tasks were dropped); using a 1-based local
    // index keeps the rendering deterministic for tests.
    const localIndex = droppedCount + i + 1;
    const lines = [
      `- Task ${localIndex}: ${title}`,
      `  Status: ${reportStatus} · Verdict: ${verdict}`,
      `  Summary: ${summary}`,
    ];
    if (filesShown.length > 0) {
      const suffix = filesOmitted > 0 ? ` (+${filesOmitted} more)` : "";
      lines.push(`  Files: ${filesShown.join(", ")}${suffix}`);
    }
    if (unresolvedShown.length > 0) {
      const suffix = unresolvedOmitted > 0 ? ` (+${unresolvedOmitted} more)` : "";
      lines.push(`  Unresolved: ${unresolvedShown.join("; ")}${suffix}`);
    }
    blocks.push(lines.join("\n"));
  }

  if (blocks.length === 0) return "";

  const droppedNote = droppedCount > 0
    ? `(${droppedCount} earlier task${droppedCount === 1 ? "" : "s"} omitted)\n`
    : "";
  let rendered = `${PRIOR_HANDOFF_HEADER}\n${droppedNote}${blocks.join("\n")}`;

  if (rendered.length > maxSize) {
    // Drop the oldest blocks from the visible window until we fit.
    // Always keep at least the most recent block so Task N+1 still has some
    // signal about Task N.
    const remaining = blocks.slice();
    while (remaining.length > 1) {
      remaining.shift();
      const omittedFromFront = visible.length - remaining.length + droppedCount;
      const noteLine = omittedFromFront > 0
        ? `(${omittedFromFront} earlier task${omittedFromFront === 1 ? "" : "s"} omitted)\n`
        : "";
      const candidate = `${PRIOR_HANDOFF_HEADER}\n${noteLine}${remaining.join("\n")}`;
      if (candidate.length <= maxSize - PRIOR_HANDOFF_TRUNCATION_MARKER.length - 1) {
        rendered = `${candidate}\n${PRIOR_HANDOFF_TRUNCATION_MARKER}`;
        return rendered;
      }
    }
    // Last resort: hard-clip only the most recent block. Clipping the original
    // rendering here would preserve the oldest visible task and could omit the
    // latest task entirely when no complete block fits.
    const omittedFromFront = priorTasks.length - 1;
    const noteLine = omittedFromFront > 0
      ? `(${omittedFromFront} earlier task${omittedFromFront === 1 ? "" : "s"} omitted)\n`
      : "";
    rendered = `${PRIOR_HANDOFF_HEADER}\n${noteLine}${remaining[remaining.length - 1]}`;
    const room = Math.max(0, maxSize - PRIOR_HANDOFF_TRUNCATION_MARKER.length - 1);
    rendered = `${rendered.slice(0, room).trimEnd()}\n${PRIOR_HANDOFF_TRUNCATION_MARKER}`;
  }
  return rendered;
}

export function priorTaskHandoffFromResults(
  priorTaskResults: readonly TaskResult[],
  options?: PriorTaskHandoffOptions
): string {
  // Map TaskResult → PriorTaskHandoffInput, deliberately dropping raw output,
  // reviewer process output, and other non-structured fields. This is the only
  // call path the runtime uses to feed handoff data into the prompt builder.
  const inputs: PriorTaskHandoffInput[] = priorTaskResults.map((r) => ({
    title: r.title,
    status: r.status,
    effectiveVerdict: r.effectiveVerdict,
    structuredReport: r.structuredReport,
  }));
  return buildPriorTaskHandoff(inputs, options);
}

function buildSubagentTaskPrompt(
  task: Task,
  parentContextSummary: string,
  priorTaskHandoff: string = ""
): string {
  const sections = [
    `Parent Workflow Context (Summary): ${parentContextSummary}`,
  ];
  if (priorTaskHandoff && priorTaskHandoff.trim().length > 0) {
    sections.push(priorTaskHandoff);
  }
  sections.push(
    `Task: ${task.title}`,
    `Description:\n${task.description}`,
    `Acceptance Criteria:\n${task.acceptanceCriteria}`,
    "Work only on this task's stated scope in the current workspace directory.",
    "Verify the acceptance criteria before reporting completion.",
    "End your final response with one JSON object (prose allowed above it) using this shape:",
    '{"status":"completed|partial|blocked","summary":"...","filesChanged":["path"],"unresolvedItems":[],"acceptanceCriteria":[{"criterion":"...","status":"met|not_met|unknown","evidence":"..."}]}'
  );
  return sections.join("\n\n");
}

export { buildSubagentTaskPrompt };

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
  // Capture the abort reason so we can surface the true cause (timeout vs
  // user abort) instead of masking it with residual stderr text. Without this,
  // a harmless stderr warning line gets promoted to the failure reason whenever
  // the subprocess is aborted by a timeout, hiding the real cause (see P0-2).
  let abortReason: string | undefined;
  // Throttle timestamp for forwarding incremental text/thinking deltas (P0-3).
  // The pi generator emits message_update / text_delta events as the model
  // streams; without forwarding them the live log shows only discrete tool
  // calls, never the model's in-progress reasoning.
  let lastTextDeltaForwardMs = 0;
  const TEXT_DELTA_THROTTLE_MS = 3000;

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
      // Forward incremental text/thinking deltas (throttled) so the live log
      // shows the model's in-progress reasoning, not just discrete tool calls
      // (P0-3). pi --mode json emits these as message_update / text_delta
      // events; previously handleLine ignored them entirely.
      if ((event?.type === "message_update" || event?.type === "text_delta") && onUpdate) {
        const deltaText =
          typeof event?.delta === "string" ? event.delta
          : typeof event?.delta?.text === "string" ? event.delta.text
          : typeof event?.text === "string" ? event.text
          : "";
        if (deltaText) {
          const now = Date.now();
          if (now - lastTextDeltaForwardMs >= TEXT_DELTA_THROTTLE_MS) {
            lastTextDeltaForwardMs = now;
            const preview = clipSubprocessLogText(deltaText, 100);
            try {
              onUpdate({ content: [{ type: "text", text: `… ${preview}` }] });
            } catch {
              // ignore observer errors
            }
          }
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
      // Read the abort reason from the signal so the true cause (e.g. a
      // timeout) is carried through to the error message instead of being
      // replaced by stale stderr (see P0-2).
      const reason = signal?.reason;
      if (reason instanceof Error) {
        abortReason = reason.message;
      } else if (typeof reason === "string" && reason) {
        abortReason = reason;
      }
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
  // Surface the true abort cause instead of masking it with residual stderr.
  // When the subprocess was aborted (timeout or user), prefer the captured
  // abort reason over stderr. This ensures timeout errors contain "timeout"
  // so isTransientError classifies them correctly and the retry path engages
  // with the right reason (see P0-2).
  const abortMessage = wasAborted ? (abortReason || "Subagent aborted") : undefined;
  const exitMessage = `pi subprocess exited with code ${exitCode}`;
  const errorMessage = isError
    ? (abortMessage || stderr || exitMessage)
    : undefined;
  const textOut = finalAssistantText.trim() || (isError ? (errorMessage || stderr || exitMessage) : "");

  return {
    content: [{ type: "text", text: textOut }],
    details: {
      results: [
        {
          agent: agent.name,
          exitCode,
          stderr: stderr || undefined,
          errorMessage,
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

  // Free-text fallback (last resort only — structured report is preferred
  // above). Previously this path used a broad regex
  // `(failed|not met|pending|todo|unresolved|skip).*${criterion}` which matched
  // any narrative sentence using those words near the criterion text, producing
  // false "incomplete" verdicts (P1-2). That regex is removed; criterion
  // validation is now handled exclusively by the structured report path. The
  // remaining checks target explicit status markers only.
  const unresolvedItems: string[] = [];
  const lines = textContent.split("\n");
  for (const line of lines) {
    const lowerLine = line.toLowerCase();
    if (lowerLine.includes("todo:") || lowerLine.includes("fixme:") || lowerLine.includes("unresolved:") || lowerLine.includes("pending:")) {
      unresolvedItems.push(line.trim());
    } else if (
      // Only flag "could not / failed to / unable to" when it appears as an
      // explicit failure statement at the start of a line (after optional
      // whitespace/label), not mid-sentence in narrative prose.
      /^\s*(could not|failed to|unable to)\b/i.test(line) &&
      !lowerLine.includes("no issues found") &&
      !lowerLine.includes("zero")
    ) {
      unresolvedItems.push(line.trim());
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
  const reviewMode = resolveReviewMode(options.reviewMode);
  const logLevelResolution = resolveCcReviewLogLevel({ flag: options.logLevel, env: process.env });
  const resolvedLogLevel: CcReviewLogSeverity = logLevelResolution.level;
  const logSourcesResolution = resolveCcReviewLogSources({ flag: options.logSources, env: process.env });
  const resolvedLogSources: string[] | undefined = logSourcesResolution.sources;
  const widgetLogLinesResolution = resolveCcReviewWidgetLogLines({ flag: options.widgetLogLines, env: process.env });
  const resolvedWidgetLogLines = widgetLogLinesResolution.lines;
  const checklistWindowResolution = resolveCcReviewChecklistWindow({ flag: options.checklistWindow, env: process.env });
  const resolvedChecklistWindow = checklistWindowResolution.window;
  // Resolve the per-attempt subagent execution timeout (P0-1). Previously this
  // was hardcoded to 300000ms (5 min); real coding subagent runs routinely
  // exceed that and were killed mid-flight. The default is now 30 min and is
  // configurable via tool param / slash flag / env. 0 disables the timeout.
  const taskTimeoutResolution = resolveSubagentTaskTimeout({ flag: options.taskTimeoutMs, env: process.env });
  const resolvedTaskTimeoutMs = taskTimeoutResolution.timeoutMs;
  // Resolve planner/reviewer subprocess timeouts (P0-4). Previously these
  // phases had NO timeout, so a stuck claude/codex could hang forever.
  const resolvedPlannerTimeoutMs = resolvePlannerTimeoutMs(process.env);
  const resolvedReviewerTimeoutMs = resolveReviewerTimeoutMs(process.env);
  // Resolve the reviewer-block repair round bound (P1-1).
  const maxReviewRepairRounds = resolveMaxReviewRepairRounds({
    flag: options.reviewRepairRounds,
    env: process.env,
  });

  // Trace workflow start
  emitTrace(ctx, "workflow_start", {
    goalLength: goal.length,
    reviewProvider: reviewProviderConfig.provider,
    reviewMode,
    logLevel: resolvedLogLevel,
    logSources: resolvedLogSources,
    widgetLogLines: resolvedWidgetLogLines,
    checklistWindow: resolvedChecklistWindow,
    taskTimeoutMs: resolvedTaskTimeoutMs,
    plannerTimeoutMs: resolvedPlannerTimeoutMs,
    reviewerTimeoutMs: resolvedReviewerTimeoutMs,
    maxReviewRepairRounds,
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
  const batchTaskExecutions: BatchTaskExecution[] = [];
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
  // Preserve prior run history: do NOT truncate the persisted log at workflow
  // start (P0-1). Previously the file was wiped every run, removing all
  // post-mortem visibility. A run-boundary entry is emitted as the first log
  // line (below, after the log function is defined) so individual runs remain
  // separable in the accumulated file.

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
      const kindLabel = payload.kind === "rollup" ? "Rollup" : `Task ${(payload.taskIndex ?? 0) + 1}`;
      await pi.sendMessage({
        customType: "cc-review-findings",
        display: true,
        content: `[CC Review Findings ${kindLabel}] ${payload.effectiveVerdict}: ${payload.summary}`,
        details: payload,
      });
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
    log({
      severity: "info",
      source: "planner",
      message: (() => {
        const preview = plannedTasks
          .slice(0, 3)
          .map((task) => task.title)
          .join("; ");
        const suffix = plannedTasks.length > 3 ? ` (+${plannedTasks.length - 3} more)` : "";
        return `Workflow planned: ${plannedTasks.length} tasks — ${preview}${suffix}`;
      })(),
    });
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

  const transitionToBatchReviewing = () => {
    currentTaskIndex = tasks.length > 0 ? tasks.length - 1 : -1;
    displayState = "reviewing";
    retryState = undefined;
    currentPhase = `Reviewing All ${tasks.length} Tasks`;
    log(`Invoking ${reviewProviderConfig.label} once to review and fix the complete workflow.`);
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
    resolvedLogSources,
    resolvedWidgetLogLines,
    resolvedChecklistWindow,
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
      const color = getStatusColorForDisplayState(displayState);
      ctx?.ui?.setStatus?.("cc-review-status", uiTheme.fg(color, statusText));
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
    const maxLiveLogs = Math.max(50, resolvedWidgetLogLines);
    if (liveLogs.length > maxLiveLogs) {
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
    if (onUpdate && resolvedWidgetLogLines > 0) {
      const entrySeverityForGate: CcReviewLogSeverity = SUPPORTED_LOG_SEVERITIES.includes(
        entry.severity as CcReviewLogSeverity
      )
        ? (entry.severity as CcReviewLogSeverity)
        : "info";
      const passesLogLevel = LOG_SEVERITY_RANK[entrySeverityForGate] >= LOG_SEVERITY_RANK[resolvedLogLevel];
      const passesLogSources = resolvedLogSources === undefined || resolvedLogSources.includes(entry.source);
      if (passesLogLevel && passesLogSources) {
        const renderedDelta = renderCcReviewLogEntry(entry, { maxLineWidth: 120 });
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

  // Emit a run-boundary entry as the first line of this run's log so
  // individual runs remain separable in the accumulated workflow-logs.jsonl
  // (P2-1). Previously the file was truncated per run; now history is
  // preserved and this boundary marks where the current run begins.
  log({
    severity: "info",
    source: "cc-review",
    message: `=== Workflow run ${workflowRunId} started (provider=${reviewProviderConfig.provider}, mode=${reviewMode}) ===`,
  });

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

  if (logSourcesResolution.invalidInput) {
    const { source: invalidSource, raw } = logSourcesResolution.invalidInput;
    const rawDisplay = typeof raw === "string" ? raw : String(raw ?? "");
    log({
      severity: "warning",
      source: "cc-review",
      message:
        `Ignoring invalid log sources ${JSON.stringify(rawDisplay)} from ${invalidSource}; ` +
        `falling back to default 'all'.`,
    });
  }

  if (taskTimeoutResolution.invalidInput) {
    const { source: invalidSource, raw } = taskTimeoutResolution.invalidInput;
    const rawDisplay = typeof raw === "string" ? raw : String(raw ?? "");
    log({
      severity: "warning",
      source: "cc-review",
      message:
        `Ignoring invalid task timeout ${JSON.stringify(rawDisplay)} from ${invalidSource}; ` +
        `falling back to default ${DEFAULT_TASK_TIMEOUT_MS}ms.`,
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
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        fn();
      };

      let timeoutTimer: NodeJS.Timeout | undefined;
      // Heartbeat: emit a periodic log line while any subprocess is running so
      // the user can tell whether the run is working or hung (see P0-3). Without
      // this, buffered (non-streaming) planner/reviewer invocations produce no
      // visible output for their entire duration.
      let heartbeatTimer: NodeJS.Timeout | undefined;
      let heartbeatElapsed = 0;
      heartbeatTimer = setInterval(() => {
        if (settled) return;
        heartbeatElapsed += SUBPROCESS_HEARTBEAT_MS;
        log({
          severity: "info",
          source: label.includes("planner") ? "planner" : label.includes("reviewer") || label.includes("review") ? "reviewer" : "subagent",
          message: `${label} still running (${Math.round(heartbeatElapsed / 1000)}s)...`,
        });
      }, SUBPROCESS_HEARTBEAT_MS);
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
        if (heartbeatTimer) clearInterval(heartbeatTimer);
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
        if (heartbeatTimer) clearInterval(heartbeatTimer);
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

  // Wrapper around runProcess for reviewer subprocesses that applies the
  // configured reviewer timeout (P0-4) and treats a timeout as a synthetic
  // non-zero exit (exit code 124) instead of letting the rejection propagate
  // and abort the whole workflow. The existing deriveEffectiveVerdict logic
  // then classifies the non-zero exit as ship_with_warnings.
  const runReviewerProcess = (
    label: string,
    command: string,
    args: string[]
  ): Promise<ProcessResult> => {
    const stdoutLogger = createSubprocessStreamLogger(log, "stdout", "reviewer");
    const stderrLogger = createSubprocessStreamLogger(log, "stderr", "reviewer");
    const processPromise = runProcess(
      label,
      command,
      args,
      (data) => stdoutLogger.write(data),
      (data) => stderrLogger.write(data),
      resolvedReviewerTimeoutMs > 0 ? resolvedReviewerTimeoutMs : undefined
    ).finally(() => {
      stdoutLogger.flush();
      stderrLogger.flush();
    });
    return processPromise.catch((err: any) => {
      const errorMessage = err?.message || String(err);
      if (/timed out/i.test(errorMessage)) {
        log({
          severity: "warning",
          source: "reviewer",
          message: `${label} timed out after ${resolvedReviewerTimeoutMs}ms; continuing with warnings.`,
        });
        emitTrace(ctx, "failure", {
          phase: "reviewer_timeout",
          label,
          command,
          timeoutMs: resolvedReviewerTimeoutMs,
        });
        const syntheticStderr = `Reviewer timed out after ${resolvedReviewerTimeoutMs}ms`;
        return {
          code: 124,
          exitCode: 124,
          stdout: "",
          stderr: syntheticStderr,
          combinedOutput: "",
          output: "",
        };
      }
      throw err;
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
        // Stream JSONL events to stdout for live observability (P0-3).
        "--json",
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
      // Use stream-json for live observability (P0-3). The final task-list JSON
      // is recovered from the stream via extractAssistantTextFromStream.
      plannerArgs = [
        "-p",
        "--dangerously-skip-permissions",
        "--no-session-persistence",
        "--output-format", "stream-json",
        "--verbose",
      ];
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
      let planResult: ProcessResult;
      const plannerStdoutLogger = createSubprocessStreamLogger(log, "stdout", "planner");
      const plannerStderrLogger = createSubprocessStreamLogger(log, "stderr", "planner");
      try {
        planResult = await runProcess(
          plannerLabel,
          plannerCommand,
          plannerArgs,
          (data) => {
            const chunk = data.toString();
            if (captureStdoutForPlanner) plannerStdoutBuffer += chunk;
            plannerStdoutLogger.write(chunk);
          },
          (data) => plannerStderrLogger.write(data),
          resolvedPlannerTimeoutMs > 0 ? resolvedPlannerTimeoutMs : undefined
        );
      } catch (err: any) {
        // Planner timeout (P0-4): treat as a retryable failure so the existing
        // backoff/retry loop engages, instead of letting the rejection propagate
        // and abort the whole workflow.
        const errorMessage = err?.message || String(err);
        const isPlannerTimeout = /timed out/i.test(errorMessage);
        if (isPlannerTimeout && attempt < maxPlanRetries) {
          emitTrace(ctx, "retry", {
            phase: "planning",
            attempt,
            maxAttempts: maxPlanRetries,
            error: errorMessage,
          });
          const backoff = Math.pow(2, attempt) * 1000;
          log({
            severity: "warning",
            source: "planner",
            message: `Planning timed out after ${resolvedPlannerTimeoutMs}ms. Waiting ${backoff}ms before retrying...`,
          });
          await delay(backoff, signal);
          continue;
        }
        throw err;
      } finally {
        plannerStdoutLogger.flush();
        plannerStderrLogger.flush();
      }

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
        // With --output-format stream-json, claude emits NDJSON events. Recover
        // the final assistant text from the stream before extracting JSON (P0-3).
        const plannerText = extractAssistantTextFromStream(plannerStdoutBuffer);
        rawPlanJson = extractBalancedJsonObject(plannerText, "first");
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
      // Build a bounded, structured handoff from prior task results. Raw
      // subagent output and reviewer process output are intentionally excluded
      // (see priorTaskHandoffFromResults).
      const priorHandoff = priorTaskHandoffFromResults(taskResults);
      const subagentPrompt = buildSubagentTaskPrompt(task, summarizedParentContext, priorHandoff);
      let subagentResult: SubagentResult = { code: 0 };
      let subagentOutputText = "";
      let validationError: string | undefined = undefined;
      let unresolvedItems: string[] | undefined = undefined;
      let taskStatus: TaskResult["status"] = "completed";
      let retryFeedback: string | undefined = undefined;
      // Repair feedback from a reviewer "block" verdict, injected into the next
      // generator attempt so the subagent can fix the reviewer's findings
      // instead of hard-failing the whole workflow (P1-1).
      let repairFeedback: string | undefined = undefined;
      let repairRequiresPostReviewValidation = false;
      const unresolvedItemsForFailedTask: string[] = [];

      // Self-repair bound for per-task subagent dispatch. Default 2 retries on
      // top of the initial attempt → maxTaskExecutionRetries + 1 total
      // dispatches. On each non-zero / validation-failed attempt, the prior
      // attempt's exit code and error/stderr/validationError text is appended
      // to the next prompt via `retryFeedback` so the subagent can repair
      // itself (see assignment below).
      const maxTaskExecutionRetries = 2;
      const maxTaskExecutionAttempts = maxTaskExecutionRetries + 1;

      // Reviewer-block repair loop (P1-1): when the reviewer returns a "block"
      // verdict, re-dispatch the generator with the reviewer's findings as
      // feedback, then re-review, up to maxReviewRepairRounds. Only hard-fail
      // after the bound is hit. Previously a single block threw and aborted the
      // entire workflow, preventing later tasks from ever running.
      REPAIR_LOOP: for (let repairRound = 0; ; repairRound++) {
        if (repairRound > 0) {
          // Inject the reviewer's findings as feedback for the repair re-execution.
          retryFeedback = repairFeedback;
          transitionToExecuting(i);
          log({
            severity: "info",
            source: "cc-review",
            message: `[Repair] Reviewer blocked "${task.title}". Re-executing with reviewer feedback (repair round ${repairRound}/${maxReviewRepairRounds})...`,
          });
        }

      for (let attempt = 1; attempt <= maxTaskExecutionAttempts; attempt++) {
        throwIfAborted();
        if (attempt > 1) {
          noteRetry(attempt, maxTaskExecutionAttempts);
          log(`Retrying task execution in subagent (attempt ${attempt}/${maxTaskExecutionAttempts})...`);
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

          // Enforce a per-attempt timeout for the long-running subagent tool
          // call. Previously hardcoded to 300000ms (5 min) which killed real
          // tasks mid-flight (P0-1). Now configurable via CC_REVIEW_TASK_TIMEOUT_MS
          // / tool param / slash flag. 0 disables the timeout entirely.
          const subagentTimeoutMs = resolvedTaskTimeoutMs;
          const timeoutTimer = subagentTimeoutMs > 0
            ? setTimeout(() => {
                log(`[Timeout] Subagent task execution exceeded timeout of ${subagentTimeoutMs}ms. Aborting subagent...`);
                taskAbortController.abort(new Error(`Subagent execution timed out after ${subagentTimeoutMs}ms`));
              }, subagentTimeoutMs)
            : undefined;

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
                  const formatted = formatSubprocessStreamLine(subagentText);
                  if (formatted !== null) {
                    log(`[Subagent] ${formatted}`);
                  }
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
            if (timeoutTimer) clearTimeout(timeoutTimer);
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
          if (attempt < maxTaskExecutionAttempts) {
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
              maxAttempts: maxTaskExecutionAttempts,
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

      if (reviewMode === "after-all") {
        const result: TaskResult = {
          title: task.title,
          description: task.description,
          executionCode: subagentResult.code,
          reviewCode: -1,
          output: subagentOutputText,
          validationError,
          unresolvedItems,
          status: "completed",
          structuredReport: structuredReport ?? undefined,
          schemaParseStatus,
        };
        taskStatuses[i] = "completed";
        recordTaskResult(result);
        batchTaskExecutions.push({
          taskIndex: i,
          task,
          startedAt: taskStartedAt,
          subagentResult,
          subagentOutputText,
          cachedSubagentResult,
          validationError,
          unresolvedItems,
          structuredReport,
          schemaParseStatus,
          result,
        });
        log(`[Task Execution Done] Queued "${task.title}" for the final workflow review.`);
        break REPAIR_LOOP;
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

      const reviewProcessResult = await runReviewerProcess(
        reviewProviderConfig.label,
        reviewProviderConfig.command,
        reviewArgs
      );

      const workspaceAfterReview = snapshotWorkspace(workflowCwd);
      const workspaceChanged = workspaceSnapshotChanged(workspaceBeforeReview, workspaceAfterReview);
      // Recover the final review text from the stream (claude stream-json) or
      // fall back to the raw combined output (codex plain text) (P0-3).
      const reviewText = extractAssistantTextFromStream(reviewProcessResult.combinedOutput);
      const parsedReview = parseReviewResult(reviewText);
      const reviewResultObject = parsedReview.result;
      const findings = reviewResultObject?.findings ?? [];
      const reportedVerdict = reviewResultObject?.verdict ?? null;
      const rerunValidation = validateSubagentOutput(cachedSubagentResult, task);
      const postReview = await runPostReviewValidation({
        reviewResult: reviewResultObject,
        workspaceChanged: workspaceChanged || repairRequiresPostReviewValidation,
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
        if (repairRound >= maxReviewRepairRounds) {
          // Exhausted repair rounds → hard-fail (P1-1).
          log(`[Workflow Halted] Blocked by reviewer after ${maxReviewRepairRounds} repair round(s) on: "${task.title}".`);
          const summary = appendPersistedLogPathToSummary(
            buildSummaryReport(goal, taskResults, tasks),
            persistedLogState.filePath
          );
          throw new WorkflowError(`Blocked by reviewer on: "${task.title}" (after ${maxReviewRepairRounds} repair round(s))`, summary);
        }
        // Build repair feedback from the reviewer's findings and re-execute +
        // re-review (P1-1). The generator gets the concrete findings so it can
        // fix them instead of the whole workflow aborting on the first block.
        repairFeedback = buildRepairFeedback(reviewResultObject ?? null, derived.blockReason, findings);
        repairRequiresPostReviewValidation ||= derived.blockReason === "post_review_validation_failed";
        log({
          severity: "warning",
          source: "reviewer",
          message: `[Repair] Reviewer blocked on "${task.title}". Dispatching repair round ${repairRound + 1}/${maxReviewRepairRounds}...`,
        });
        continue REPAIR_LOOP;
      }
      break REPAIR_LOOP; // not block → task passed review, move to next task
      } // end REPAIR_LOOP
    }

    if (reviewMode === "after-all") {
      const batchReviewTask: Task = {
        title: `Complete workflow: ${goal}`,
        description: [
          `Review the complete workspace after all ${tasks.length} planned tasks have executed.`,
          `Overall goal: ${goal}`,
          "Planned tasks and acceptance criteria:",
          ...tasks.map(
            (plannedTask, index) =>
              `${index + 1}. ${plannedTask.title}\n` +
              `Description: ${plannedTask.description}\n` +
              `Acceptance criteria: ${plannedTask.acceptanceCriteria}`
          ),
          "Review integration issues across task boundaries, fix problems directly, and verify the workflow as a whole.",
        ].join("\n\n"),
        acceptanceCriteria: "The complete workflow satisfies every planned task's acceptance criteria.",
      };
      let batchRepairFeedback: string | undefined;
      let batchRepairRequiresPostReviewValidation = false;

      BATCH_REPAIR_LOOP: for (let repairRound = 0; ; repairRound++) {
      transitionToBatchReviewing();
      emitTrace(ctx, "subagent_assignment", {
        role: "reviewer",
        agent: reviewProviderConfig.provider,
        reviewMode,
        tasksCount: tasks.length,
        repairRound,
      });

      const reviewTask = batchRepairFeedback
        ? {
            ...batchReviewTask,
            description: [
              batchReviewTask.description,
              `This is repair round ${repairRound}/${maxReviewRepairRounds}.`,
              "Fix every issue below in the workspace, rerun the relevant verification, and then review the complete workflow again:",
              batchRepairFeedback,
            ].join("\n\n"),
          }
        : batchReviewTask;
      const reviewArgs = reviewProviderConfig.buildArgs({ task: reviewTask });
      const workspaceBeforeReview = snapshotWorkspace(workflowCwd);
      const reviewProcessResult = await runReviewerProcess(
        reviewProviderConfig.label,
        reviewProviderConfig.command,
        reviewArgs
      );

      const workspaceAfterReview = snapshotWorkspace(workflowCwd);
      const workspaceChanged = workspaceSnapshotChanged(workspaceBeforeReview, workspaceAfterReview);
      // Recover the final review text from the stream (claude stream-json) or
      // fall back to the raw combined output (codex plain text) (P0-3).
      const reviewText = extractAssistantTextFromStream(reviewProcessResult.combinedOutput);
      const parsedReview = parseReviewResult(reviewText);
      const reviewResultObject = parsedReview.result;
      const findings = reviewResultObject?.findings ?? [];
      const reportedVerdict = reviewResultObject?.verdict ?? null;
      const rerunValidations = batchTaskExecutions.map((execution) =>
        validateSubagentOutput(execution.cachedSubagentResult, execution.task)
      );
      const postReview = await runPostReviewValidation({
        reviewResult: reviewResultObject,
        workspaceChanged: workspaceChanged || batchRepairRequiresPostReviewValidation,
        verificationPlan,
        runCommand: runVerificationCommand,
        rerunSubagentValidationPassed: rerunValidations.every((validation) => validation.valid),
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
      const batchStatus = mapEffectiveVerdictToTaskStatus(effectiveVerdict);

      if (effectiveVerdict === "block" && repairRound < maxReviewRepairRounds) {
        batchRepairFeedback = buildRepairFeedback(
          reviewResultObject ?? null,
          derived.blockReason,
          findings,
          postReview
        );
        batchRepairRequiresPostReviewValidation ||= derived.blockReason === "post_review_validation_failed";
        log({
          severity: "warning",
          source: "reviewer",
          message: `[Repair] Final workflow review blocked completion. Re-dispatching the reviewer to fix findings and validation failures (repair round ${repairRound + 1}/${maxReviewRepairRounds})...`,
        });
        continue BATCH_REPAIR_LOOP;
      }

      let reviewerExitDiagnostic: string | undefined;
      if (reviewProcessResult.exitCode !== 0 && effectiveVerdict === "ship") {
        reviewerExitDiagnostic = `Reviewer exited non-zero (code ${reviewProcessResult.exitCode}) despite ship verdict`;
      }

      if (reviewProcessResult.exitCode !== 0 && effectiveVerdict === "ship_with_warnings") {
        const warningMessage = `${reviewProviderConfig.label} exited with code ${reviewProcessResult.exitCode}`;
        noteReviewWarning(warningMessage);
        log({ severity: "warning", source: "reviewer", message: `[Review Warning] ${warningMessage}` });
      } else if (effectiveVerdict === "ship") {
        log(`[Review Done] ${reviewProviderConfig.label} completed the final workflow review.`);
      } else if (effectiveVerdict === "ship_with_warnings") {
        log({
          severity: "warning",
          source: "reviewer",
          message: `[Review Warning] ${reviewProviderConfig.label} reported workflow-level warnings.`,
        });
      }

      let lastArtifactPath = path.join(workflowCwd, WORKFLOW_ARTIFACT_DIR, workflowRunId);
      for (let index = 0; index < batchTaskExecutions.length; index++) {
        const execution = batchTaskExecutions[index];
        const rerunValidation = rerunValidations[index];
        const completedAt = new Date().toISOString();
        const artifactPath = writeTaskArtifactForIndex({
          taskIndex: execution.taskIndex,
          task: execution.task,
          startedAt: execution.startedAt,
          completedAt,
          execution: {
            exitCode: execution.subagentResult.code,
            status: batchStatus,
            rawOutput: execution.subagentOutputText,
            structuredReport: execution.structuredReport,
            schemaParseStatus: execution.schemaParseStatus,
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
        lastArtifactPath = artifactPath;
        taskStatuses[execution.taskIndex] = batchStatus;
        Object.assign(execution.result, {
          reviewCode: reviewProcessResult.exitCode,
          reviewWarningName: reviewProviderConfig.warningName,
          status: batchStatus,
          artifactPath,
          reviewResult: index === 0 ? reviewResultObject ?? undefined : undefined,
          reportedVerdict,
          effectiveVerdict,
          blockReason: derived.blockReason,
          reviewerExitDiagnostic,
        });
      }

      await emitFindingsMessage(
        buildFindingsPayload({
          kind: "task",
          taskTitle: "Complete workflow review",
          reportedVerdict,
          effectiveVerdict,
          blockReason: derived.blockReason,
          summary: reviewResultObject?.summary ?? `Workflow review completed with ${effectiveVerdict}`,
          findings,
          artifactPath: lastArtifactPath,
        })
      );
      collectedTaskFindings.push(findings);
      findingsRollup = updateFindingsRollup(findingsRollup, effectiveVerdict, findings);
      reviewedTaskCount = 1;
      refreshWorkflowUi();

      if (effectiveVerdict === "block") {
        log(`[Workflow Halted] Final workflow review remained blocked after ${maxReviewRepairRounds} repair round(s).`);
        const summary = appendPersistedLogPathToSummary(
          buildSummaryReport(goal, taskResults, tasks),
          persistedLogState.filePath
        );
        throw new WorkflowError(
          `Blocked by final workflow review (after ${maxReviewRepairRounds} repair round(s))`,
          summary
        );
      }
      break BATCH_REPAIR_LOOP;
      } // end BATCH_REPAIR_LOOP
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
      displayState = "failed";
      currentPhase = "Failed";
      err.meta ??= buildCcReviewSummaryMeta(taskResults);
      refreshWorkflowUi();
      throw err;
    }

    // Mark the currently executing/reviewing task as cancelled if it was interrupted
    if (isCancelled) {
      displayState = isTimeout ? "timeout" : "cancelled";
    } else {
      displayState = "failed";
      currentPhase = "Failed";
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
    refreshWorkflowUi();
    throw new WorkflowError(err.message, summary, buildCcReviewSummaryMeta(taskResults));
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
