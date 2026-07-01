import * as path from "node:path";

import {
  buildFindingsPayload,
  deriveEffectiveVerdict,
  mapEffectiveVerdictToTaskStatus,
  mergeRollupFindings,
  parseReviewResult,
  runPostReviewValidation,
  snapshotWorkspace,
  updateFindingsRollup,
  workspaceSnapshotChanged,
  WORKFLOW_ARTIFACT_DIR,
} from "../../structured.ts";
import { emitTrace } from "../../subprocess.ts";
import type { Task } from "../dependencies.ts";
import { extractAssistantTextFromStream } from "../stream-format.ts";
import { validateSubagentOutput } from "../validation.ts";
import type { CcReviewWorkflowResult } from "../types.ts";
import { WorkflowError } from "../types.ts";
import { buildCcReviewSummaryMeta, buildSummaryReport } from "../summary.ts";
import { buildRepairFeedback } from "../review.ts";
import type { WorkflowRuntime } from "./runtime.ts";

export async function finishWorkflow(rt: WorkflowRuntime): Promise<CcReviewWorkflowResult> {
    if (!rt.rollupEmitted) {
      const rollupFindings = mergeRollupFindings(rt.collectedTaskFindings);
      const lastArtifact =
        rt.taskResults[rt.taskResults.length - 1]?.artifactPath ??
        path.join(rt.workflowCwd, WORKFLOW_ARTIFACT_DIR, rt.workflowRunId);
      await rt.emitFindingsMessage(
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
      rt.rollupEmitted = true;
    }

    // PHASE 3: Wrap up
    rt.transitionToComplete();

    // Construct the final report
    const hasWarnings = rt.taskResults.some((task) => task.executionCode !== 0 || task.reviewCode !== 0 || task.validationError);

    emitTrace(rt.ctx, "completion", {
      status: hasWarnings ? "warning" : "success",
      tasksCount: rt.tasks.length,
    });

    rt.persistRunCheckpoint("complete");

    return {
      summary: rt.wrapWorkflowSummary(
        buildSummaryReport(rt.goal, rt.taskResults, rt.tasks, {
          concurrency: rt.resolvedConcurrency,
          runId: rt.workflowRunId,
          artifactDir: rt.artifactRunDir,
        })
      ),
      meta: buildCcReviewSummaryMeta(rt.taskResults, { concurrency: rt.resolvedConcurrency }),
    };
}

export async function runReviewPhase(rt: WorkflowRuntime): Promise<CcReviewWorkflowResult> {
    if (rt.reviewMode === "after-all") {
      const batchReviewTask: Task = {
        title: `Complete workflow: ${rt.goal}`,
        description: [
          `Review the complete workspace after all ${rt.tasks.length} planned tasks have executed.`,
          `Overall goal: ${rt.goal}`,
          "Planned tasks and acceptance criteria:",
          ...rt.tasks.map(
            (plannedTask, index) =>
              `${index + 1}. ${plannedTask.title}\n` +
              `Description: ${plannedTask.description}\n` +
              `Acceptance criteria: ${plannedTask.acceptanceCriteria}`
          ),
          "Review integration issues across task boundaries and report structured findings without modifying the workspace.",
        ].join("\n\n"),
        acceptanceCriteria: "The complete workflow satisfies every planned task's acceptance criteria.",
      };
      let batchRepairFeedback: string | undefined;
      let batchRepairRequiresPostReviewValidation = false;
      let activeRepairFindingCount = 0;

      BATCH_REPAIR_LOOP: for (let repairRound = 0; ; repairRound++) {
      rt.transitionToBatchReviewing();
      if (repairRound > 0) {
        rt.log({
          severity: "info",
          source: "cc-review",
          message: `[Repair Started] Round ${repairRound}/${rt.maxReviewRepairRounds}; addressing ${activeRepairFindingCount} review finding(s).`,
          details: {
            event: "repair_started",
            round: repairRound,
            maxRounds: rt.maxReviewRepairRounds,
            findingCount: activeRepairFindingCount,
          },
        });
      }
      emitTrace(rt.ctx, "subagent_assignment", {
        role: "reviewer",
        agent: rt.reviewProviderConfig.provider,
        reviewMode: rt.reviewMode,
        tasksCount: rt.tasks.length,
        repairRound,
      });

      const reviewTask = batchRepairFeedback
        ? {
            ...batchReviewTask,
            description: [
              batchReviewTask.description,
              `This is repair round ${repairRound}/${rt.maxReviewRepairRounds}.`,
              "Fix every issue below in the workspace, rerun the relevant verification, and then review the complete workflow again:",
              batchRepairFeedback,
            ].join("\n\n"),
          }
        : batchReviewTask;
      const reviewArgs = rt.reviewProviderConfig.buildArgs({
        task: reviewTask,
        intent: repairRound === 0 ? "inspect" : "repair",
      });
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
      const findings = (reviewResultObject?.findings ?? []).map((finding) =>
        repairRound === 0 && finding.status === "fixed"
          ? { ...finding, status: "unfixed" as const }
          : finding
      );
      const actionableFindings = findings.filter((finding) => finding.status === "unfixed");
      for (const finding of actionableFindings) {
        const location = finding.file
          ? `${finding.file}${finding.line ? `:${finding.line}` : ""}`
          : "workspace";
        rt.log({
          severity: finding.priority === "P0" || finding.priority === "P1" ? "warning" : "info",
          source: "reviewer",
          message: `[Review Finding] [${finding.priority}] ${location} — ${finding.message}`,
          details: {
            event: "review_finding",
            round: repairRound,
            finding,
          },
        });
      }
      const reportedVerdict = reviewResultObject?.verdict ?? null;
      const rerunValidations = rt.batchTaskExecutions.map((execution) =>
        validateSubagentOutput(execution.cachedSubagentResult, execution.task, { allowTextValidation: rt.allowTextValidation })
      );
      const postReview = await runPostReviewValidation({
        reviewResult: reviewResultObject,
        workspaceChanged: workspaceChanged || batchRepairRequiresPostReviewValidation,
        verificationPlan: rt.verificationPlan,
        runCommand: rt.runVerificationCommand,
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

      const repairRequired = effectiveVerdict === "block" || actionableFindings.length > 0;
      if (repairRequired && repairRound < rt.maxReviewRepairRounds) {
        batchRepairFeedback = buildRepairFeedback(
          reviewResultObject ?? null,
          derived.blockReason,
          findings,
          postReview
        );
        batchRepairRequiresPostReviewValidation ||= derived.blockReason === "post_review_validation_failed";
        activeRepairFindingCount = Math.max(actionableFindings.length, 1);
        continue BATCH_REPAIR_LOOP;
      }

      if (repairRound > 0 && effectiveVerdict !== "block" && postReview.passed) {
        rt.log({
          severity: "info",
          source: "cc-review",
          message: `[Repair Completed] Round ${repairRound}/${rt.maxReviewRepairRounds}; fixed ${activeRepairFindingCount} finding(s); post-repair validation passed.`,
          details: {
            event: "repair_completed",
            round: repairRound,
            maxRounds: rt.maxReviewRepairRounds,
            fixedCount: activeRepairFindingCount,
            validationPassed: true,
          },
        });
      } else if (repairRound > 0 && repairRequired) {
        rt.log({
          severity: "error",
          source: "cc-review",
          message: `[Repair Failed] Round ${repairRound}/${rt.maxReviewRepairRounds}; review remains blocked.`,
          details: {
            event: "repair_failed",
            round: repairRound,
            maxRounds: rt.maxReviewRepairRounds,
            error: postReview.error ?? derived.blockReason ?? "review remains blocked",
          },
        });
      }

      let reviewerExitDiagnostic: string | undefined;
      if (reviewProcessResult.exitCode !== 0 && effectiveVerdict === "ship") {
        reviewerExitDiagnostic = `Reviewer exited non-zero (code ${reviewProcessResult.exitCode}) despite ship verdict`;
      }

      if (reviewProcessResult.exitCode !== 0 && effectiveVerdict === "ship_with_warnings") {
        const warningMessage = `${rt.reviewProviderConfig.label} exited with code ${reviewProcessResult.exitCode}`;
        rt.noteReviewWarning(warningMessage);
        rt.log({ severity: "warning", source: "reviewer", message: `[Review Warning] ${warningMessage}` });
      } else if (effectiveVerdict === "ship") {
        rt.log(`[Review Done] ${rt.reviewProviderConfig.label} completed the final workflow review.`);
      } else if (effectiveVerdict === "ship_with_warnings") {
        rt.log({
          severity: "warning",
          source: "reviewer",
          message: `[Review Warning] ${rt.reviewProviderConfig.label} reported workflow-level warnings.`,
        });
      }

      let lastArtifactPath = path.join(rt.workflowCwd, WORKFLOW_ARTIFACT_DIR, rt.workflowRunId);
      for (let index = 0; index < rt.batchTaskExecutions.length; index++) {
        const execution = rt.batchTaskExecutions[index];
        const rerunValidation = rerunValidations[index];
        const completedAt = new Date().toISOString();
        const artifactPath = rt.writeTaskArtifactForIndex({
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
            model: execution.subagentResult.effectiveModel,
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
        lastArtifactPath = artifactPath;
        rt.taskStatuses[execution.taskIndex] = batchStatus;
        Object.assign(execution.result, {
          reviewCode: reviewProcessResult.exitCode,
          reviewWarningName: rt.reviewProviderConfig.warningName,
          status: batchStatus,
          artifactPath,
          reviewResult: index === 0 ? reviewResultObject ?? undefined : undefined,
          reportedVerdict,
          effectiveVerdict,
          blockReason: derived.blockReason,
          reviewerExitDiagnostic,
        });
      }

      await rt.emitFindingsMessage(
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
      rt.collectedTaskFindings.push(findings);
      rt.findingsRollup = updateFindingsRollup(rt.findingsRollup, effectiveVerdict, findings);
      rt.reviewedTaskCount = 1;
      rt.refreshWorkflowUi();

      if (effectiveVerdict === "block") {
        rt.log(`[Workflow Halted] Final workflow review remained blocked after ${rt.maxReviewRepairRounds} repair round(s).`);
        const summary = rt.wrapWorkflowSummary(
          buildSummaryReport(rt.goal, rt.taskResults, rt.tasks, {
            concurrency: rt.resolvedConcurrency,
            runId: rt.workflowRunId,
            artifactDir: rt.artifactRunDir,
          })
        );
        throw new WorkflowError(
          `Blocked by final workflow review (after ${rt.maxReviewRepairRounds} repair round(s))`,
          summary,
          buildCcReviewSummaryMeta(rt.taskResults, { concurrency: rt.resolvedConcurrency })
        );
      }
      break BATCH_REPAIR_LOOP;
      } // end BATCH_REPAIR_LOOP
    }
  return finishWorkflow(rt);
}
