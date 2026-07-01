import * as fs from "node:fs";
import * as path from "node:path";

import { formatSubprocessStreamLineRich, inferSubprocessStreamSeverity } from "./stream-format.ts";
import type { CcReviewLogEntry, CcReviewLogInput, SubprocessProvider } from "./types.ts";

const WORKFLOW_LOG_MAX_LINES_DEFAULT = 2000;
const WORKFLOW_LOG_TRUNCATE_KEEP = 1500;

export interface SubprocessStreamLogger {
  write(chunk: string | Buffer): void;
  flush(): void;
}

export function createSubprocessStreamLogger(
  logFn: (input: CcReviewLogInput) => void,
  stream: "stdout" | "stderr",
  source: "planner" | "reviewer",
  provider?: SubprocessProvider
): SubprocessStreamLogger {
  let remainder = "";
  const emitLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const rich = formatSubprocessStreamLineRich(trimmed, provider);
    if (rich === null) return;
    const severity = rich.severity ?? inferSubprocessStreamSeverity(rich.message, stream);
    logFn({ severity, source, message: rich.message });
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
    const dir = path.dirname(state.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
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

export const CC_REVIEW_LOG_DIR_NAME = ".cc-review/logs";

export interface ResolveCcReviewLogPathOptions {
  /** Working directory used to resolve relative paths. */
  cwd: string;
  /** Unique run identifier included in the generated file name. */
  runId: string;
  /** Explicit log file path from tool parameters / CLI flags. */
  explicitLogFile?: string | undefined;
  /** Optional environment override (e.g. process.env.CC_REVIEW_LOG_FILE). */
  envLogFile?: string | undefined;
  /** When true, write under workspace root (legacy). Set via CC_REVIEW_LOG_ROOT=1. */
  useWorkspaceRoot?: boolean;
}

export function resolveCcReviewRunLogDir(cwd: string, runId: string, useWorkspaceRoot = false): string {
  if (useWorkspaceRoot) {
    return cwd;
  }
  return path.join(cwd, CC_REVIEW_LOG_DIR_NAME, runId);
}

export function resolveCcReviewTracePath(cwd: string, runId: string, useWorkspaceRoot = false): string {
  return path.join(resolveCcReviewRunLogDir(cwd, runId, useWorkspaceRoot), "workflow-trace.jsonl");
}

export function shouldUseWorkspaceRootLogs(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CC_REVIEW_LOG_ROOT;
  if (raw === undefined || raw === "") return false;
  const normalized = String(raw).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

// Resolve the path for the persisted human-readable JSONL log.
//
// Precedence:
//   1. explicitLogFile (tool/CLI flag)
//   2. envLogFile (e.g. CC_REVIEW_LOG_FILE)
//   3. Default: .cc-review/logs/<runId>/workflow-logs.jsonl
//      (or workspace root when CC_REVIEW_LOG_ROOT=1)
//
// If the chosen explicit path is an existing directory, a unique file is
// generated inside that directory so callers can configure a log directory
// without specifying a full file name.
export function resolveCcReviewLogPath(options: ResolveCcReviewLogPathOptions): string {
  const cwd = options.cwd;
  const logFile = options.explicitLogFile ?? options.envLogFile;
  if (logFile) {
    const resolved = path.isAbsolute(logFile) ? logFile : path.join(cwd, logFile);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return path.join(resolved, `workflow-logs-${options.runId}.jsonl`);
    }
    return resolved;
  }
  const useRoot = options.useWorkspaceRoot ?? shouldUseWorkspaceRootLogs();
  if (useRoot) {
    return path.join(cwd, `workflow-logs-${options.runId}.jsonl`);
  }
  return path.join(resolveCcReviewRunLogDir(cwd, options.runId, false), "workflow-logs.jsonl");
}

export function appendArtifactDirToSummary(summary: string, artifactDir: string | undefined): string {
  if (!artifactDir) return summary;
  const trimmed = summary.replace(/\s+$/, "");
  return `${trimmed}\n\n### 📁 Run Artifacts\n\nStructured task artifacts and checkpoint: \`${artifactDir}\`\n`;
}

// Surface the absolute path of the persisted workflow log file in the summary.
// Mirrors pi's truncated-tool.ts pattern: when the compact widget/status is
// cleared, users can still open the JSONL to inspect the full run.
export function appendPersistedLogPathToSummary(summary: string, persistedLogPath: string | undefined): string {
  if (!persistedLogPath) return summary;
  const trimmed = summary.replace(/\s+$/, "");
  return `${trimmed}\n\n### 📄 Persisted Workflow Log\n\nFull human-readable JSONL log available at: \`${persistedLogPath}\`\n`;
}
