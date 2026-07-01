import * as fs from "node:fs";
import * as path from "node:path";

import {
  isExecutionGateHaltError,
  loadVerificationPlan,
  mergeRollupFindings,
  buildFindingsPayload,
  WORKFLOW_ARTIFACT_DIR,
} from "../../structured.ts";
import {
  enterCcReviewWorkflowNest,
  readAvailableCpuCount,
  resolveCcReviewConcurrency,
} from "../../config.ts";
import { resolveReviewProviderConfig } from "../../providers.ts";
import { emitTrace } from "../../subprocess.ts";
import { runPreflight, shouldSkipPreflight, formatPreflightReport } from "../preflight.ts";
import {
  type CcReviewWorkflowResult,
  type RunCcReviewWorkflowOptions,
  WorkflowError,
} from "../types.ts";
import { buildCcReviewSummaryMeta, buildSummaryReport } from "../summary.ts";
import type { ExtensionAPI } from "../types.ts";
import { createWorkflowRuntime } from "./runtime.ts";
import { runPlanningPhase } from "./planning-phase.ts";
import { runExecutionPhase } from "./execution-phase.ts";
import { runReviewPhase } from "./review-phase.ts";

export async function runCcReviewWorkflow(
  pi: ExtensionAPI,
  goal: string,
  ctx: any,
  onUpdate?: (partial: any) => void,
  signal?: AbortSignal,
  options: RunCcReviewWorkflowOptions = {}
): Promise<CcReviewWorkflowResult> {
  const exitCcReviewNest = enterCcReviewWorkflowNest(process.env);

  try {
    const reviewProviderConfig = resolveReviewProviderConfig(options.reviewProvider);
    const concurrencyResolution = resolveCcReviewConcurrency({
      flag: options.concurrency ?? options.concurrencyLimit,
      env: process.env,
      cpuCount: readAvailableCpuCount(process.env),
    });
    const resolvedConcurrency = concurrencyResolution.concurrency;

    if (options.checkOnly) {
      if (!shouldSkipPreflight(process.env)) {
        const preflight = runPreflight({
          provider: reviewProviderConfig.provider,
          providerCli: reviewProviderConfig.command,
        });
        const summary = formatPreflightReport(preflight);
        if (!preflight.ok) {
          throw new WorkflowError(preflight.errors.join("; "), summary);
        }
        return { summary, meta: buildCcReviewSummaryMeta([], { concurrency: resolvedConcurrency }) };
      }
      return {
        summary: formatPreflightReport({
          ok: true,
          errors: [],
          warnings: ["Preflight skipped (CC_REVIEW_SKIP_PREFLIGHT=1)"],
          resolved: {
            provider: reviewProviderConfig.provider,
            providerCli: reviewProviderConfig.command,
          },
        }),
        meta: buildCcReviewSummaryMeta([], { concurrency: resolvedConcurrency }),
      };
    }

    const rt = createWorkflowRuntime(pi, goal, ctx, onUpdate, signal, options);

    try {
      const verificationPlanLoad = loadVerificationPlan(rt.workflowCwd, rt.options.validationCommands);
      if (verificationPlanLoad.error) {
        rt.failWorkflow();
        rt.log({
          severity: "error",
          source: "cc-review",
          message: `Failed to load verification plan: ${verificationPlanLoad.error}`,
        });
        throw new WorkflowError(
          verificationPlanLoad.error,
          verificationPlanLoad.error,
          buildCcReviewSummaryMeta(rt.taskResults, { concurrency: rt.resolvedConcurrency })
        );
      }
      rt.verificationPlan = verificationPlanLoad.plan;

      rt.throwIfAborted();

      if (!shouldSkipPreflight(process.env)) {
        const preflight = runPreflight({
          provider: rt.reviewProviderConfig.provider,
          providerCli: rt.reviewProviderConfig.command,
        });
        if (!preflight.ok) {
          throw new WorkflowError(
            preflight.errors.join("; "),
            formatPreflightReport(preflight),
            buildCcReviewSummaryMeta(rt.taskResults, { concurrency: rt.resolvedConcurrency })
          );
        }
        for (const warning of preflight.warnings) {
          rt.log({ severity: "warning", source: "cc-review", message: warning });
        }
      }
      const planOnlyResult = await runPlanningPhase(rt);
      if (planOnlyResult) return planOnlyResult;
      await runExecutionPhase(rt);
      return await runReviewPhase(rt);
    } catch (err: any) {
      emitTrace(rt.ctx, "failure", { error: err.message });
      const isTimeout = /timeout/i.test(err.message || "");
      const isCancelled =
        rt.signal?.aborted ||
        err.message?.includes("aborted") ||
        err.message?.includes("timeout") ||
        err.message?.includes("cancel");

      if (!rt.rollupEmitted && isExecutionGateHaltError(err.message || "")) {
        const rollupFindings = mergeRollupFindings(rt.collectedTaskFindings);
        const lastArtifact =
          rt.taskResults[rt.taskResults.length - 1]?.artifactPath ??
          path.join(rt.workflowCwd, WORKFLOW_ARTIFACT_DIR, rt.workflowRunId);
        await rt.emitFindingsMessage(
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
        rt.rollupEmitted = true;
      }
      if (!rt.rollupEmitted && isCancelled && rt.hasCompletedReview) {
        const rollupFindings = mergeRollupFindings(rt.collectedTaskFindings);
        const lastArtifact =
          rt.taskResults[rt.taskResults.length - 1]?.artifactPath ??
          path.join(rt.workflowCwd, WORKFLOW_ARTIFACT_DIR, rt.workflowRunId);
        await rt.emitFindingsMessage(
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
        rt.rollupEmitted = true;
      }

      if (err instanceof WorkflowError) {
        rt.failWorkflow();
        err.meta ??= buildCcReviewSummaryMeta(rt.taskResults, { concurrency: rt.resolvedConcurrency });
        rt.refreshWorkflowUi();
        throw err;
      }

      // Mark the currently executing/reviewing task as cancelled if it was interrupted
      if (isCancelled) {
        if (isTimeout) {
          rt.displayState = "timeout";
        } else {
          rt.abortWorkflow();
        }
      } else {
        rt.failWorkflow();
      }
      if (isCancelled && rt.currentTaskIndex >= 0 && rt.currentTaskIndex < rt.tasks.length) {
        if (rt.taskResults.length === rt.currentTaskIndex) {
          rt.taskResults.push({
            title: rt.tasks[rt.currentTaskIndex].title,
            description: rt.tasks[rt.currentTaskIndex].description,
            executionCode: -1,
            reviewCode: -1,
            status: "cancelled",
          });
        }
      }

      try {
        rt.persistRunCheckpoint(isCancelled ? "cancelled" : "failed");
      } catch {
        // best-effort
      }

      const summary = rt.wrapWorkflowSummary(
        buildSummaryReport(rt.goal, rt.taskResults, rt.tasks, {
          concurrency: rt.resolvedConcurrency,
          runId: rt.workflowRunId,
          artifactDir: rt.artifactRunDir,
          batchReviewResult: rt.batchReviewResult,
          termination: isCancelled ? "cancelled" : "failed",
        })
      );
      rt.refreshWorkflowUi();
      throw new WorkflowError(err.message, summary, buildCcReviewSummaryMeta(rt.taskResults, { concurrency: rt.resolvedConcurrency, batchReviewResult: rt.batchReviewResult }));
    } finally {
      try {
        fs.rmSync(rt.tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      if (rt.signal) {
        rt.signal.removeEventListener("abort", rt.onAbort);
      }
      rt.ctx?.ui?.setWidget?.("cc-review-widget", undefined);
      rt.ctx?.ui?.setStatus?.("cc-review-status", undefined);
    }
  } finally {
    exitCcReviewNest();
  }
}
