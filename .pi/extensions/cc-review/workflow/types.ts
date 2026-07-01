import type { CcReviewLogSeverity } from "../config.ts";
import type {
  BlockReason,
  CcReviewSummaryMeta,
  ReviewResult,
  ReviewVerdict,
  SchemaParseStatus,
  SubagentStructuredReport,
  TaskStatus,
  VerificationCommand,
} from "../structured.ts";
import type { Task } from "./dependencies.ts";

export type SubprocessProvider = "codex" | "claude";

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

export type CcReviewLogStructuredInput = Partial<Omit<CcReviewLogEntry, "severity">> & {
  severity?: CcReviewLogSeverity | string;
};

/** @deprecated Use CcReviewLogStructuredInput */
export type CcReviewStructuredLogInput = CcReviewLogStructuredInput;

export type CcReviewLogInput = string | CcReviewStructuredLogInput;

export interface SubagentResult {
  code: number;
  configuredModel?: string;
  effectiveModel?: string;
}


export interface TaskResult {
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
  configuredModel?: string;
  effectiveModel?: string;
}

export interface BatchTaskExecution {
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

export class WorkflowError extends Error {
  summary: string;
  meta?: CcReviewSummaryMeta;
  constructor(message: string, summary: string, meta?: CcReviewSummaryMeta) {
    super(message);
    this.name = "WorkflowError";
    this.summary = summary;
    this.meta = meta;
  }
}

export interface SubagentToolResult {
  content?: Array<{ type: string; text?: string }>;
  details?: {
    results?: Array<{
      agent?: string;
      exitCode?: number;
      stderr?: string;
      errorMessage?: string;
      model?: string;
    }>;
  };
  isError?: boolean;
  model?: string;
}

export interface SubagentValidation {
  valid: boolean;
  error?: string;
  unresolvedItems?: string[];
  structuredReport?: SubagentStructuredReport;
  schemaParseStatus?: SchemaParseStatus;
}

export interface RunCcReviewWorkflowOptions {
  reviewProvider?: string;
  logLevel?: string;
  logSources?: string;
  reviewMode?: string;
  reviewRepairRounds?: number;
  taskTimeoutMs?: number;
  widgetLogLines?: number;
  checklistWindow?: number;
  validationCommands?: VerificationCommand[];
  concurrency?: number;
  concurrencyLimit?: number;
  logFile?: string;
  /** Run environment checks only; no planning or execution. */
  checkOnly?: boolean;
  /** Plan tasks and write plan artifact without executing subagents. */
  planOnly?: boolean;
  /** Resume a prior run by artifact run id. */
  resumeRunId?: string;
  /** Skip tasks before this 0-based index when resuming. */
  fromTask?: number;
  /** Allow legacy text-heuristic subagent validation (default false). */
  allowTextValidation?: boolean;
}

export type SubagentToolExecutor = (
  toolName: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  onUpdate?: (partial: any) => void,
  ctx?: any
) => Promise<SubagentToolResult>;

export interface CcReviewWorkflowResult {
  summary: string;
  meta: CcReviewSummaryMeta;
}

export interface ExtensionAPI {
  registerCommand(name: string, config: unknown): void;
  registerTool(config: unknown): void;
  registerMessageRenderer?(customType: string, renderer: unknown): void;
  sendMessage?(message: unknown): Promise<void>;
}
