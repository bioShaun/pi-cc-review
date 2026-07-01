import { createRequire } from "node:module";

import type { CcReviewFindingsPayload, CcReviewSummaryMeta } from "../structured.ts";
import { WorkflowError, type ExtensionAPI } from "./types.ts";
import {
  buildCcReviewSummaryMeta,
  classifyCcReviewSummary,
  type CcReviewSummaryBadge,
  formatCcReviewSummaryHeadline,
  countCcReviewTaskOutcomesFromSummary,
} from "./summary.ts";
import { previewWidgetText, truncateForWidget } from "./ui.ts";
import { runCcReviewWorkflow } from "./orchestrator/index.ts";

const require = createRequire(import.meta.url);

export type { ExtensionAPI } from "./types.ts";

export const CcReviewParams = {
  properties: {
    goal: {
      type: "string",
      description: "The overarching goal for CC Review to accomplish using Codex planning and Pi subagents",
    },
    reviewProvider: {
      type: "string",
      description: "Optional review backend for this run. Supported values: codex or claude. Omit to use CC_REVIEW_PROVIDER or the default Codex reviewer.",
    },
    logLevel: {
      type: "string",
      description: "Optional minimum log severity for compact surfaces (widget + onUpdate). Supported values: debug, info, warning, error (aliases: warn, fatal). Omit to use CC_REVIEW_LOG_LEVEL or the default 'info'. Persisted workflow logs are never filtered.",
    },
    logSources: {
      type: "string",
      description: "Optional comma-separated list of compact-surface log sources to keep (planner, subagent, reviewer, cc-review). Omit to use CC_REVIEW_LOG_SOURCES or show all. Explicit values override the environment, invalid values show all sources with one warning, and persisted logs remain unfiltered.",
    },
    reviewMode: {
      type: "string",
      description: "Optional review timing. Supported values: per-task or after-all. Omit to use CC_REVIEW_MODE or the default after-all mode.",
    },
    reviewRepairRounds: {
      type: "integer",
      minimum: 0,
      description: "Optional number of repair/re-review rounds after initial inspection. 0 disables repair. Omit to use CC_REVIEW_MAX_REPAIR_ROUNDS or the default 1.",
    },
    taskTimeoutMs: {
      type: "number",
      description: "Optional per-attempt subagent execution timeout in milliseconds. 0 disables the timeout. Omit to use CC_REVIEW_TASK_TIMEOUT_MS or the default 1800000 (30 min).",
    },
    widgetLogLines: {
      type: "number",
      description: "Optional log tail length for compact widget and onUpdate delta stream. Omit to use CC_REVIEW_WIDGET_LOG_LINES or the default 5.",
    },
    checklistWindow: {
      type: "number",
      description: "Optional task checklist window size for the compact widget. Omit to use CC_REVIEW_CHECKLIST_WINDOW or the default 8.",
    },
    concurrency: {
      type: "integer",
      minimum: 1,
      description: "Optional maximum number of concurrent subagent tasks. Omit to use CC_REVIEW_CONCURRENCY or the default automatically computed from the available CPUs (bounded between 1 and 8, capped by the planned task count).",
    },
    concurrencyLimit: {
      type: "integer",
      minimum: 1,
      description: "Optional maximum number of concurrent subagent tasks. Omit to use CC_REVIEW_CONCURRENCY or the default automatically computed from the available CPUs (bounded between 1 and 8, capped by the planned task count).",
    },
    logFile: {
      type: "string",
      description: "Optional path for the persisted JSONL execution log. Relative paths are resolved against the workflow cwd; absolute paths are used as-is. When omitted, logs are written under .cc-review/logs/<runId>/ (or CC_REVIEW_LOG_FILE / CC_REVIEW_LOG_ROOT=1 for legacy workspace-root behavior).",
    },
    checkOnly: {
      type: "boolean",
      description: "When true, validate environment (provider CLI on PATH) and print resolved configuration without starting planning or execution.",
    },
    planOnly: {
      type: "boolean",
      description: "When true, run the planner and write a plan artifact under cc-review-artifacts/<runId>/ without dispatching subagents or reviewers.",
    },
    resumeRunId: {
      type: "string",
      description: "Resume a prior workflow run by artifact run id. Skips tasks already recorded in the checkpoint; use fromTask to force a starting index.",
    },
    fromTask: {
      type: "integer",
      minimum: 0,
      description: "0-based task index to start from when resuming (skips all prior tasks).",
    },
    allowTextValidation: {
      type: "boolean",
      description: "When true, allow legacy text-heuristic subagent validation when structured JSON is missing. Default false (structured report required). Env fallback: CC_REVIEW_ALLOW_TEXT_VALIDATION=1.",
    },
  },
  required: ["goal"],
  additionalProperties: false,
};

export interface CcReviewExecuteParams {
  goal: string;
  reviewProvider?: string;
  logLevel?: string;
  logSources?: string;
  reviewMode?: string;
  reviewRepairRounds?: number;
  taskTimeoutMs?: number;
  widgetLogLines?: number;
  checklistWindow?: number;
  concurrency?: number;
  concurrencyLimit?: number;
  logFile?: string;
  checkOnly?: boolean;
  planOnly?: boolean;
  resumeRunId?: string;
  fromTask?: number;
  allowTextValidation?: boolean;
}

function registerCcReviewFindingsRenderer(pi: ExtensionAPI): void {
  if (typeof pi.registerMessageRenderer !== "function") return;

  let piTui: any;
  try {
    piTui = require("@earendil-works/pi-tui");
  } catch {
    return;
  }
  const BoxCtor = piTui?.Box;
  const TextCtor = piTui?.Text;
  if (typeof BoxCtor !== "function" || typeof TextCtor !== "function") return;

  try {
    pi.registerMessageRenderer("cc-review-findings", (message: any, opts: any, theme: any) => {
      const expanded = !!opts?.expanded;
      const content = (message?.details ?? {}) as CcReviewFindingsPayload;
      const kindLabel = content.kind === "rollup" ? "Rollup" : `Task ${(content.taskIndex ?? 0) + 1}`;
      const partial = content.partial ? " (partial run)" : "";
      const verdictColor =
        content.effectiveVerdict === "block"
          ? "error"
          : content.effectiveVerdict === "ship_with_warnings"
            ? "warning"
            : "success";
      let text = `${theme.fg(verdictColor, `[CC Review Findings ${kindLabel}${partial}]`)} ${content.effectiveVerdict}`;
      if (content.blockReason) {
        text += ` ${theme.fg("dim", `(${content.blockReason})`)}`;
      }
      if (expanded) {
        text += `\n${content.summary}`;
        for (const finding of content.findings ?? []) {
          const color =
            finding.priority === "P0" || finding.priority === "P1"
              ? "error"
              : finding.priority === "P2"
                ? "warning"
                : "muted";
          const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "workspace";
          text += `\n- ${theme.fg(color, `[${finding.priority}]`)} ${location}: ${finding.message} (${finding.status})`;
        }
        if (content.artifactPath) {
          text += `\n${theme.fg("dim", `Artifact: ${content.artifactPath}`)}`;
        }
      } else {
        text += `\n${theme.fg("dim", "  (expand for finding cards)")}`;
      }
      const box = new BoxCtor(1, 1, (t: string) => theme.bg("customMessageBg", t));
      box.addChild(new TextCtor(text, 0, 0));
      return box;
    });
  } catch {
    // ignore registration errors
  }
}

function registerCcReviewSummaryRenderer(pi: ExtensionAPI): void {
  if (typeof pi.registerMessageRenderer !== "function") return;

  let piTui: any;
  try {
    piTui = require("@earendil-works/pi-tui");
  } catch {
    return;
  }
  const BoxCtor = piTui?.Box;
  const TextCtor = piTui?.Text;
  if (typeof BoxCtor !== "function" || typeof TextCtor !== "function") return;

  const BADGE_PALETTE: Record<CcReviewSummaryBadge, { label: string; color: string }> = {
    success: { label: "OK", color: "success" },
    warning: { label: "WARN", color: "warning" },
    failed: { label: "FAIL", color: "error" },
    cancelled: { label: "CANCELLED", color: "error" },
  };

  try {
    pi.registerMessageRenderer("cc-review-summary", (message: any, opts: any, theme: any) => {
      const expanded = !!opts?.expanded;
      const content = typeof message?.content === "string" ? message.content : "";
      const meta = message?.details as CcReviewSummaryMeta | undefined;

      let badge: CcReviewSummaryBadge;
      if (meta && meta.taskOutcomes) {
        const outcomes = meta.taskOutcomes;
        if ((outcomes.cancelled ?? 0) > 0) {
          badge = "cancelled";
        } else if ((outcomes.failed ?? 0) > 0 || (outcomes.review_blocked ?? 0) > 0) {
          badge = "failed";
        } else if ((outcomes.warning ?? 0) > 0) {
          badge = "warning";
        } else if ((outcomes.completed ?? 0) > 0) {
          badge = "success";
        } else {
          badge = classifyCcReviewSummary(content);
        }
      } else {
        badge = classifyCcReviewSummary(content);
      }

      const palette = BADGE_PALETTE[badge];
      const prefix = theme.fg(palette.color, `[CC Review ${palette.label}]`);

      let headline = "";
      if (meta && meta.taskOutcomes) {
        const completed = meta.taskOutcomes.completed ?? 0;
        const warnings = meta.taskOutcomes.warning ?? 0;
        const failed = (meta.taskOutcomes.failed ?? 0) + (meta.taskOutcomes.review_blocked ?? 0);
        const total = completed + warnings + failed + (meta.taskOutcomes.cancelled ?? 0);
        const counts = { completed, warnings, failed, total };
        const rawHeadline = formatCcReviewSummaryHeadline(counts);
        headline = truncateForWidget(rawHeadline, 120);
      } else {
        headline = extractCcReviewSummaryHeadline(content);
      }

      if (!expanded && meta?.topBlockers?.length) {
        const blocker = meta.topBlockers[0];
        headline += ` · top blocker: [${blocker.priority}] ${truncateForWidget(blocker.message, 60)}`;
      }

      let text = `${prefix} ${headline}`;
      if (expanded && content) {
        text += `\n\n${content}`;
      } else if (!expanded) {
        text += `\n${theme.fg("dim", "  (expand for full report)")}`;
      }
      const box = new BoxCtor(1, 1, (t: string) => theme.bg("customMessageBg", t));
      box.addChild(new TextCtor(text, 0, 0));
      return box;
    });
  } catch {
    // ignore registration errors: this is best-effort UI polish.
  }
}

function extractCcReviewSummaryHeadline(summary: string): string {
  const counts = countCcReviewTaskOutcomesFromSummary(summary);
  const headline = formatCcReviewSummaryHeadline(counts);
  return truncateForWidget(headline, 120);
}

function splitCommandLine(input: string): string[] {
  const tokens: string[] = [];
  const tokenPattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(input)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    tokens.push(token.replace(/\\(["'\\])/g, "$1"));
  }
  return tokens;
}

export function parseCcReviewCommandArgs(args: string): {
  goal: string;
  reviewProvider?: string;
  logLevel?: string;
  logSources?: string;
  reviewMode?: string;
  reviewRepairRounds?: number;
  taskTimeoutMs?: number;
  widgetLogLines?: number;
  checklistWindow?: number;
  concurrency?: number;
  logFile?: string;
  checkOnly?: boolean;
  planOnly?: boolean;
  resumeRunId?: string;
  fromTask?: number;
  allowTextValidation?: boolean;
  error?: string;
} {
  const hasProviderFlag = /(?:^|\s)--(?:review-)?provider(?:=|\s|$)/.test(args);
  const hasLogLevelFlag = /(?:^|\s)--log-level(?:=|\s|$)/.test(args);
  const hasLogSourcesFlag = /(?:^|\s)--log-sources(?:=|\s|$)/.test(args);
  const hasReviewModeFlag = /(?:^|\s)--review-mode(?:=|\s|$)/.test(args);
  const hasReviewRepairRoundsFlag = /(?:^|\s)--review-repair-rounds(?:=|\s|$)/.test(args);
  const hasTaskTimeoutFlag = /(?:^|\s)--task-timeout(?:=|\s|$)/.test(args);
  const hasWidgetLogLinesFlag = /(?:^|\s)--widget-log-lines(?:=|\s|$)/.test(args);
  const hasChecklistWindowFlag = /(?:^|\s)--checklist-window(?:=|\s|$)/.test(args);
  const hasConcurrencyFlag = /(?:^|\s)--(?:concurrency|concurrency-limit)(?:=|\s|$)/.test(args);
  const hasLogFileFlag = /(?:^|\s)--log-file(?:=|\s|$)/.test(args);
  const hasCheckFlag = /(?:^|\s)--check(?:\s|$)/.test(args);
  const hasPlanOnlyFlag = /(?:^|\s)--plan-only(?:\s|$)/.test(args);
  const hasResumeFlag = /(?:^|\s)--resume(?:=|\s|$)/.test(args);
  const hasFromTaskFlag = /(?:^|\s)--from-task(?:=|\s|$)/.test(args);
  const hasAllowTextValidationFlag = /(?:^|\s)--allow-text-validation(?:\s|$)/.test(args);
  if (
    !hasProviderFlag &&
    !hasLogLevelFlag &&
    !hasLogSourcesFlag &&
    !hasReviewModeFlag &&
    !hasReviewRepairRoundsFlag &&
    !hasTaskTimeoutFlag &&
    !hasWidgetLogLinesFlag &&
    !hasChecklistWindowFlag &&
    !hasConcurrencyFlag &&
    !hasLogFileFlag &&
    !hasCheckFlag &&
    !hasPlanOnlyFlag &&
    !hasResumeFlag &&
    !hasFromTaskFlag &&
    !hasAllowTextValidationFlag
  ) {
    return { goal: args.trim() };
  }

  const tokens = splitCommandLine(args);
  const goalTokens: string[] = [];
  let reviewProvider: string | undefined;
  let logLevel: string | undefined;
  let logSources: string | undefined;
  let reviewMode: string | undefined;
  let reviewRepairRounds: number | undefined;
  let taskTimeoutMs: number | undefined;
  let widgetLogLines: number | undefined;
  let checklistWindow: number | undefined;
  let concurrency: number | undefined;
  let logFile: string | undefined;
  let checkOnly: boolean | undefined;
  let planOnly: boolean | undefined;
  let resumeRunId: string | undefined;
  let fromTask: number | undefined;
  let allowTextValidation: boolean | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const equalsProviderMatch = token.match(/^--(?:review-)?provider=(.*)$/);
    if (equalsProviderMatch) {
      reviewProvider = equalsProviderMatch[1];
      if (!reviewProvider) {
        return { goal: "", error: "Invalid --provider value \"\". Supported review providers: codex, claude." };
      }
      continue;
    }

    if (token === "--provider" || token === "--review-provider") {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { goal: "", error: `Invalid ${token} value "${value ?? ""}". Supported review providers: codex, claude.` };
      }
      reviewProvider = value;
      i++;
      continue;
    }

    const equalsLogLevelMatch = token.match(/^--log-level=(.*)$/);
    if (equalsLogLevelMatch) {
      logLevel = equalsLogLevelMatch[1];
      if (!logLevel) {
        return { goal: "", error: "Invalid --log-level value \"\". Supported log levels: debug, info, warning, error." };
      }
      continue;
    }

    if (token === "--log-level") {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { goal: "", error: `Invalid ${token} value "${value ?? ""}". Supported log levels: debug, info, warning, error.` };
      }
      logLevel = value;
      i++;
      continue;
    }

    const equalsLogSourcesMatch = token.match(/^--log-sources=(.*)$/);
    if (equalsLogSourcesMatch) {
      logSources = equalsLogSourcesMatch[1];
      continue;
    }

    if (token === "--log-sources") {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        logSources = "";
      } else {
        logSources = value;
        i++;
      }
      continue;
    }

    const equalsReviewModeMatch = token.match(/^--review-mode=(.*)$/);
    if (equalsReviewModeMatch) {
      reviewMode = equalsReviewModeMatch[1];
      if (!reviewMode) {
        return { goal: "", error: "Invalid --review-mode value \"\". Supported review modes: per-task, after-all." };
      }
      continue;
    }

    if (token === "--review-mode") {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { goal: "", error: `Invalid ${token} value "${value ?? ""}". Supported review modes: per-task, after-all.` };
      }
      reviewMode = value;
      i++;
      continue;
    }

    const equalsReviewRepairRoundsMatch = token.match(/^--review-repair-rounds=(.*)$/);
    if (equalsReviewRepairRoundsMatch) {
      const raw = equalsReviewRepairRoundsMatch[1];
      const parsed = Number(raw);
      if (raw === "" || !Number.isInteger(parsed) || parsed < 0) {
        return { goal: "", error: `Invalid --review-repair-rounds value "${raw}". Expected a non-negative integer.` };
      }
      reviewRepairRounds = parsed;
      continue;
    }

    if (token === "--review-repair-rounds") {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { goal: "", error: `Invalid ${token} value "${value ?? ""}". Expected a non-negative integer.` };
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { goal: "", error: `Invalid --review-repair-rounds value "${value}". Expected a non-negative integer.` };
      }
      reviewRepairRounds = parsed;
      i++;
      continue;
    }

    const equalsTaskTimeoutMatch = token.match(/^--task-timeout=(.*)$/);
    if (equalsTaskTimeoutMatch) {
      const raw = equalsTaskTimeoutMatch[1];
      const parsed = Number(raw);
      if (raw === "" || !Number.isFinite(parsed) || parsed < 0) {
        return { goal: "", error: `Invalid --task-timeout value "${raw}". Expected a non-negative number of milliseconds (0 disables).` };
      }
      taskTimeoutMs = Math.floor(parsed);
      continue;
    }

    if (token === "--task-timeout") {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { goal: "", error: `Invalid ${token} value "${value ?? ""}". Expected a non-negative number of milliseconds (0 disables).` };
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return { goal: "", error: `Invalid --task-timeout value "${value}". Expected a non-negative number of milliseconds (0 disables).` };
      }
      taskTimeoutMs = Math.floor(parsed);
      i++;
      continue;
    }

    const equalsWidgetLogLinesMatch = token.match(/^--widget-log-lines=(.*)$/);
    if (equalsWidgetLogLinesMatch) {
      const raw = equalsWidgetLogLinesMatch[1];
      const parsed = Number(raw);
      if (raw === "" || !Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
        return { goal: "", error: `Invalid --widget-log-lines value "${raw}". Expected a non-negative integer.` };
      }
      widgetLogLines = parsed;
      continue;
    }

    if (token === "--widget-log-lines") {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { goal: "", error: `Invalid ${token} value "${value ?? ""}". Expected a non-negative integer.` };
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
        return { goal: "", error: `Invalid --widget-log-lines value "${value}". Expected a non-negative integer.` };
      }
      widgetLogLines = parsed;
      i++;
      continue;
    }

    const equalsChecklistWindowMatch = token.match(/^--checklist-window=(.*)$/);
    if (equalsChecklistWindowMatch) {
      const raw = equalsChecklistWindowMatch[1];
      const parsed = Number(raw);
      if (raw === "" || !Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
        return { goal: "", error: `Invalid --checklist-window value "${raw}". Expected a non-negative integer.` };
      }
      checklistWindow = parsed;
      continue;
    }

    if (token === "--checklist-window") {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { goal: "", error: `Invalid ${token} value "${value ?? ""}". Expected a non-negative integer.` };
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
        return { goal: "", error: `Invalid --checklist-window value "${value}". Expected a non-negative integer.` };
      }
      checklistWindow = parsed;
      i++;
      continue;
    }

    const equalsConcurrencyMatch = token.match(/^--(?:concurrency|concurrency-limit)=(.*)$/);
    if (equalsConcurrencyMatch) {
      const raw = equalsConcurrencyMatch[1];
      const parsed = Number(raw);
      if (raw === "" || !Number.isInteger(parsed) || parsed < 1) {
        return { goal: "", error: `Invalid --concurrency value "${raw}". Expected a positive integer.` };
      }
      concurrency = parsed;
      continue;
    }

    if (token === "--concurrency" || token === "--concurrency-limit") {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { goal: "", error: `Invalid ${token} value "${value ?? ""}". Expected a positive integer.` };
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return { goal: "", error: `Invalid ${token} value "${value}". Expected a positive integer.` };
      }
      concurrency = parsed;
      i++;
      continue;
    }

    const equalsLogFileMatch = token.match(/^--log-file=(.*)$/);
    if (equalsLogFileMatch) {
      logFile = equalsLogFileMatch[1];
      continue;
    }

    if (token === "--log-file") {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { goal: "", error: `Invalid ${token} value "${value ?? ""}". Expected a log file path.` };
      }
      logFile = value;
      i++;
      continue;
    }

    if (token === "--check") {
      checkOnly = true;
      continue;
    }

    if (token === "--plan-only") {
      planOnly = true;
      continue;
    }

    const equalsResumeMatch = token.match(/^--resume=(.*)$/);
    if (equalsResumeMatch) {
      resumeRunId = equalsResumeMatch[1]?.trim();
      if (!resumeRunId) {
        return { goal: "", error: 'Invalid --resume value "". Expected a prior run id from cc-review-artifacts/<run-id>/.' };
      }
      continue;
    }

    if (token === "--resume") {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { goal: "", error: `Invalid ${token} value "${value ?? ""}". Expected a prior run id.` };
      }
      resumeRunId = value.trim();
      i++;
      continue;
    }

    const equalsFromTaskMatch = token.match(/^--from-task=(.*)$/);
    if (equalsFromTaskMatch) {
      const raw = equalsFromTaskMatch[1];
      const parsed = Number(raw);
      if (raw === "" || !Number.isInteger(parsed) || parsed < 0) {
        return { goal: "", error: `Invalid --from-task value "${raw}". Expected a non-negative integer.` };
      }
      fromTask = parsed;
      continue;
    }

    if (token === "--from-task") {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { goal: "", error: `Invalid ${token} value "${value ?? ""}". Expected a non-negative integer.` };
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { goal: "", error: `Invalid --from-task value "${value}". Expected a non-negative integer.` };
      }
      fromTask = parsed;
      i++;
      continue;
    }

    if (token === "--allow-text-validation") {
      allowTextValidation = true;
      continue;
    }

    goalTokens.push(token);
  }

  return {
    goal: goalTokens.join(" ").trim(),
    reviewProvider,
    logLevel,
    logSources,
    reviewMode,
    reviewRepairRounds,
    taskTimeoutMs,
    widgetLogLines,
    checklistWindow,
    concurrency,
    logFile,
    checkOnly,
    planOnly,
    resumeRunId,
    fromTask,
    allowTextValidation,
  };
}

export default function ccReviewExtension(pi: ExtensionAPI) {
  // Register the slash command
  pi.registerCommand("cc-review", {
    description: "Run CC Review to plan, execute via Pi subagents, and review either per task or once after all tasks. Use --review-mode per-task|after-all to select review timing; when omitted, set CC_REVIEW_MODE or fall back to after-all. Use --review-repair-rounds <n> to bound repair/re-review rounds (default 1; 0 disables; CC_REVIEW_MAX_REPAIR_ROUNDS fallback). Use --provider claude or --provider codex to select the planner+reviewer backend; when omitted, set CC_REVIEW_PROVIDER or fall back to codex. Use --log-level <debug|info|warning|error> and --log-sources <planner,subagent,reviewer,cc-review> (or their CC_REVIEW_LOG_LEVEL / CC_REVIEW_LOG_SOURCES env fallbacks) to filter compact surfaces. Explicit values override the environment, invalid values show all sources with one warning, and persisted logs remain unfiltered. Use --task-timeout <ms> (or the CC_REVIEW_TASK_TIMEOUT_MS env fallback; default 1800000, 0 disables) to configure the per-attempt subagent execution timeout. Use --concurrency <n> or --concurrency-limit <n> (or CC_REVIEW_CONCURRENCY; default automatically computed from available CPUs, bounded between 1 and 8 and capped by the planned task count) to cap dependency-safe parallel subagents. Use --log-file <path> (or CC_REVIEW_LOG_FILE) to write the persisted JSONL log to a fixed path; when omitted, a unique workflow-logs-<runId>.jsonl file is created in the cwd.",
    handler: async (args: string, ctx: any) => {
      const parsedArgs = parseCcReviewCommandArgs(args);
      if (parsedArgs.error) {
        ctx?.ui?.notify?.(parsedArgs.error, "error");
        return;
      }

      if (parsedArgs.checkOnly) {
        try {
          const workflowResult = await runCcReviewWorkflow(pi, parsedArgs.goal || "environment check", ctx, undefined, undefined, {
            checkOnly: true,
            reviewProvider: parsedArgs.reviewProvider,
          });
          await pi.sendMessage?.({
            customType: "cc-review-summary",
            content: workflowResult.summary,
            details: workflowResult.meta,
            display: true,
          });
        } catch (err: any) {
          ctx?.ui?.notify?.(`CC Review check failed: ${err.message}`, "error");
          if (err instanceof WorkflowError || err.summary) {
            await pi.sendMessage?.({
              customType: "cc-review-summary",
              content: err.summary,
              details: err.meta,
              display: true,
            });
          }
        }
        return;
      }

      let goal = parsedArgs.goal;
      if (!goal && !parsedArgs.resumeRunId) {
        goal = ((await ctx?.ui?.input?.("Enter the overarching goal to accomplish:")) ?? "").trim();
        if (!goal) {
          ctx?.ui?.notify?.("Goal cannot be empty", "error");
          return;
        }
      }

      ctx?.ui?.notify?.(`Starting CC Review for goal: "${goal}"`, "info");
      try {
        const workflowResult = await runCcReviewWorkflow(pi, goal, ctx, undefined, undefined, {
          reviewProvider: parsedArgs.reviewProvider,
          logLevel: parsedArgs.logLevel,
          logSources: parsedArgs.logSources,
          reviewMode: parsedArgs.reviewMode,
          reviewRepairRounds: parsedArgs.reviewRepairRounds,
          taskTimeoutMs: parsedArgs.taskTimeoutMs,
          widgetLogLines: parsedArgs.widgetLogLines,
          checklistWindow: parsedArgs.checklistWindow,
          concurrency: parsedArgs.concurrency,
          logFile: parsedArgs.logFile,
          planOnly: parsedArgs.planOnly,
          resumeRunId: parsedArgs.resumeRunId,
          fromTask: parsedArgs.fromTask,
          allowTextValidation: parsedArgs.allowTextValidation,
        });
        ctx?.ui?.notify?.("CC Review completed.", "info");
        
        // Output the final summary to the main session
        await pi.sendMessage?.({
          customType: "cc-review-summary",
          content: workflowResult.summary,
          details: workflowResult.meta,
          display: true,
        });
      } catch (err: any) {
        ctx?.ui?.notify?.(`CC Review failed: ${err.message}`, "error");
        if (err instanceof WorkflowError || err.summary) {
          await pi.sendMessage?.({
            customType: "cc-review-summary",
            content: err.summary,
            details: err.meta,
            display: true,
          });
        }
      }
    },
  });

  // Register a custom message renderer for the cc-review-summary payload so the
  // final report appears with a severity badge in the TUI (learned from pi's
  // example message-renderer.ts). Registration is best-effort: if the host pi
  // build doesn't expose registerMessageRenderer or the pi-tui primitives, this
  // is a no-op and the summary still displays as default markdown.
  registerCcReviewSummaryRenderer(pi);
  registerCcReviewFindingsRenderer(pi);

  // Register the tool
  pi.registerTool({
    name: "cc_review",
    label: "CC Review",
    description: "Run CC Review: plan a goal, execute tasks in dependency-safe after-all batches or per-task order, then review/fix either per task or once after all tasks. Pass reviewMode as per-task or after-all, or omit it to use CC_REVIEW_MODE / the after-all default. Pass reviewRepairRounds as a non-negative integer to bound repair/re-review rounds, or omit it to use CC_REVIEW_MAX_REPAIR_ROUNDS / the default 1; 0 disables repair. Pass reviewProvider as codex or claude, or omit it to use CC_REVIEW_PROVIDER / the codex default. Pass logLevel as debug|info|warning|error and logSources as a comma-separated planner,subagent,reviewer,cc-review allow-list, or omit them to use CC_REVIEW_LOG_LEVEL / CC_REVIEW_LOG_SOURCES. Explicit logSources override the environment, invalid values show all sources with one warning, and persisted logs remain unfiltered. Pass taskTimeoutMs as a non-negative number of milliseconds (0 disables), or omit it to use CC_REVIEW_TASK_TIMEOUT_MS / the 1800000 (30 min) default. Pass concurrency or concurrencyLimit as a positive integer, or omit to use CC_REVIEW_CONCURRENCY / the default automatically computed from available CPUs (bounded between 1 and 8, capped by the planned task count). Pass logFile as a fixed log file path (or set CC_REVIEW_LOG_FILE); when omitted, a unique workflow-logs-<runId>.jsonl file is created in the cwd.",
    parameters: CcReviewParams,
    async execute(_toolCallId: string, params: CcReviewExecuteParams, signal?: AbortSignal, onUpdate?: (update: any) => void, ctx?: any) {
      const renderDetails = {
        goal: params.goal,
        reviewProvider: (params.reviewProvider ?? process.env.CC_REVIEW_PROVIDER ?? "codex").trim().toLowerCase() || "codex",
        reviewMode: (params.reviewMode ?? process.env.CC_REVIEW_MODE ?? "after-all").trim().toLowerCase() || "after-all",
      };
      const renderUpdate = onUpdate
        ? (update: any) => onUpdate({ ...update, details: { ...renderDetails, ...update?.details } })
        : undefined;
      renderUpdate?.({ content: [{ type: "text", text: "Starting CC Review..." }] });

      try {
        const workflowResult = await runCcReviewWorkflow(pi, params.goal, ctx, renderUpdate, signal, {
          reviewProvider: params.reviewProvider,
          logLevel: params.logLevel,
          logSources: params.logSources,
          reviewMode: params.reviewMode,
          reviewRepairRounds: params.reviewRepairRounds,
          taskTimeoutMs: params.taskTimeoutMs,
          widgetLogLines: params.widgetLogLines,
          checklistWindow: params.checklistWindow,
          concurrency: params.concurrency,
          concurrencyLimit: params.concurrencyLimit,
          logFile: params.logFile,
          checkOnly: params.checkOnly,
          planOnly: params.planOnly,
          resumeRunId: params.resumeRunId,
          fromTask: params.fromTask,
          allowTextValidation: params.allowTextValidation,
        });
        return {
          content: [{ type: "text", text: workflowResult.summary }],
          details: { ...renderDetails, status: "completed", meta: workflowResult.meta },
        };
      } catch (err: any) {
        const summary = err.summary || `Workflow failed: ${err.message}`;
        return {
          content: [{ type: "text", text: summary }],
          details: {
            ...renderDetails,
            status: "failed",
            error: err.message,
            meta: err.meta ?? buildCcReviewSummaryMeta([]),
          },
          isError: true,
        };
      }
    },
    renderCall(args: any, theme: any, context: any) {
      let piTui: any;
      try {
        piTui = require("@earendil-works/pi-tui");
      } catch {
        return undefined;
      }
      const Text = piTui?.Text;
      if (!Text) return undefined;

      const goal = args?.goal || "";
      const goalPreview = previewWidgetText(goal, 40);
      const provider = args?.reviewProvider || "codex";
      const mode = args?.reviewMode || "after-all";

      let text = theme.fg("toolTitle", theme.bold("cc_review"));
      text += " " + theme.fg("muted", `"${goalPreview}"`);
      text += " " + theme.fg("dim", `[provider: ${provider}, mode: ${mode}]`);
      return new Text(text, 0, 0);
    },
    renderResult(result: any, options: any, theme: any) {
      let piTui: any;
      try {
        piTui = require("@earendil-works/pi-tui");
      } catch {
        return undefined;
      }
      const Text = piTui?.Text;
      if (!Text) return undefined;

      const { expanded, isPartial } = options || {};
      const details = result?.details;
      const goal = details?.goal || "";
      const goalPreview = previewWidgetText(goal, 40);
      const provider = details?.reviewProvider || "codex";
      const mode = details?.reviewMode || "after-all";

      if (isPartial) {
        let progressText = "Initializing...";
        if (result?.content) {
          for (let i = result.content.length - 1; i >= 0; i--) {
            const t = result.content[i]?.text;
            if (t && t.trim()) {
              const lines = t.trim().split("\n");
              const lastLine = lines[lines.length - 1].trim();
              if (lastLine) {
                progressText = lastLine;
                break;
              }
            }
          }
        }
        progressText = previewWidgetText(progressText, 60);

        let text = theme.fg("warning", "⟳ Running");
        text += " " + theme.fg("muted", ` "${goalPreview}"`);
        text += " " + theme.fg("dim", ` [provider: ${provider}, mode: ${mode}]`);
        text += " " + theme.fg("muted", ` | Progress: ${progressText}`);
        return new Text(text, 0, 0);
      }

      // Finished execution
      const isError = !!result?.isError;
      const errorMsg = details?.error || "";

      let statusText = "Success";
      let statusColor = "success";
      let statusIcon = "✓";

      if (isError) {
        if (/cancel|abort/i.test(errorMsg)) {
          statusText = "Cancelled";
          statusColor = "error";
          statusIcon = "🛑";
        } else {
          statusText = "Failed";
          statusColor = "error";
          statusIcon = "✖";
        }
      } else {
        // Check metadata for warnings/failures
        const meta = details?.meta as CcReviewSummaryMeta | undefined;
        if (meta && meta.taskOutcomes) {
          const outcomes = meta.taskOutcomes;
          if ((outcomes.cancelled ?? 0) > 0) {
            statusText = "Cancelled";
            statusColor = "error";
            statusIcon = "\ud83d\uded1";
          } else if ((outcomes.failed ?? 0) > 0 || (outcomes.review_blocked ?? 0) > 0) {
            statusText = "Failed";
            statusColor = "error";
            statusIcon = "✖";
          } else if ((outcomes.warning ?? 0) > 0) {
            statusText = "Warning";
            statusColor = "warning";
            statusIcon = "⚠";
          }
        } else {
          // Fallback to regex badge classification
          const contentText = result?.content?.[0]?.text || "";
          const badge = classifyCcReviewSummary(contentText);
          if (badge === "failed") {
            statusText = "Failed";
            statusColor = "error";
            statusIcon = "✖";
          } else if (badge === "warning") {
            statusText = "Warning";
            statusColor = "warning";
            statusIcon = "⚠";
          } else if (badge === "cancelled") {
            statusText = "Cancelled";
            statusColor = "error";
            statusIcon = "🛑";
          }
        }
      }

      let text = `${theme.fg(statusColor, `${statusIcon} ${statusText}`)}`;
      text += " " + theme.fg("muted", `"${goalPreview}"`);
      text += " " + theme.fg("dim", `[provider: ${provider}, mode: ${mode}]`);

      if (expanded) {
        const contentText = result?.content?.[0]?.text || "";
        if (contentText) {
          text += "\n" + contentText;
        }
      }

      return new Text(text, 0, 0);
    },
  });
}
