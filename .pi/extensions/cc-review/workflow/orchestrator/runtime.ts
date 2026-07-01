import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  type CcReviewFindingsPayload,
  type CcReviewFindingsRollup,
  type ReviewFinding,
  type SubagentStructuredReport,
  type TaskArtifact,
  type TaskStatus,
  type VerificationPlan,
  generateWorkflowRunId,
  getArtifactRunDir,
  writeTaskArtifact,
  emptyFindingsRollup,
  type RunVerificationCommand,
} from "../../structured.ts";
import {
  DEFAULT_TASK_TIMEOUT_MS,
  type CcReviewLogSeverity,
  readAvailableCpuCount,
  resolveAllowTextValidation,
  resolveCcReviewChecklistWindow,
  resolveCcReviewConcurrency,
  resolveCcReviewLogLevel,
  resolveCcReviewLogSources,
  resolveCcReviewWidgetLogLines,
  resolveMaxReviewRepairRounds,
  resolvePlannerTimeoutMs,
  resolveReviewerTimeoutMs,
  resolveSubagentTaskTimeout,
} from "../../config.ts";
import { resolveReviewMode, resolveReviewProviderConfig } from "../../providers.ts";
import { emitTrace, runSubprocess } from "../../subprocess.ts";
import type { Task } from "../dependencies.ts";
import {
  formatResumeInstructions,
  loadCheckpoint,
  restoreBatchTaskExecutions,
  resolveTasksToSkipOnResume,
  writeCheckpoint,
  type WorkflowCheckpoint,
} from "../checkpoint.ts";
import {
  appendArtifactDirToSummary,
  appendPersistedLogEntry,
  appendPersistedLogPathToSummary,
  createSubprocessStreamLogger,
  resolveCcReviewLogPath,
  resolveCcReviewTracePath,
  shouldUseWorkspaceRootLogs,
  type PersistedLogState,
} from "../logging.ts";
import {
  emptyStateBuffer,
  loadStateBuffer,
  mergeTaskResultIntoStateBuffer,
  persistStateBuffer,
} from "../session.ts";
import {
  type BatchTaskExecution,
  type BatchReviewResult,
  type RunCcReviewWorkflowOptions,
  type TaskResult,
  WorkflowError,
  type CcReviewLogEntry,
  type CcReviewLogInput,
} from "../types.ts";
import {
  buildCcReviewStatusText,
  buildCcReviewWidgetLines,
  getStatusColorForDisplayState,
  LOG_SEVERITY_RANK,
  normalizeCcReviewLogEntry,
  renderCcReviewLogEntry,
  type CcReviewDisplayState,
  type CcReviewWidgetState,
  type CcReviewWidgetTheme,
  type TaskModelState,
  WIDGET_MAX_WIDTH_DEFAULT,
  SUPPORTED_LOG_SEVERITIES,
} from "../ui.ts";
import { discoverAgent } from "../execution.ts";
import { buildCcReviewSummaryMeta, setTaskConfiguredModel, resolveDisplayedTaskModel } from "../summary.ts";
import type { ExtensionAPI } from "../types.ts";

const SUBPROCESS_HEARTBEAT_MS = 30000;

export interface ProcessResult {
  code: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  combinedOutput: string;
  output?: string;
}

export interface WorkflowRuntime {
  pi: ExtensionAPI;
  goal: string;
  ctx: any;
  onUpdate?: (partial: any) => void;
  signal?: AbortSignal;
  options: RunCcReviewWorkflowOptions;
  reviewProviderConfig: ReturnType<typeof resolveReviewProviderConfig>;
  reviewMode: ReturnType<typeof resolveReviewMode>;
  resolvedLogLevel: CcReviewLogSeverity;
  resolvedLogSources: string[] | undefined;
  resolvedWidgetLogLines: number;
  resolvedChecklistWindow: number;
  resolvedTaskTimeoutMs: number;
  resolvedPlannerTimeoutMs: number;
  resolvedReviewerTimeoutMs: number;
  maxReviewRepairRounds: number;
  resolvedConcurrency: number;
  concurrencyResolution: ReturnType<typeof resolveCcReviewConcurrency>;
  allowTextValidation: boolean;
  workflowCwd: string;
  workflowRunId: string;
  resumeCheckpoint: WorkflowCheckpoint | undefined;
  skipTaskIndices: Set<number>;
  runStateBuffer: ReturnType<typeof emptyStateBuffer>;
  checkpointCreatedAt: string;
  tempDir: string;
  schemaPath: string;
  outputPath: string;
  activeProcesses: Set<any>;
  currentTaskIndex: number;
  tasks: Task[];
  taskResults: TaskResult[];
  batchTaskExecutions: BatchTaskExecution[];
  currentPhase: string;
  displayState: CcReviewDisplayState;
  retryState: { attempt: number; maxAttempts: number } | undefined;
  lastTaskWarning: string | undefined;
  liveLogs: CcReviewLogEntry[];
  logSequence: number;
  workerAgent: ReturnType<typeof discoverAgent>;
  resolvedWorkerModel: string | undefined;
  logFilePath: string;
  persistedLogState: PersistedLogState;
  verificationPlan: VerificationPlan | null;
  findingsRollup: CcReviewFindingsRollup;
  taskStatuses: Array<TaskStatus | "running" | undefined>;
  taskModels: TaskModelState[];
  /** P1-1: per-task session file paths (for sequential chaining when continuity enabled). */
  taskSessionPaths: (string | undefined)[];
  collectedTaskFindings: ReviewFinding[][];
  rollupEmitted: boolean;
  /** Whether at least one review result has been processed (R7). */
  hasCompletedReview: boolean;
  /** First-class batch review result (after-all mode only). Undefined in per-task mode (R8). */
  batchReviewResult: BatchReviewResult | undefined;
  artifactRunDir: string;
  log: (input: CcReviewLogInput) => void;
  persistRunCheckpoint: (phase: WorkflowCheckpoint["phase"]) => void;
  wrapWorkflowSummary: (summary: string) => string;
  emitFindingsMessage: (payload: CcReviewFindingsPayload) => Promise<void>;
  writeTaskArtifactForIndex: (input: {
    taskIndex: number;
    task: Task;
    startedAt: string;
    completedAt: string;
    execution: TaskArtifact["execution"];
    review: TaskArtifact["review"];
    validation: TaskArtifact["validation"];
    postReviewValidation: TaskArtifact["postReviewValidation"];
    workflow: TaskArtifact["workflow"];
  }) => string;
  getTaskOrThrow: (index: number) => Task;
  transitionToPlanning: () => void;
  setPlannedTasks: (plannedTasks: Task[]) => void;
  updateExecutionPhase: () => void;
  transitionToExecuting: (index: number) => void;
  transitionToReviewing: (index: number) => void;
  transitionToBatchReviewing: () => void;
  noteRetry: (attempt: number, maxAttempts: number) => void;
  clearRetry: () => void;
  abortWorkflow: (reason?: string) => void;
  failWorkflow: (reason?: string) => void;
  noteReviewWarning: (warningMessage: string) => void;
  transitionToComplete: () => void;
  recordTaskResult: (taskIndex: number, result: TaskResult, structured?: SubagentStructuredReport | null) => void;
  buildTaskResultModelState: (index: number, fallback?: { configuredModel?: string; effectiveModel?: string }) => {
    configuredModel?: string;
    effectiveModel?: string;
  };
  throwIfAborted: () => void;
  refreshWorkflowUi: () => void;
  runProcess: (
    label: string,
    command: string,
    args: string[],
    onStdout: (data: Buffer) => void,
    onStderr: (data: Buffer) => void,
    timeoutMs?: number
  ) => Promise<ProcessResult>;
  runReviewerProcess: (label: string, command: string, args: string[]) => Promise<ProcessResult>;
  onAbort: () => void;
  logLevelResolution: ReturnType<typeof resolveCcReviewLogLevel>;
  logSourcesResolution: ReturnType<typeof resolveCcReviewLogSources>;
  taskTimeoutResolution: ReturnType<typeof resolveSubagentTaskTimeout>;
  preRetryDisplayState: CcReviewDisplayState | undefined;
  runVerificationCommand: RunVerificationCommand;
}

/**
 * Class implementation of WorkflowRuntime (R6).
 *
 * Replaces the former `const rt = {} as WorkflowRuntime` pattern that defeated
 * TypeScript initialization checking. With a class, if a field is added to the
 * interface but not declared on the class, TypeScript reports an error.
 * Fields use `!` (definite assignment assertion) because they are assigned
 * incrementally in `createWorkflowRuntime` rather than in a constructor.
 */
class WorkflowRuntimeImpl implements WorkflowRuntime {
  // Configuration & context
  pi!: ExtensionAPI;
  goal!: string;
  ctx!: any;
  onUpdate?: (partial: any) => void;
  signal?: AbortSignal;
  options!: RunCcReviewWorkflowOptions;
  reviewProviderConfig!: ReturnType<typeof resolveReviewProviderConfig>;
  reviewMode!: ReturnType<typeof resolveReviewMode>;
  resolvedLogLevel!: CcReviewLogSeverity;
  resolvedLogSources!: string[] | undefined;
  resolvedWidgetLogLines!: number;
  resolvedChecklistWindow!: number;
  resolvedTaskTimeoutMs!: number;
  resolvedPlannerTimeoutMs!: number;
  resolvedReviewerTimeoutMs!: number;
  maxReviewRepairRounds!: number;
  resolvedConcurrency!: number;
  concurrencyResolution!: ReturnType<typeof resolveCcReviewConcurrency>;
  allowTextValidation!: boolean;
  workflowCwd!: string;
  workflowRunId!: string;
  resumeCheckpoint!: WorkflowCheckpoint | undefined;
  skipTaskIndices!: Set<number>;
  runStateBuffer!: ReturnType<typeof emptyStateBuffer>;
  checkpointCreatedAt!: string;
  tempDir!: string;
  schemaPath!: string;
  outputPath!: string;
  logFilePath!: string;
  persistedLogState!: PersistedLogState;
  artifactRunDir!: string;
  workerAgent!: ReturnType<typeof discoverAgent>;
  resolvedWorkerModel!: string | undefined;
  verificationPlan!: VerificationPlan | null;

  // Runtime state
  activeProcesses!: Set<any>;
  currentTaskIndex!: number;
  tasks!: Task[];
  taskResults!: TaskResult[];
  batchTaskExecutions!: BatchTaskExecution[];
  currentPhase!: string;
  displayState!: CcReviewDisplayState;
  retryState!: { attempt: number; maxAttempts: number } | undefined;
  lastTaskWarning!: string | undefined;
  liveLogs!: CcReviewLogEntry[];
  logSequence!: number;
  taskStatuses!: Array<TaskStatus | "running" | undefined>;
  taskModels!: TaskModelState[];
  /** P1-1: per-task session file paths (for sequential chaining when continuity enabled). */
  taskSessionPaths!: (string | undefined)[];
  collectedTaskFindings!: ReviewFinding[][];
  findingsRollup!: CcReviewFindingsRollup;
  rollupEmitted!: boolean;
  hasCompletedReview!: boolean;
  batchReviewResult!: BatchReviewResult | undefined;
  preRetryDisplayState!: CcReviewDisplayState | undefined;

  // Resolver metadata
  logLevelResolution!: ReturnType<typeof resolveCcReviewLogLevel>;
  logSourcesResolution!: ReturnType<typeof resolveCcReviewLogSources>;
  taskTimeoutResolution!: ReturnType<typeof resolveSubagentTaskTimeout>;

  // Methods (assigned as closures in createWorkflowRuntime)
  log!: (input: CcReviewLogInput) => void;
  persistRunCheckpoint!: (phase: WorkflowCheckpoint["phase"]) => void;
  wrapWorkflowSummary!: (summary: string) => string;
  emitFindingsMessage!: (payload: CcReviewFindingsPayload) => Promise<void>;
  writeTaskArtifactForIndex!: (input: {
    taskIndex: number;
    task: Task;
    startedAt: string;
    completedAt: string;
    execution: TaskArtifact["execution"];
    review: TaskArtifact["review"];
    validation: TaskArtifact["validation"];
    postReviewValidation: TaskArtifact["postReviewValidation"];
    workflow: TaskArtifact["workflow"];
  }) => string;
  getTaskOrThrow!: (index: number) => Task;
  transitionToPlanning!: () => void;
  setPlannedTasks!: (plannedTasks: Task[]) => void;
  updateExecutionPhase!: () => void;
  transitionToExecuting!: (index: number) => void;
  transitionToReviewing!: (index: number) => void;
  transitionToBatchReviewing!: () => void;
  noteRetry!: (attempt: number, maxAttempts: number) => void;
  clearRetry!: () => void;
  abortWorkflow!: (reason?: string) => void;
  failWorkflow!: (reason?: string) => void;
  noteReviewWarning!: (warningMessage: string) => void;
  transitionToComplete!: () => void;
  recordTaskResult!: (taskIndex: number, result: TaskResult, structured?: SubagentStructuredReport | null) => void;
  buildTaskResultModelState!: (index: number, fallback?: { configuredModel?: string; effectiveModel?: string }) => {
    configuredModel?: string;
    effectiveModel?: string;
  };
  throwIfAborted!: () => void;
  refreshWorkflowUi!: () => void;
  runProcess!: (
    label: string,
    command: string,
    args: string[],
    onStdout: (data: Buffer) => void,
    onStderr: (data: Buffer) => void,
    timeoutMs?: number
  ) => Promise<ProcessResult>;
  runReviewerProcess!: (label: string, command: string, args: string[]) => Promise<ProcessResult>;
  onAbort!: () => void;
  runVerificationCommand!: RunVerificationCommand;
}

export function createWorkflowRuntime(
  pi: ExtensionAPI,
  goal: string,
  ctx: any,
  onUpdate: ((partial: any) => void) | undefined,
  signal: AbortSignal | undefined,
  options: RunCcReviewWorkflowOptions
): WorkflowRuntime {
  const rt = new WorkflowRuntimeImpl();
  rt.pi = pi;
  rt.goal = goal;
  rt.ctx = ctx;
  rt.onUpdate = onUpdate;
  rt.signal = signal;
  rt.options = options;

  rt.reviewProviderConfig = resolveReviewProviderConfig(rt.options.reviewProvider);
  rt.reviewMode = resolveReviewMode(rt.options.reviewMode);
  rt.logLevelResolution = resolveCcReviewLogLevel({ flag: rt.options.logLevel, env: process.env });
  rt.resolvedLogLevel = rt.logLevelResolution.level;
  rt.logSourcesResolution = resolveCcReviewLogSources({ flag: rt.options.logSources, env: process.env });
  rt.resolvedLogSources = rt.logSourcesResolution.sources;
  const widgetLogLinesResolution = resolveCcReviewWidgetLogLines({ flag: rt.options.widgetLogLines, env: process.env });
  rt.resolvedWidgetLogLines = widgetLogLinesResolution.lines;
  const checklistWindowResolution = resolveCcReviewChecklistWindow({ flag: rt.options.checklistWindow, env: process.env });
  rt.resolvedChecklistWindow = checklistWindowResolution.window;
  // Resolve the per-attempt subagent execution timeout (P0-1). Previously this
  // was hardcoded to 300000ms (5 min); real coding subagent runs routinely
  // exceed that and were killed mid-flight. The default is now 30 min and is
  // configurable via tool param / slash flag / env. 0 disables the timeout.
  rt.taskTimeoutResolution = resolveSubagentTaskTimeout({ flag: rt.options.taskTimeoutMs, env: process.env });
  rt.resolvedTaskTimeoutMs = rt.taskTimeoutResolution.timeoutMs;
  // Resolve planner/reviewer subprocess timeouts (P0-4). Previously these
  // phases had NO timeout, so a stuck claude/codex could hang forever.
  rt.resolvedPlannerTimeoutMs = resolvePlannerTimeoutMs(process.env);
  rt.resolvedReviewerTimeoutMs = resolveReviewerTimeoutMs(process.env);
  // Resolve the reviewer-block repair round bound (P1-1).
  rt.maxReviewRepairRounds = resolveMaxReviewRepairRounds({
    flag: rt.options.reviewRepairRounds,
    env: process.env,
  });

  // Resolve the concurrency limit for parallel task execution
  rt.concurrencyResolution = resolveCcReviewConcurrency({
    flag: rt.options.concurrency ?? rt.options.concurrencyLimit,
    env: process.env,
    cpuCount: readAvailableCpuCount(process.env),
  });
  rt.resolvedConcurrency = rt.concurrencyResolution.concurrency;
  rt.allowTextValidation = resolveAllowTextValidation({
    flag: rt.options.allowTextValidation,
    env: process.env,
  });
  rt.workflowCwd = rt.ctx?.cwd || process.cwd();
  rt.workflowRunId = rt.options.resumeRunId?.trim() || generateWorkflowRunId();
  rt.resumeCheckpoint = undefined;
  rt.skipTaskIndices = new Set<number>();
  rt.runStateBuffer = emptyStateBuffer(rt.workflowRunId);
  rt.checkpointCreatedAt = new Date().toISOString();

  if (rt.options.resumeRunId) {
    rt.resumeCheckpoint = loadCheckpoint(rt.workflowCwd, rt.workflowRunId);
    if (!rt.resumeCheckpoint) {
      throw new WorkflowError(
        `Cannot resume: no checkpoint found for run id "${rt.workflowRunId}"`,
        `No checkpoint at \`cc-review-artifacts/${rt.workflowRunId}/checkpoint.json\`. Run plan-only first or verify the run id.`,
        buildCcReviewSummaryMeta([], { concurrency: rt.resolvedConcurrency })
      );
    }
    if (!rt.goal.trim()) {
      rt.goal = rt.resumeCheckpoint.goal;
    }
    rt.skipTaskIndices = resolveTasksToSkipOnResume(rt.resumeCheckpoint, rt.options.fromTask);
    rt.runStateBuffer = rt.resumeCheckpoint.stateBuffer ?? loadStateBuffer(rt.workflowCwd, rt.workflowRunId);
    rt.checkpointCreatedAt = rt.resumeCheckpoint.createdAt;
  }

  const useRootLogs = shouldUseWorkspaceRootLogs(process.env);
  if (rt.ctx) {
    rt.ctx.traceFilePath = resolveCcReviewTracePath(rt.workflowCwd, rt.workflowRunId, useRootLogs);
  }

  // Trace workflow start
  emitTrace(rt.ctx, "workflow_start", {
    goalLength: rt.goal.length,
    reviewProvider: rt.reviewProviderConfig.provider,
    reviewMode: rt.reviewMode,
    logLevel: rt.resolvedLogLevel,
    logSources: rt.resolvedLogSources,
    widgetLogLines: rt.resolvedWidgetLogLines,
    checklistWindow: rt.resolvedChecklistWindow,
    taskTimeoutMs: rt.resolvedTaskTimeoutMs,
    plannerTimeoutMs: rt.resolvedPlannerTimeoutMs,
    concurrency: rt.resolvedConcurrency,
    reviewerTimeoutMs: rt.resolvedReviewerTimeoutMs,
    maxReviewRepairRounds: rt.maxReviewRepairRounds,
    allowTextValidation: rt.allowTextValidation,
    resumeRunId: rt.options.resumeRunId,
    planOnly: rt.options.planOnly,
  });

  // FLOW NOTE: This orchestrator manages the lifecycle of:
  // Trigger -> Phase 1 (Plan tasks via selected provider) -> Phase 2 (Iterative loop: Part A: execute in subagent, Part B: review with configured provider) -> Phase 3 (Wrap up)
  rt.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-"));
  rt.schemaPath = path.join(rt.tempDir, "workflow-schema.json");
  rt.outputPath = path.join(rt.tempDir, "workflow-output.json");

  rt.activeProcesses = new Set<any>();
  rt.currentTaskIndex = -1;
  rt.tasks = [];
  rt.taskResults = [];
  rt.batchTaskExecutions = [];
  rt.currentPhase = "Initializing";
  rt.displayState = "initializing";
  rt.retryState = undefined;
  rt.lastTaskWarning = undefined;
  rt.liveLogs = [];
  rt.logSequence = 0;

  rt.workerAgent = discoverAgent("worker", "both", rt.workflowCwd);
  rt.resolvedWorkerModel = rt.workerAgent?.model;

  // Resolve explicit or automatic unique rt.log path
  rt.logFilePath = resolveCcReviewLogPath({
    cwd: rt.workflowCwd,
    runId: rt.workflowRunId,
    explicitLogFile: rt.options.logFile,
    envLogFile: process.env.CC_REVIEW_LOG_FILE,
    useWorkspaceRoot: useRootLogs,
  });

  rt.persistedLogState = {
    filePath: rt.logFilePath,
    appendedLineCount: 0,
  };
  // Preserve prior run history: do NOT truncate the persisted rt.log at workflow
  // start (P0-1). Previously the file was wiped every run, removing all
  // post-mortem visibility. A run-boundary entry is emitted as the first rt.log
  // line (below, after the rt.log function is defined) so individual runs remain
  // separable in the accumulated file.
  rt.verificationPlan = null;
  rt.findingsRollup = emptyFindingsRollup();
  rt.taskStatuses = [];
  rt.taskModels = [];
  rt.taskSessionPaths = [];
  rt.collectedTaskFindings = [];
  rt.rollupEmitted = false;
  rt.hasCompletedReview = false;
  rt.batchReviewResult = undefined;
  rt.artifactRunDir = getArtifactRunDir(rt.workflowCwd, rt.workflowRunId);

  if (rt.resumeCheckpoint) {
    rt.tasks = rt.resumeCheckpoint.tasks;
    for (const prior of rt.resumeCheckpoint.taskResults) {
      rt.taskResults.push(prior);
    }
    // Restore after-all execution snapshots so final review can process
    // completed tasks without re-running their workers (R1).
    rt.batchTaskExecutions = restoreBatchTaskExecutions(
      rt.resumeCheckpoint.batchTaskExecutions
    );
    // Restore batch review result if the review phase had already completed (R8).
    rt.batchReviewResult = rt.resumeCheckpoint.batchReviewResult ?? undefined;
    for (let index = 0; index < rt.tasks.length; index++) {
      const prior = rt.resumeCheckpoint.taskResults[index];
      if (prior?.status) {
        rt.taskStatuses[index] = prior.status;
      }
      setTaskConfiguredModel(rt.taskModels, index, rt.resolvedWorkerModel);
    }
  }

  rt.persistRunCheckpoint = (phase: WorkflowCheckpoint["phase"]) => {
    const completedTaskIndices: number[] = [];
    for (let i = 0; i < rt.taskResults.length; i++) {
      const status = rt.taskResults[i]?.status;
      if (
        status === "completed" ||
        status === "completed_with_warnings" ||
        status === "failed" ||
        status === "validation_failed" ||
        status === "review_blocked" ||
        status === "cancelled"
      ) {
        completedTaskIndices.push(i);
      }
    }
    writeCheckpoint(rt.workflowCwd, {
      schemaVersion: 1,
      runId: rt.workflowRunId,
      goal: rt.goal,
      createdAt: rt.checkpointCreatedAt,
      updatedAt: new Date().toISOString(),
      reviewProvider: rt.reviewProviderConfig.provider,
      reviewMode: rt.reviewMode,
      tasks: rt.tasks,
      taskResults: [...rt.taskResults],
      completedTaskIndices,
      phase,
      stateBuffer: rt.runStateBuffer,
      resumeHint: formatResumeInstructions(rt.workflowCwd, rt.workflowRunId),
      // Persist after-all execution snapshots so resume can reconstruct
      // the final-review input collection without re-running workers (R1).
      batchTaskExecutions: rt.batchTaskExecutions.filter(Boolean),
      // Persist batch review result so resume can skip re-reviewing (R8).
      batchReviewResult: rt.batchReviewResult,
    });
    persistStateBuffer(rt.workflowCwd, rt.runStateBuffer);
  };

  rt.wrapWorkflowSummary = (summary: string): string =>
    appendArtifactDirToSummary(
      appendPersistedLogPathToSummary(summary, rt.persistedLogState.filePath),
      rt.artifactRunDir
    );

  rt.emitFindingsMessage = async (payload: CcReviewFindingsPayload) => {
    if (typeof rt.pi.sendMessage === "function") {
      const kindLabel = payload.kind === "rollup" ? "Rollup" : `Task ${(payload.taskIndex ?? 0) + 1}`;
      await rt.pi.sendMessage({
        customType: "cc-review-findings",
        display: true,
        content: `[CC Review Findings ${kindLabel}] ${payload.effectiveVerdict}: ${payload.summary}`,
        details: payload,
      });
    }
  };

  // Route verification commands through the shared hardened subprocess runner
  // so they get detached process groups, SIGTERM→SIGKILL escalation, AbortSignal
  // wiring, and active-process registration. Previously this spawned directly
  // with childProcess.spawn, sent only SIGTERM on timeout, and was NOT
  // registered in rt.activeProcesses — so a stuck command could hang the run
  // past its timeout and user cancellation could leave children running (I2).
  const runVerificationCommand: RunVerificationCommand = async (command) => {
    const startedAt = new Date().toISOString();
    const subprocessResult = await runSubprocess({
      label: `verification: ${command.command}`,
      command: command.command,
      args: command.args,
      cwd: rt.workflowCwd,
      timeoutMs: command.timeoutMs,
      signal: rt.signal,
      traceCtx: rt.ctx,
      abortMode: "internal",
      registerProc(proc) {
        rt.activeProcesses.add(proc);
        return () => rt.activeProcesses.delete(proc);
      },
    });
    const completedAt = new Date().toISOString();

    // Map spawn errors to a non-zero exit, matching the prior contract.
    if (subprocessResult.spawnError) {
      return {
        command: command.command,
        args: command.args,
        exitCode: 1,
        stdout: subprocessResult.stdout,
        stderr: subprocessResult.stderr || subprocessResult.spawnError.message,
        timedOut: false,
        startedAt,
        completedAt,
      };
    }

    const exitCode = subprocessResult.code ?? (subprocessResult.signal ? 1 : 0);
    return {
      command: command.command,
      args: command.args,
      exitCode: subprocessResult.timedOut ? 124 : exitCode,
      stdout: subprocessResult.stdout,
      stderr: subprocessResult.stderr,
      timedOut: subprocessResult.timedOut,
      startedAt,
      completedAt,
    };
  };

  rt.writeTaskArtifactForIndex = (input: {
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
    writeTaskArtifact(rt.workflowCwd, rt.workflowRunId, {
      schemaVersion: 1,
      runId: rt.workflowRunId,
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
  rt.getTaskOrThrow = (index: number) => {
    const task = rt.tasks[index];
    if (!task) {
      throw new Error(`Invalid workflow task index ${index}`);
    }
    return task;
  };

  rt.transitionToPlanning = () => {
    rt.currentTaskIndex = -1;
    rt.displayState = "planning";
    rt.retryState = undefined;
    rt.currentPhase = `Planning Tasks via ${rt.reviewProviderConfig.label}`;
    rt.log({
      severity: "info",
      source: "planner",
      message: `Planning workflow with ${rt.reviewProviderConfig.label}...`,
    });
  };

  rt.setPlannedTasks = (plannedTasks: Task[]) => {
    rt.tasks = plannedTasks;
    rt.currentTaskIndex = -1;
    rt.retryState = undefined;
    for (let index = 0; index < plannedTasks.length; index++) {
      setTaskConfiguredModel(rt.taskModels, index, rt.resolvedWorkerModel);
    }
    rt.log({
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

  // Shared display-state derivation from the canonical taskStatuses array (R2).
  // `currentTaskIndex` is documented as the lowest running task index when
  // multiple tasks execute concurrently.
  const refreshExecutionDisplaysFromStatuses = () => {
    const runningIndices = rt.taskStatuses
      .map((status, idx) => (status === "running" ? idx : -1))
      .filter((idx) => idx !== -1);

    if (runningIndices.length > 1) {
      rt.displayState = "executing";
      rt.currentTaskIndex = runningIndices[0];
      const taskNumbers = runningIndices.map(idx => idx + 1).join(", ");
      rt.currentPhase = `Executing Tasks ${taskNumbers} concurrently`;
    } else if (runningIndices.length === 1) {
      const index = runningIndices[0];
      const task = rt.getTaskOrThrow(index);
      rt.currentTaskIndex = index;
      rt.displayState = "executing";
      rt.currentPhase = `Executing Task ${index + 1}/${rt.tasks.length}: ${task.title}`;
    }
    // When no tasks are running, leave display state unchanged (the caller
    // may be transitioning to reviewing/complete which sets its own state).
  };

  rt.updateExecutionPhase = () => {
    refreshExecutionDisplaysFromStatuses();
  };

  rt.transitionToExecuting = (index: number) => {
    const task = rt.getTaskOrThrow(index);
    rt.taskStatuses[index] = "running";
    setTaskConfiguredModel(rt.taskModels, index, rt.resolvedWorkerModel);
    rt.retryState = undefined;
    // Delegate display derivation to the shared helper (R2).
    refreshExecutionDisplaysFromStatuses();

    rt.log({
      severity: "info",
      source: "subagent",
      message: `Starting execution of Task: "${task.title}"`,
      details: {
        taskIndex: index,
        subagentRunId: `subagent-run-${rt.workflowRunId}-${index}`,
      }
    });
    rt.log({
      severity: "info",
      source: "subagent",
      message: `Description: ${task.description}`,
      details: {
        taskIndex: index,
        subagentRunId: `subagent-run-${rt.workflowRunId}-${index}`,
      }
    });
  };

  rt.transitionToReviewing = (index: number) => {
    const task = rt.getTaskOrThrow(index);
    rt.currentTaskIndex = index;
    rt.displayState = "reviewing";
    rt.retryState = undefined;
    rt.currentPhase = `Reviewing Task ${index + 1}/${rt.tasks.length}: ${task.title}`;
    rt.log(`Invoking ${rt.reviewProviderConfig.label} to review and fix any issues for: "${task.title}"`);
  };

  rt.transitionToBatchReviewing = () => {
    rt.currentTaskIndex = rt.tasks.length > 0 ? rt.tasks.length - 1 : -1;
    rt.displayState = "reviewing";
    rt.retryState = undefined;
    rt.currentPhase = `Reviewing All ${rt.tasks.length} Tasks`;
    rt.log(`Invoking ${rt.reviewProviderConfig.label} once to review and fix the complete workflow.`);
  };

  rt.preRetryDisplayState = undefined;

  rt.noteRetry = (attempt: number, maxAttempts: number) => {
    if (rt.displayState !== "retrying") {
      rt.preRetryDisplayState = rt.displayState;
    }
    rt.retryState = { attempt, maxAttempts };
    rt.displayState = "retrying";
  };

  rt.clearRetry = () => {
    rt.retryState = undefined;
    if (rt.displayState === "retrying") {
      rt.displayState = rt.preRetryDisplayState ?? (rt.currentTaskIndex < 0 ? "planning" : "executing");
      rt.preRetryDisplayState = undefined;
    }
  };

  rt.abortWorkflow = (reason?: string) => {
    rt.displayState = "cancelled";
    rt.currentPhase = reason ?? "cancelled";
  };

  rt.failWorkflow = (reason?: string) => {
    rt.displayState = "failed";
    rt.currentPhase = reason ?? "failed";
  };

  rt.noteReviewWarning = (warningMessage: string) => {
    rt.lastTaskWarning = warningMessage;
    rt.displayState = "warning";
  };

  rt.transitionToComplete = () => {
    rt.currentTaskIndex = rt.tasks.length;
    rt.displayState = "complete";
    rt.currentPhase = "Complete";
    rt.log("Workflow finished!");
  };

  rt.recordTaskResult = (taskIndex: number, result: TaskResult, structured?: SubagentStructuredReport | null) => {
    // Overwrite by task index instead of appending. Previously this pushed,
    // so a per-task repair loop that called recordTaskResult on every round
    // accumulated one row per round — a round-0 "review_blocked" entry
    // survived even after a round-1 success, polluting the summary, findings
    // rollup, run-state buffer, and persisted checkpoints (I1).
    rt.taskResults[taskIndex] = result;
    rt.runStateBuffer = mergeTaskResultIntoStateBuffer(rt.runStateBuffer, result, structured);
    try {
      rt.persistRunCheckpoint("executing");
    } catch {
      // best-effort checkpoint
    }
  };

  rt.buildTaskResultModelState = (index: number, fallback?: { configuredModel?: string; effectiveModel?: string }) => {
    const taskModelState = rt.taskModels[index];
    return {
      configuredModel: taskModelState?.configured || fallback?.configuredModel,
      effectiveModel: taskModelState?.effective || fallback?.effectiveModel,
    };
  };

  rt.throwIfAborted = () => {
    if (rt.signal?.aborted) {
      throw new Error("Workflow aborted by user");
    }
  };

  const buildWidgetState = (): CcReviewWidgetState => ({
    goal: rt.goal,
    tasks: rt.tasks.map((task, index) => {
      const modelState = rt.taskModels[index];
      return {
        title: task.title,
        status: rt.taskStatuses[index],
        model: resolveDisplayedTaskModel(modelState),
        modelState,
      };
    }),
    currentTaskIndex: rt.currentTaskIndex,
    displayState: rt.displayState,
    currentPhase: rt.currentPhase,
    retryState: rt.retryState,
    lastTaskWarning: rt.lastTaskWarning,
    liveLogs: rt.liveLogs,
    resolvedLogLevel: rt.resolvedLogLevel,
    resolvedLogSources: rt.resolvedLogSources,
    resolvedWidgetLogLines: rt.resolvedWidgetLogLines,
    resolvedChecklistWindow: rt.resolvedChecklistWindow,
    persistedLogPath: rt.persistedLogState.filePath,
    findingsRollup: rt.findingsRollup,
    taskStatuses: rt.taskStatuses,
    taskModels: rt.taskModels,
  });

  rt.refreshWorkflowUi = () => {
    if (rt.ctx?.ui?.setWidget) {
      const widgetState = buildWidgetState();
      const uiTheme = rt.ctx.ui.theme;
      if (uiTheme && typeof uiTheme.fg === "function") {
        rt.ctx.ui.setWidget("cc-review-widget", (_tui: unknown, theme: CcReviewWidgetTheme) => ({
          render: (renderWidth: number) =>
            buildCcReviewWidgetLines(widgetState, { width: renderWidth, theme }),
          invalidate: () => {},
        }));
      } else {
        rt.ctx.ui.setWidget(
          "cc-review-widget",
          buildCcReviewWidgetLines(widgetState, { width: WIDGET_MAX_WIDTH_DEFAULT })
        );
      }
    }

    const statusText = buildCcReviewStatusText({
      tasks: rt.tasks,
      currentTaskIndex: rt.currentTaskIndex,
      displayState: rt.displayState,
      retryState: rt.retryState,
      currentPhase: rt.currentPhase,
    });
    const uiTheme = rt.ctx?.ui?.theme;
    if (uiTheme && typeof uiTheme.fg === "function") {
      const color = getStatusColorForDisplayState(rt.displayState);
      rt.ctx?.ui?.setStatus?.("cc-review-status", uiTheme.fg(color, statusText));
    } else {
      rt.ctx?.ui?.setStatus?.("cc-review-status", statusText);
    }
  };

  // Helper to rt.log and update the widget & rt.onUpdate stream.
  //
  // Display surfaces (rebuilt from rt.pi examples — see truncated-tool.ts persisting
  // full output, todo.ts truncating to width, message-renderer.ts using severity
  // badges):
  // - Persisted JSONL rt.log file: bounded, full history; surfaced as a path so
  //   users can `read`/`cat` it after the compact TUI is cleared.
  // - TUI widget: width-truncated, windowed checklist, explicit empty/warning
  //   /cancelled states, last N live rt.log lines only.
  // - rt.onUpdate stream: compact delta for the single new entry rather than a
  //   re-broadcast of the full rt.goal/phase/last-5 markdown block. Phase changes
  //   still emit a one-line state header to give downstream consumers context.
  let lastSeenPhase: string | undefined;
  rt.log = (input: CcReviewLogInput) => {
    const entry = normalizeCcReviewLogEntry(input, { sequence: ++rt.logSequence });
    if (!entry.message) return;
    rt.liveLogs.push(entry);
    const maxLiveLogs = Math.max(50, rt.resolvedWidgetLogLines);
    if (rt.liveLogs.length > maxLiveLogs) {
      rt.liveLogs.shift();
    }

    // Persist full rt.log line to the workspace rt.log file.
    rt.persistedLogState = appendPersistedLogEntry(rt.persistedLogState, entry);

    // Update TUI widget with explicit empty/warning/cancelled states.
    rt.refreshWorkflowUi();

    // Emit a compact delta on the agent stream. Pi example pattern: keep tool
    // updates short so downstream LLMs aren't flooded by re-broadcast markdown.
    // The resolved rt.log level gates this compact surface: entries below the
    // threshold are skipped here but they were ALREADY persisted to the JSONL
    // rt.log a few lines above, so the on-disk record remains complete.
    if (rt.onUpdate && rt.resolvedWidgetLogLines > 0) {
      const entrySeverityForGate: CcReviewLogSeverity = SUPPORTED_LOG_SEVERITIES.includes(
        entry.severity as CcReviewLogSeverity
      )
        ? (entry.severity as CcReviewLogSeverity)
        : "info";
      const passesLogLevel = LOG_SEVERITY_RANK[entrySeverityForGate] >= LOG_SEVERITY_RANK[rt.resolvedLogLevel];
      const passesLogSources = rt.resolvedLogSources === undefined || rt.resolvedLogSources.includes(entry.source);
      if (passesLogLevel && passesLogSources) {
        const renderedDelta = renderCcReviewLogEntry(entry, { maxLineWidth: 120 });
        const deltaLines: string[] = [...renderedDelta];
        if (rt.currentPhase !== lastSeenPhase) {
          deltaLines.unshift(`▸ Phase: ${rt.currentPhase}`);
          lastSeenPhase = rt.currentPhase;
        }
        rt.onUpdate({
          content: [{ type: "text", text: deltaLines.join("\n") }],
          details: entry.details,
        });
      }
    }
  };

  // Emit a run-boundary entry as the first line of this run's rt.log so
  // individual runs remain separable in the accumulated workflow-logs.jsonl
  // (P2-1). Previously the file was truncated per run; now history is
  // preserved and this boundary marks where the current run begins.
  rt.log({
    severity: "info",
    source: "cc-review",
    message: `=== Workflow run ${rt.workflowRunId} started (provider=${rt.reviewProviderConfig.provider}, mode=${rt.reviewMode}) ===`,
  });

  // If the rt.log-level resolver flagged an invalid user input (bad flag or bad
  // env var) emit EXACTLY ONE warning entry so the workflow can continue with
  // the safe `info` default instead of crashing. The warning itself is `warn`
  // severity so it survives the `warning`/`error` thresholds and appears on
  // every compact surface AND in the persisted rt.log.
  if (rt.logLevelResolution.invalidInput) {
    const { source: invalidSource, raw } = rt.logLevelResolution.invalidInput;
    const rawDisplay = typeof raw === "string" ? raw : String(raw ?? "");
    rt.log({
      severity: "warning",
      source: "cc-review",
      message:
        `Ignoring invalid log level ${JSON.stringify(rawDisplay)} from ${invalidSource}; ` +
        `falling back to default 'info'.`,
    });
  }

  if (rt.logSourcesResolution.invalidInput) {
    const { source: invalidSource, raw } = rt.logSourcesResolution.invalidInput;
    const rawDisplay = typeof raw === "string" ? raw : String(raw ?? "");
    rt.log({
      severity: "warning",
      source: "cc-review",
      message:
        `Ignoring invalid log sources ${JSON.stringify(rawDisplay)} from ${invalidSource}; ` +
        `falling back to default 'all'.`,
    });
  }

  if (rt.taskTimeoutResolution.invalidInput) {
    const { source: invalidSource, raw } = rt.taskTimeoutResolution.invalidInput;
    const rawDisplay = typeof raw === "string" ? raw : String(raw ?? "");
    rt.log({
      severity: "warning",
      source: "cc-review",
      message:
        `Ignoring invalid task timeout ${JSON.stringify(rawDisplay)} from ${invalidSource}; ` +
        `falling back to default ${DEFAULT_TASK_TIMEOUT_MS}ms.`,
    });
  }

  // Clean up processes on abort
  rt.onAbort = () => {
    rt.abortWorkflow();
    rt.log({ severity: "warning", source: "cc-review", message: "Workflow aborted by user. Killing subprocesses..." });
    try {
      rt.persistRunCheckpoint("cancelled");
    } catch {
      // best-effort
    }
    const pidsToKill: number[] = [];
    for (const proc of rt.activeProcesses) {
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
      rt.activeProcesses.clear();
    }, 500);
  };

  if (rt.signal) {
    rt.signal.addEventListener("abort", rt.onAbort);
  }

  rt.runProcess = async (
    label: string,
    command: string,
    args: string[],
    onStdout: (data: Buffer) => void,
    onStderr: (data: Buffer) => void,
    timeoutMs?: number
  ): Promise<ProcessResult> => {
    rt.throwIfAborted();

    let heartbeatTimer: NodeJS.Timeout | undefined;
    let heartbeatElapsed = 0;
    heartbeatTimer = setInterval(() => {
      heartbeatElapsed += SUBPROCESS_HEARTBEAT_MS;
      rt.log({
        severity: "info",
        source: label.includes("planner") ? "planner" : label.includes("reviewer") || label.includes("review") ? "reviewer" : "subagent",
        message: `${label} still running (${Math.round(heartbeatElapsed / 1000)}s)...`,
      });
    }, SUBPROCESS_HEARTBEAT_MS);

    const subprocessResult = await runSubprocess({
      label,
      command,
      args,
      cwd: rt.ctx?.cwd ?? process.cwd(),
      timeoutMs,
      signal: rt.signal,
      traceCtx: rt.ctx,
      onStdoutChunk: onStdout,
      onStderrChunk: onStderr,
      registerProc(proc) {
        rt.activeProcesses.add(proc);
        return () => rt.activeProcesses.delete(proc);
      },
      abortMode: "external",
    }).finally(() => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    });

    if (subprocessResult.spawnError) {
      throw new Error(`${label} failed to start: ${subprocessResult.spawnError.message}`);
    }
    if (subprocessResult.timedOut) {
      rt.log(`[Timeout] ${label} exceeded timeout of ${timeoutMs}ms. Killing process group...`);
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    if (rt.signal?.aborted || subprocessResult.aborted) {
      throw new Error("Workflow aborted by user");
    }

    const exitCode = subprocessResult.code ?? (subprocessResult.signal ? 1 : 0);
    return {
      code: exitCode,
      exitCode,
      stdout: subprocessResult.stdout,
      stderr: subprocessResult.stderr,
      combinedOutput: subprocessResult.combinedOutput,
      output: subprocessResult.combinedOutput,
    };
  };

  // Wrapper around rt.runProcess for reviewer subprocesses that applies the
  // configured reviewer timeout (P0-4) and treats a timeout as a synthetic
  // non-zero exit (exit code 124) instead of letting the rejection propagate
  // and abort the whole workflow. The existing deriveEffectiveVerdict logic
  // then classifies the non-zero exit as ship_with_warnings.
  rt.runReviewerProcess = (
    label: string,
    command: string,
    args: string[]
  ): Promise<ProcessResult> => {
    const stdoutLogger = createSubprocessStreamLogger(rt.log, "stdout", "reviewer");
    const stderrLogger = createSubprocessStreamLogger(rt.log, "stderr", "reviewer");
    const processPromise = rt.runProcess(
      label,
      command,
      args,
      (data) => stdoutLogger.write(data),
      (data) => stderrLogger.write(data),
      rt.resolvedReviewerTimeoutMs > 0 ? rt.resolvedReviewerTimeoutMs : undefined
    ).finally(() => {
      stdoutLogger.flush();
      stderrLogger.flush();
    });
    return processPromise.catch((err: any) => {
      const errorMessage = err?.message || String(err);
      if (/timed out/i.test(errorMessage)) {
        rt.log({
          severity: "warning",
          source: "reviewer",
          message: `${label} timed out after ${rt.resolvedReviewerTimeoutMs}ms; continuing with warnings.`,
        });
        emitTrace(rt.ctx, "failure", {
          phase: "reviewer_timeout",
          label,
          command,
          timeoutMs: rt.resolvedReviewerTimeoutMs,
        });
        const syntheticStderr = `Reviewer timed out after ${rt.resolvedReviewerTimeoutMs}ms`;
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

  rt.runVerificationCommand = runVerificationCommand;

  return rt;
}
