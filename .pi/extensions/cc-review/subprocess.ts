import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");

export function emitTrace(ctx: any, event: string, payload: Record<string, any> = {}) {
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

export interface SubprocessResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  combinedOutput: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError: Error | null;
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
    code: resolvedCode, signal: resolvedSignal,
    stdout: stdoutBuf, stderr: stderrBuf, combinedOutput: combined,
    timedOut, aborted, spawnError,
  });

  proc.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    stdoutBuf += text;
    combined += text;
    if (onStdoutChunk) { try { onStdoutChunk(chunk); } catch { /* ignore */ } }
    if (onStdoutLine) {
      stdoutLineRem += text;
      let nl: number;
      while ((nl = stdoutLineRem.indexOf("\n")) !== -1) {
        const line = stdoutLineRem.slice(0, nl);
        stdoutLineRem = stdoutLineRem.slice(nl + 1);
        try { onStdoutLine(line); } catch { /* ignore */ }
      }
    }
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    stderrBuf += text;
    combined += text;
    if (onStderrChunk) { try { onStderrChunk(chunk); } catch { /* ignore */ } }
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
      stderrBuf += `\n[spawn error] ${err.message}`;
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
        try { onStdoutLine(stdoutLineRem); } catch { /* ignore */ }
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
