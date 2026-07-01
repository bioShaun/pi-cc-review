import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

import type { CcReviewLogSeverity } from "./config.ts";
import type { SubprocessProvider } from "./workflow/types.ts";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");

export function emitTrace(
  ctx: any,
  event: string,
  payload: Record<string, any> = {},
  traceFilePathOverride?: string
) {
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

  // Write to a trace file (per-run directory by default; override via ctx.traceFilePath)
  try {
    const cwd = ctx?.cwd || process.cwd();
    const traceFilePath =
      traceFilePathOverride ?? ctx?.traceFilePath ?? path.join(cwd, "workflow-trace.jsonl");
    const dir = path.dirname(traceFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(traceFilePath, traceLine, "utf8");
  } catch {
    // ignore
  }
}

export interface SubprocessResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  combinedOutput: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError: Error | null;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface RunSubprocessOptions {
  label: string;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  traceCtx?: any;
  onStdoutChunk?: (data: Buffer) => void;
  onStderrChunk?: (data: Buffer) => void;
  onStdoutLine?: (line: string) => void;
  registerProc?: (proc: import("child_process").ChildProcess) => (() => void) | undefined;
  abortMode?: "external" | "internal";
  /** Override CC_REVIEW_SUBPROCESS_OUTPUT_MAX_BYTES for this invocation. */
  maxStreamBytes?: number;
}

export const SUBPROCESS_OUTPUT_TRUNCATED_MARKER =
  "\n[cc-review: subprocess output truncated; further output was discarded]\n";
export const DEFAULT_SUBPROCESS_STREAM_MAX_BYTES = 32 * 1024 * 1024;

export function resolveSubprocessStreamMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CC_REVIEW_SUBPROCESS_OUTPUT_MAX_BYTES;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(String(raw).trim());
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_SUBPROCESS_STREAM_MAX_BYTES;
}

interface StreamAppendState {
  bytes: number;
  truncated: boolean;
  maxBytes: number;
}

function createStreamAppendState(maxBytes: number): StreamAppendState {
  return { bytes: 0, truncated: false, maxBytes };
}

export function appendStreamText(
  existing: string,
  chunk: string,
  state: StreamAppendState
): string {
  if (state.truncated || state.bytes >= state.maxBytes) {
    state.truncated = true;
    if (!existing.includes(SUBPROCESS_OUTPUT_TRUNCATED_MARKER.trim())) {
      return existing + SUBPROCESS_OUTPUT_TRUNCATED_MARKER;
    }
    return existing;
  }

  const chunkBytes = Buffer.byteLength(chunk, "utf8");
  const remaining = state.maxBytes - state.bytes;
  if (chunkBytes <= remaining) {
    state.bytes += chunkBytes;
    return existing + chunk;
  }

  state.truncated = true;
  const partial = Buffer.from(chunk, "utf8").subarray(0, remaining).toString("utf8");
  state.bytes = state.maxBytes;
  let result = existing + partial;
  if (!result.includes(SUBPROCESS_OUTPUT_TRUNCATED_MARKER.trim())) {
    result += SUBPROCESS_OUTPUT_TRUNCATED_MARKER;
  }
  return result;
}

const SUBPROCESS_KILL_GRACE_MS = 500;

function sendSignalToProcessGroup(
  proc: import("child_process").ChildProcess,
  signal: NodeJS.Signals
): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // already reaped
    }
  }
}

async function killProcessGroup(proc: import("child_process").ChildProcess, graceMs: number = SUBPROCESS_KILL_GRACE_MS): Promise<void> {
  sendSignalToProcessGroup(proc, "SIGTERM");
  await new Promise<void>((r) => setTimeout(r, graceMs));
  sendSignalToProcessGroup(proc, "SIGKILL");
}

export async function runSubprocess(opts: RunSubprocessOptions): Promise<SubprocessResult> {
  const {
    label, command, args, cwd, timeoutMs, signal, traceCtx,
    onStdoutChunk, onStderrChunk, onStdoutLine, registerProc,
    abortMode = "external",
    maxStreamBytes,
  } = opts;

  if (traceCtx) emitTrace(traceCtx, "tool_execution_start", { label, command, source: "subprocess" });

  const proc = childProcess.spawn(command, args, {
    cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    detached: true,
  });

  let unregister: (() => void) | undefined;
  if (registerProc) unregister = registerProc(proc);

  const streamMaxBytes = maxStreamBytes ?? resolveSubprocessStreamMaxBytes();
  const stdoutStoreState = createStreamAppendState(streamMaxBytes);
  const stderrStoreState = createStreamAppendState(streamMaxBytes);
  const stdoutLineState = createStreamAppendState(streamMaxBytes);
  const combinedStdoutState = createStreamAppendState(streamMaxBytes);
  const combinedStderrState = createStreamAppendState(streamMaxBytes);
  const retainStdoutBuffer = !onStdoutLine;

  let stdoutBuf = "";
  let stderrBuf = "";
  let combined = "";
  let stdoutLineRem = "";
  let settled = false;
  let timedOut = false;
  let aborted = false;
  let spawnError: Error | null = null;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let resolvedCode: number | null = null;
  let resolvedSignal: string | null = null;

  const finalize = (): SubprocessResult => ({
    code: resolvedCode,
    signal: resolvedSignal,
    stdout: stdoutBuf,
    stderr: stderrBuf,
    combinedOutput: combined,
    timedOut,
    aborted,
    spawnError,
    stdoutTruncated: retainStdoutBuffer ? stdoutStoreState.truncated : stdoutLineState.truncated,
    stderrTruncated: stderrStoreState.truncated,
  });

  proc.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    if (onStdoutChunk) {
      try {
        onStdoutChunk(chunk);
      } catch {
        // ignore
      }
    }
    if (onStdoutLine) {
      stdoutLineRem = appendStreamText(stdoutLineRem, text, stdoutLineState);
      let nl: number;
      while ((nl = stdoutLineRem.indexOf("\n")) !== -1) {
        const line = stdoutLineRem.slice(0, nl);
        stdoutLineRem = stdoutLineRem.slice(nl + 1);
        try {
          onStdoutLine(line);
        } catch {
          // ignore
        }
      }
    }
    if (retainStdoutBuffer) {
      stdoutBuf = appendStreamText(stdoutBuf, text, stdoutStoreState);
      combined = appendStreamText(combined, text, combinedStdoutState);
    }
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    stderrBuf = appendStreamText(stderrBuf, text, stderrStoreState);
    combined = appendStreamText(combined, text, combinedStderrState);
    if (onStderrChunk) {
      try {
        onStderrChunk(chunk);
      } catch {
        // ignore
      }
    }
  });

  if (timeoutMs) {
    timeoutTimer = setTimeout(async () => {
      if (settled) return;
      timedOut = true;
      await killProcessGroup(proc, SUBPROCESS_KILL_GRACE_MS);
    }, timeoutMs);
  }

  const onAbortInternal = () => {
    if (settled) return;
    aborted = true;
    killProcessGroup(proc, SUBPROCESS_KILL_GRACE_MS).catch(() => {});
  };
  if (abortMode === "internal" && signal) {
    if (signal.aborted) onAbortInternal();
    else signal.addEventListener("abort", onAbortInternal, { once: true });
  }

  return new Promise<SubprocessResult>((resolve) => {
    proc.on("error", (err: Error) => {
      if (settled) return;
      spawnError = err;
      stderrBuf = appendStreamText(stderrBuf, `\n[spawn error] ${err.message}`, stderrStoreState);
      combined = appendStreamText(combined, `\n[spawn error] ${err.message}`, combinedStderrState);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (abortMode === "internal" && signal) signal.removeEventListener("abort", onAbortInternal);
      if (traceCtx) emitTrace(traceCtx, "failure", { phase: "subprocess_start", label, command, error: err.message });
      settled = true;
      if (unregister) unregister();
      resolve(finalize());
    });

    proc.on("close", (code, closeSignal) => {
      if (settled) return;
      resolvedCode = typeof code === "number" ? code : null;
      resolvedSignal = closeSignal ?? null;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (abortMode === "internal" && signal) signal.removeEventListener("abort", onAbortInternal);

      if (onStdoutLine && stdoutLineRem.length > 0) {
        try {
          onStdoutLine(stdoutLineRem);
        } catch {
          // ignore
        }
        stdoutLineRem = "";
      }

      if (traceCtx) {
        emitTrace(traceCtx, "tool_execution_end", {
          label, command, source: "subprocess",
          exitCode: resolvedCode ?? (resolvedSignal ? 1 : 0),
          signal: resolvedSignal ?? undefined,
        });
        if ((resolvedCode !== null && resolvedCode !== 0) || resolvedSignal || timedOut) {
          emitTrace(traceCtx, "failure", {
            phase: timedOut ? "subprocess_timeout" : "subprocess_exit",
            label, command,
            exitCode: resolvedCode ?? (resolvedSignal ? 1 : 0),
            signal: resolvedSignal ?? undefined,
            timeoutMs: timedOut ? timeoutMs : undefined,
          });
        }
      }

      settled = true;
      if (unregister) unregister();
      resolve(finalize());
    });
  });
}

// Strip ANSI color escape codes for clean TUI text
function stripAnsi(str: string): string {
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
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

type AdapterSeverityHint = CcReviewLogSeverity | undefined;

type StreamSummarizerOutcome =
  | { readonly kind: "terminal"; readonly summary: string | null; readonly severity?: AdapterSeverityHint }
  | { readonly kind: "redispatch"; readonly rawLine: string };

interface StreamSummarizerContext {
  readonly provider: SubprocessProvider | undefined;
  readonly rawLine: string;
}

interface StreamSummarizer {
  readonly provider: SubprocessProvider;
  summarize(payload: unknown, context: StreamSummarizerContext): StreamSummarizerOutcome | null;
}

const MAX_REDISPATCH_DEPTH = 2;

interface RichStreamSummary {
  readonly message: string;
  readonly severity?: AdapterSeverityHint;
}

function resolveNestedAssistantText(
  rawText: string | undefined,
  provider: SubprocessProvider | undefined
): { readonly summary: string | null } {
  if (typeof rawText !== "string") return { summary: null };
  const trimmed = rawText.trim();
  if (!trimmed) return { summary: null };
  const nested = formatSubprocessStreamLineRich(rawText, provider);
  if (nested !== null && nested.message !== trimmed) {
    return { summary: nested.message };
  }
  if (nested === null && /^[\[{]/.test(trimmed)) {
    return { summary: null };
  }
  return { summary: `Assistant: ${structuredTextPreview(rawText, 120)}` };
}

function codexItemSummary(eventType: string, item: Record<string, unknown>, provider: SubprocessProvider | undefined): string | null {
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
    return resolveNestedAssistantText(item.text, provider).summary;
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

const codexSummarizer: StreamSummarizer = {
  provider: "codex",
  summarize(payload, context) {
    if (!payload || typeof payload !== "object") return null;
    const obj = payload as Record<string, unknown>;
    if (typeof obj.type !== "string") return null;

    if (obj.type === "thread.started" || obj.type === "turn.started") {
      return { kind: "terminal", summary: null };
    }
    if (obj.type === "turn.completed") {
      return { kind: "terminal", summary: "Codex turn completed" };
    }
    if (obj.type === "turn.failed") {
      const error =
        structuredTextPreview((obj.error as Record<string, unknown> | undefined)?.message, 100) ||
        structuredTextPreview(obj.message, 100);
      return { kind: "terminal", summary: error ? `Codex turn failed: ${error}` : "Codex turn failed", severity: "error" };
    }
    if (
      (obj.type === "item.started" || obj.type === "item.updated" || obj.type === "item.completed") &&
      obj.item &&
      typeof obj.item === "object"
    ) {
      const item = obj.item as Record<string, unknown>;
      const itemType = typeof item.type === "string" ? item.type : "item";
      const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
      const severity: AdapterSeverityHint =
        itemType === "command_execution" && exitCode !== undefined && exitCode !== 0 ? "error" : undefined;
      const summary = codexItemSummary(obj.type, item, context.provider);
      return { kind: "terminal", summary, severity };
    }
    if (obj.type === "item.started" || obj.type === "item.updated" || obj.type === "item.completed") {
      return { kind: "terminal", summary: null };
    }

    return null;
  },
};

const claudeSummarizer: StreamSummarizer = {
  provider: "claude",
  summarize(payload, _context) {
    if (!payload || typeof payload !== "object") return null;
    const obj = payload as Record<string, unknown>;
    if (typeof obj.type !== "string") return null;

    if (obj.type === "system" || obj.type === "user") {
      return { kind: "terminal", summary: null };
    }
    if (obj.type === "stream_event") {
      const event = obj.event && typeof obj.event === "object" ? obj.event as Record<string, unknown> : undefined;
      const delta = event?.delta && typeof event.delta === "object" ? event.delta as Record<string, unknown> : undefined;
      if (event?.type === "content_block_delta" && delta?.type === "text_delta") {
        const text = structuredTextPreview(delta.text, 100);
        return { kind: "terminal", summary: text || null };
      }
      return { kind: "terminal", summary: null };
    }
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
          const resolved = resolveNestedAssistantText(contentPart.text, "claude");
          if (resolved.summary !== null) summaries.push(resolved.summary);
        }
      }
      return { kind: "terminal", summary: summaries.length > 0 ? summaries.slice(0, 2).join(" · ") : null };
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
      if (failed) return { kind: "terminal", summary: resultText ? `Claude failed: ${resultText}` : "Claude run failed", severity: "error" };
      return { kind: "terminal", summary: `Claude run completed${details ? ` (${details})` : ""}` };
    }
    if (obj.type === "tool_progress") {
      const tool = structuredTextPreview(obj.tool_name ?? obj.name, 60) || "tool";
      return { kind: "terminal", summary: `${tool} is still running` };
    }
    if (obj.type === "rate_limit_event") {
      return { kind: "terminal", summary: "Rate limited; waiting to retry", severity: "warning" };
    }
    if (obj.type === "tool_call" || obj.type === "tool_use" || obj.type === "tool_execution_start") {
      const name =
        typeof obj.name === "string"
          ? obj.name
          : typeof obj.tool === "string"
            ? obj.tool
            : typeof obj.toolName === "string"
              ? obj.toolName
              : "tool";
      return { kind: "terminal", summary: `⚙ ${name}` };
    }
    if (obj.type === "message" || obj.type === "message_end") {
      return { kind: "terminal", summary: null };
    }

    return null;
  },
};

const STREAM_SUMMARIZERS: readonly StreamSummarizer[] = [codexSummarizer, claudeSummarizer];

function selectSummarizers(provider: SubprocessProvider | undefined): readonly StreamSummarizer[] {
  if (provider === undefined) return STREAM_SUMMARIZERS;
  return STREAM_SUMMARIZERS.filter((adapter) => adapter.provider === provider);
}

function summarizeStructuredSubprocessPayload(
  payload: unknown,
  provider: SubprocessProvider | undefined,
  depth: number
): StreamSummarizerOutcome | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;

  if (obj.type === "workflow_trace" || obj.type === "cc_review_log_rotation") {
    return { kind: "terminal", summary: null };
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
    return { kind: "terminal", summary: `Planned ${titles.length} task${titles.length === 1 ? "" : "s"}: ${preview}${suffix}` };
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
    return { kind: "terminal", summary: parts.join(" — ") };
  }

  const context: StreamSummarizerContext = { provider, rawLine: "" };
  for (const adapter of selectSummarizers(provider)) {
    const outcome = adapter.summarize(obj, context);
    if (outcome !== null) return outcome;
  }

  if (typeof obj.command === "string") {
    return { kind: "terminal", summary: `exec ${clipSubprocessLogText(obj.command, 80)}` };
  }

  const error = structuredTextPreview(obj.error ?? obj.message, 110);
  return error
    ? { kind: "terminal", summary: `Provider message: ${error}` }
    : { kind: "terminal", summary: null };
}

export function formatSubprocessStreamLineRich(
  rawLine: string,
  provider: SubprocessProvider | undefined,
  depth = 0
): RichStreamSummary | null {
  const line = stripAnsi(rawLine).trim();
  if (!line) return null;

  if (line.includes('"type":"workflow_trace"') || line.includes('"type": "workflow_trace"')) {
    return null;
  }

  if (line.startsWith("{") || line.startsWith("[")) {
    try {
      const parsed = JSON.parse(line);
      const outcome = summarizeStructuredSubprocessPayload(parsed, provider, depth);
      if (outcome === null) return null;
      if (outcome.kind === "terminal") {
        if (outcome.summary === null) return null;
        return { message: outcome.summary, severity: outcome.severity };
      }
      if (depth >= MAX_REDISPATCH_DEPTH) {
        const fallback = resolveNestedAssistantText(outcome.rawLine, provider);
        return fallback.summary === null ? null : { message: fallback.summary };
      }
      return formatSubprocessStreamLineRich(outcome.rawLine, provider, depth + 1);
    } catch {
      return null;
    }
  }

  if (looksLikeJsonFragment(line)) return null;

  return { message: line };
}

export function formatSubprocessStreamLine(rawLine: string): string | null {
  const rich = formatSubprocessStreamLineRich(rawLine, undefined);
  return rich === null ? null : rich.message;
}
