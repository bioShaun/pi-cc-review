import {
  buildFindingsPayload,
  deriveEffectiveVerdict,
  mapEffectiveVerdictToTaskStatus,
  parseReviewResult,
  runPostReviewValidation,
  snapshotWorkspace,
  updateFindingsRollup,
  workspaceSnapshotChanged,
  type SubagentStructuredReport,
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
import type { SchemaParseStatus } from "../../structured.ts";
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
import type { WorkflowRuntime } from "./runtime.ts";

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

          await runWithConcurrencyLimit(rt.resolvedConcurrency, batch, async (batchItem) => {
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

          const subagentRunId = `subagent-run-${rt.workflowRunId}-${i}`;
          rt.taskStatuses[i] = "running";
          rt.transitionToExecuting(i);
          const taskStartedAt = new Date().toISOString();
          let cachedSubagentResult: SubagentToolResult = {};
          let structuredReport: SubagentStructuredReport | null = null;
          let schemaParseStatus: SchemaParseStatus = "absent";

          const summarizedParentContext = summarizeParentContext(rt.goal);
          const priorHandoff = priorTaskHandoffFromResults(batchPriorResults);
          const stateBufferSection = formatStateBufferForPrompt(rt.runStateBuffer);
          const subagentPrompt = buildSubagentTaskPrompt(task, summarizedParentContext, priorHandoff, stateBufferSection);
          let subagentResult: SubagentResult = { code: 0 };
          let subagentOutputText = "";
          let validationError: string | undefined = undefined;
          let unresolvedItems: string[] | undefined = undefined;
          let taskStatus: TaskResult["status"] = "completed";
          let retryFeedback: string | undefined = undefined;
          const unresolvedItemsForFailedTask: string[] = [];

          const maxTaskExecutionRetries = 2;
          const maxTaskExecutionAttempts = maxTaskExecutionRetries + 1;

          for (let attempt = 1; attempt <= maxTaskExecutionAttempts; attempt++) {
            if (rt.signal?.aborted || taskAbortControllers[i].signal.aborted) {
              throw new Error("Workflow aborted by user");
            }
            if (attempt > 1) {
              rt.log({
                severity: "info",
                source: "subagent",
                message: `[Task ${i + 1}] Retrying task execution in subagent (attempt ${attempt}/${maxTaskExecutionAttempts})...`,
                details: { taskIndex: i, subagentRunId },
              });
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
              taskIndex: i,
              subagentRunId,
              attempt,
              model: rt.resolvedWorkerModel,
            });

            emitTrace(rt.ctx, "tool_execution_start", {
              taskIndex: i,
              subagentRunId,
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
              if (rt.signal?.aborted || taskAbortControllers[i].signal.aborted) {
                throw new Error("Workflow aborted by user");
              }

              const attemptAbortController = new AbortController();
              const onTaskAbort = () => {
                attemptAbortController.abort();
              };
              taskAbortControllers[i].signal.addEventListener("abort", onTaskAbort);

              const subagentTimeoutMs = rt.resolvedTaskTimeoutMs;
              const timeoutTimer = subagentTimeoutMs > 0
                ? setTimeout(() => {
                    rt.log({
                      severity: "warning",
                      source: "subagent",
                      message: `[Timeout] [Task ${i + 1}] Subagent task execution exceeded timeout of ${subagentTimeoutMs}ms. Aborting subagent...`,
                      details: { taskIndex: i, subagentRunId },
                    });
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
                  },
                  attemptAbortController.signal,
                  (partial) => {
                    const subagentText = partial?.content?.find(
                      (item: any) => item?.type === "text" && item.text
                    )?.text;
                    if (subagentText) {
                      const formatted = formatSubprocessStreamLine(subagentText);
                      if (formatted !== null) {
                        rt.log({
                          severity: "info",
                          source: "subagent",
                          message: `[Subagent - Task ${i + 1}] ${formatted}`,
                          details: {
                            subagentRunId,
                            taskIndex: i,
                          }
                        });
                      }
                    }
                    const partialModel = partial?.model || partial?.details?.results?.[0]?.model;
                    if (partialModel) {
                      setTaskEffectiveModel(rt.taskModels, i, partialModel);
                      rt.refreshWorkflowUi();
                    }
                    if (rt.onUpdate) {
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
                          subagentRunId,
                          taskIndex: i,
                        }
                      });
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
                    rt.log({
                      severity: "warning",
                      source: "subagent",
                      message: `[Transient Error] [Task ${i + 1}] Subagent tool call failed with transient error: "${errorMsg}". Retrying in ${backoff}ms... (Attempt ${transientAttempt}/${maxTransientRetries})`,
                      details: { taskIndex: i, subagentRunId },
                    });
                    await delay(backoff, taskAbortControllers[i].signal);
                    transientAttempt++;
                    continue;
                  }
                }
                transientDone = true;
              } catch (err: any) {
                if (rt.signal?.aborted || taskAbortControllers[i].signal.aborted) {
                  throw new Error("Workflow aborted by user");
                }
                const errorMessage = err?.message || String(err);
                if (isTransientError(errorMessage) && transientAttempt < maxTransientRetries) {
                  const backoff = Math.pow(2, transientAttempt) * 1000;
                  rt.log({
                    severity: "warning",
                    source: "subagent",
                    message: `[Transient Error] [Task ${i + 1}] Subagent tool call threw transient exception: "${errorMessage}". Retrying in ${backoff}ms... (Attempt ${transientAttempt}/${maxTransientRetries})`,
                    details: { taskIndex: i, subagentRunId },
                  });
                  await delay(backoff, taskAbortControllers[i].signal);
                  transientAttempt++;
                  continue;
                }
                emitTrace(rt.ctx, "failure", {
                  phase: "subagent_execution",
                  taskIndex: i,
                  subagentRunId,
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
                taskAbortControllers[i].signal.removeEventListener("abort", onTaskAbort);
              }
            }

            const resultCode = getSubagentExitCode(result);
            const effectiveModel = result.model || result.details?.results?.[0]?.model;
            subagentResult = {
              code: resultCode,
              configuredModel: rt.taskModels[i]?.configured || rt.resolvedWorkerModel,
              effectiveModel,
            };
            if (effectiveModel) {
              setTaskEffectiveModel(rt.taskModels, i, effectiveModel);
            }
            emitTrace(rt.ctx, "tool_execution_end", {
              taskIndex: i,
              subagentRunId,
              toolName: "subagent",
              source: "_subagent",
              exitCode: resultCode,
              model: effectiveModel,
            });

            subagentOutputText = extractSubagentText(result);

            // Validate subagent outputs
            const validation = validateSubagentOutput(result, task, { allowTextValidation: rt.allowTextValidation });
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
              rt.log({
                severity: "info",
                source: "subagent",
                message: `[Subagent Execution Done] [Task ${i + 1}] Completed and validated.`,
                details: { taskIndex: i, subagentRunId },
              });
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
                  taskIndex: i,
                  subagentRunId,
                  attempt,
                  maxAttempts: maxTaskExecutionAttempts,
                  error: errorMsg,
                });
              } else {
                rt.log({
                  severity: "error",
                  source: "subagent",
                  message: `[Subagent Execution Failure] [Task ${i + 1}] ${errorMsg}`,
                  details: { taskIndex: i, subagentRunId },
                });
                taskStatus = resultCode === 0 ? "validation_failed" : "failed";
              }
            }
          }

          // Early Termination Gate or record result
          if (taskStatus === "failed" || taskStatus === "validation_failed") {
            rt.log({
              severity: "warning",
              source: "cc-review",
              message: `[Workflow Halted] Halting workflow due to unrecoverable task failure on: "${task.title}".`,
              details: { taskIndex: i, subagentRunId },
            });
            const completedAt = new Date().toISOString();
            const artifactPath = rt.writeTaskArtifactForIndex({
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
                model: subagentResult.effectiveModel,
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
            rt.taskStatuses[i] = taskStatus;
            const res: TaskResult = {
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
              ...rt.buildTaskResultModelState(i, subagentResult),
            };
            rt.taskResults[i] = res; // Assign directly to correct index
            rt.updateExecutionPhase();
            rt.refreshWorkflowUi();

            // Trigger abort on all other tasks
            for (const controller of taskAbortControllers) {
              controller.abort();
            }
            throw new Error(`Task execution failed unrecoverably on: "${task.title}" (${validationError || "exit code " + subagentResult.code})`);
          }

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
            ...rt.buildTaskResultModelState(i, subagentResult),
          };
          rt.taskStatuses[i] = "completed";
          rt.taskResults[i] = result; // Assign directly to correct index
          rt.batchTaskExecutions[i] = {
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
          };
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
      const taskStartedAt = new Date().toISOString();
      let cachedSubagentResult: SubagentToolResult = {};
      let structuredReport: SubagentStructuredReport | null = null;
      let schemaParseStatus: SchemaParseStatus = "absent";

      const summarizedParentContext = summarizeParentContext(rt.goal);
      // Build a bounded, structured handoff from prior task results. Raw
      // subagent output and reviewer process output are intentionally excluded
      // (see priorTaskHandoffFromResults).
      const priorHandoff = priorTaskHandoffFromResults(rt.taskResults);
      const stateBufferSection = formatStateBufferForPrompt(rt.runStateBuffer);
      const subagentPrompt = buildSubagentTaskPrompt(task, summarizedParentContext, priorHandoff, stateBufferSection);
      let subagentResult: SubagentResult = { code: 0 };
      let subagentOutputText = "";
      let validationError: string | undefined = undefined;
      let unresolvedItems: string[] | undefined = undefined;
      let taskStatus: TaskResult["status"] = "completed";
      let retryFeedback: string | undefined = undefined;
      // Repair feedback from a reviewer "block" verdict, injected into the next
      // worker attempt so the subagent can fix the reviewer's findings
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
      // verdict, re-dispatch the worker with the reviewer's findings as
      // feedback, then re-review, up to rt.maxReviewRepairRounds. Only hard-fail
      // after the bound is hit. Previously a single block threw and aborted the
      // entire workflow, preventing later tasks from ever running.
      REPAIR_LOOP: for (let repairRound = 0; ; repairRound++) {
        if (repairRound > 0) {
          // Inject the reviewer's findings as feedback for the repair re-execution.
          retryFeedback = repairFeedback;
          rt.transitionToExecuting(i);
          rt.log({
            severity: "info",
            source: "cc-review",
            message: `[Repair] Reviewer blocked "${task.title}". Re-executing with reviewer feedback (repair round ${repairRound}/${rt.maxReviewRepairRounds})...`,
          });
        }

      for (let attempt = 1; attempt <= maxTaskExecutionAttempts; attempt++) {
        rt.throwIfAborted();
        if (attempt > 1) {
          rt.noteRetry(attempt, maxTaskExecutionAttempts);
          rt.log(`Retrying task execution in subagent (attempt ${attempt}/${maxTaskExecutionAttempts})...`);
        } else {
          rt.clearRetry();
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
          taskIndex: i,
          attempt,
          model: rt.resolvedWorkerModel,
        });

        emitTrace(rt.ctx, "tool_execution_start", {
          taskIndex: rt.currentTaskIndex,
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
          rt.throwIfAborted();

          const taskAbortController = new AbortController();
          const onParentAbort = () => {
            taskAbortController.abort();
          };
          if (rt.signal) {
            rt.signal.addEventListener("abort", onParentAbort);
          }

          // Enforce a per-attempt timeout for the long-running subagent tool
          // call. Previously hardcoded to 300000ms (5 min) which killed real
          // tasks mid-flight (P0-1). Now configurable via CC_REVIEW_TASK_TIMEOUT_MS
          // / tool param / slash flag. 0 disables the timeout entirely.
          const subagentTimeoutMs = rt.resolvedTaskTimeoutMs;
          const timeoutTimer = subagentTimeoutMs > 0
            ? setTimeout(() => {
                rt.log(`[Timeout] Subagent task execution exceeded timeout of ${subagentTimeoutMs}ms. Aborting subagent...`);
                taskAbortController.abort(new Error(`Subagent execution timed out after ${subagentTimeoutMs}ms`));
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
              },
              taskAbortController.signal,
              (partial) => {
                const subagentText = partial?.content?.find(
                  (item: any) => item?.type === "text" && item.text
                )?.text;
                if (subagentText) {
                  const formatted = formatSubprocessStreamLine(subagentText);
                  if (formatted !== null) {
                    rt.log(`[Subagent] ${formatted}`);
                  }
                }
                rt.onUpdate?.(partial);
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
                rt.log(`[Transient Error] Subagent tool call failed with transient error: "${errorMsg}". Retrying in ${backoff}ms... (Attempt ${transientAttempt}/${maxTransientRetries})`);
                await delay(backoff, rt.signal);
                transientAttempt++;
                continue;
              }
            }
            transientDone = true;
          } catch (err: any) {
            if (rt.signal?.aborted) {
              throw new Error("Workflow aborted by user");
            }
            const errorMessage = err?.message || String(err);
            if (isTransientError(errorMessage) && transientAttempt < maxTransientRetries) {
              const backoff = Math.pow(2, transientAttempt) * 1000;
              rt.log(`[Transient Error] Subagent tool call threw transient exception: "${errorMessage}". Retrying in ${backoff}ms... (Attempt ${transientAttempt}/${maxTransientRetries})`);
              await delay(backoff, rt.signal);
              transientAttempt++;
              continue;
            }
            emitTrace(rt.ctx, "failure", {
              phase: "subagent_execution",
              taskIndex: rt.currentTaskIndex,
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
            if (rt.signal) {
              rt.signal.removeEventListener("abort", onParentAbort);
            }
          }
        }

        const resultCode = getSubagentExitCode(result);
        const effectiveModel = result.model || result.details?.results?.[0]?.model;
        subagentResult = {
          code: resultCode,
          configuredModel: rt.taskModels[i]?.configured || rt.resolvedWorkerModel,
          effectiveModel,
        };
        if (effectiveModel) {
          setTaskEffectiveModel(rt.taskModels, i, effectiveModel);
        }
        emitTrace(rt.ctx, "tool_execution_end", {
          taskIndex: rt.currentTaskIndex,
          toolName: "subagent",
          source: "_subagent",
          exitCode: resultCode,
          model: effectiveModel,
        });

        subagentOutputText = extractSubagentText(result);

        // Validate subagent outputs
        const validation = validateSubagentOutput(result, task, { allowTextValidation: rt.allowTextValidation });
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
          rt.log(`[Subagent Execution Done] Task completed and validated.`);
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
              taskIndex: i,
              attempt,
              maxAttempts: maxTaskExecutionAttempts,
              error: errorMsg,
            });
          } else {
            rt.log(`[Subagent Execution Failure] ${errorMsg}`);
            taskStatus = resultCode === 0 ? "validation_failed" : "failed";
          }
        }
      }

      // Early Termination Gate
      if (taskStatus === "failed" || taskStatus === "validation_failed") {
        rt.log(`[Workflow Halted] Halting workflow due to unrecoverable task failure on: "${task.title}".`);
        const completedAt = new Date().toISOString();
        const artifactPath = rt.writeTaskArtifactForIndex({
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
            model: subagentResult.effectiveModel,
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
        rt.taskStatuses[i] = taskStatus;
        rt.recordTaskResult(i, {
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
          ...rt.buildTaskResultModelState(i, subagentResult),
        }, structuredReport);
        throw new Error(`Task execution failed unrecoverably on: "${task.title}" (${validationError || "exit code " + subagentResult.code})`);
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
      // Recover the final review text from the stream (claude stream-json) or
      // fall back to the raw combined output (codex plain text) (P0-3).
      const reviewText = extractAssistantTextFromStream(reviewProcessResult.combinedOutput);
      const parsedReview = parseReviewResult(reviewText);
      const reviewResultObject = parsedReview.result;
      const findings = reviewResultObject?.findings ?? [];
      const reportedVerdict = reviewResultObject?.verdict ?? null;
      const rerunValidation = validateSubagentOutput(cachedSubagentResult, task, { allowTextValidation: rt.allowTextValidation });
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
      taskStatus = mapEffectiveVerdictToTaskStatus(effectiveVerdict);
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
        startedAt: taskStartedAt,
        completedAt,
        execution: {
          exitCode: subagentResult.code,
          status: taskStatus,
          rawOutput: subagentOutputText,
          structuredReport,
          schemaParseStatus,
          model: subagentResult.effectiveModel,
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
      // Update task status for UI feedback on every round. The intermediate
      // blocked status is visible during repair, but only the terminal
      // verdict is recorded as a durable task result (I1).
      rt.taskStatuses[i] = taskStatus;
      rt.refreshWorkflowUi();

      if (effectiveVerdict === "block") {
        if (repairRound >= rt.maxReviewRepairRounds) {
          // Terminal: exhausted repair rounds → record the final result and
          // hard-fail. Previously recordTaskResult was called on every round,
          // leaving stale review_blocked rows after a later success (I1).
          rt.collectedTaskFindings.push(findings);
          rt.findingsRollup = updateFindingsRollup(rt.findingsRollup, effectiveVerdict, findings);
          rt.reviewedTaskCount += 1;
          rt.recordTaskResult(i, {
            title: task.title,
            description: task.description,
            executionCode: subagentResult.code,
            reviewCode: reviewProcessResult.exitCode,
            output: subagentOutputText,
            validationError,
            unresolvedItems,
            reviewWarningName: rt.reviewProviderConfig.warningName,
            status: taskStatus,
            artifactPath,
            structuredReport: structuredReport ?? undefined,
            schemaParseStatus,
            reviewResult: reviewResultObject ?? undefined,
            reportedVerdict,
            effectiveVerdict,
            blockReason: derived.blockReason,
            reviewerExitDiagnostic,
            ...rt.buildTaskResultModelState(i, subagentResult),
          }, structuredReport);
          // Exhausted repair rounds → hard-fail (P1-1).
          rt.log(`[Workflow Halted] Blocked by reviewer after ${rt.maxReviewRepairRounds} repair round(s) on: "${task.title}".`);
          const summary = rt.wrapWorkflowSummary(
            buildSummaryReport(rt.goal, rt.taskResults, rt.tasks, {
              concurrency: rt.resolvedConcurrency,
              runId: rt.workflowRunId,
              artifactDir: rt.artifactRunDir,
            })
          );
          throw new WorkflowError(
            `Blocked by reviewer on: "${task.title}" (after ${rt.maxReviewRepairRounds} repair round(s))`,
            summary,
            buildCcReviewSummaryMeta(rt.taskResults, { concurrency: rt.resolvedConcurrency })
          );
        }
        // Build repair feedback from the reviewer's findings and re-execute +
        // re-review (P1-1). The worker gets the concrete findings so it can
        // fix them instead of the whole workflow aborting on the first block.
        // The intermediate blocked result is NOT recorded as a durable task
        // result; only the terminal outcome (success or final block) is (I1).
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
      rt.reviewedTaskCount += 1;
      rt.recordTaskResult(i, {
        title: task.title,
        description: task.description,
        executionCode: subagentResult.code,
        reviewCode: reviewProcessResult.exitCode,
        output: subagentOutputText,
        validationError,
        unresolvedItems,
        reviewWarningName: rt.reviewProviderConfig.warningName,
        status: taskStatus,
        artifactPath,
        structuredReport: structuredReport ?? undefined,
        schemaParseStatus,
        reviewResult: reviewResultObject ?? undefined,
        reportedVerdict,
        effectiveVerdict,
        blockReason: derived.blockReason,
        reviewerExitDiagnostic,
        ...rt.buildTaskResultModelState(i, subagentResult),
      }, structuredReport);
      break REPAIR_LOOP; // not block → task passed review, move to next task
      } // end REPAIR_LOOP
    }
    }

}
