import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

import {
  attachPostExitStdioGuard,
  resolvePostExitGuardTimings,
} from "./workflow/post-exit-stdio-guard.ts";

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

  // Attach the post-exit stdio guard (P0-2). If a child exits while inherited
  // descendants keep stdout/stderr open, `close` would never fire and the
  // promise would hang. The guard destroys unended streams after an idle
  // window and a hard ceiling post-`exit`, so `close` resolves promptly.
  // Timers are unref'd so they never keep the event loop alive on their own.
  const guardTimings = resolvePostExitGuardTimings();
  let clearGuardTimers = attachPostExitStdioGuard(proc, guardTimings);

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
      clearGuardTimers();
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
      clearGuardTimers();

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

export {
  extractAssistantTextFromStream,
  formatSubprocessStreamLine,
  formatSubprocessStreamLineRich,
  inferSubprocessStreamSeverity,
} from "./workflow/stream-format.ts";
