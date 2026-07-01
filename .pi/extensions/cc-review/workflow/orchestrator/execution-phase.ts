import * as fs from "node:fs";

import {
  buildFindingsPayload,
  deriveEffectiveVerdict,
  mapEffectiveVerdictToTaskStatus,
  parseReviewResult,
  runPostReviewValidation,
  snapshotWorkspace,
  updateFindingsRollup,
  workspaceSnapshotChanged,
  type SchemaParseStatus,
  type SubagentStructuredReport,
  type TaskStatus,
} from "../../structured.ts";
import { buildAfterAllExecutionBatches, runWithConcurrencyLimit } from "../dependencies.ts";
import { emitTrace } from "../../subprocess.ts";
import {
  readAvailableCpuCount,
  resolveCcReviewConcurrency,
} from "../../config.ts";
import { extractAssistantTextFromStream, formatSubprocessStreamLine } from "../stream-format.ts";
import { validateSubagentOutput } from "../validation.ts";
import { delay, isTransientError } from "../util.ts";
import type { SubagentResult, SubagentToolResult, TaskResult } from "../types.ts";
import { WorkflowError } from "../types.ts";
import { buildCcReviewSummaryMeta, buildSummaryReport, setTaskEffectiveModel } from "../summary.ts";
import {
  appendUnique,
  buildSubagentTaskPrompt,
  extractSubagentText,
  getSubagentExecutor,
  getSubagentExitCode,
  priorTaskHandoffFromResults,
  summarizeParentContext,
} from "../execution.ts";
import { buildRepairFeedback } from "../review.ts";
import { formatStateBufferForPrompt } from "../session.ts";
import { resolvePriorTaskSessionPath } from "../session-continuity.ts";
import {
  readStructuredOutputFile,
  resolveStructuredOutputFile,
  resolveStructuredOutputStrict,
} from "../structured-output.ts";
import type { Task } from "../dependencies.ts";
import type { WorkflowRuntime } from "./runtime.ts";

// ─── R5: Shared worker execution helper ─────────────────────────────────────
// Extracted from the duplicated after-all and per-task branches to prevent
// R1-class drift. Both branches call this and then apply only their
// mode-specific orchestration.

interface WorkerExecutionOptions {
  /** Task-level abort signal (taskAbortControllers[i].signal or a per-task controller wired to rt.signal). */
  taskAbortSignal: AbortSignal;
  /** Prior results for handoff context. */
  priorResults: TaskResult[];
  /** Initial retry feedback (for repair rounds in per-task mode). */
  initialRetryFeedback?: string;
  /** subagentRunId for trace/log correlation (after-all mode). */
  subagentRunId?: string;
  /** Whether to use structured log entries with taskIndex and subagentRunId (after-all mode). */
  structuredLogging: boolean;
  /** Whether to call noteRetry/clearRetry (per-task mode). */
  trackRetryState: boolean;
}

interface WorkerExecutionResult {
  subagentResult: SubagentResult;
  subagentOutputText: string;
  validationError: string | undefined;
  unresolvedItems: string[] | undefined;
  taskStatus: TaskStatus;
  structuredReport: SubagentStructuredReport | null;
  schemaParseStatus: SchemaParseStatus;
  cachedSubagentResult: SubagentToolResult;
  taskStartedAt: string;
}

async function executeWorkerAttempts(
  rt: WorkflowRuntime,
  task: Task,
  index: number,
  opts: WorkerExecutionOptions
): Promise<WorkerExecutionResult> {
  const taskStartedAt = new Date().toISOString();
  let cachedSubagentResult: SubagentToolResult = {};
  let structuredReport: SubagentStructuredReport | null = null;
  let schemaParseStatus: SchemaParseStatus = "absent";

  const summarizedParentContext = summarizeParentContext(rt.goal);
  const priorHandoff = priorTaskHandoffFromResults(opts.priorResults);
  const stateBufferSection = formatStateBufferForPrompt(rt.runStateBuffer);
  const structuredOutput = resolveStructuredOutputFile(
    rt.artifactRunDir,
    index,
    resolveStructuredOutputStrict(),
  );
  const subagentPrompt = buildSubagentTaskPrompt(
    task,
    summarizedParentContext,
    priorHandoff,
    stateBufferSection,
    structuredOutput?.promptInstruction,
  );
  let subagentResult: SubagentResult = { code: 0 };
  let subagentOutputText = "";
  let validationError: string | undefined = undefined;
  let unresolvedItems: string[] | undefined = undefined;
  let taskStatus: TaskResult["status"] = "completed";
  let retryFeedback: string | undefined = opts.initialRetryFeedback;
  const unresolvedItemsForFailedTask: string[] = [];

  const maxTaskExecutionRetries = 2;
  const maxTaskExecutionAttempts = maxTaskExecutionRetries + 1;

  for (let attempt = 1; attempt <= maxTaskExecutionAttempts; attempt++) {
    if (rt.signal?.aborted || opts.taskAbortSignal.aborted) {
      throw new Error("Workflow aborted by user");
    }
    if (attempt > 1) {
      if (opts.trackRetryState) {
        rt.noteRetry(attempt, maxTaskExecutionAttempts);
        rt.log(`Retrying task execution in subagent (attempt ${attempt}/${maxTaskExecutionAttempts})...`);
      } else {
        rt.log({
          severity: "info",
          source: "subagent",
          message: `[Task ${index + 1}] Retrying task execution in subagent (attempt ${attempt}/${maxTaskExecutionAttempts})...`,
          details: { taskIndex: index, subagentRunId: opts.subagentRunId },
        });
      }
    } else if (opts.trackRetryState) {
      rt.clearRetry();
    }

    // A retry must produce a fresh result. Otherwise an output file left by a
    // previous attempt could make a later non-writing attempt appear valid.
    if (structuredOutput) {
      try {
        fs.rmSync(structuredOutput.outputPath, { force: true });
      } catch {
        // The subsequent read reports a precise failure if cleanup/write fails.
      }
    }

    const attemptPrompt = retryFeedback
      ? [
          subagentPrompt,
          "Previous attempt feedback:",
          retryFeedback,
          "Resolve the previous attempt's errors or unresolved items before reporting completion.",
        ].join("\n\n")
      : subagentPrompt;

    emitTrace(rt.ctx, "subagent_assignment", {
      role: "executor",
      agent: "worker",
      taskIndex: index,
      ...(opts.subagentRunId ? { subagentRunId: opts.subagentRunId } : {}),
      attempt,
      model: rt.resolvedWorkerModel,
    });

    emitTrace(rt.ctx, "tool_execution_start", {
      taskIndex: opts.structuredLogging ? index : rt.currentTaskIndex,
      ...(opts.subagentRunId ? { subagentRunId: opts.subagentRunId } : {}),
      toolName: "subagent",
      source: "_subagent",
      model: rt.resolvedWorkerModel,
    });

    const executeSubagentTool = getSubagentExecutor(rt.pi);
    let result: SubagentToolResult = {};
    const maxTransientRetries = 3;
    let transientAttempt = 1;
    let transientDone = false;

    while (transientAttempt <= maxTransientRetries && !transientDone) {
      if (rt.signal?.aborted || opts.taskAbortSignal.aborted) {
        throw new Error("Workflow aborted by user");
      }

      const attemptAbortController = new AbortController();
      const onTaskAbort = () => {
        attemptAbortController.abort();
      };
      opts.taskAbortSignal.addEventListener("abort", onTaskAbort);

      const subagentTimeoutMs = rt.resolvedTaskTimeoutMs;
      const timeoutTimer = subagentTimeoutMs > 0
        ? setTimeout(() => {
            if (opts.structuredLogging) {
              rt.log({
                severity: "warning",
                source: "subagent",
                message: `[Timeout] [Task ${index + 1}] Subagent task execution exceeded timeout of ${subagentTimeoutMs}ms. Aborting subagent...`,
                details: { taskIndex: index, subagentRunId: opts.subagentRunId },
              });
            } else {
              rt.log(`[Timeout] Subagent task execution exceeded timeout of ${subagentTimeoutMs}ms. Aborting subagent...`);
            }
            attemptAbortController.abort(new Error(`Subagent execution timed out after ${subagentTimeoutMs}ms`));
          }, subagentTimeoutMs)
        : undefined;

      try {
        result = await executeSubagentTool(
          "subagent",
          {
            agent: "worker",
            task: attemptPrompt,
            agentScope: "both",
            cwd: rt.ctx?.cwd ?? process.cwd(),
            // P1-1: pass session continuity context so the fallback executor
            // can use --session <file> instead of --no-session when enabled.
            artifactRunDir: rt.artifactRunDir,
            taskIndex: index,
            workflowRunId: rt.workflowRunId,
            priorSessionPath: resolvePriorTaskSessionPath(
              index,
              task.dependsOn,
              rt.taskSessionPaths,
            ),
          },
          attemptAbortController.signal,
          (partial) => {
            const subagentText = partial?.content?.find(
              (item: any) => item?.type === "text" && item.text
            )?.text;
            if (subagentText) {
              const formatted = formatSubprocessStreamLine(subagentText);
              if (formatted !== null) {
                if (opts.structuredLogging) {
                  rt.log({
                    severity: "info",
                    source: "subagent",
                    message: `[Subagent - Task ${index + 1}] ${formatted}`,
                    details: { subagentRunId: opts.subagentRunId, taskIndex: index }
                  });
                } else {
                  rt.log(`[Subagent] ${formatted}`);
                }
              }
            }
            const partialModel = partial?.model || partial?.details?.results?.[0]?.model;
            if (partialModel) {
              setTaskEffectiveModel(rt.taskModels, index, partialModel);
              rt.refreshWorkflowUi();
            }
            if (rt.onUpdate) {
              if (opts.structuredLogging) {
                rt.onUpdate({
                  ...partial,
                  model: partialModel || partial?.model,
                  details: {
                    ...partial?.details,
                    results: Array.isArray(partial?.details?.results)
                      ? partial.details.results
                      : partialModel
                        ? [{ model: partialModel }]
                        : partial?.details?.results,
                    subagentRunId: opts.subagentRunId,
                    taskIndex: index,
                  }
                });
              } else {
                rt.onUpdate(partial);
              }
            }
          },
          rt.ctx
        );

        const subagentFailure = result.details?.results?.[0];
        const errorMsg = result.isError
          ? (subagentFailure?.errorMessage || subagentFailure?.stderr || extractSubagentText(result) || "Subagent execution error")
          : "";

        if (result.isError && isTransientError(errorMsg)) {
          if (transientAttempt < maxTransientRetries) {
            const backoff = Math.pow(2, transientAttempt) * 1000;
            if (opts.structuredLogging) {
              rt.log({
                severity: "warning",
                source: "subagent",
                message: `[Transient Error] [Task ${index + 1}] Subagent tool call failed with transient error: "${errorMsg}". Retrying in ${backoff}ms... (Attempt ${transientAttempt}/${maxTransientRetries})`,
                details: { taskIndex: index, subagentRunId: opts.subagentRunId },
              });
            } else {
              rt.log(`[Transient Error] Subagent tool call failed with transient error: "${errorMsg}". Retrying in ${backoff}ms... (Attempt ${transientAttempt}/${maxTransientRetries})`);
            }
            await delay(backoff, opts.taskAbortSignal);
            transientAttempt++;
            continue;
          }
        }
        transientDone = true;
      } catch (err: any) {
        if (rt.signal?.aborted || opts.taskAbortSignal.aborted) {
          throw new Error("Workflow aborted by user");
        }
        const errorMessage = err?.message || String(err);
        if (isTransientError(errorMessage) && transientAttempt < maxTransientRetries) {
          const backoff = Math.pow(2, transientAttempt) * 1000;
          if (opts.structuredLogging) {
            rt.log({
              severity: "warning",
              source: "subagent",
              message: `[Transient Error] [Task ${index + 1}] Subagent tool call threw transient exception: "${errorMessage}". Retrying in ${backoff}ms... (Attempt ${transientAttempt}/${maxTransientRetries})`,
              details: { taskIndex: index, subagentRunId: opts.subagentRunId },
            });
          } else {
            rt.log(`[Transient Error] Subagent tool call threw transient exception: "${errorMessage}". Retrying in ${backoff}ms... (Attempt ${transientAttempt}/${maxTransientRetries})`);
          }
          await delay(backoff, opts.taskAbortSignal);
          transientAttempt++;
          continue;
        }
        emitTrace(rt.ctx, "failure", {
          phase: "subagent_execution",
          taskIndex: opts.structuredLogging ? index : rt.currentTaskIndex,
          ...(opts.subagentRunId ? { subagentRunId: opts.subagentRunId } : {}),
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
        opts.taskAbortSignal.removeEventListener("abort", onTaskAbort);
      }
    }

    const resultCode = getSubagentExitCode(result);
    const effectiveModel = result.model || result.details?.results?.[0]?.model;
    // P1-1: capture the session path from the fallback executor so the next
    // sequential task can chain from it (when continuity is enabled).
    const sessionPath = result.details?.results?.[0]?.sessionPath;
    if (sessionPath) {
      rt.taskSessionPaths[index] = sessionPath;
    }
    subagentResult = {
      code: resultCode,
      configuredModel: rt.taskModels[index]?.configured || rt.resolvedWorkerModel,
      effectiveModel,
    };
    if (effectiveModel) {
      setTaskEffectiveModel(rt.taskModels, index, effectiveModel);
    }
    emitTrace(rt.ctx, "tool_execution_end", {
      taskIndex: opts.structuredLogging ? index : rt.currentTaskIndex,
      ...(opts.subagentRunId ? { subagentRunId: opts.subagentRunId } : {}),
      toolName: "subagent",
      source: "_subagent",
      exitCode: resultCode,
      model: effectiveModel,
    });

    subagentOutputText = extractSubagentText(result);

    // Validate subagent outputs
    let resultForValidation = result;
    let strictOutputError: string | undefined;
    if (structuredOutput && !result.isError) {
      const fileResult = readStructuredOutputFile(structuredOutput.outputPath);
      if (fileResult.error) {
        strictOutputError = fileResult.error;
      } else {
        resultForValidation = {
          ...result,
          content: [{ type: "text", text: JSON.stringify(fileResult.parsed) }],
        };
      }
    }
    const validation = strictOutputError
      ? {
          valid: false,
          error: strictOutputError,
          unresolvedItems: [strictOutputError],
          schemaParseStatus: "absent" as SchemaParseStatus,
        }
      : validateSubagentOutput(resultForValidation, task, {
          // Strict mode always requires the file-backed JSON contract.
          allowTextValidation: structuredOutput ? false : rt.allowTextValidation,
        });
    structuredReport = validation.structuredReport ?? null;
    schemaParseStatus = validation.schemaParseStatus ?? "absent";
    // Review-phase revalidation must inspect the same file-backed report that
    // was accepted here, not the worker's optional prose response.
    cachedSubagentResult = resultForValidation;
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
      if (opts.structuredLogging) {
        rt.log({
          severity: "info",
          source: "subagent",
          message: `[Subagent Execution Done] [Task ${index + 1}] Completed and validated.`,
          details: { taskIndex: index, subagentRunId: opts.subagentRunId },
        });
      } else {
        rt.log(`[Subagent Execution Done] Task completed and validated.`);
      }
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
        emitTrace(rt.ctx, "retry", {
          phase: "execution",
          taskIndex: index,
          ...(opts.subagentRunId ? { subagentRunId: opts.subagentRunId } : {}),
          attempt,
          maxAttempts: maxTaskExecutionAttempts,
          error: errorMsg,
        });
      } else {
        if (opts.structuredLogging) {
          rt.log({
            severity: "error",
            source: "subagent",
            message: `[Subagent Execution Failure] [Task ${index + 1}] ${errorMsg}`,
            details: { taskIndex: index, subagentRunId: opts.subagentRunId },
          });
        } else {
          rt.log(`[Subagent Execution Failure] ${errorMsg}`);
        }
        taskStatus = resultCode === 0 ? "validation_failed" : "failed";
      }
    }
  }

  return {
    subagentResult,
    subagentOutputText,
    validationError,
    unresolvedItems,
    taskStatus,
    structuredReport,
    schemaParseStatus,
    cachedSubagentResult,
    taskStartedAt,
  };
}

/** Shared early-termination gate: write a failed-task artifact and record the result. */
function writeFailedTaskArtifact(
  rt: WorkflowRuntime,
  task: Task,
  index: number,
  exec: WorkerExecutionResult,
): string {
  const completedAt = new Date().toISOString();
  return rt.writeTaskArtifactForIndex({
    taskIndex: index,
    task,
    startedAt: exec.taskStartedAt,
    completedAt,
    execution: {
      exitCode: exec.subagentResult.code,
      status: exec.taskStatus,
      rawOutput: exec.subagentOutputText,
      structuredReport: exec.structuredReport,
      schemaParseStatus: exec.schemaParseStatus,
      model: exec.subagentResult.effectiveModel,
    },
    review: {
      provider: rt.reviewProviderConfig.provider,
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
      error: exec.validationError ?? "execution failed",
      unresolvedItems: exec.unresolvedItems ?? [],
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
}

// ─── Main execution phase ───────────────────────────────────────────────────

export async function runExecutionPhase(rt: WorkflowRuntime): Promise<void> {
    rt.persistRunCheckpoint("executing");

    // If the concurrency was automatically resolved, adjust it based on the actual planned tasks count
    if (rt.concurrencyResolution.source === "default") {
      rt.resolvedConcurrency = resolveCcReviewConcurrency({
        flag: rt.options.concurrency ?? rt.options.concurrencyLimit,
        env: process.env,
        cpuCount: readAvailableCpuCount(process.env),
        taskCount: rt.tasks.length,
      }).concurrency;
    }

    emitTrace(rt.ctx, "execution_config", {
      concurrency: rt.resolvedConcurrency,
      concurrencySource: rt.concurrencyResolution.source,
      taskCount: rt.tasks.length,
      cpuCount: readAvailableCpuCount(process.env),
    });

    // PHASE 2: Task Execution Loop
    if (rt.reviewMode === "after-all") {
      const executionBatches = buildAfterAllExecutionBatches(rt.tasks);
      const parallelBatchCount = executionBatches.filter((batch) => batch.length > 1).length;
      rt.log(
        `Running ${rt.tasks.length} subagent tasks in ${executionBatches.length} dependency-aware batch${executionBatches.length === 1 ? "" : "es"} with concurrency limit of ${rt.resolvedConcurrency}${parallelBatchCount > 0 ? ` (${parallelBatchCount} parallel-capable)` : ""}...`
      );

      const taskAbortControllers: AbortController[] = rt.tasks.map(() => new AbortController());
      const parentAbortHandler = () => {
        for (const controller of taskAbortControllers) {
          controller.abort();
        }
      };
      if (rt.signal) {
        rt.signal.addEventListener("abort", parentAbortHandler);
      }

      let executionError: any = null;

      try {
        for (let batchIndex = 0; batchIndex < executionBatches.length; batchIndex++) {
          rt.throwIfAborted();
          const batch = executionBatches[batchIndex];
          const batchPriorResults = rt.taskResults.filter(
            (result): result is TaskResult => result !== undefined
          );
          const taskNumbers = batch.map(({ index }) => index + 1).join(", ");
          rt.log({
            severity: "info",
            source: "cc-review",
            message: `[Execution Batch ${batchIndex + 1}/${executionBatches.length}] Starting task${batch.length === 1 ? "" : "s"} ${taskNumbers}${batch.length > 1 && rt.resolvedConcurrency > 1 ? " concurrently" : ""}.`,
            details: {
              batchIndex,
              taskIndices: batch.map(({ index }) => index),
              concurrency: rt.resolvedConcurrency,
            },
          });

          await runWithConcurrencyLimit(rt.resolvedConcurrency, batch, async (batchItem, _itemIndex, batchSignal) => {
            const task = batchItem.task;
            const i = batchItem.index;
            rt.throwIfAborted();

            if (rt.skipTaskIndices.has(i)) {
              rt.log({
                severity: "info",
                source: "cc-review",
                message: `Skipping Task ${i + 1}/${rt.tasks.length} "${task.title}" (already completed — resume).`,
              });
              return;
            }

            // Wire the batch-level cancel signal into this task's abort
            // controller so an unexpected error in a sibling aborts this
            // task promptly (R3).
            if (batchSignal.aborted) {
              taskAbortControllers[i].abort();
            } else {
              batchSignal.addEventListener("abort", () => taskAbortControllers[i].abort(), { once: true });
            }

            const subagentRunId = `subagent-run-${rt.workflowRunId}-${i}`;
            rt.taskStatuses[i] = "running";
            rt.transitionToExecuting(i);

            // Shared execution helper (R5).
            const exec = await executeWorkerAttempts(rt, task, i, {
              taskAbortSignal: taskAbortControllers[i].signal,
              priorResults: batchPriorResults,
              subagentRunId,
              structuredLogging: true,
              trackRetryState: false,
            });

            // Early Termination Gate
            if (exec.taskStatus === "failed" || exec.taskStatus === "validation_failed") {
              rt.log({
                severity: "warning",
                source: "cc-review",
                message: `[Workflow Halted] Halting workflow due to unrecoverable task failure on: "${task.title}".`,
                details: { taskIndex: i, subagentRunId },
              });
              const artifactPath = writeFailedTaskArtifact(rt, task, i, exec);
              rt.taskStatuses[i] = exec.taskStatus;
              const res: TaskResult = {
                title: task.title,
                description: task.description,
                executionCode: exec.subagentResult.code,
                reviewCode: -1,
                output: exec.subagentOutputText,
                validationError: exec.validationError,
                unresolvedItems: exec.unresolvedItems,
                status: exec.taskStatus,
                artifactPath,
                structuredReport: exec.structuredReport ?? undefined,
                schemaParseStatus: exec.schemaParseStatus,
                ...rt.buildTaskResultModelState(i, exec.subagentResult),
              };
              // Route through recordTaskResult for state buffer + checkpoint (R1).
              rt.recordTaskResult(i, res, exec.structuredReport);
              rt.updateExecutionPhase();
              rt.refreshWorkflowUi();

              // Trigger abort on all other tasks
              for (const controller of taskAbortControllers) {
                controller.abort();
              }
              throw new Error(`Task execution failed unrecoverably on: "${task.title}" (${exec.validationError || "exit code " + exec.subagentResult.code})`);
            }

            const result: TaskResult = {
              title: task.title,
              description: task.description,
              executionCode: exec.subagentResult.code,
              reviewCode: -1,
              output: exec.subagentOutputText,
              validationError: exec.validationError,
              unresolvedItems: exec.unresolvedItems,
              status: "completed",
              structuredReport: exec.structuredReport ?? undefined,
              schemaParseStatus: exec.schemaParseStatus,
              ...rt.buildTaskResultModelState(i, exec.subagentResult),
            };
            rt.taskStatuses[i] = "completed";
            // Set batchTaskExecutions[i] BEFORE recordTaskResult so the
            // checkpoint persisted inside recordTaskResult captures it (R1).
            rt.batchTaskExecutions[i] = {
              taskIndex: i,
              task,
              startedAt: exec.taskStartedAt,
              subagentResult: exec.subagentResult,
              subagentOutputText: exec.subagentOutputText,
              cachedSubagentResult: exec.cachedSubagentResult,
              validationError: exec.validationError,
              unresolvedItems: exec.unresolvedItems,
              structuredReport: exec.structuredReport,
              schemaParseStatus: exec.schemaParseStatus,
              result,
            };
            // Route through recordTaskResult for state buffer + checkpoint (R1).
            rt.recordTaskResult(i, result, exec.structuredReport);
            rt.log({
              severity: "info",
              source: "subagent",
              message: `[Task Execution Done] [Task ${i + 1}] Queued "${task.title}" for the final workflow review.`,
              details: { taskIndex: i, subagentRunId },
            });
            rt.updateExecutionPhase();
            rt.refreshWorkflowUi();
          });
        }
      } catch (err: any) {
        executionError = err;
      } finally {
        if (rt.signal) {
          rt.signal.removeEventListener("abort", parentAbortHandler);
        }
      }

      if (executionError) {
        const isCancelled =
          rt.signal?.aborted ||
          executionError.message?.includes("aborted") ||
          executionError.message?.includes("timeout") ||
          executionError.message?.includes("cancel");

        // Fill remaining/unexecuted slots to prevent crash in downstream report/UI code
        for (let idx = 0; idx < rt.tasks.length; idx++) {
          if (!rt.taskResults[idx]) {
            const wasStarted = rt.taskStatuses[idx] !== undefined;
            if (wasStarted || !isCancelled) {
              rt.taskResults[idx] = {
                title: rt.tasks[idx].title,
                description: rt.tasks[idx].description,
                executionCode: -1,
                reviewCode: -1,
                output: "",
                status: isCancelled ? "cancelled" : "failed",
                ...rt.buildTaskResultModelState(idx, { configuredModel: rt.resolvedWorkerModel }),
              };
            }
          }
        }
        throw executionError;
      }

      // Filter out any undefined/sparse values in rt.batchTaskExecutions to keep it compact and correct for subsequent stages
      const activeBatchTaskExecutions = rt.batchTaskExecutions.filter(Boolean);
      rt.batchTaskExecutions.length = 0;
      rt.batchTaskExecutions.push(...activeBatchTaskExecutions);
    } else {
      // ── Per-task mode ──────────────────────────────────────────────────
      for (let i = 0; i < rt.tasks.length; i++) {
        rt.throwIfAborted();
        const task = rt.tasks[i];
        if (rt.skipTaskIndices.has(i)) {
          rt.log({
            severity: "info",
            source: "cc-review",
            message: `Skipping Task ${i + 1}/${rt.tasks.length} "${task.title}" (already completed — resume).`,
          });
          continue;
        }
        rt.transitionToExecuting(i);

        // Repair feedback from a reviewer "block" verdict, injected into the next
        // worker attempt so the subagent can fix the reviewer's findings
        // instead of hard-failing the whole workflow (P1-1).
        let repairFeedback: string | undefined = undefined;
        let repairRequiresPostReviewValidation = false;

        // Reviewer-block repair loop (P1-1): when the reviewer returns a "block"
        // verdict, re-dispatch the worker with the reviewer's findings as
        // feedback, then re-review, up to rt.maxReviewRepairRounds. Only hard-fail
        // after the bound is hit.
        REPAIR_LOOP: for (let repairRound = 0; ; repairRound++) {
          if (repairRound > 0) {
            rt.transitionToExecuting(i);
            rt.log({
              severity: "info",
              source: "cc-review",
              message: `[Repair] Reviewer blocked "${task.title}". Re-executing with reviewer feedback (repair round ${repairRound}/${rt.maxReviewRepairRounds})...`,
            });
          }

          // Per-task abort controller, wired to the workflow signal.
          const taskAbortController = new AbortController();
          const onParentAbort = () => taskAbortController.abort();
          if (rt.signal) {
            rt.signal.addEventListener("abort", onParentAbort);
          }

          let exec: WorkerExecutionResult;
          try {
            // Shared execution helper (R5).
            exec = await executeWorkerAttempts(rt, task, i, {
              taskAbortSignal: taskAbortController.signal,
              priorResults: rt.taskResults,
              initialRetryFeedback: repairRound > 0 ? repairFeedback : undefined,
              structuredLogging: false,
              trackRetryState: true,
            });
          } finally {
            if (rt.signal) {
              rt.signal.removeEventListener("abort", onParentAbort);
            }
          }

          // Early Termination Gate
          if (exec.taskStatus === "failed" || exec.taskStatus === "validation_failed") {
            rt.log(`[Workflow Halted] Halting workflow due to unrecoverable task failure on: "${task.title}".`);
            const artifactPath = writeFailedTaskArtifact(rt, task, i, exec);
            rt.taskStatuses[i] = exec.taskStatus;
            rt.recordTaskResult(i, {
              title: task.title,
              description: task.description,
              executionCode: exec.subagentResult.code,
              reviewCode: -1,
              output: exec.subagentOutputText,
              validationError: exec.validationError,
              unresolvedItems: exec.unresolvedItems,
              status: exec.taskStatus,
              artifactPath,
              structuredReport: exec.structuredReport ?? undefined,
              schemaParseStatus: exec.schemaParseStatus,
              ...rt.buildTaskResultModelState(i, exec.subagentResult),
            }, exec.structuredReport);
            throw new Error(`Task execution failed unrecoverably on: "${task.title}" (${exec.validationError || "exit code " + exec.subagentResult.code})`);
          }

          // Part B: Review and Fix with the configured review provider
          rt.transitionToReviewing(i);

          emitTrace(rt.ctx, "subagent_assignment", {
            role: "reviewer",
            agent: rt.reviewProviderConfig.provider,
            taskIndex: i,
          });

          const reviewArgs = rt.reviewProviderConfig.buildArgs({ task });
          const workspaceBeforeReview = snapshotWorkspace(rt.workflowCwd);

          const reviewProcessResult = await rt.runReviewerProcess(
            rt.reviewProviderConfig.label,
            rt.reviewProviderConfig.command,
            reviewArgs
          );

          const workspaceAfterReview = snapshotWorkspace(rt.workflowCwd);
          const workspaceChanged = workspaceSnapshotChanged(workspaceBeforeReview, workspaceAfterReview);
          const reviewText = extractAssistantTextFromStream(reviewProcessResult.combinedOutput);
          const parsedReview = parseReviewResult(reviewText);
          const reviewResultObject = parsedReview.result;
          const findings = reviewResultObject?.findings ?? [];
          const reportedVerdict = reviewResultObject?.verdict ?? null;
          const rerunValidation = validateSubagentOutput(exec.cachedSubagentResult, task, { allowTextValidation: rt.allowTextValidation });
          const postReview = await runPostReviewValidation({
            reviewResult: reviewResultObject,
            workspaceChanged: workspaceChanged || repairRequiresPostReviewValidation,
            verificationPlan: rt.verificationPlan,
            runCommand: rt.runVerificationCommand,
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
          const taskStatus = mapEffectiveVerdictToTaskStatus(effectiveVerdict);
          let reviewerExitDiagnostic: string | undefined;
          if (reviewProcessResult.exitCode !== 0 && effectiveVerdict === "ship") {
            reviewerExitDiagnostic = `Reviewer exited non-zero (code ${reviewProcessResult.exitCode}) despite ship verdict`;
          }

          if (reviewProcessResult.exitCode !== 0 && effectiveVerdict === "ship_with_warnings") {
            const warningMessage = `${rt.reviewProviderConfig.label} exited with code ${reviewProcessResult.exitCode}`;
            rt.noteReviewWarning(warningMessage);
            rt.log({ severity: "warning", source: "reviewer", message: `[Review Warning] ${warningMessage}` });
          } else if (effectiveVerdict === "ship") {
            rt.log(`[Review Done] ${rt.reviewProviderConfig.label} completed the review.`);
          } else if (effectiveVerdict === "ship_with_warnings") {
            rt.log({
              severity: "warning",
              source: "reviewer",
              message: `[Review Warning] ${rt.reviewProviderConfig.label} reported warnings.`,
            });
          }

          const completedAt = new Date().toISOString();
          const artifactPath = rt.writeTaskArtifactForIndex({
            taskIndex: i,
            task,
            startedAt: exec.taskStartedAt,
            completedAt,
            execution: {
              exitCode: exec.subagentResult.code,
              status: taskStatus,
              rawOutput: exec.subagentOutputText,
              structuredReport: exec.structuredReport,
              schemaParseStatus: exec.schemaParseStatus,
              model: exec.subagentResult.effectiveModel,
            },
            review: {
              provider: rt.reviewProviderConfig.provider,
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

          await rt.emitFindingsMessage(
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
          rt.taskStatuses[i] = taskStatus;
          rt.refreshWorkflowUi();

          if (effectiveVerdict === "block") {
            if (repairRound >= rt.maxReviewRepairRounds) {
              rt.collectedTaskFindings.push(findings);
              rt.findingsRollup = updateFindingsRollup(rt.findingsRollup, effectiveVerdict, findings);
              rt.hasCompletedReview = true;
              rt.recordTaskResult(i, {
                title: task.title,
                description: task.description,
                executionCode: exec.subagentResult.code,
                reviewCode: reviewProcessResult.exitCode,
                output: exec.subagentOutputText,
                validationError: exec.validationError,
                unresolvedItems: exec.unresolvedItems,
                reviewWarningName: rt.reviewProviderConfig.warningName,
                status: taskStatus,
                artifactPath,
                structuredReport: exec.structuredReport ?? undefined,
                schemaParseStatus: exec.schemaParseStatus,
                reviewResult: reviewResultObject ?? undefined,
                reportedVerdict,
                effectiveVerdict,
                blockReason: derived.blockReason,
                reviewerExitDiagnostic,
                ...rt.buildTaskResultModelState(i, exec.subagentResult),
              }, exec.structuredReport);
              rt.log(`[Workflow Halted] Blocked by reviewer after ${rt.maxReviewRepairRounds} repair round(s) on: "${task.title}".`);
              const summary = rt.wrapWorkflowSummary(
                buildSummaryReport(rt.goal, rt.taskResults, rt.tasks, {
                  concurrency: rt.resolvedConcurrency,
                  runId: rt.workflowRunId,
                  artifactDir: rt.artifactRunDir,
                  batchReviewResult: rt.batchReviewResult,
                })
              );
              throw new WorkflowError(
                `Blocked by reviewer on: "${task.title}" (after ${rt.maxReviewRepairRounds} repair round(s))`,
                summary,
                buildCcReviewSummaryMeta(rt.taskResults, { concurrency: rt.resolvedConcurrency, batchReviewResult: rt.batchReviewResult })
              );
            }
            repairFeedback = buildRepairFeedback(reviewResultObject ?? null, derived.blockReason, findings);
            repairRequiresPostReviewValidation ||= derived.blockReason === "post_review_validation_failed";
            rt.log({
              severity: "warning",
              source: "reviewer",
              message: `[Repair] Reviewer blocked on "${task.title}". Dispatching repair round ${repairRound + 1}/${rt.maxReviewRepairRounds}...`,
            });
            continue REPAIR_LOOP;
          }
          // Terminal: task passed review → record the final result (I1).
          rt.collectedTaskFindings.push(findings);
          rt.findingsRollup = updateFindingsRollup(rt.findingsRollup, effectiveVerdict, findings);
          rt.hasCompletedReview = true;
          rt.recordTaskResult(i, {
            title: task.title,
            description: task.description,
            executionCode: exec.subagentResult.code,
            reviewCode: reviewProcessResult.exitCode,
            output: exec.subagentOutputText,
            validationError: exec.validationError,
            unresolvedItems: exec.unresolvedItems,
            reviewWarningName: rt.reviewProviderConfig.warningName,
            status: taskStatus,
            artifactPath,
            structuredReport: exec.structuredReport ?? undefined,
            schemaParseStatus: exec.schemaParseStatus,
            reviewResult: reviewResultObject ?? undefined,
            reportedVerdict,
            effectiveVerdict,
            blockReason: derived.blockReason,
            reviewerExitDiagnostic,
            ...rt.buildTaskResultModelState(i, exec.subagentResult),
          }, exec.structuredReport);
          break REPAIR_LOOP;
        } // end REPAIR_LOOP
      }
    }

}
