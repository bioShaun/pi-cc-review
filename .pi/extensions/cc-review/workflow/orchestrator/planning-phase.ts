import * as fs from "node:fs";

import { extractBalancedJsonObject } from "../../structured.ts";
import { emitTrace } from "../../subprocess.ts";
import { resolvePlannerModelEnv } from "../../providers.ts";
import { formatResumeInstructions, writePlanArtifact } from "../checkpoint.ts";
import { createSubprocessStreamLogger } from "../logging.ts";
import { extractAssistantTextFromStream } from "../stream-format.ts";
import { delay } from "../util.ts";
import type { CcReviewWorkflowResult } from "../types.ts";
import { buildCcReviewSummaryMeta } from "../summary.ts";
import type { WorkflowRuntime, ProcessResult } from "./runtime.ts";

export async function runPlanningPhase(rt: WorkflowRuntime): Promise<CcReviewWorkflowResult | undefined> {
    if (rt.resumeCheckpoint && rt.tasks.length > 0) {
      rt.log({
        severity: "info",
        source: "cc-review",
        message: `Resuming workflow ${rt.workflowRunId}: ${rt.tasks.length} tasks, skipping ${rt.skipTaskIndices.size} already completed.`,
      });
    } else {
    // Write out the task breakdown schema
    const schema = {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              acceptanceCriteria: { type: "string" },
              dependsOn: {
                type: "array",
                items: { type: "integer", minimum: 1 },
                description: "1-based task numbers that must finish before this task can start; use [] only when independent.",
              },
            },
            required: ["title", "description", "acceptanceCriteria"],
            additionalProperties: false,
          },
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    };
    fs.writeFileSync(rt.schemaPath, JSON.stringify(schema, null, 2), "utf8");

    // PHASE 1: Task breakdowns via the selected provider
    rt.transitionToPlanning();

    const plannerPrompt = `Break down the following goal into a sequence of small, self-contained, and incremental implementation tasks: ${rt.goal}. Ensure each task is tightly scoped and includes specific, verifiable acceptance criteria. For every task, include dependsOn as 1-based task numbers that must finish before it can start; use [] only when the task is truly independent of earlier task output. Summarize any necessary parent workflow context for each task instead of copying the entire goal or parent context wholesale, so the subagent can execute the task with clear boundaries.`;
    const plannerProvider = rt.reviewProviderConfig.provider;
    const plannerLabel = `${rt.reviewProviderConfig.label.replace(/ reviewer$/i, "")} planner`;

    let plannerCommand: string;
    let plannerArgs: string[];
    let captureStdoutForPlanner = false;

    if (plannerProvider === "codex") {
      plannerCommand = "codex";
      plannerArgs = [
        "exec",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        // Stream JSONL events to stdout for live observability (P0-3).
        "--json",
        "--output-schema",
        rt.schemaPath,
        "-o",
        rt.outputPath,
      ];
      const codexModel = resolvePlannerModelEnv(process.env, "codex");
      if (codexModel) plannerArgs.push("--model", codexModel);
      plannerArgs.push(plannerPrompt);
    } else {
      // Claude has no native --output-schema. Ask for strict JSON in the prompt
      // and parse it from stdout. This keeps the workflow runnable for users
      // who only have the claude CLI installed (goal #1: minimize external
      // plugin dependencies).
      captureStdoutForPlanner = true;
      plannerCommand = "claude";
      // Use stream-json for live observability (P0-3). The final task-list JSON
      // is recovered from the stream via extractAssistantTextFromStream.
      plannerArgs = [
        "-p",
        "--dangerously-skip-permissions",
        "--no-session-persistence",
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
      ];
      const claudeModel = resolvePlannerModelEnv(process.env, "claude");
      if (claudeModel) plannerArgs.push("--model", claudeModel);
      const claudePlannerPrompt = [
        plannerPrompt,
        "",
        "Respond with ONLY a JSON object matching this schema (no markdown fences, no prose):",
        JSON.stringify({
          type: "object",
          properties: {
            tasks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  acceptanceCriteria: { type: "string" },
                  dependsOn: {
                    type: "array",
                    items: { type: "integer", minimum: 1 },
                    description: "1-based task numbers that must finish before this task can start; use [] only when independent.",
                  },
                },
                required: ["title", "description", "acceptanceCriteria"],
              },
            },
          },
          required: ["tasks"],
        }),
      ].join("\n");
      plannerArgs.push(claudePlannerPrompt);
    }

    const maxPlanRetries = 3;
    for (let attempt = 1; attempt <= maxPlanRetries; attempt++) {
      rt.throwIfAborted();
      fs.rmSync(rt.outputPath, { force: true });
      if (attempt > 1) {
        rt.noteRetry(attempt, maxPlanRetries);
        rt.log({
          severity: "warning",
          source: "planner",
          message: `Retrying planning with ${rt.reviewProviderConfig.label} (attempt ${attempt}/${maxPlanRetries})...`,
        });
      } else {
        rt.clearRetry();
      }

      emitTrace(rt.ctx, "subagent_assignment", {
        role: "planner",
        agent: plannerProvider,
        attempt,
      });

      let plannerStdoutBuffer = "";
      let planResult: ProcessResult;
      const plannerStdoutLogger = createSubprocessStreamLogger(rt.log, "stdout", "planner");
      const plannerStderrLogger = createSubprocessStreamLogger(rt.log, "stderr", "planner");
      try {
        planResult = await rt.runProcess(
          plannerLabel,
          plannerCommand,
          plannerArgs,
          (data) => {
            const chunk = data.toString();
            if (captureStdoutForPlanner) plannerStdoutBuffer += chunk;
            plannerStdoutLogger.write(chunk);
          },
          (data) => plannerStderrLogger.write(data),
          rt.resolvedPlannerTimeoutMs > 0 ? rt.resolvedPlannerTimeoutMs : undefined
        );
      } catch (err: any) {
        // Planner timeout (P0-4): treat as a retryable failure so the existing
        // backoff/retry loop engages, instead of letting the rejection propagate
        // and abort the whole workflow.
        const errorMessage = err?.message || String(err);
        const isPlannerTimeout = /timed out/i.test(errorMessage);
        if (isPlannerTimeout && attempt < maxPlanRetries) {
          emitTrace(rt.ctx, "retry", {
            phase: "planning",
            attempt,
            maxAttempts: maxPlanRetries,
            error: errorMessage,
          });
          const backoff = Math.pow(2, attempt) * 1000;
          rt.log({
            severity: "warning",
            source: "planner",
            message: `Planning timed out after ${rt.resolvedPlannerTimeoutMs}ms. Waiting ${backoff}ms before retrying...`,
          });
          await delay(backoff, rt.signal);
          continue;
        }
        throw err;
      } finally {
        plannerStdoutLogger.flush();
        plannerStderrLogger.flush();
      }

      if (planResult.code !== 0) {
        const errorMsg = `${rt.reviewProviderConfig.label} task planning failed with exit code ${planResult.code}`;
        if (attempt < maxPlanRetries) {
          emitTrace(rt.ctx, "retry", {
            phase: "planning",
            attempt,
            maxAttempts: maxPlanRetries,
            error: errorMsg,
          });
          const backoff = Math.pow(2, attempt) * 1000;
          rt.log({
            severity: "warning",
            source: "planner",
            message: `Planning failed. Waiting ${backoff}ms before retrying...`,
          });
          await delay(backoff, rt.signal);
          continue;
        }
        throw new Error(errorMsg);
      }

      let rawPlanJson: string | undefined;
      if (captureStdoutForPlanner) {
        // With --output-format stream-json, claude emits NDJSON events. Recover
        // the final assistant text from the stream before extracting JSON (P0-3).
        const plannerText = extractAssistantTextFromStream(plannerStdoutBuffer);
        rawPlanJson = extractBalancedJsonObject(plannerText, "first");
      } else if (fs.existsSync(rt.outputPath)) {
        rawPlanJson = fs.readFileSync(rt.outputPath, "utf8");
      }

      if (!rawPlanJson) {
        const errorMsg = `${rt.reviewProviderConfig.label} failed to output the structured task list`;
        if (attempt < maxPlanRetries) {
          emitTrace(rt.ctx, "retry", {
            phase: "planning",
            attempt,
            maxAttempts: maxPlanRetries,
            error: errorMsg,
          });
          const backoff = Math.pow(2, attempt) * 1000;
          rt.log({
            severity: "warning",
            source: "planner",
            message: `Planning output missing. Waiting ${backoff}ms before retrying...`,
          });
          await delay(backoff, rt.signal);
          continue;
        }
        throw new Error(errorMsg);
      }

      try {
        const outputData = JSON.parse(rawPlanJson);
        rt.tasks = Array.isArray(outputData?.tasks) ? outputData.tasks : [];
        if (rt.tasks.length === 0) {
          throw new Error(`${rt.reviewProviderConfig.label} returned an empty task list`);
        }
        break;
      } catch (err: any) {
        if (attempt < maxPlanRetries) {
          emitTrace(rt.ctx, "retry", {
            phase: "planning",
            attempt,
            maxAttempts: maxPlanRetries,
            error: err.message,
          });
          const backoff = Math.pow(2, attempt) * 1000;
          rt.log({
            severity: "warning",
            source: "planner",
            message: `Planning parse/validation failed: ${err.message}. Waiting ${backoff}ms before retrying...`,
          });
          await delay(backoff, rt.signal);
          continue;
        }
        throw err;
      }
    }

    rt.setPlannedTasks(rt.tasks);
    } // end planning (skipped on resume when rt.tasks already loaded)

    if (rt.options.planOnly) {
      const planPath = writePlanArtifact(rt.workflowCwd, {
        schemaVersion: 1,
        runId: rt.workflowRunId,
        goal: rt.goal,
        createdAt: new Date().toISOString(),
        reviewProvider: rt.reviewProviderConfig.provider,
        reviewMode: rt.reviewMode,
        tasks: rt.tasks,
      });
      rt.persistRunCheckpoint("planning");
      rt.transitionToComplete();
      return {
        summary: rt.wrapWorkflowSummary(
          `## Plan-only Complete\n\n**Goal:** ${rt.goal}\n\n**${rt.tasks.length} tasks** planned.\n\nPlan artifact: \`${planPath}\`\n\n${formatResumeInstructions(rt.workflowCwd, rt.workflowRunId)}`
        ),
        meta: buildCcReviewSummaryMeta([], { concurrency: rt.resolvedConcurrency }),
      };
    }
}
