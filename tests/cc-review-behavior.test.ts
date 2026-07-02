import test, { describe, it, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import child_process from "node:child_process";
import { mock } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import ccReviewExtension, {
  appendPersistedLogEntry,
  buildAfterAllExecutionBatches,
  buildBuiltinWorkerAgent,
  buildCcReviewStatusText,
  buildCcReviewWidgetLines,
  buildPriorTaskHandoff,
  buildRepairFeedback,
  buildSubagentTaskPrompt,
  priorTaskHandoffFromResults,
  classifyCcReviewSummary,
  computeChecklistWindow,
  computeDefaultAutoConcurrency,
  readAvailableCpuCount,
  countCcReviewTaskOutcomesFromSummary,
  createSubprocessStreamLogger,
  DEFAULT_MAX_REVIEW_REPAIR_ROUNDS,
  DEFAULT_TASK_TIMEOUT_MS,
  discoverAgent,
  extractAssistantTextFromStream,
  filterCcReviewLogEntries,
  formatSubprocessStreamLine,
  inferSubprocessStreamSeverity,
  formatCcReviewSummaryHeadline,
  formatPhaseSeverityLine,
  normalizeCcReviewLogEntry,
  previewWidgetText,
  renderCcReviewLogEntry,
  resolveCcReviewLogLevel,
  resolveCcReviewLogPath,
  resolveCcReviewConcurrency,
  resolveMaxReviewRepairRounds,
  resolvePlannerTimeoutMs,
  resolveReviewMode,
  resolveReviewerTimeoutMs,
  resolveSubagentTaskTimeout,
  resolveCcReviewWidgetLogLines,
  resolveCcReviewChecklistWindow,
  collapseConsecutiveLogEntries,
  emptyFindingsRollup,
  summarizeLogSeverities,
  summarizeSubagentToolActivity,
  truncateForWidget,
  runSubprocess,
  appendStreamText,
  SUBPROCESS_OUTPUT_TRUNCATED_MARKER,
  enterCcReviewWorkflowNest,
  CcReviewNestDepthError,
  CC_REVIEW_NEST_DEPTH_ENV,
  runPreflight,
  shouldSkipPreflight,
  formatPreflightReport,
  validateSubagentOutput,
  resolveAllowTextValidation,
  writeCheckpoint,
  loadCheckpoint,
  restoreBatchTaskExecutions,
  resolveTasksToSkipOnResume,
  rebuildStateBufferFromTaskResults,
  resolveCcReviewTracePath,
  getPiSpawnCommand,
  formatResolvedPiCommand,
  findPiPackageRootFromEntry,
  resolveWindowsPiCliScript,
  CC_REVIEW_PI_BINARY_ENV,
  PI_SUBAGENT_PI_BINARY_ENV,
  PI_CODING_AGENT_PACKAGE,
  type PiSpawnDeps,
  attachPostExitStdioGuard,
  resolvePostExitGuardTimings,
  DEFAULT_POST_EXIT_IDLE_MS,
  DEFAULT_POST_EXIT_HARD_MS,
  resolveSessionContinuity,
  resolveTaskSessionFile,
  resolvePriorTaskSessionPath,
  describeSessionPath,
  CC_REVIEW_SESSION_CONTINUITY_ENV,
  CC_REVIEW_SESSION_CHAIN_ENV,
  splitThinkingSuffix,
  parseFallbackModels,
  buildModelCandidates,
  isRetryableModelFailure,
  formatModelAttemptNote,
  summarizeAttemptedModels,
  resolveModelFallbackConfig,
  type ModelAttemptSummary,
  type ModelFallbackConfig,
  resolveStructuredOutputStrict,
  resolveStructuredOutputFile,
  readStructuredOutputFile,
  CC_REVIEW_STRUCTURED_OUTPUT_STRICT_ENV,
  expectsImplementationMutation,
  isMutatingBashCommand,
  hasMutationToolCall,
  evaluateCompletionMutationGuard,
  type GuardedToolEvent,
  createSubagentActivityTracker,
  recordActivity,
  recordToolFailure,
  markCompleted,
  classifySubagentControlState,
  emitControlEvent,
  formatControlEventLabel,
  formatControlStateLabel,
  buildControlEventLogPayload,
  DEFAULT_CONTROL_THRESHOLDS,
} from "../.pi/extensions/cc-review.ts";

const plainWidgetTheme = { fg: (_color: string, text: string) => text };

function findWorkflowTracePath(cwd: string): string {
  const logsRoot = path.join(cwd, ".cc-review", "logs");
  if (!fs.existsSync(logsRoot)) {
    throw new Error(`missing log directory: ${logsRoot}`);
  }
  for (const runId of fs.readdirSync(logsRoot)) {
    const candidate = path.join(logsRoot, runId, "workflow-trace.jsonl");
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`workflow-trace.jsonl not found under ${logsRoot}`);
}

function captureWidgetLines(
  content: string[] | ((tui: unknown, theme: unknown) => { render?: (width: number) => string[] }) | undefined,
  width = 96
): string[] | undefined {
  if (Array.isArray(content)) return [...content];
  if (typeof content === "function") {
    const component = content({}, plainWidgetTheme);
    return component?.render ? component.render(width) : undefined;
  }
  return undefined;
}

function createWidgetCaptureUi(options?: {
  width?: number;
  theme?: typeof plainWidgetTheme;
}): {
  ui: {
    theme: typeof plainWidgetTheme;
    setWidget: (id: string, content: Parameters<typeof captureWidgetLines>[0]) => void;
    setStatus: (id: string, value: string | undefined) => void;
    requestRender: () => void;
  };
  widgetSnapshots: string[][];
  statusSnapshots: string[];
  widgetCleared: () => boolean;
  statusCleared: () => boolean;
} {
  const width = options?.width ?? 96;
  const theme = options?.theme ?? plainWidgetTheme;
  const widgetSnapshots: string[][] = [];
  const statusSnapshots: string[] = [];
  let mountedComponent: { render?: (renderWidth: number) => string[] } | undefined;
  let widgetWasCleared = false;
  let statusWasCleared = false;

  const captureRender = () => {
    const lines = mountedComponent?.render?.(width);
    if (lines) widgetSnapshots.push(lines);
  };

  return {
    widgetSnapshots,
    statusSnapshots,
    widgetCleared: () => widgetWasCleared,
    statusCleared: () => statusWasCleared,
    ui: {
      theme,
      setWidget: (_id: string, content: Parameters<typeof captureWidgetLines>[0]) => {
        if (content === undefined) {
          widgetWasCleared = true;
          mountedComponent = undefined;
          return;
        }
        if (typeof content === "function") {
          mountedComponent = content({}, theme);
          captureRender();
          return;
        }
        const lines = captureWidgetLines(content, width);
        if (lines) widgetSnapshots.push(lines);
      },
      setStatus: (_id: string, value: string | undefined) => {
        if (value === undefined) {
          statusWasCleared = true;
          return;
        }
        statusSnapshots.push(value);
      },
      requestRender: () => {
        captureRender();
      },
    },
  };
}

describe("summarizes subagent tool activity for live progress", () => {
  it("includes a bounded, whitespace-collapsed command hint for bash", () => {
    const long = "echo " + "x".repeat(200);
    const out = summarizeSubagentToolActivity({ type: "tool_execution_start", toolName: "bash", args: { command: long } });
    assert.match(out, /^⚙ bash: echo /);
    assert.ok(out.endsWith("…"));
    assert.ok(out.length <= 90);
  });

  it("prefers file path hints for file tools", () => {
    assert.equal(
      summarizeSubagentToolActivity({ type: "tool_execution_start", toolName: "read", args: { path: "src/app.ts" } }),
      "⚙ read: src/app.ts"
    );
    assert.equal(
      summarizeSubagentToolActivity({ type: "tool_execution_start", toolName: "edit", args: { file_path: "lib/x.ts" } }),
      "⚙ edit: lib/x.ts"
    );
  });

  it("falls back to the tool name when no useful arg is present", () => {
    assert.equal(summarizeSubagentToolActivity({ type: "tool_execution_start", toolName: "think", args: {} }), "⚙ think");
    assert.equal(summarizeSubagentToolActivity({ type: "tool_execution_start" }), "⚙ tool");
  });
});

describe("formatSubprocessStreamLine turns structured CLI output into readable log lines", () => {
  it("summarizes planner task JSON instead of dumping raw payloads", () => {
    const formatted = formatSubprocessStreamLine(
      JSON.stringify({
        tasks: [
          { title: "Task A", description: "d", acceptanceCriteria: "a" },
          { title: "Task B", description: "d", acceptanceCriteria: "a" },
        ],
      })
    );
    assert.equal(formatted, "Planned 2 tasks: Task A; Task B");
  });

  it("summarizes reviewer verdict JSON instead of dumping raw payloads", () => {
    const formatted = formatSubprocessStreamLine(
      JSON.stringify({
        verdict: "ship",
        summary: "All checks passed",
        findings: [{ priority: "P2", confidence: 1, message: "nit", status: "fixed" }],
      })
    );
    assert.match(formatted ?? "", /^Review: ship — All checks passed — 1 finding/);
  });

  it("skips JSON fragments and workflow trace noise", () => {
    assert.equal(formatSubprocessStreamLine('  "tasks": ['), null);
    assert.equal(formatSubprocessStreamLine('{"type":"workflow_trace","event":"workflow_start"}'), null);
  });

  it("keeps ordinary prose lines unchanged", () => {
    assert.equal(formatSubprocessStreamLine("exec /bin/zsh -lc \"git status\""), 'exec /bin/zsh -lc "git status"');
  });

  it("translates Codex JSONL work items into concrete activity", () => {
    assert.equal(
      formatSubprocessStreamLine(JSON.stringify({
        type: "item.started",
        item: { type: "command_execution", command: "/bin/zsh -lc 'npm test'", status: "in_progress" },
      })),
      "Running command: /bin/zsh -lc 'npm test'"
    );
    assert.equal(
      formatSubprocessStreamLine(JSON.stringify({
        type: "item.completed",
        item: { type: "file_change", changes: [{ path: "src/app.ts" }, { path: "tests/app.test.ts" }] },
      })),
      "Updated 2 files: src/app.ts, tests/app.test.ts"
    );
    assert.equal(
      formatSubprocessStreamLine(JSON.stringify({
        type: "item.completed",
        item: { type: "reasoning", text: "Checking the parser and its tests" },
      })),
      "Thinking: Checking the parser and its tests"
    );
  });

  it("translates Claude stream-json tool and completion events", () => {
    assert.equal(
      formatSubprocessStreamLine(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/app.ts" } }] },
      })),
      "Using tool: Read — src/app.ts"
    );
    assert.equal(
      formatSubprocessStreamLine(JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1250,
        num_turns: 2,
        result: "done",
      })),
      "Claude run completed (1.3s, 2 turns)"
    );
  });

  it("hides unknown or malformed JSON rather than exposing raw provider payloads", () => {
    assert.equal(formatSubprocessStreamLine('{"type":"future.provider.event","opaque":true}'), null);
    assert.equal(formatSubprocessStreamLine('{"type":"item.started","item":'), null);
  });
});

describe("createSubprocessStreamLogger buffers provider NDJSON across data chunks", () => {
  it("does not expose a split JSON fragment and emits one readable event after the newline", () => {
    const entries: any[] = [];
    const logger = createSubprocessStreamLogger((entry) => entries.push(entry), "stdout", "planner");
    logger.write('{"type":"item.started","item":{"type":"command_execution","command":"npm');
    assert.deepEqual(entries, []);
    logger.write(' test","status":"in_progress"}}\n');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].message, "Running command: npm test");
    assert.equal(entries[0].source, "planner");
  });

  it("flushes a final plain-text line without a trailing newline", () => {
    const entries: any[] = [];
    const logger = createSubprocessStreamLogger((entry) => entries.push(entry), "stderr", "reviewer");
    logger.write("review completed");
    assert.deepEqual(entries, []);
    logger.flush();
    assert.equal(entries[0].message, "review completed");
  });
});

describe("inferSubprocessStreamSeverity classifies CLI stream lines by content", () => {
  it("treats routine stderr diagnostics as info", () => {
    assert.equal(
      inferSubprocessStreamSeverity("docs/plugin-log-surface-audit.md:70: retry field docs", "stderr"),
      "info"
    );
    assert.equal(
      inferSubprocessStreamSeverity("exec /bin/zsh -lc \"git status\" succeeded in 0ms", "stderr"),
      "info"
    );
  });

  it("elevates stderr lines with explicit failure signals", () => {
    assert.equal(inferSubprocessStreamSeverity("schema validation failed", "stderr"), "error");
    assert.equal(inferSubprocessStreamSeverity("Claude review failed", "stderr"), "error");
    assert.equal(inferSubprocessStreamSeverity("rate limited", "stderr"), "warning");
  });
});

describe("renders severity-aware log entries for the CC Review display", () => {
  const baseEntry = normalizeCcReviewLogEntry({
    timestamp: "2026-06-26T03:04:05.678Z",
    source: "planner",
    pluginId: "cc-review",
    message: "Ready for task execution",
  }, { sequence: 1 });

  it("renders severity-aware log entries with distinct labels, timestamps, source, and messages", () => {
    const renderedDebug = renderCcReviewLogEntry({ ...baseEntry, severity: "debug", message: "Inspecting planner output" });
    const renderedInfo = renderCcReviewLogEntry({ ...baseEntry, severity: "info", message: "Planner ready" });
    const renderedWarning = renderCcReviewLogEntry({ ...baseEntry, severity: "warning", source: "reviewer", message: "Reviewer exited with code 1" });
    const renderedError = renderCcReviewLogEntry({ ...baseEntry, severity: "error", source: "subagent", message: "Task execution failed" });

    assert.deepEqual(renderedDebug, ["🔎 DEBUG 2026-06-26 03:04:05Z [planner]: Inspecting planner output"]);
    assert.deepEqual(renderedInfo, ["ℹ INFO  2026-06-26 03:04:05Z [planner]: Planner ready"]);
    assert.deepEqual(renderedWarning, ["⚠ WARN  2026-06-26 03:04:05Z [reviewer]: Reviewer exited with code 1"]);
    assert.deepEqual(renderedError, ["✖ ERROR 2026-06-26 03:04:05Z [subagent]: Task execution failed"]);
  });

  it("renders missing optional metadata and invalid timestamps cleanly", () => {
    const entry = normalizeCcReviewLogEntry({
      timestamp: "not-a-date",
      severity: "warn",
      source: "   ",
      pluginId: "cc-review",
      message: "\u001b[31mRecovered after retry\u001b[0m",
    }, { sequence: 2 });

    assert.deepEqual(renderCcReviewLogEntry(entry), [
      "⚠ WARN  unknown-time [cc-review]: Recovered after retry",
    ]);
  });

  it("wraps long rendered log messages without breaking layout", () => {
    const entry = normalizeCcReviewLogEntry({
      timestamp: "2026-06-26T03:04:05.678Z",
      severity: "error",
      source: "reviewer",
      message: "Supercalifragilisticexpialidocious tokens wrap cleanly around the compact log widget boundary",
    }, { sequence: 3 });

    const rendered = renderCcReviewLogEntry(entry, { maxMessageWidth: 20 });
    const prefix = "✖ ERROR 2026-06-26 03:04:05Z [reviewer]: ";
    assert.equal(rendered[0], `${prefix}Supercalifragilistic`);
    assert.equal(rendered[1], `${" ".repeat(prefix.length)}expialidocious`);
    assert.equal(rendered[2], `${" ".repeat(prefix.length)}tokens wrap cleanly`);
    assert.equal(rendered[3], `${" ".repeat(prefix.length)}around the compact`);
    assert.equal(rendered[4], `${" ".repeat(prefix.length)}log widget boundary`);
    for (const continuation of rendered.slice(1)) {
      assert.ok(continuation.startsWith(" ".repeat(prefix.length)), "continuation line should align under message body");
    }
  });

  it("respects maxLineWidth so prefix plus first message line fits the widget budget", () => {
    const entry = normalizeCcReviewLogEntry({
      timestamp: "2026-06-26T03:04:05.678Z",
      severity: "info",
      source: "subagent",
      message: "bash: cd /workspace && grep -R observability docs tests README workflow-baseline.md",
    }, { sequence: 4 });

    const maxLineWidth = 80;
    const rendered = renderCcReviewLogEntry(entry, { maxLineWidth });
    assert.ok(rendered.length > 0);
    for (const line of rendered) {
      assert.ok(line.length <= maxLineWidth, `line too long (${line.length}): ${line}`);
    }
  });
});

describe("summarizeLogSeverities rolls up CC Review liveLogs into a compact widget line", () => {
  const makeEntry = (severity: "debug" | "info" | "warning" | "error", sequence: number) =>
    normalizeCcReviewLogEntry(
      {
        timestamp: "2026-06-26T03:04:05.678Z",
        severity,
        source: "cc-review",
        pluginId: "cc-review",
        message: `entry-${sequence}`,
      },
      { sequence }
    );

  it("summarizes mixed severities ordered error > warning > info > debug and omits zero counts", () => {
    const entries = [
      makeEntry("error", 1),
      makeEntry("warning", 2),
      makeEntry("warning", 3),
      makeEntry("info", 4),
      makeEntry("info", 5),
      makeEntry("info", 6),
      makeEntry("info", 7),
      makeEntry("info", 8),
    ];
    assert.equal(
      summarizeLogSeverities(entries),
      "\u03a3 1 error \u00b7 2 warnings \u00b7 5 info"
    );
  });

  it("pluralizes errors and warnings while keeping info/debug as mass nouns", () => {
    const single = summarizeLogSeverities([makeEntry("error", 1), makeEntry("warning", 2), makeEntry("info", 3)]);
    const many = summarizeLogSeverities([
      makeEntry("error", 1),
      makeEntry("error", 2),
      makeEntry("warning", 3),
      makeEntry("warning", 4),
      makeEntry("warning", 5),
      makeEntry("info", 6),
    ]);
    assert.equal(single, "\u03a3 1 error \u00b7 1 warning \u00b7 1 info");
    assert.equal(many, "\u03a3 2 errors \u00b7 3 warnings \u00b7 1 info");
  });

  it("shows a neutral 'no issues' line when only info/debug entries are present", () => {
    const infoOnly = summarizeLogSeverities([
      makeEntry("info", 1),
      makeEntry("info", 2),
      makeEntry("debug", 3),
    ]);
    assert.ok(infoOnly.startsWith("\u03a3 no issues"), `expected 'no issues' prefix, got: ${infoOnly}`);
    assert.doesNotMatch(infoOnly, /error|warning/);
    // info/debug counts still surfaced after the neutral phrase to remain informative.
    assert.match(infoOnly, /2 info/);
    assert.match(infoOnly, /1 debug/);
  });

  it("returns a stable placeholder for empty or nullish input", () => {
    assert.equal(summarizeLogSeverities([]), "\u03a3 no logs");
    // @ts-expect-error — helper must tolerate undefined defensively at call sites.
    assert.equal(summarizeLogSeverities(undefined), "\u03a3 no logs");
    // @ts-expect-error — helper must tolerate null defensively at call sites.
    assert.equal(summarizeLogSeverities(null), "\u03a3 no logs");
  });

  it("truncates overly long rollups via truncateForWidget using maxWidth", () => {
    // Construct mixed severities so the rollup body is long enough to overflow.
    const entries = [
      ...Array.from({ length: 99 }, (_, idx) => makeEntry("error", idx + 1)),
      ...Array.from({ length: 99 }, (_, idx) => makeEntry("warning", idx + 100)),
      ...Array.from({ length: 99 }, (_, idx) => makeEntry("info", idx + 200)),
      ...Array.from({ length: 99 }, (_, idx) => makeEntry("debug", idx + 300)),
    ];
    const full = summarizeLogSeverities(entries);
    assert.ok(full.length > 20, `precondition: full rollup should be long enough to overflow, got: ${full}`);
    const narrow = summarizeLogSeverities(entries, { maxWidth: 16 });
    assert.ok(narrow.length <= 16, `expected length <= 16, got ${narrow.length} (${narrow})`);
    assert.ok(narrow.endsWith("\u2026"), `expected ellipsis suffix, got: ${narrow}`);
    assert.ok(narrow.startsWith("\u03a3"), `expected leading sigma, got: ${narrow}`);
  });

  it("is wired into buildCcReviewWidgetLines via formatPhaseSeverityLine", () => {
    const liveLogs = [makeEntry("warning", 1)];
    const expected = formatPhaseSeverityLine("Reviewing", liveLogs);
    const lines = buildCcReviewWidgetLines({
      goal: "Verify phase rollup",
      tasks: [],
      currentTaskIndex: -1,
      displayState: "reviewing",
      currentPhase: "Reviewing",
      liveLogs,
      resolvedLogLevel: "debug",
      persistedLogPath: "/tmp/workflow.log",
      findingsRollup: emptyFindingsRollup(),
    });
    assert.ok(lines.includes(expected));
  });
});

describe("buildCcReviewStatusText surfaces task progress and retry state", () => {
  it("shows planning before tasks exist", () => {
    assert.equal(
      buildCcReviewStatusText({ tasks: [], currentTaskIndex: -1, displayState: "planning" }),
      "[CC Review] Planning"
    );
  });

  it("shows task progress during execution and retry counter when retrying", () => {
    assert.equal(
      buildCcReviewStatusText({
        tasks: [{}, {}, {}],
        currentTaskIndex: 1,
        displayState: "executing",
      }),
      "[CC Review] Task 2/3 Executing"
    );
    assert.equal(
      buildCcReviewStatusText({
        tasks: [{}, {}, {}],
        currentTaskIndex: 1,
        displayState: "retrying",
        retryState: { attempt: 2, maxAttempts: 3 },
      }),
      "[CC Review] Task 2/3 Retrying ⟳2/3"
    );
  });
});

describe("buildCcReviewWidgetLines colors and merges phase with severity rollup", () => {
  const mockTheme = {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  };

  it("merges phase and severity rollup on one line", () => {
    const merged = formatPhaseSeverityLine("Executing Task 2/5", [
      normalizeCcReviewLogEntry({ severity: "error", message: "boom" }, { sequence: 1 }),
      normalizeCcReviewLogEntry({ severity: "warning", message: "hmm" }, { sequence: 2 }),
    ], { theme: mockTheme });
    assert.match(merged, /<accent>/);
    assert.match(merged, /<error>1 error<\/error>/);
    assert.match(merged, /<warning>1 warning<\/warning>/);
  });

  it("uses adaptive width via truncateWidgetLine and colors task markers", () => {
    const lines = buildCcReviewWidgetLines(
      {
        goal: "Ship widget polish",
        tasks: [{ title: "Color the widget" }, { title: "Add status progress" }],
        currentTaskIndex: 0,
        displayState: "executing",
        currentPhase: "Executing Task 1/2",
        liveLogs: [],
        resolvedLogLevel: "info",
        persistedLogPath: "/tmp/workflow-logs.jsonl",
      },
      { width: 80, theme: mockTheme }
    );
    assert.ok(lines.some((line) => line.includes("<accent>") && line.includes("Goal:")));
    assert.ok(lines.some((line) => line.includes("<accent>") && line.includes("\u25b8")));
    assert.ok(lines.some((line) => line.includes("Executing Task 1/2")));
    assert.ok(lines.some((line) => line.includes("/tmp/workflow-logs.jsonl")));
    for (const line of lines) {
      assert.ok(line.length <= 80, `widget line exceeds width 80 (${line.length}): ${line}`);
    }
  });

  it("truncates an overlong Full log path line", () => {
    const longPath = `/tmp/${"very-long-segment/".repeat(20)}workflow-logs.jsonl`;
    const lines = buildCcReviewWidgetLines(
      {
        goal: "Ship widget polish",
        tasks: [{ title: "Color the widget" }],
        currentTaskIndex: 0,
        displayState: "executing",
        currentPhase: "Executing Task 1/1",
        liveLogs: [],
        resolvedLogLevel: "info",
        persistedLogPath: longPath,
        findingsRollup: { tasksReviewed: 0, ship: 0, shipWithWarnings: 0, blocked: 0, unfixedP0: 0, unfixedP1: 0, unfixedP2P3: 0 },
      },
      { width: 60, theme: mockTheme }
    );
    const fullLogLine = lines[lines.length - 1];
    assert.ok(fullLogLine.length <= 60, `expected truncated Full log line, got length ${fullLogLine.length}`);
    assert.ok(fullLogLine.includes("\u2026") || fullLogLine.length < longPath.length);
  });
});

describe("formatCcReviewSummaryHeadline uses structured task outcome counts", () => {
  it("parses status lines from the markdown summary", () => {
    const summary = `## Report

1. **Task A**
   - *Status:* Completed and reviewed
2. **Task B**
   - *Status:* Completed with warnings (subagent exit 1, review exit 0)
3. **Task C**
   - *Status:* Failed (subagent exit 1)
`;
    const counts = countCcReviewTaskOutcomesFromSummary(summary);
    assert.deepEqual(counts, { completed: 1, warnings: 1, failed: 1, total: 3 });
    assert.equal(formatCcReviewSummaryHeadline(counts), "1 完成 · 1 警告 · 1 失败");
  });
});

describe("previewWidgetText bounds long goal/title strings for the compact widget", () => {
  it("returns short single-line input unchanged", () => {
    assert.equal(previewWidgetText("Ship the demo"), "Ship the demo");
  });

  it("collapses internal whitespace, newlines, and tabs into single spaces and trims", () => {
    assert.equal(
      previewWidgetText("\n\n  hello\tworld   from\nthe planner  \n"),
      "hello world from the planner"
    );
  });

  it("caps long input to the configured max length with a single-char ellipsis", () => {
    const long = "a".repeat(200);
    const out = previewWidgetText(long, 32);
    assert.equal(out.length, 32);
    assert.equal(out.endsWith("\u2026"), true);
    // Body before the ellipsis is the leading slice of the original.
    assert.equal(out.slice(0, -1), "a".repeat(31));
  });

  it("uses the default cap when no maxLength is supplied", () => {
    const long = "b".repeat(500);
    const out = previewWidgetText(long);
    assert.equal(out.length, 80, `expected default cap of 80, got length ${out.length}`);
    assert.equal(out.endsWith("\u2026"), true);
  });

  it("handles multi-line long input by collapsing first, then capping", () => {
    const multi = `Line one with detail\n\nLine two with even more detail\n\tand a trailing fragment that pushes us over the limit`;
    const out = previewWidgetText(multi, 40);
    assert.equal(out.length, 40);
    assert.equal(out.endsWith("\u2026"), true);
    assert.equal(out.includes("\n"), false, "newlines must be collapsed");
    assert.equal(out.includes("\t"), false, "tabs must be collapsed");
  });

  it("returns an empty string for empty, whitespace-only, null, or undefined input", () => {
    assert.equal(previewWidgetText(""), "");
    assert.equal(previewWidgetText("   \n\t  "), "");
    assert.equal(previewWidgetText(null), "");
    assert.equal(previewWidgetText(undefined), "");
  });

  it("degrades safely when given a tiny cap (<=1) by slicing without crashing", () => {
    assert.equal(previewWidgetText("abcdef", 1), "a");
    assert.equal(previewWidgetText("abcdef", 0), "a"); // cap floored to 1
  });
});

describe("filterCcReviewLogEntries returns a filtered copy by min severity and/or source allow-list", () => {
  const makeEntry = (
    severity: "debug" | "info" | "warning" | "error",
    source: string,
    sequence: number
  ) =>
    normalizeCcReviewLogEntry(
      {
        timestamp: "2026-06-26T03:04:05.678Z",
        severity,
        source,
        pluginId: "cc-review",
        message: `${source}-${severity}-${sequence}`,
      },
      { sequence }
    );

  const entries = [
    makeEntry("debug", "planner", 1),
    makeEntry("info", "planner", 2),
    makeEntry("info", "subagent", 3),
    makeEntry("warning", "reviewer", 4),
    makeEntry("error", "subagent", 5),
  ];

  it("passes all entries through when options are undefined, empty, or omitted", () => {
    assert.deepEqual(filterCcReviewLogEntries(entries), entries);
    assert.deepEqual(filterCcReviewLogEntries(entries, {}), entries);
    assert.deepEqual(filterCcReviewLogEntries(entries, undefined), entries);
  });

  it("returns a new array (does not mutate input)", () => {
    const before = entries.slice();
    const out = filterCcReviewLogEntries(entries, {});
    assert.notStrictEqual(out, entries, "must return a new array reference");
    assert.deepEqual(entries, before, "input must not be mutated");
  });

  it("filters by min severity using the defined ordering debug<info<warning<error", () => {
    const infoUp = filterCcReviewLogEntries(entries, { minSeverity: "info" });
    assert.deepEqual(
      infoUp.map((e) => e.severity),
      ["info", "info", "warning", "error"],
      "min=info should drop debug entries"
    );

    const warnUp = filterCcReviewLogEntries(entries, { minSeverity: "warning" });
    assert.deepEqual(
      warnUp.map((e) => e.severity),
      ["warning", "error"],
      "min=warning should keep warning and error only"
    );

    const errorOnly = filterCcReviewLogEntries(entries, { minSeverity: "error" });
    assert.deepEqual(
      errorOnly.map((e) => e.severity),
      ["error"],
      "min=error should keep only error entries"
    );

    const debugUp = filterCcReviewLogEntries(entries, { minSeverity: "debug" });
    assert.deepEqual(debugUp, entries, "min=debug is effectively pass-through");
  });

  it("filters by source allow-list (exact match)", () => {
    const plannerOnly = filterCcReviewLogEntries(entries, { sources: ["planner"] });
    assert.deepEqual(
      plannerOnly.map((e) => e.message),
      ["planner-debug-1", "planner-info-2"]
    );

    const multi = filterCcReviewLogEntries(entries, { sources: ["reviewer", "subagent"] });
    assert.deepEqual(
      multi.map((e) => e.source),
      ["subagent", "reviewer", "subagent"]
    );

    const unknown = filterCcReviewLogEntries(entries, { sources: ["nope"] });
    assert.deepEqual(unknown, []);
  });

  it("applies min severity and source allow-list together as a logical AND", () => {
    const reviewerWarnings = filterCcReviewLogEntries(entries, {
      minSeverity: "warning",
      sources: ["reviewer"],
    });
    assert.deepEqual(
      reviewerWarnings.map((e) => ({ source: e.source, severity: e.severity })),
      [{ source: "reviewer", severity: "warning" }]
    );

    const subagentInfoUp = filterCcReviewLogEntries(entries, {
      minSeverity: "info",
      sources: ["subagent"],
    });
    assert.deepEqual(
      subagentInfoUp.map((e) => e.message),
      ["subagent-info-3", "subagent-error-5"]
    );
  });

  it("returns [] for the empty-result case (empty allow-list) and for empty/nullish input", () => {
    // Empty allow-list = "no sources enabled" toggle: nothing matches.
    assert.deepEqual(filterCcReviewLogEntries(entries, { sources: [] }), []);
    // Empty / nullish inputs are inert under any options.
    assert.deepEqual(filterCcReviewLogEntries([]), []);
    assert.deepEqual(filterCcReviewLogEntries(null), []);
    assert.deepEqual(filterCcReviewLogEntries(undefined), []);
    assert.deepEqual(filterCcReviewLogEntries([], { minSeverity: "error" }), []);
  });

  it("treats entries with an unknown severity as info (matches existing convention)", () => {
    const weird = [
      ...entries,
      { ...makeEntry("info", "planner", 6), severity: "trace" as unknown as "info" },
    ];
    const warnUp = filterCcReviewLogEntries(weird, { minSeverity: "warning" });
    // The unknown-severity entry is treated as info, so it is dropped at min=warning.
    assert.deepEqual(
      warnUp.map((e) => e.severity),
      ["warning", "error"]
    );
    const infoUp = filterCcReviewLogEntries(weird, { minSeverity: "info" });
    // At min=info the unknown-severity entry is kept (rank 1 >= 1).
    assert.equal(infoUp.length, 5);
  });
});

describe("resolveCcReviewLogLevel derives the compact-surface minimum severity", () => {
  it("honors flag override, env fallback, default, aliases, and precedence", () => {
    assert.deepEqual(resolveCcReviewLogLevel({ flag: "warning" }), {
      level: "warning",
      source: "flag",
    });
    assert.deepEqual(
      resolveCcReviewLogLevel({ env: { CC_REVIEW_LOG_LEVEL: "error" } as NodeJS.ProcessEnv }),
      { level: "error", source: "env" }
    );
    assert.deepEqual(resolveCcReviewLogLevel({}), { level: "info", source: "default" });
    assert.deepEqual(
      resolveCcReviewLogLevel({
        flag: "debug",
        env: { CC_REVIEW_LOG_LEVEL: "error" } as NodeJS.ProcessEnv,
      }),
      { level: "debug", source: "flag" }
    );
    assert.deepEqual(resolveCcReviewLogLevel({ flag: "warn" }), { level: "warning", source: "flag" });
    assert.deepEqual(resolveCcReviewLogLevel({ flag: "WARN" }), { level: "warning", source: "flag" });
    assert.deepEqual(resolveCcReviewLogLevel({ flag: "fatal" }), { level: "error", source: "flag" });
  });

  it("falls back to info with invalidInput for bad flag or env values", () => {
    assert.deepEqual(resolveCcReviewLogLevel({ flag: "loud" }), {
      level: "info",
      source: "default",
      invalidInput: { source: "flag", raw: "loud" },
    });
    assert.deepEqual(
      resolveCcReviewLogLevel({ env: { CC_REVIEW_LOG_LEVEL: "loud" } as NodeJS.ProcessEnv }),
      {
        level: "info",
        source: "default",
        invalidInput: { source: "env", raw: "loud" },
      }
    );
    assert.deepEqual(resolveCcReviewLogLevel({ flag: "" }), {
      level: "info",
      source: "default",
      invalidInput: { source: "flag", raw: "" },
    });
    assert.deepEqual(resolveCcReviewLogLevel({ flag: "   " }), {
      level: "info",
      source: "default",
      invalidInput: { source: "flag", raw: "   " },
    });
  });

  it("treats empty or whitespace-only env as unset rather than invalid", () => {
    assert.deepEqual(
      resolveCcReviewLogLevel({ env: { CC_REVIEW_LOG_LEVEL: "" } as NodeJS.ProcessEnv }),
      { level: "info", source: "default" }
    );
    assert.deepEqual(
      resolveCcReviewLogLevel({ env: { CC_REVIEW_LOG_LEVEL: "   " } as NodeJS.ProcessEnv }),
      { level: "info", source: "default" }
    );
  });
});

describe("resolveReviewMode selects review timing", () => {
  it("uses explicit value, environment fallback, and the after-all default", () => {
    assert.equal(resolveReviewMode(" per-task "), "per-task");
    assert.equal(
      resolveReviewMode(undefined, { CC_REVIEW_MODE: "per-task" } as NodeJS.ProcessEnv),
      "per-task"
    );
    assert.equal(resolveReviewMode(undefined, {} as NodeJS.ProcessEnv), "after-all");
  });

  it("rejects unsupported explicit and environment values", () => {
    assert.throws(() => resolveReviewMode("batch"), /Invalid reviewMode value "batch"/);
    assert.throws(
      () => resolveReviewMode(undefined, { CC_REVIEW_MODE: "later" } as NodeJS.ProcessEnv),
      /Invalid CC_REVIEW_MODE value "later"/
    );
  });
});

describe("readAvailableCpuCount resolves the machine CPU count for auto concurrency", () => {
  it("reads CC_REVIEW_CPU_COUNT when set to a non-negative integer", () => {
    assert.equal(readAvailableCpuCount({ CC_REVIEW_CPU_COUNT: "8" } as NodeJS.ProcessEnv), 8);
    assert.equal(readAvailableCpuCount({ CC_REVIEW_CPU_COUNT: "0" } as NodeJS.ProcessEnv), 0);
  });

  it("falls back to os.cpus().length when CC_REVIEW_CPU_COUNT is unset or invalid", () => {
    const expected = os.cpus().length;
    assert.equal(readAvailableCpuCount({} as NodeJS.ProcessEnv), expected);
    assert.equal(readAvailableCpuCount({ CC_REVIEW_CPU_COUNT: "" } as NodeJS.ProcessEnv), expected);
    assert.equal(readAvailableCpuCount({ CC_REVIEW_CPU_COUNT: "many" } as NodeJS.ProcessEnv), expected);
    assert.equal(readAvailableCpuCount({ CC_REVIEW_CPU_COUNT: "-1" } as NodeJS.ProcessEnv), expected);
  });
});

describe("computeDefaultAutoConcurrency defines the worker default auto-parallel policy", () => {
  it("returns an automatic value when no explicit concurrency is configured", () => {
    assert.equal(computeDefaultAutoConcurrency({ cpuCount: 4 }), 4);
  });

  it("is at least 1 regardless of CPU count", () => {
    assert.equal(computeDefaultAutoConcurrency({ cpuCount: 0 }), 1);
    assert.equal(computeDefaultAutoConcurrency({ cpuCount: -5 }), 1);
    assert.equal(computeDefaultAutoConcurrency({ cpuCount: 1 }), 1);
  });

  it("caps the CPU-based value at a reasonable upper bound", () => {
    assert.equal(computeDefaultAutoConcurrency({ cpuCount: 16 }), 8);
    assert.equal(computeDefaultAutoConcurrency({ cpuCount: 8 }), 8);
    assert.equal(computeDefaultAutoConcurrency({ cpuCount: 7 }), 7);
  });

  it("supports injecting CPU count and task count so tests stay machine-independent", () => {
    assert.equal(computeDefaultAutoConcurrency({ cpuCount: 16, taskCount: 3 }), 3);
    assert.equal(computeDefaultAutoConcurrency({ cpuCount: 2, taskCount: 10 }), 2);
    assert.equal(computeDefaultAutoConcurrency({ cpuCount: 4, taskCount: 4 }), 4);
    // No CPU injection: fallback is used, and it is still bounded.
    assert.equal(computeDefaultAutoConcurrency({ fallbackCpuCount: 2 }), 2);
  });

  it("falls back to a safe default when cpuCount is missing and degrades to the minimum for invalid values", () => {
    assert.equal(computeDefaultAutoConcurrency({ cpuCount: NaN }), 1);
    assert.equal(computeDefaultAutoConcurrency({ cpuCount: Infinity }), 1);
    assert.equal(computeDefaultAutoConcurrency({ cpuCount: -1 }), 1);
    assert.equal(computeDefaultAutoConcurrency({}), 4);
  });

  it("allows custom min and max bounds to be injected", () => {
    assert.equal(computeDefaultAutoConcurrency({ cpuCount: 16, maxConcurrency: 4 }), 4);
    assert.equal(computeDefaultAutoConcurrency({ cpuCount: 1, minConcurrency: 2 }), 2);
    assert.equal(computeDefaultAutoConcurrency({ cpuCount: 16, minConcurrency: 2, maxConcurrency: 4 }), 4);
    assert.equal(computeDefaultAutoConcurrency({ cpuCount: 0, minConcurrency: 2, maxConcurrency: 4 }), 2);
  });

  it("ignores taskCount when it is not a positive finite integer", () => {
    assert.equal(computeDefaultAutoConcurrency({ cpuCount: 4, taskCount: 0 }), 4);
    assert.equal(computeDefaultAutoConcurrency({ cpuCount: 4, taskCount: -1 }), 4);
    assert.equal(computeDefaultAutoConcurrency({ cpuCount: 4, taskCount: NaN }), 4);
    assert.equal(computeDefaultAutoConcurrency({ cpuCount: 4, taskCount: Infinity }), 4);
  });

  it("always returns a positive integer", () => {
    const result = computeDefaultAutoConcurrency({ cpuCount: 4.7, taskCount: 2.9 });
    assert.equal(result, 2);
    assert.ok(Number.isInteger(result));
    assert.ok(result >= 1);
  });
});

describe("resolveCcReviewConcurrency selects the subagent concurrency limit", () => {
  it("uses explicit value, environment fallback, and the default limit of 4", () => {
    assert.deepEqual(resolveCcReviewConcurrency({ flag: "2", cpuCount: 4 }), { concurrency: 2, source: "flag" });
    assert.deepEqual(
      resolveCcReviewConcurrency({ env: { CC_REVIEW_CONCURRENCY: "3" } as NodeJS.ProcessEnv, cpuCount: 4 }),
      { concurrency: 3, source: "env" }
    );
    assert.deepEqual(resolveCcReviewConcurrency({ env: {} as NodeJS.ProcessEnv, cpuCount: 4 }), {
      concurrency: 4,
      source: "default",
    });
  });

  it("falls back to the default for invalid values", () => {
    assert.deepEqual(resolveCcReviewConcurrency({ flag: "0", cpuCount: 4 }), {
      concurrency: 4,
      source: "default",
      invalidInput: { source: "flag", raw: "0" },
    });
    assert.deepEqual(
      resolveCcReviewConcurrency({ env: { CC_REVIEW_CONCURRENCY: "many" } as NodeJS.ProcessEnv, cpuCount: 4 }),
      {
        concurrency: 4,
        source: "default",
        invalidInput: { source: "env", raw: "many" },
      }
    );
  });

  it("automatically calculates dynamic concurrency when neither flag nor env is configured", () => {
    // Large machine (e.g., 16 cores) is capped at the upper bound of 8
    assert.deepEqual(
      resolveCcReviewConcurrency({ cpuCount: 16 }),
      { concurrency: 8, source: "default" }
    );

    // Medium machine (e.g., 6 cores) yields exactly 6
    assert.deepEqual(
      resolveCcReviewConcurrency({ cpuCount: 6 }),
      { concurrency: 6, source: "default" }
    );

    // Small machine (e.g., 2 cores) yields exactly 2
    assert.deepEqual(
      resolveCcReviewConcurrency({ cpuCount: 2 }),
      { concurrency: 2, source: "default" }
    );

    // Tiny machine (e.g., 1 core) is bounded at the lower limit of 1
    assert.deepEqual(
      resolveCcReviewConcurrency({ cpuCount: 1 }),
      { concurrency: 1, source: "default" }
    );

    // Capped by taskCount if provided and smaller than cores limit
    assert.deepEqual(
      resolveCcReviewConcurrency({ cpuCount: 16, taskCount: 3 }),
      { concurrency: 3, source: "default" }
    );

    // Not capped by taskCount if taskCount is larger than cores limit
    assert.deepEqual(
      resolveCcReviewConcurrency({ cpuCount: 4, taskCount: 10 }),
      { concurrency: 4, source: "default" }
    );
  });

  it("always respects the explicit concurrency flag and environment variable over the automatic/dynamic value", () => {
    // Explicit flag wins even if automatic logic would compute 2 on a 2-core machine
    assert.deepEqual(
      resolveCcReviewConcurrency({ flag: 12, cpuCount: 2 }),
      { concurrency: 12, source: "flag" }
    );

    // Environment wins even if automatic logic would compute 8 on a 16-core machine
    assert.deepEqual(
      resolveCcReviewConcurrency({ env: { CC_REVIEW_CONCURRENCY: "1" } as NodeJS.ProcessEnv, cpuCount: 16 }),
      { concurrency: 1, source: "env" }
    );

    // Explicit flag or env overrides taskCount capping
    assert.deepEqual(
      resolveCcReviewConcurrency({ flag: 12, cpuCount: 2, taskCount: 3 }),
      { concurrency: 12, source: "flag" }
    );
    assert.deepEqual(
      resolveCcReviewConcurrency({ env: { CC_REVIEW_CONCURRENCY: "5" } as NodeJS.ProcessEnv, cpuCount: 16, taskCount: 2 }),
      { concurrency: 5, source: "env" }
    );
  });

  it("ensures the automatic concurrency is always a positive integer within bounds", () => {
    // Floating point cpu count is truncated and bounded correctly
    const resFloat = resolveCcReviewConcurrency({ cpuCount: 4.7 });
    assert.ok(Number.isInteger(resFloat.concurrency), "must be an integer");
    assert.equal(resFloat.concurrency, 4);

    // Out-of-bounds/invalid inputs degrade safely
    const resNegative = resolveCcReviewConcurrency({ cpuCount: -5 });
    assert.ok(resNegative.concurrency >= 1 && resNegative.concurrency <= 8, "must be within [1, 8]");
    assert.ok(Number.isInteger(resNegative.concurrency), "must be an integer");

    const resInfinite = resolveCcReviewConcurrency({ cpuCount: Infinity });
    assert.ok(resInfinite.concurrency >= 1 && resInfinite.concurrency <= 8, "must be within [1, 8]");
    assert.ok(Number.isInteger(resInfinite.concurrency), "must be an integer");
  });
});

describe("resolveCcReviewLogPath generates unique, stable log file paths", () => {
  it("returns a unique path under .cc-review/logs/<runId> when no explicit path is configured", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-log-path-"));
    const runId = "20260701T120000000Z-abc123";
    const p = resolveCcReviewLogPath({ cwd, runId });
    assert.equal(path.dirname(p), path.join(cwd, ".cc-review", "logs", runId));
    assert.equal(path.basename(p), "workflow-logs.jsonl");
    assert.equal(p, path.join(cwd, ".cc-review", "logs", runId, "workflow-logs.jsonl"));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("returns different paths for different runIds", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-log-path-"));
    const p1 = resolveCcReviewLogPath({ cwd, runId: "run-a" });
    const p2 = resolveCcReviewLogPath({ cwd, runId: "run-b" });
    assert.notEqual(p1, p2);
    assert.match(p1, /\/\.cc-review\/logs\/run-a\/workflow-logs\.jsonl$/);
    assert.match(p2, /\/\.cc-review\/logs\/run-b\/workflow-logs\.jsonl$/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("uses an explicit relative log file path when provided", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-log-path-"));
    const p = resolveCcReviewLogPath({ cwd, runId: "run-id", explicitLogFile: "my-logs.jsonl" });
    assert.equal(p, path.join(cwd, "my-logs.jsonl"));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("uses an explicit absolute log file path when provided", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-log-path-"));
    const absolute = path.join(cwd, "absolute", "logs.jsonl");
    const p = resolveCcReviewLogPath({ cwd, runId: "run-id", explicitLogFile: absolute });
    assert.equal(p, absolute);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("gives explicit flag precedence over the environment variable", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-log-path-"));
    const p = resolveCcReviewLogPath({
      cwd,
      runId: "run-id",
      explicitLogFile: "flag-logs.jsonl",
      envLogFile: "env-logs.jsonl",
    });
    assert.equal(p, path.join(cwd, "flag-logs.jsonl"));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("falls back to the environment variable when no explicit flag is set", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-log-path-"));
    const p = resolveCcReviewLogPath({ cwd, runId: "run-id", envLogFile: "env-logs.jsonl" });
    assert.equal(p, path.join(cwd, "env-logs.jsonl"));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("generates a unique file inside a configured directory", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-log-path-"));
    const logDir = path.join(cwd, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const p = resolveCcReviewLogPath({ cwd, runId: "20260701T120000000Z-abc123", envLogFile: "logs" });
    assert.equal(path.dirname(p), logDir);
    assert.match(path.basename(p), /^workflow-logs-20260701T120000000Z-abc123\.jsonl$/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("generates a unique file inside a configured absolute directory", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-log-path-"));
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-absolute-log-dir-"));
    const p = resolveCcReviewLogPath({ cwd, runId: "20260701T120000000Z-abc123", envLogFile: logDir });
    assert.equal(path.dirname(p), logDir);
    assert.match(path.basename(p), /^workflow-logs-20260701T120000000Z-abc123\.jsonl$/);
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(logDir, { recursive: true, force: true });
  });
});

describe("buildAfterAllExecutionBatches preserves handoff dependencies", () => {
  it("keeps legacy plans serial when dependency metadata is missing", () => {
    const batches = buildAfterAllExecutionBatches([
      { title: "Foundation", description: "Build foundation", acceptanceCriteria: "Foundation works" },
      { title: "Integration", description: "Integrate foundation", acceptanceCriteria: "Integration works" },
      { title: "Verify", description: "Verify integration", acceptanceCriteria: "Verification works" },
    ]);

    assert.deepEqual(
      batches.map((batch) => batch.map(({ index }) => index)),
      [[0], [1], [2]]
    );
  });

  it("runs explicitly independent tasks in the same batch", () => {
    const batches = buildAfterAllExecutionBatches([
      { title: "A", description: "Build A", acceptanceCriteria: "A works", dependsOn: [] },
      { title: "B", description: "Build B", acceptanceCriteria: "B works", dependsOn: [] },
      { title: "C", description: "Integrate", acceptanceCriteria: "C works", dependsOn: [1, 2] },
    ]);

    assert.deepEqual(
      batches.map((batch) => batch.map(({ index }) => index)),
      [[0, 1], [2]]
    );
  });

  it("rejects cyclic dependency graphs instead of violating their prerequisites", () => {
    assert.throws(
      () => buildAfterAllExecutionBatches([
        { title: "A", description: "Build A", acceptanceCriteria: "A works", dependsOn: [2] },
        { title: "B", description: "Build B", acceptanceCriteria: "B works", dependsOn: [1] },
      ]),
      /cycle detected.*1, 2/i
    );
  });

  it("rejects a task that depends on itself", () => {
    assert.throws(
      () => buildAfterAllExecutionBatches([
        { title: "A", description: "Build A", acceptanceCriteria: "A works", dependsOn: [1] },
      ]),
      /cycle detected.*1/i
    );
  });
});

describe("normalizes log entries into the CC Review display contract", () => {  it("normalizes log entries from a legacy string with default display fields", () => {
    const entry = normalizeCcReviewLogEntry("\u001b[31mPlanner ready\u001b[0m", {
      sequence: 7,
      now: () => new Date("2026-06-26T00:00:00.000Z"),
    });

    assert.match(entry.id, /^cc-review-log-7-[a-z0-9]+$/);
    assert.equal(entry.timestamp, "2026-06-26T00:00:00.000Z");
    assert.equal(entry.severity, "info");
    assert.equal(entry.source, "cc-review");
    assert.equal(entry.pluginId, "cc-review");
    assert.equal(entry.message, "Planner ready");
    assert.equal(entry.sequence, 7);
    assert.equal(entry.details, undefined);
  });

  it("normalizes legacy prefixed log entries into severity and source context", () => {
    const plannerError = normalizeCcReviewLogEntry("[Codex Planner Error] schema validation failed", {
      sequence: 8,
      now: () => new Date("2026-06-26T00:00:00.000Z"),
    });
    const subagentInfo = normalizeCcReviewLogEntry("[Subagent] generated focused render test", {
      sequence: 9,
      now: () => new Date("2026-06-26T00:00:00.000Z"),
    });
    const timeoutWarning = normalizeCcReviewLogEntry("[Timeout] subagent exceeded timeout", {
      sequence: 10,
      now: () => new Date("2026-06-26T00:00:00.000Z"),
    });

    assert.equal(plannerError.severity, "error");
    assert.equal(plannerError.source, "planner");
    assert.equal(plannerError.message, "schema validation failed");
    assert.equal(subagentInfo.severity, "info");
    assert.equal(subagentInfo.source, "subagent");
    assert.equal(subagentInfo.message, "generated focused render test");
    assert.equal(timeoutWarning.severity, "warning");
    assert.equal(timeoutWarning.source, "cc-review");
    assert.equal(timeoutWarning.message, "subagent exceeded timeout");

    const plannerDiagnostic = normalizeCcReviewLogEntry(
      "[Codex Planner Error] docs/plugin-log-surface-audit.md:70: retry field",
      { sequence: 11, now: () => new Date("2026-06-26T00:00:00.000Z") }
    );
    assert.equal(plannerDiagnostic.severity, "info");
    assert.equal(plannerDiagnostic.source, "planner");
  });

  it("normalizes log entries from a complete structured input without dropping fields", () => {
    const details = { taskIndex: 2, attempt: 1 };
    const entry = normalizeCcReviewLogEntry({
      id: "reviewer-error-2",
      timestamp: "2026-06-26T00:01:00.000Z",
      severity: "error",
      source: "reviewer",
      pluginId: "cc-review",
      message: "Reviewer failed",
      details,
      sequence: 99,
    }, {
      sequence: 12,
      now: () => new Date("2026-06-26T00:02:00.000Z"),
    });

    assert.deepEqual(entry, {
      id: "reviewer-error-2",
      timestamp: "2026-06-26T00:01:00.000Z",
      severity: "error",
      source: "reviewer",
      pluginId: "cc-review",
      message: "Reviewer failed",
      details,
      sequence: 12,
    });
  });

  it("normalizes log entries with invalid severity and blank fields safely", () => {
    const first = normalizeCcReviewLogEntry({
      severity: "critical",
      source: "   ",
      pluginId: "   ",
      message: "\n  \u001b[33mRecovered\u001b[0m  ",
    }, {
      sequence: 1,
      now: () => new Date("2026-06-26T00:03:00.000Z"),
    });
    const repeated = normalizeCcReviewLogEntry({
      severity: "critical",
      source: "   ",
      pluginId: "   ",
      message: "\n  \u001b[33mRecovered\u001b[0m  ",
    }, {
      sequence: 1,
      now: () => new Date("2026-06-26T00:03:00.000Z"),
    });
    const interleaved = normalizeCcReviewLogEntry({
      severity: "critical",
      source: "   ",
      pluginId: "   ",
      message: "\n  \u001b[33mRecovered\u001b[0m  ",
    }, {
      sequence: 2,
      now: () => new Date("2026-06-26T00:03:00.000Z"),
    });

    assert.equal(first.severity, "info");
    assert.equal(first.source, "cc-review");
    assert.equal(first.pluginId, "cc-review");
    assert.equal(first.message, "Recovered");
    assert.equal(first.id, repeated.id, "same normalized fields and sequence should derive the same stable id");
    assert.notEqual(first.id, interleaved.id, "different sequence should disambiguate interleaved duplicate logs");
  });
});

describe("cc_review nest depth guard", () => {
  it("allows the root workflow and blocks nested invocation", () => {
    const env = {} as NodeJS.ProcessEnv;
    const exit = enterCcReviewWorkflowNest(env);
    assert.equal(env[CC_REVIEW_NEST_DEPTH_ENV], "1");
    assert.throws(() => enterCcReviewWorkflowNest(env), CcReviewNestDepthError);
    exit();
    assert.equal(env[CC_REVIEW_NEST_DEPTH_ENV], undefined);
  });
});

describe("runSubprocess stream safety", () => {
  const originalSpawn = child_process.spawn;
  let spawnMock: ReturnType<typeof mock.method>;

  before(() => {
    spawnMock = mock.method(child_process, "spawn", (command: string, args: string[], options: any) => {
      if (command === "cc-review-stream-test") {
        const mockProc = new EventEmitter() as any;
        mockProc.pid = 4242;
        mockProc.stdout = new EventEmitter();
        mockProc.stderr = new EventEmitter();
        process.nextTick(() => {
          mockProc.stdout.emit("data", Buffer.from("line-1\n"));
          mockProc.stdout.emit("data", Buffer.from("line-2\n"));
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      if (command === "cc-review-huge-stdout") {
        const mockProc = new EventEmitter() as any;
        mockProc.pid = 4243;
        mockProc.stdout = new EventEmitter();
        mockProc.stderr = new EventEmitter();
        process.nextTick(() => {
          mockProc.stdout.emit("data", Buffer.from("x".repeat(4096)));
          mockProc.stdout.emit("data", Buffer.from("y".repeat(4096)));
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return originalSpawn(command, args, options);
    });
  });

  after(() => {
    spawnMock.mock.restore();
  });

  it("appendStreamText truncates once the byte cap is reached", () => {
    const state = { bytes: 0, truncated: false, maxBytes: 10 };
    let buf = appendStreamText("", "hello", state);
    assert.equal(buf, "hello");
    buf = appendStreamText(buf, "world-overflow", state);
    assert.ok(state.truncated);
    assert.match(buf, /truncated/);
  });

  it("does not retain stdout when parsing NDJSON lines", async () => {
    const lines: string[] = [];
    const result = await runSubprocess({
      label: "line-parser",
      command: "cc-review-stream-test",
      args: [],
      cwd: process.cwd(),
      onStdoutLine: (line) => lines.push(line),
      maxStreamBytes: 1024,
    });
    assert.deepEqual(lines, ["line-1", "line-2"]);
    assert.equal(result.stdout, "");
    assert.equal(result.stdoutTruncated, false);
  });

  it("truncates retained stdout instead of exceeding the configured cap", async () => {
    const result = await runSubprocess({
      label: "huge-stdout",
      command: "cc-review-huge-stdout",
      args: [],
      cwd: process.cwd(),
      maxStreamBytes: 4096,
    });
    assert.ok(result.stdoutTruncated);
    assert.match(result.stdout, new RegExp(SUBPROCESS_OUTPUT_TRUNCATED_MARKER.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 4096 + 256);
  });
});

describe("built-in worker safety prompt", () => {
  it("forbids nested cc_review and full-suite test runs", () => {
    const agent = buildBuiltinWorkerAgent();
    assert.match(agent.systemPrompt, /NEVER invoke the cc_review tool/);
    assert.match(agent.systemPrompt, /test-name-pattern/);
    assert.match(agent.systemPrompt, /Do not run the full `node --test tests\/cc-review-behavior\.test\.ts`/);
  });
});

class MockChildProcess extends EventEmitter {
  pid = 99999;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  // Default to true so non-planner reviewer mocks auto-emit a valid
  // REVIEW_SHIP_OUTPUT on close, unless a test explicitly sets this to false.
  // Previously defaulted to false, which meant the spawn mock's
  // `autoReviewStdout !== false` check never enabled auto-emit; tests then
  // relied on the old deriveEffectiveVerdict fallback (absent + exit 0 → ship)
  // which I3 corrected to ship_with_warnings.
  autoReviewStdout = true;
  private reviewStdoutEmitted = false;

  emit(event: string | symbol, ...args: any[]): boolean {
    if (event === "close" && this.autoReviewStdout && !this.reviewStdoutEmitted) {
      emitMockReviewStdout(this);
      this.reviewStdoutEmitted = true;
    }
    return super.emit(event, ...args);
  }

  kill(signal?: string) {
    this.emit("close", null, signal || "SIGTERM");
  }
}

// Helper: detect whether a claude CLI invocation is the planner phase by inspecting
// the final prompt argument. The planner prompt always begins with "Break down the
// following goal" (see cc-review.ts). Tests use this to multiplex claude planner
// and reviewer behavior through a single command="claude" branch.
function isClaudePlannerArgs(args: string[]): boolean {
  const last = args[args.length - 1] || "";
  return last.startsWith("Break down the following goal");
}

function isCodexPlannerArgs(args: string[]): boolean {
  return args.includes("-o");
}

const REVIEW_SHIP_OUTPUT = `Review complete\n${JSON.stringify({
  verdict: "ship",
  summary: "No blocking issues remain.",
  findings: [],
})}`;

function emitMockReviewStdout(mockProc: MockChildProcess) {
  mockProc.stdout.emit("data", Buffer.from(REVIEW_SHIP_OUTPUT));
}

function getSummaryMessage(messages: any[]): any | undefined {
  return messages.find((message) => message.customType === "cc-review-summary");
}

function getSummaryText(messages: any[]): string {
  const message = getSummaryMessage(messages);
  return typeof message?.content === "string" ? message.content : "";
}

// ---------------------------------------------------------------------------
// Unit tests for the reliability-issue remediation (P0-1 through P2-1)
// ---------------------------------------------------------------------------

describe("resolveSubagentTaskTimeout (P0-1: configurable execution timeout)", () => {
  it("defaults to 30 minutes when nothing is configured", () => {
    const result = resolveSubagentTaskTimeout({ env: {} });
    assert.equal(result.timeoutMs, DEFAULT_TASK_TIMEOUT_MS);
    assert.equal(result.timeoutMs, 1800000);
    assert.equal(result.source, "default");
    assert.equal(result.invalidInput, undefined);
  });

  it("reads CC_REVIEW_TASK_TIMEOUT_MS from the supplied env", () => {
    const result = resolveSubagentTaskTimeout({ env: { CC_REVIEW_TASK_TIMEOUT_MS: "600000" } });
    assert.equal(result.timeoutMs, 600000);
    assert.equal(result.source, "env");
  });

  it("treats 0 as 'no timeout' (valid)", () => {
    const result = resolveSubagentTaskTimeout({ env: { CC_REVIEW_TASK_TIMEOUT_MS: "0" } });
    assert.equal(result.timeoutMs, 0);
    assert.equal(result.source, "env");
  });

  it("explicit flag takes precedence over env", () => {
    const result = resolveSubagentTaskTimeout({ flag: "120000", env: { CC_REVIEW_TASK_TIMEOUT_MS: "600000" } });
    assert.equal(result.timeoutMs, 120000);
    assert.equal(result.source, "flag");
  });

  it("accepts a numeric flag", () => {
    const result = resolveSubagentTaskTimeout({ flag: 0 });
    assert.equal(result.timeoutMs, 0);
    assert.equal(result.source, "flag");
  });

  it("invalid env falls back to default and reports invalidInput", () => {
    const result = resolveSubagentTaskTimeout({ env: { CC_REVIEW_TASK_TIMEOUT_MS: "abc" } });
    assert.equal(result.timeoutMs, DEFAULT_TASK_TIMEOUT_MS);
    assert.equal(result.source, "default");
    assert.ok(result.invalidInput);
    assert.equal(result.invalidInput!.source, "env");
    assert.equal(result.invalidInput!.raw, "abc");
  });

  it("negative values are invalid", () => {
    const result = resolveSubagentTaskTimeout({ flag: "-1" });
    assert.equal(result.timeoutMs, DEFAULT_TASK_TIMEOUT_MS);
    assert.ok(result.invalidInput);
  });

  it("empty env string is treated as 'not provided'", () => {
    const result = resolveSubagentTaskTimeout({ env: { CC_REVIEW_TASK_TIMEOUT_MS: "  " } });
    assert.equal(result.timeoutMs, DEFAULT_TASK_TIMEOUT_MS);
    assert.equal(result.source, "default");
    assert.equal(result.invalidInput, undefined);
  });
});

describe("resolvePlannerTimeoutMs / resolveReviewerTimeoutMs (P0-4: phase timeouts)", () => {
  it("planner defaults to 10 minutes", () => {
    assert.equal(resolvePlannerTimeoutMs({}), 600000);
  });

  it("reviewer defaults to 10 minutes", () => {
    assert.equal(resolveReviewerTimeoutMs({}), 600000);
  });

  it("reads CC_REVIEW_PLANNER_TIMEOUT_MS", () => {
    assert.equal(resolvePlannerTimeoutMs({ CC_REVIEW_PLANNER_TIMEOUT_MS: "300000" }), 300000);
  });

  it("reads CC_REVIEW_REVIEWER_TIMEOUT_MS", () => {
    assert.equal(resolveReviewerTimeoutMs({ CC_REVIEW_REVIEWER_TIMEOUT_MS: "0" }), 0);
  });

  it("invalid values fall back to default", () => {
    assert.equal(resolvePlannerTimeoutMs({ CC_REVIEW_PLANNER_TIMEOUT_MS: "garbage" }), 600000);
    assert.equal(resolveReviewerTimeoutMs({ CC_REVIEW_REVIEWER_TIMEOUT_MS: "-5" }), 600000);
  });
});

describe("resolveMaxReviewRepairRounds (P1-1: repair loop bound)", () => {
  it("defaults to one observable repair/re-review round", () => {
    assert.equal(resolveMaxReviewRepairRounds({}), DEFAULT_MAX_REVIEW_REPAIR_ROUNDS);
    assert.equal(DEFAULT_MAX_REVIEW_REPAIR_ROUNDS, 1);
  });

  it("reads CC_REVIEW_MAX_REPAIR_ROUNDS", () => {
    assert.equal(resolveMaxReviewRepairRounds({ env: { CC_REVIEW_MAX_REPAIR_ROUNDS: "5" } }), 5);
  });

  it("0 disables the repair loop (hard-fail on first block)", () => {
    assert.equal(resolveMaxReviewRepairRounds({ env: { CC_REVIEW_MAX_REPAIR_ROUNDS: "0" } }), 0);
  });

  it("invalid values fall back to default", () => {
    assert.equal(resolveMaxReviewRepairRounds({ env: { CC_REVIEW_MAX_REPAIR_ROUNDS: "abc" } }), 1);
    assert.equal(resolveMaxReviewRepairRounds({ env: { CC_REVIEW_MAX_REPAIR_ROUNDS: "-1" } }), 1);
    assert.equal(resolveMaxReviewRepairRounds({ flag: 1.5 }), 1);
  });

  it("explicit parameter overrides the environment", () => {
    assert.equal(resolveMaxReviewRepairRounds({
      flag: 2,
      env: { CC_REVIEW_MAX_REPAIR_ROUNDS: "5" },
    }), 2);
  });
});

describe("extractAssistantTextFromStream (P0-3: stream-json parsing)", () => {
  it("extracts final text from claude stream-json result event", () => {
    const stream = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: '{"tasks":[' }] } }),
      JSON.stringify({ type: "result", result: '{"tasks":[{"title":"T1"}]}' }),
    ].join("\n");
    assert.equal(extractAssistantTextFromStream(stream), '{"tasks":[{"title":"T1"}]}');
  });

  it("accumulates text from assistant message events when no result event", () => {
    const stream = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello " }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "world" }] } }),
    ].join("\n");
    assert.equal(extractAssistantTextFromStream(stream), "Hello world");
  });

  it("accumulates text deltas from claude partial stream events", () => {
    const stream = [
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } } }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } } }),
    ].join("\n");
    assert.equal(extractAssistantTextFromStream(stream), "Hello world");
  });

  it("returns original text when no stream events are found (plain text fallback)", () => {
    const plain = "Review complete\n" + JSON.stringify({ verdict: "ship", summary: "ok", findings: [] });
    assert.equal(extractAssistantTextFromStream(plain), plain);
  });

  it("returns original text for empty input", () => {
    assert.equal(extractAssistantTextFromStream(""), "");
  });

  it("handles codex-style message events", () => {
    const stream = [
      JSON.stringify({ type: "message", content: "Partial " }),
      JSON.stringify({ type: "message", content: "result" }),
    ].join("\n");
    assert.equal(extractAssistantTextFromStream(stream), "Partial result");
  });
});

describe("buildRepairFeedback (P1-1: reviewer-block repair feedback)", () => {
  it("includes verdict, block reason, summary, and unfixed findings", () => {
    const feedback = buildRepairFeedback(
      { verdict: "block", summary: "Critical bug found", findings: [
        { priority: "P0", confidence: 0.9, message: "null pointer", status: "unfixed", file: "src/app.ts", line: 42 },
        { priority: "P2", confidence: 0.5, message: "minor nit", status: "fixed" },
      ]},
      "unfixed_high_severity",
      [
        { priority: "P0", confidence: 0.9, message: "null pointer", status: "unfixed", file: "src/app.ts", line: 42 },
        { priority: "P2", confidence: 0.5, message: "minor nit", status: "fixed" },
      ]
    );
    assert.match(feedback, /Reviewer verdict: block \(unfixed_high_severity\)/);
    assert.match(feedback, /Reviewer summary: Critical bug found/);
    assert.match(feedback, /Unfixed findings to address:/);
    assert.match(feedback, /\[P0\] src\/app\.ts:42: null pointer/);
    // Fixed findings should NOT appear in the repair feedback
    assert.doesNotMatch(feedback, /minor nit/);
  });

  it("handles null review result gracefully", () => {
    const feedback = buildRepairFeedback(null, "explicit_block", []);
    assert.match(feedback, /Reviewer verdict: block \(explicit_block\)/);
    assert.doesNotMatch(feedback, /Unfixed findings/);
  });

  it("includes post-fix validation failure evidence when present", () => {
    const feedback = buildRepairFeedback(
      { verdict: "block", summary: "test", findings: [], postFixValidation: { status: "failed", evidence: "tests failed" } },
      "post_review_validation_failed",
      []
    );
    assert.match(feedback, /Post-fix validation failed: tests failed/);
  });

  it("includes orchestrator verification failures in repair feedback", () => {
    const feedback = buildRepairFeedback(
      { verdict: "ship", summary: "reviewer fixed the findings", findings: [] },
      "post_review_validation_failed",
      [],
      {
        error: "Verification command failed: node tests/failing.test.mjs",
        commands: [{
          command: "node",
          args: ["tests/failing.test.mjs"],
          exitCode: 1,
          stderr: "AssertionError: expected true",
          timedOut: false,
        }],
      }
    );
    assert.match(feedback, /Orchestrator post-review validation failed/);
    assert.match(feedback, /node tests\/failing\.test\.mjs: exit code 1/);
    assert.match(feedback, /AssertionError: expected true/);
  });
});

describe("CC Review Behavioral Regression Tests", () => {
  let tempTestDir: string;
  let sentMessages: any[] = [];
  let registeredCommand: any = null;
  let registeredTool: any = null;

  let mockSpawnHandler: ((command: string, args: string[]) => MockChildProcess | null) | null = null;
  let mockSubagentHandler: (
    toolName: string,
    params: any,
    signal?: AbortSignal,
    onUpdate?: any,
    ctx?: any
  ) => Promise<any> = async () => ({});

  const piMock: any = {
    registerCommand(name: string, config: any) {
      if (name === "cc-review") {
        registeredCommand = config;
      }
    },
    registerTool(config: any) {
      if (config.name === "cc_review") {
        registeredTool = config;
      }
    },
    async sendMessage(msg: any) {
      sentMessages.push(msg);
    },
    toolManager: {
      async executeTool(toolName: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) {
        return mockSubagentHandler(toolName, params, signal, onUpdate, ctx);
      }
    }
  };

  // Setup hooks to stub child_process.spawn globally for these tests
  const originalSpawn = child_process.spawn;
  const originalProcessKill = process.kill;
  const originalFetch = globalThis.fetch;
  const originalCcReviewProvider = process.env.CC_REVIEW_PROVIDER;
  const originalCodexApiKey = process.env.CODEX_API_KEY;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalCodexModel = process.env.CODEX_MODEL;
  const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const originalClaudeApiKey = process.env.CLAUDE_API_KEY;
  const originalClaudeModel = process.env.CLAUDE_MODEL;
  const originalClaudeMaxTokens = process.env.CLAUDE_MAX_TOKENS;
  const originalClaudeApiUrl = process.env.CLAUDE_API_URL;
  const originalCcReviewLogLevel = process.env.CC_REVIEW_LOG_LEVEL;
  const originalCcReviewMode = process.env.CC_REVIEW_MODE;
  const originalCcReviewMaxRepairRounds = process.env.CC_REVIEW_MAX_REPAIR_ROUNDS;
  const originalCcReviewLogFile = process.env.CC_REVIEW_LOG_FILE;
  const originalCcReviewNestDepth = process.env.CC_REVIEW_NEST_DEPTH;

  beforeEach(() => {
    tempTestDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-test-workspace-"));
    sentMessages = [];
    registeredCommand = null;
    registeredTool = null;
    mockSpawnHandler = null;
    mockSubagentHandler = async () => ({});
    delete process.env.CC_REVIEW_PROVIDER;
    delete process.env.CODEX_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_MODEL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_API_KEY;
    delete process.env.CLAUDE_MODEL;
    delete process.env.CLAUDE_MAX_TOKENS;
    delete process.env.CLAUDE_API_URL;
    delete process.env.CC_REVIEW_LOG_LEVEL;
    delete process.env.CC_REVIEW_MODE;
    delete process.env.CC_REVIEW_MAX_REPAIR_ROUNDS;
    process.env.CC_REVIEW_LOG_FILE = "workflow-logs.jsonl";
    delete process.env.CC_REVIEW_NEST_DEPTH;
    process.env.CC_REVIEW_SKIP_PREFLIGHT = "1";
    process.env.CODEX_API_KEY = "test-codex-review-key";
    process.env.ANTHROPIC_API_KEY = "test-claude-review-key";
    globalThis.fetch = originalFetch;

    // Register extension tools/commands
    ccReviewExtension(piMock);
  });

  it("registers only the new CC Review command and tool metadata", () => {
    assert.ok(registeredCommand, "cc-review command should be registered");
    assert.ok(registeredTool, "cc_review tool should be registered");
    assert.match(registeredCommand.description, /CC Review/);
    assert.match(registeredCommand.description, /--provider claude/);
    assert.match(registeredCommand.description, /CC_REVIEW_PROVIDER/);
    assert.match(registeredCommand.description, /--log-level/);
    assert.match(registeredCommand.description, /CC_REVIEW_LOG_LEVEL/);
    assert.equal(registeredTool.name, "cc_review");
    assert.equal(registeredTool.label, "CC Review");
    assert.match(registeredTool.description, /CC Review/);
    assert.match(registeredTool.description, /codex/i);
    assert.match(registeredTool.description, /CC_REVIEW_PROVIDER/);
    assert.match(registeredTool.description, /logLevel/);
    assert.match(registeredTool.description, /CC_REVIEW_LOG_LEVEL/);
    assert.match(registeredTool.description, /CC_REVIEW_MODE/);
    assert.equal(registeredTool.parameters.properties.reviewProvider.type, "string");
    assert.equal(registeredTool.parameters.properties.logLevel.type, "string");
    assert.equal(registeredTool.parameters.properties.reviewMode.type, "string");
    assert.equal(registeredTool.parameters.properties.reviewRepairRounds.type, "integer");
    assert.equal(registeredTool.parameters.properties.reviewRepairRounds.minimum, 0);
    assert.equal(registeredTool.parameters.properties.reviewProvider.enum, undefined);
    assert.equal((piMock as any).codex_workflow, undefined);
    assert.equal((piMock as any).codexWorkflow, undefined);
  });

  it("rejects nested cc_review tool calls while a workflow is active", async () => {
    process.env.CC_REVIEW_NEST_DEPTH = "1";
    let spawnCalls = 0;
    mockSpawnHandler = () => {
      spawnCalls++;
      return null;
    };

    const result = await registeredTool.execute(
      "nested-cc-review",
      { goal: "Nested workflow should be blocked" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(spawnCalls, 0);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Nested invocation is blocked/i);
  });

  it("slash command missing goal reports validation error without spawning workflow", async () => {
    let spawnCalls = 0;
    mockSpawnHandler = () => {
      spawnCalls++;
      return null;
    };

    const notifications: Array<{ message: string; level: string }> = [];
    await registeredCommand.handler("   ", {
      cwd: tempTestDir,
      ui: {
        async input() {
          return "   ";
        },
        notify(message: string, level: string) {
          notifications.push({ message, level });
        }
      }
    });

    assert.equal(spawnCalls, 0);
    assert.equal(sentMessages.length, 0);
    assert.deepEqual(notifications.at(-1), { message: "Goal cannot be empty", level: "error" });
  });

  afterEach(() => {
    if (originalCcReviewProvider === undefined) {
      delete process.env.CC_REVIEW_PROVIDER;
    } else {
      process.env.CC_REVIEW_PROVIDER = originalCcReviewProvider;
    }
    if (originalCodexApiKey === undefined) {
      delete process.env.CODEX_API_KEY;
    } else {
      process.env.CODEX_API_KEY = originalCodexApiKey;
    }
    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }
    if (originalCodexModel === undefined) {
      delete process.env.CODEX_MODEL;
    } else {
      process.env.CODEX_MODEL = originalCodexModel;
    }
    if (originalAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
    }
    if (originalClaudeApiKey === undefined) {
      delete process.env.CLAUDE_API_KEY;
    } else {
      process.env.CLAUDE_API_KEY = originalClaudeApiKey;
    }
    if (originalClaudeModel === undefined) {
      delete process.env.CLAUDE_MODEL;
    } else {
      process.env.CLAUDE_MODEL = originalClaudeModel;
    }
    if (originalClaudeMaxTokens === undefined) {
      delete process.env.CLAUDE_MAX_TOKENS;
    } else {
      process.env.CLAUDE_MAX_TOKENS = originalClaudeMaxTokens;
    }
    if (originalClaudeApiUrl === undefined) {
      delete process.env.CLAUDE_API_URL;
    } else {
      process.env.CLAUDE_API_URL = originalClaudeApiUrl;
    }
    if (originalCcReviewLogLevel === undefined) {
      delete process.env.CC_REVIEW_LOG_LEVEL;
    } else {
      process.env.CC_REVIEW_LOG_LEVEL = originalCcReviewLogLevel;
    }
    if (originalCcReviewMode === undefined) {
      delete process.env.CC_REVIEW_MODE;
    } else {
      process.env.CC_REVIEW_MODE = originalCcReviewMode;
    }
    if (originalCcReviewMaxRepairRounds === undefined) {
      delete process.env.CC_REVIEW_MAX_REPAIR_ROUNDS;
    } else {
      process.env.CC_REVIEW_MAX_REPAIR_ROUNDS = originalCcReviewMaxRepairRounds;
    }
    if (originalCcReviewLogFile === undefined) {
      delete process.env.CC_REVIEW_LOG_FILE;
    } else {
      process.env.CC_REVIEW_LOG_FILE = originalCcReviewLogFile;
    }
    if (originalCcReviewNestDepth === undefined) {
      delete process.env.CC_REVIEW_NEST_DEPTH;
    } else {
      process.env.CC_REVIEW_NEST_DEPTH = originalCcReviewNestDepth;
    }
    globalThis.fetch = originalFetch;
    try {
      fs.rmSync(tempTestDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // Enable mocking child_process.spawn and process.kill
  mock.method(child_process, "spawn", (command: string, args: string[], options: any) => {
    if (mockSpawnHandler) {
      const mockProc = mockSpawnHandler(command, args);
      if (mockProc) {
        const isPlanner =
          (command === "codex" && isCodexPlannerArgs(args)) ||
          (command === "claude" && isClaudePlannerArgs(args));
        if ((command === "codex" || command === "claude") && !isPlanner && mockProc.autoReviewStdout !== false) {
          mockProc.autoReviewStdout = true;
        }
        return mockProc as any;
      }
    }
    return originalSpawn(command, args, options);
  });

  mock.method(process, "kill", (pid: number, signal?: string | number) => {
    if (pid === 99999 || pid === -99999) {
      return true;
    }
    return originalProcessKill(pid, signal as any);
  });

  it("review provider default uses existing codex reviewer behavior", async () => {
    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];

    const reviewCommands: string[] = [];
    const reviewArgsList: string[][] = [];
    let plannerCalls = 0;

    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            plannerCalls++;
            const oIndex = args.indexOf("-o");
            const outputPath = args[oIndex + 1];
            fs.writeFileSync(outputPath, JSON.stringify({ tasks: mockTasks }), "utf8");
          } else {
            reviewCommands.push(command);
            reviewArgsList.push(args);
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };

    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    const result = await registeredTool.execute(
      "tool-call-provider-default",
      { goal: "Build with default reviewer" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    assert.equal(plannerCalls, 1);
    assert.deepEqual(reviewCommands, ["codex"]);
    assert.equal(reviewArgsList[0][0], "exec");
    assert.ok(reviewArgsList[0].includes("--skip-git-repo-check"));
    assert.ok(reviewArgsList[0].includes("--dangerously-bypass-approvals-and-sandbox"));
  });

  it("review provider claude uses Claude for planner and reviewer", async () => {
    process.env.CC_REVIEW_PROVIDER = " ClAuDe ";
    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];

    let plannerCalls = 0;
    const reviewCommands: string[] = [];
    const reviewArgsList: string[][] = [];

    mockSpawnHandler = (command, args) => {
      if (command === "claude") {
        const mockProc = new MockChildProcess();
        const planner = isClaudePlannerArgs(args);
        process.nextTick(() => {
          if (planner) {
            plannerCalls++;
            mockProc.stdout.emit("data", Buffer.from(JSON.stringify({ tasks: mockTasks })));
          } else {
            reviewCommands.push(command);
            reviewArgsList.push(args);
            mockProc.stdout.emit("data", Buffer.from("Claude review success\n"));
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };

    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    const result = await registeredTool.execute(
      "tool-call-provider-claude",
      { goal: "Build with Claude reviewer", reviewMode: "per-task" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    assert.equal(plannerCalls, 1);
    assert.deepEqual(reviewCommands, ["claude"]);
    assert.ok(reviewArgsList[0].includes("-p"));
    assert.ok(reviewArgsList[0].includes("--dangerously-skip-permissions"));
    assert.ok(reviewArgsList[0].includes("--no-session-persistence"));
    assert.match(reviewArgsList[0].at(-1) || "", /Review the changes in the workspace for task: 'Task 1'/);
  });

  it("explicit tool provider option claude uses Claude for both planner and reviewer without environment setup", async () => {
    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];

    let plannerCalls = 0;
    const reviewCommands: string[] = [];

    mockSpawnHandler = (command, args) => {
      if (command === "claude") {
        const mockProc = new MockChildProcess();
        const planner = isClaudePlannerArgs(args);
        process.nextTick(() => {
          if (planner) {
            plannerCalls++;
            mockProc.stdout.emit("data", Buffer.from(JSON.stringify({ tasks: mockTasks })));
          } else {
            reviewCommands.push(command);
            mockProc.stdout.emit("data", Buffer.from("Claude explicit review success\n"));
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };

    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    const result = await registeredTool.execute(
      "tool-call-explicit-provider-claude",
      { goal: "Build with explicit Claude reviewer", reviewProvider: "claude" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    assert.equal(plannerCalls, 1);
    assert.deepEqual(reviewCommands, ["claude"]);
  });

  it("explicit tool provider option is normalized before reviewer dispatch", async () => {
    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];

    let plannerCalls = 0;
    const reviewCommands: string[] = [];

    mockSpawnHandler = (command, args) => {
      if (command === "claude") {
        const mockProc = new MockChildProcess();
        const planner = isClaudePlannerArgs(args);
        process.nextTick(() => {
          if (planner) {
            plannerCalls++;
            mockProc.stdout.emit("data", Buffer.from(JSON.stringify({ tasks: mockTasks })));
          } else {
            reviewCommands.push(command);
            mockProc.stdout.emit("data", Buffer.from("Claude normalized explicit review success\n"));
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };

    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    const result = await registeredTool.execute(
      "tool-call-explicit-provider-normalized",
      { goal: "Build with normalized explicit reviewer", reviewProvider: " ClAuDe " },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    assert.equal(plannerCalls, 1);
    assert.deepEqual(reviewCommands, ["claude"]);

    const tracePath = findWorkflowTracePath(tempTestDir);
    const traceLines = fs.readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(traceLines[0].reviewProvider, "claude");
    assert.ok(traceLines.some((entry) => entry.event === "subagent_assignment" && entry.role === "reviewer" && entry.agent === "claude"));
  });

  it("explicit tool provider option codex overrides CC_REVIEW_PROVIDER", async () => {
    process.env.CC_REVIEW_PROVIDER = "claude";
    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];

    let plannerCalls = 0;
    const reviewCommands: string[] = [];

    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            plannerCalls++;
            fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
          } else {
            reviewCommands.push(command);
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      if (command === "claude") {
        throw new Error("explicit codex provider should not invoke claude");
      }
      return null;
    };

    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    const result = await registeredTool.execute(
      "tool-call-explicit-provider-codex",
      { goal: "Build with explicit Codex reviewer", reviewProvider: "codex" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    assert.equal(plannerCalls, 1);
    assert.deepEqual(reviewCommands, ["codex"]);
  });

  it("invalid explicit tool provider option fails clearly before planner subprocess", async () => {
    let spawnCalls = 0;
    mockSpawnHandler = () => {
      spawnCalls++;
      return null;
    };

    const result = await registeredTool.execute(
      "tool-call-explicit-provider-invalid",
      { goal: "Build with invalid explicit reviewer", reviewProvider: "bogus" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, true);
    assert.match(result.details.error, /Invalid reviewProvider value "bogus"/);
    assert.match(result.details.error, /Supported review providers: codex, claude/);
    assert.equal(spawnCalls, 0);
  });

  it("whitespace explicit tool provider option fails clearly before planner subprocess", async () => {
    let spawnCalls = 0;
    mockSpawnHandler = () => {
      spawnCalls++;
      return null;
    };

    const result = await registeredTool.execute(
      "tool-call-explicit-provider-whitespace",
      { goal: "Build with whitespace explicit reviewer", reviewProvider: "   " },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, true);
    assert.match(result.details.error, /Invalid reviewProvider value "   "/);
    assert.equal(spawnCalls, 0);
  });

  it("review provider warning summary uses configured provider name", async () => {
    process.env.CC_REVIEW_PROVIDER = "claude";
    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];

    mockSpawnHandler = (command, args) => {
      if (command === "claude") {
        const mockProc = new MockChildProcess();
        const planner = isClaudePlannerArgs(args);
        process.nextTick(() => {
          if (planner) {
            mockProc.stdout.emit("data", Buffer.from(JSON.stringify({ tasks: mockTasks })));
            mockProc.emit("close", 0, null);
          } else {
            mockProc.autoReviewStdout = false;
            mockProc.stderr.emit("data", Buffer.from("Claude review failed\n"));
            mockProc.emit("close", 1, null);
          }
        });
        return mockProc;
      }
      return null;
    };

    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    const result = await registeredTool.execute(
      "tool-call-provider-warning",
      { goal: "Build with Claude reviewer warning" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /claude review exit 1/);
    assert.doesNotMatch(result.content[0].text, /codex review exit 2/);
  });

  it("slash command without explicit provider preserves Codex review path", async () => {
    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];

    let plannerCalls = 0;
    const reviewCommands: string[] = [];
    const reviewArgsList: string[][] = [];

    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            plannerCalls++;
            fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
          } else {
            reviewCommands.push(command);
            reviewArgsList.push(args);
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };

    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    await registeredCommand.handler("Build via command with default reviewer", { cwd: tempTestDir });

    assert.equal(plannerCalls, 1);
    assert.deepEqual(reviewCommands, ["codex"]);
    assert.equal(reviewArgsList[0][0], "exec");
    assert.ok(reviewArgsList[0].includes("--skip-git-repo-check"));
    assert.ok(reviewArgsList[0].includes("--dangerously-bypass-approvals-and-sandbox"));
    const findingsMessages = sentMessages.filter((message) => message.customType === "cc-review-findings");
    assert.equal(findingsMessages.length, 2);
    for (const message of findingsMessages) {
      assert.equal(
        typeof message.content,
        "string",
        "custom message content must satisfy Pi's string-or-content-block-array contract"
      );
      assert.ok(
        message.details?.kind === "task" || message.details?.kind === "rollup",
        "structured findings payload must be carried in custom message details"
      );
    }
    assert.match(getSummaryText(sentMessages), /Completed and reviewed/);
    assert.ok(getSummaryMessage(sentMessages)?.details, "summary renderer metadata must use Pi's details field");
  });

  it("slash command with --provider claude reaches Claude subprocess path", async () => {
    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];

    let plannerCalls = 0;
    const reviewCommands: string[] = [];
    const reviewArgsList: string[][] = [];

    mockSpawnHandler = (command, args) => {
      if (command === "claude") {
        const mockProc = new MockChildProcess();
        const planner = isClaudePlannerArgs(args);
        process.nextTick(() => {
          if (planner) {
            plannerCalls++;
            mockProc.stdout.emit("data", Buffer.from(JSON.stringify({ tasks: mockTasks })));
          } else {
            reviewCommands.push(command);
            reviewArgsList.push(args);
            mockProc.stdout.emit("data", Buffer.from("Claude command review success\n"));
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };

    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    await registeredCommand.handler("--provider claude Build via command with Claude reviewer", { cwd: tempTestDir });

    assert.equal(plannerCalls, 1);
    assert.deepEqual(reviewCommands, ["claude"]);
    assert.ok(reviewArgsList[0].includes("-p"));
    assert.equal(sentMessages.filter((message) => message.customType === "cc-review-findings").length, 2);
    assert.match(getSummaryText(sentMessages), /Completed and reviewed/);
  });

  it("slash command with --provider=codex overrides CC_REVIEW_PROVIDER", async () => {
    process.env.CC_REVIEW_PROVIDER = "claude";
    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];

    let plannerCalls = 0;
    const reviewCommands: string[] = [];

    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            plannerCalls++;
            fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
          } else {
            reviewCommands.push(command);
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      if (command === "claude") {
        throw new Error("explicit command codex provider should not invoke claude");
      }
      return null;
    };

    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    await registeredCommand.handler("--provider=codex Build via command with Codex reviewer", { cwd: tempTestDir });

    assert.equal(plannerCalls, 1);
    assert.deepEqual(reviewCommands, ["codex"]);
    assert.equal(sentMessages.filter((message) => message.customType === "cc-review-findings").length, 2);
    assert.match(getSummaryText(sentMessages), /Completed and reviewed/);
  });

  it("slash command with invalid --provider value fails clearly before subprocess", async () => {
    let spawnCalls = 0;
    mockSpawnHandler = () => {
      spawnCalls++;
      return null;
    };

    const notifications: Array<{ message: string; level: string }> = [];
    await registeredCommand.handler("--provider bogus Build via command with invalid provider", {
      cwd: tempTestDir,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        }
      }
    });

    assert.equal(spawnCalls, 0);
    assert.equal(sentMessages.length, 0);
    assert.match(notifications.at(-1)?.message || "", /Invalid reviewProvider value "bogus"/);
    assert.equal(notifications.at(-1)?.level, "error");
  });

  it("slash command with missing --provider value fails clearly before subprocess", async () => {
    let spawnCalls = 0;
    mockSpawnHandler = () => {
      spawnCalls++;
      return null;
    };

    const notifications: Array<{ message: string; level: string }> = [];
    await registeredCommand.handler("--provider Build via command with missing provider", {
      cwd: tempTestDir,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        }
      }
    });

    assert.equal(spawnCalls, 0);
    assert.equal(sentMessages.length, 0);
    assert.match(notifications.at(-1)?.message || "", /Invalid reviewProvider value "Build"|Invalid --provider value/);
    assert.equal(notifications.at(-1)?.level, "error");
  });

  it("slash command with --log-level warning strips the flag and reaches the workflow", async () => {
    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];
    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };
    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    await registeredCommand.handler("--log-level warning Build feature X", { cwd: tempTestDir });

    assert.equal(sentMessages.filter((message) => message.customType === "cc-review-findings").length, 2);
    assert.match(getSummaryText(sentMessages), /Completed and reviewed/);
  });

  it("slash command with --log-level=error and --provider codex coexist regardless of flag order", async () => {
    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];
    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };
    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    await registeredCommand.handler("--provider codex --log-level=error Build feature Y", { cwd: tempTestDir });

    assert.equal(sentMessages.filter((message) => message.customType === "cc-review-findings").length, 2);
    assert.match(getSummaryText(sentMessages), /Completed and reviewed/);
  });

  it("slash command with missing --log-level value fails clearly before subprocess", async () => {
    let spawnCalls = 0;
    mockSpawnHandler = () => {
      spawnCalls++;
      return null;
    };

    const notifications: Array<{ message: string; level: string }> = [];
    await registeredCommand.handler("Build feature with trailing --log-level", {
      cwd: tempTestDir,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        }
      }
    });

    assert.equal(spawnCalls, 0);
    assert.equal(sentMessages.length, 0);
    assert.match(notifications.at(-1)?.message || "", /Invalid --log-level value/);
    assert.equal(notifications.at(-1)?.level, "error");
  });

  it("slash command with Claude provider from environment still reaches Claude subprocess path", async () => {
    process.env.CC_REVIEW_PROVIDER = " ClAuDe ";
    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];

    let plannerCalls = 0;
    const reviewCommands: string[] = [];
    const reviewArgsList: string[][] = [];

    mockSpawnHandler = (command, args) => {
      if (command === "claude") {
        const mockProc = new MockChildProcess();
        const planner = isClaudePlannerArgs(args);
        process.nextTick(() => {
          if (planner) {
            plannerCalls++;
            mockProc.stdout.emit("data", Buffer.from(JSON.stringify({ tasks: mockTasks })));
          } else {
            reviewCommands.push(command);
            reviewArgsList.push(args);
            mockProc.stdout.emit("data", Buffer.from("Claude command review success\n"));
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };

    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    await registeredCommand.handler("Build via command with Claude reviewer", { cwd: tempTestDir });

    assert.equal(plannerCalls, 1);
    assert.deepEqual(reviewCommands, ["claude"]);
    assert.ok(reviewArgsList[0].includes("-p"));
    assert.equal(sentMessages.filter((message) => message.customType === "cc-review-findings").length, 2);
    assert.match(getSummaryText(sentMessages), /Completed and reviewed/);
  });

  it("review provider invalid value fails clearly before reviewer subprocess", async () => {
    process.env.CC_REVIEW_PROVIDER = " bogus ";

    let spawnCalls = 0;
    mockSpawnHandler = () => {
      spawnCalls++;
      return null;
    };

    const result = await registeredTool.execute(
      "tool-call-provider-invalid",
      { goal: "Build with invalid reviewer" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, true);
    assert.match(result.details.error, /Invalid CC_REVIEW_PROVIDER value " bogus "/);
    assert.match(result.details.error, /Supported review providers: codex, claude/);
    assert.equal(spawnCalls, 0);
  });

  it("selected backend initialization claude does not require Codex-only review variables", async () => {
    process.env.CC_REVIEW_PROVIDER = "claude";
    process.env.ANTHROPIC_API_KEY = "test-claude-review-key";
    delete process.env.CODEX_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_MODEL;

    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];

    let plannerCalls = 0;
    let claudeCalls = 0;
    mockSpawnHandler = (command, args) => {
      if (command === "claude") {
        const mockProc = new MockChildProcess();
        const planner = isClaudePlannerArgs(args);
        process.nextTick(() => {
          claudeCalls++;
          if (planner) {
            plannerCalls++;
            mockProc.stdout.emit("data", Buffer.from(JSON.stringify({ tasks: mockTasks })));
          } else {
            assert.ok(!args.includes("test-codex-model"));
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };

    mockSubagentHandler = async () => {
      return {
        content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
        details: { results: [{ exitCode: 0 }] }
      };
    };

    const result = await registeredTool.execute(
      "tool-call-claude-selected-backend-no-codex-vars",
      { goal: "Build with Claude selected backend" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    assert.equal(plannerCalls, 1);
    assert.equal(claudeCalls, 2);
  });

  it("selected backend initialization codex does not require Claude-only review variables", async () => {
    process.env.CC_REVIEW_PROVIDER = "codex";
    process.env.CODEX_API_KEY = "test-codex-review-key";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_API_KEY;
    process.env.CLAUDE_MODEL = "claude-unselected-model";

    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];

    let plannerCalls = 0;
    let codexReviewCalls = 0;
    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            plannerCalls++;
            fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
          } else {
            codexReviewCalls++;
            assert.ok(!args.includes("claude-unselected-model"));
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      if (command === "claude") {
        throw new Error("selected codex backend should not initialize or invoke claude");
      }
      return null;
    };

    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    const result = await registeredTool.execute(
      "tool-call-codex-selected-backend-no-claude-vars",
      { goal: "Build with Codex selected backend" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    assert.equal(plannerCalls, 1);
    assert.equal(codexReviewCalls, 1);
  });

  it("missing selected backend credentials do not preflight-fail; auth is delegated to the CLI", async () => {
    // No preflight credential gate: like codex, the claude CLI handles its own auth.
    delete process.env.CODEX_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_API_KEY;

    const plannedTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" },
    ];

    let plannerCalls = 0;
    let claudeReviewCalls = 0;
    mockSpawnHandler = (command, args) => {
      const mockProc = new MockChildProcess();
      process.nextTick(() => {
        if (command === "claude") {
          if (isClaudePlannerArgs(args)) {
            plannerCalls++;
            mockProc.stdout.emit("data", Buffer.from(JSON.stringify({ tasks: plannedTasks })));
          } else {
            claudeReviewCalls++;
          }
        }
        mockProc.emit("close", 0, null);
      });
      return mockProc;
    };

    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] },
    });

    const claudeResult = await registeredTool.execute(
      "tool-call-no-preflight-credentials",
      { goal: "Build with Claude reviewer using CLI auth", reviewProvider: "claude" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(claudeResult.isError, undefined);
    assert.equal(plannerCalls, 1);
    assert.equal(claudeReviewCalls, 1);
  });

  it("Claude review subprocess ignores API-only max token config", async () => {
    process.env.CC_REVIEW_PROVIDER = "claude";
    process.env.CLAUDE_MAX_TOKENS = "12oops";

    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];

    let claudeCalls = 0;
    mockSpawnHandler = (command, args) => {
      if (command === "claude") {
        const mockProc = new MockChildProcess();
        const planner = isClaudePlannerArgs(args);
        process.nextTick(() => {
          if (planner) {
            mockProc.stdout.emit("data", Buffer.from(JSON.stringify({ tasks: mockTasks })));
          } else {
            claudeCalls++;
            assert.ok(!args.includes("--max-tokens"));
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };

    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    const result = await registeredTool.execute(
      "tool-call-claude-ignores-api-max-tokens",
      { goal: "Build with Claude CLI max token env" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    assert.equal(claudeCalls, 1);
  });

  it("Claude review subprocess constructs CLI args with prompt and model config", async () => {
    process.env.CC_REVIEW_PROVIDER = "claude";
    process.env.CLAUDE_MODEL = "claude-test-model";

    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];
    let claudeArgs: string[] = [];
    mockSpawnHandler = (command, args) => {
      if (command === "claude") {
        const mockProc = new MockChildProcess();
        const planner = isClaudePlannerArgs(args);
        process.nextTick(() => {
          if (planner) {
            mockProc.stdout.emit("data", Buffer.from(JSON.stringify({ tasks: mockTasks })));
          } else {
            claudeArgs = args;
            mockProc.stdout.emit("data", Buffer.from("NO_ISSUES_FOUND\n"));
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };

    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    const result = await registeredTool.execute(
      "tool-call-claude-request",
      { goal: "Build with Claude request", reviewMode: "per-task" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    assert.ok(claudeArgs.includes("-p"));
    assert.ok(claudeArgs.includes("--dangerously-skip-permissions"));
    assert.ok(claudeArgs.includes("--no-session-persistence"));
    assert.deepEqual(claudeArgs.slice(claudeArgs.indexOf("--model"), claudeArgs.indexOf("--model") + 2), ["--model", "claude-test-model"]);
    assert.match(claudeArgs.at(-1) || "", /Review the changes in the workspace for task: 'Task 1'/);
    assert.match(claudeArgs.at(-1) || "", /Task description: 'Implement feature A'/);
  });

  it("Claude review subprocess invokes normalized interface and parses success response", async () => {
    process.env.CC_REVIEW_PROVIDER = "claude";

    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];
    mockSpawnHandler = (command, args) => {
      if (command === "claude") {
        const mockProc = new MockChildProcess();
        const planner = isClaudePlannerArgs(args);
        process.nextTick(() => {
          if (planner) {
            mockProc.stdout.emit("data", Buffer.from(JSON.stringify({ tasks: mockTasks })));
          } else {
            mockProc.stdout.emit("data", Buffer.from("Claude normalized review output\n"));
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };
    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    const result = await registeredTool.execute(
      "tool-call-claude-normalized",
      { goal: "Build with normalized Claude result" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Completed and reviewed/);
  });

  it("Claude review subprocess non-zero exits become warning results", async () => {
    process.env.CC_REVIEW_PROVIDER = "claude";

    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];
    mockSpawnHandler = (command, args) => {
      if (command === "claude") {
        const mockProc = new MockChildProcess();
        const planner = isClaudePlannerArgs(args);
        process.nextTick(() => {
          if (planner) {
            mockProc.stdout.emit("data", Buffer.from(JSON.stringify({ tasks: mockTasks })));
            mockProc.emit("close", 0, null);
          } else {
            mockProc.autoReviewStdout = false;
            mockProc.stderr.emit("data", Buffer.from("rate limited\n"));
            mockProc.emit("close", 1, null);
          }
        });
        return mockProc;
      }
      return null;
    };
    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    const result = await registeredTool.execute(
      "tool-call-claude-error-response",
      { goal: "Build with Claude error response" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /completed_with_warnings|Completed with warnings/i);
    assert.match(result.content[0].text, /claude review exit 1/);
  });

  it("Claude review subprocess spawn failures fail the workflow clearly", async () => {
    process.env.CC_REVIEW_PROVIDER = "claude";

    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];
    mockSpawnHandler = (command, args) => {
      if (command === "claude") {
        const mockProc = new MockChildProcess();
        const planner = isClaudePlannerArgs(args);
        process.nextTick(() => {
          if (planner) {
            mockProc.stdout.emit("data", Buffer.from(JSON.stringify({ tasks: mockTasks })));
            mockProc.emit("close", 0, null);
          } else {
            mockProc.emit("error", new Error("spawn claude ENOENT"));
          }
        });
        return mockProc;
      }
      return null;
    };
    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    const result = await registeredTool.execute(
      "tool-call-claude-spawn-failure",
      { goal: "Build with Claude spawn failure" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, true);
    assert.match(result.details.error, /Claude reviewer failed to start|spawn/);
  });

  it("successful multi-step execution of multiple tasks", async () => {
    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" },
      { title: "Task 2", description: "Implement feature B", acceptanceCriteria: "B is verified" }
    ];

    let plannerCalls = 0;
    let reviewerCalls = 0;

    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            plannerCalls++;
            const oIndex = args.indexOf("-o");
            const outputPath = args[oIndex + 1];
            fs.writeFileSync(outputPath, JSON.stringify({ tasks: mockTasks }), "utf8");
            mockProc.stdout.emit("data", Buffer.from("Planning success\n"));
            mockProc.emit("close", 0, null);
          } else {
            reviewerCalls++;
            mockProc.stdout.emit("data", Buffer.from("Review success\n"));
            mockProc.emit("close", 0, null);
          }
        });
        return mockProc;
      }
      return null;
    };

    let subagentCalls = 0;
    mockSubagentHandler = async (toolName, params, signal, onUpdate) => {
      subagentCalls++;
      onUpdate?.({ content: [{ type: "text", text: `Progressing on task: ${params.task}` }] });
      return {
        content: [{ type: "text", text: "Successfully completed task. No issues found." }],
        details: { results: [{ exitCode: 0 }] }
      };
    };

    const statusSnapshots: string[] = [];
    const result = await registeredTool.execute(
      "tool-call-1",
      { goal: "Build a perfect calculator app", reviewMode: "per-task" },
      undefined,
      undefined,
      {
        cwd: tempTestDir,
        ui: {
          setWidget() {},
          setStatus: (_id: string, value: string | undefined) => {
            if (value) statusSnapshots.push(value);
          },
        },
      }
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.details.status, "completed");

    assert.equal(plannerCalls, 1);
    assert.equal(subagentCalls, 2);
    assert.equal(reviewerCalls, 2);
    assert.ok(
      statusSnapshots.some((status) => status.includes("Task 1/2 Executing")),
      "per-task execution should expose the running task in status state"
    );

    const reportText = result.content[0].text;
    assert.match(reportText, /## 🏆 CC Review Orchestrator Report/);
    assert.match(reportText, /Calculator/i);
    assert.match(reportText, /Completed and reviewed/);
    assert.match(reportText, /Task 1/);
    assert.match(reportText, /Task 2/);

    const tracePath = findWorkflowTracePath(tempTestDir);
    assert.ok(fs.existsSync(tracePath));
    const traceLines = fs.readFileSync(tracePath, "utf8").trim().split("\n");
    assert.ok(traceLines.length > 0);
    const firstTrace = JSON.parse(traceLines[0]);
    assert.equal(firstTrace.type, "workflow_trace");
    assert.equal(firstTrace.event, "workflow_start");
  });

  it("after-all review mode executes every task before invoking one workflow review", async () => {
    const mockTasks = [
      { title: "Foundation", description: "Implement foundation", acceptanceCriteria: "Foundation works" },
      { title: "Integration", description: "Integrate feature", acceptanceCriteria: "Integration works" }
    ];
    let subagentCalls = 0;
    let reviewerCalls = 0;
    let subagentCallsWhenReviewStarted = -1;
    let reviewPrompt = "";

    mockSpawnHandler = (command, args) => {
      if (command !== "codex") return null;
      const mockProc = new MockChildProcess();
      if (args.includes("-o")) {
        process.nextTick(() => {
          fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
          mockProc.emit("close", 0, null);
        });
      } else {
        reviewerCalls++;
        subagentCallsWhenReviewStarted = subagentCalls;
        reviewPrompt = args.at(-1) || "";
        process.nextTick(() => mockProc.emit("close", 0, null));
      }
      return mockProc;
    };

    mockSubagentHandler = async () => {
      subagentCalls++;
      return {
        content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
        details: { results: [{ exitCode: 0 }] }
      };
    };

    const result = await registeredTool.execute(
      "tool-call-after-all",
      { goal: "Build the integrated workflow", reviewMode: "after-all" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    assert.equal(subagentCalls, 2);
    assert.equal(reviewerCalls, 1);
    assert.equal(subagentCallsWhenReviewStarted, 2);
    assert.match(reviewPrompt, /Complete workflow: Build the integrated workflow/);
    assert.match(reviewPrompt, /Foundation/);
    assert.match(reviewPrompt, /Integration/);
    assert.equal(
      sentMessages.filter((message) => message.customType === "cc-review-findings").length,
      2,
      "after-all emits one workflow finding plus one rollup"
    );

    const artifactRoot = path.join(tempTestDir, "cc-review-artifacts");
    const runDirs = fs.readdirSync(artifactRoot);
    assert.equal(runDirs.length, 1);
    const artifactFiles = fs.readdirSync(path.join(artifactRoot, runDirs[0])).sort();
    assert.ok(artifactFiles.includes("task-001.json"));
    assert.ok(artifactFiles.includes("task-002.json"));
    assert.ok(artifactFiles.includes("checkpoint.json"));
    for (const artifactFile of artifactFiles.filter((f) => f.startsWith("task-") && f.endsWith(".json"))) {
      const artifact = JSON.parse(
        fs.readFileSync(path.join(artifactRoot, runDirs[0], artifactFile), "utf8")
      );
      assert.equal(artifact.review.effectiveVerdict, "ship");
      assert.equal(artifact.workflow.haltedOnReview, false);
    }
  });

  it("after-all mode preserves serial handoff for legacy plans without dependency metadata", async () => {
    const mockTasks = [
      { title: "Foundation", description: "Implement foundation", acceptanceCriteria: "Foundation works" },
      { title: "Integration", description: "Integrate feature", acceptanceCriteria: "Integration works" }
    ];
    const subagentPrompts: string[] = [];
    const activeCalls: number[] = [];
    let maxConcurrencyObserved = 0;

    mockSpawnHandler = (command, args) => {
      if (command !== "codex") return null;
      const mockProc = new MockChildProcess();
      process.nextTick(() => {
        if (args.includes("-o")) {
          fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
        } else {
          emitMockReviewStdout(mockProc);
        }
        mockProc.emit("close", 0, null);
      });
      return mockProc;
    };

    mockSubagentHandler = async (_toolName, params) => {
      activeCalls.push(1);
      maxConcurrencyObserved = Math.max(maxConcurrencyObserved, activeCalls.length);
      subagentPrompts.push(String(params.task));
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeCalls.pop();

      const isFoundation = String(params.task).includes("Foundation");
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "completed",
            summary: isFoundation ? "Foundation summary for handoff" : "Integration summary",
            filesChanged: isFoundation ? ["src/foundation.ts"] : ["src/integration.ts"],
            unresolvedItems: [],
            acceptanceCriteria: [{
              criterion: isFoundation ? "Foundation works" : "Integration works",
              status: "met",
              evidence: "Mocked verification passed",
            }],
          }),
        }],
        details: { results: [{ exitCode: 0 }] },
      };
    };

    const result = await registeredTool.execute(
      "tool-call-after-all-legacy-handoff",
      { goal: "Build a dependent workflow", reviewMode: "after-all", concurrencyLimit: 2 },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    assert.equal(maxConcurrencyObserved, 1, "Legacy tasks without dependsOn should preserve serial execution");

    const integrationPrompt = subagentPrompts.find((prompt) => prompt.includes("Task: Integration")) ?? "";
    assert.match(integrationPrompt, /Prior Tasks \(Handoff\):/);
    assert.match(integrationPrompt, /Foundation summary for handoff/);
  });

  it("includes a completed forward dependency in the dependent task handoff", async () => {
    const mockTasks = [
      {
        title: "Consumer",
        description: "Consume the provider output",
        acceptanceCriteria: "Consumer works",
        dependsOn: [2],
      },
      {
        title: "Provider",
        description: "Produce the required output",
        acceptanceCriteria: "Provider works",
        dependsOn: [],
      },
    ];
    const executionOrder: string[] = [];
    const subagentPrompts: string[] = [];

    mockSpawnHandler = (command, args) => {
      if (command !== "codex") return null;
      const mockProc = new MockChildProcess();
      process.nextTick(() => {
        if (args.includes("-o")) {
          fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
        } else {
          emitMockReviewStdout(mockProc);
        }
        mockProc.emit("close", 0, null);
      });
      return mockProc;
    };

    mockSubagentHandler = async (_toolName, params) => {
      const prompt = String(params.task);
      const isProvider = prompt.includes("Task: Provider");
      executionOrder.push(isProvider ? "Provider" : "Consumer");
      subagentPrompts.push(prompt);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "completed",
            summary: isProvider ? "Provider summary for forward handoff" : "Consumer summary",
            filesChanged: [],
            unresolvedItems: [],
            acceptanceCriteria: [{
              criterion: isProvider ? "Provider works" : "Consumer works",
              status: "met",
              evidence: "Mocked verification passed",
            }],
          }),
        }],
        details: { results: [{ exitCode: 0 }] },
      };
    };

    const result = await registeredTool.execute(
      "tool-call-after-all-forward-handoff",
      { goal: "Build a forward-dependent workflow", reviewMode: "after-all", concurrencyLimit: 2 },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    assert.deepEqual(executionOrder, ["Provider", "Consumer"]);
    const consumerPrompt = subagentPrompts.find((prompt) => prompt.includes("Task: Consumer")) ?? "";
    assert.match(consumerPrompt, /Prior Tasks \(Handoff\):/);
    assert.match(consumerPrompt, /Provider summary for forward handoff/);
  });

  it("after-all review mode asks the reviewer to repair a block and then re-reviews", async () => {
    const mockTasks = [
      { title: "Integrated task", description: "Implement feature", acceptanceCriteria: "Feature works" }
    ];
    const reviewPrompts: string[] = [];
    const blockedReview = `Review found issues\n${JSON.stringify({
      verdict: "block",
      summary: "Integration bug found",
      findings: [{
        priority: "P1",
        confidence: 0.98,
        message: "repair this integration bug",
        status: "unfixed",
        file: "src/integration.ts",
        line: 12,
      }],
    })}`;

    mockSpawnHandler = (command, args) => {
      if (command !== "codex") return null;
      const mockProc = new MockChildProcess();
      mockProc.autoReviewStdout = false;
      process.nextTick(() => {
        if (args.includes("-o")) {
          fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
        } else {
          reviewPrompts.push(args.at(-1) || "");
          mockProc.stdout.emit(
            "data",
            Buffer.from(reviewPrompts.length === 1 ? blockedReview : REVIEW_SHIP_OUTPUT)
          );
        }
        mockProc.emit("close", 0, null);
      });
      return mockProc;
    };

    let subagentCalls = 0;
    mockSubagentHandler = async () => {
      subagentCalls++;
      return {
        content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
        details: { results: [{ exitCode: 0 }] }
      };
    };

    const result = await registeredTool.execute(
      "tool-call-after-all-repair",
      {
        goal: "Build and repair the integrated workflow",
        reviewMode: "after-all",
      },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.details.status, "completed");
    assert.equal(subagentCalls, 1, "planned task execution should not be repeated");
    assert.equal(reviewPrompts.length, 2, "final review should run again after the repair request");
    assert.match(reviewPrompts[0], /inspection-only review phase/);
    assert.match(reviewPrompts[0], /Do not modify workspace files or attempt repairs/);
    assert.match(reviewPrompts[1], /This is a repair phase/);
    assert.match(reviewPrompts[1], /repair round 1\/1/);
    assert.match(reviewPrompts[1], /\[P1\] src\/integration\.ts:12: repair this integration bug/);

    const lifecycleEvents = fs.readFileSync(
      path.join(tempTestDir, "workflow-logs.jsonl"),
      "utf8"
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.details?.event)
      .map((entry) => entry.details.event);
    assert.deepEqual(lifecycleEvents, [
      "review_finding",
      "repair_started",
      "repair_completed",
    ]);
  });

  it("after-all summaries retain normalized initial-review blockers", async () => {
    const mockTasks = [
      { title: "Integrated task", description: "Implement feature", acceptanceCriteria: "Feature works" }
    ];
    const misleadingFixedReview = `Review found issues\n${JSON.stringify({
      verdict: "ship",
      summary: "Reviewer incorrectly claimed an existing issue was fixed",
      findings: [{
        priority: "P1",
        confidence: 0.98,
        message: "existing blocker",
        status: "fixed",
        file: "src/integration.ts",
        line: 12,
      }],
    })}`;

    mockSpawnHandler = (command, args) => {
      if (command !== "codex") return null;
      const mockProc = new MockChildProcess();
      mockProc.autoReviewStdout = false;
      process.nextTick(() => {
        if (args.includes("-o")) {
          fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
        } else {
          mockProc.stdout.emit("data", Buffer.from(misleadingFixedReview));
        }
        mockProc.emit("close", 0, null);
      });
      return mockProc;
    };
    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    const result = await registeredTool.execute(
      "tool-call-after-all-normalized-findings",
      {
        goal: "Preserve normalized review findings",
        reviewMode: "after-all",
        reviewRepairRounds: 0,
      },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, true);
    assert.equal(result.details.meta.topBlockers.length, 1);
    assert.equal(result.details.meta.topBlockers[0].status, "unfixed");
    assert.match(result.content[0].text, /existing blocker \(unfixed,/);
  });

  it("after-all repair reruns failed orchestrator validation after the reviewer fixes it", async () => {
    const mockTasks = [
      { title: "Validated task", description: "Implement feature", acceptanceCriteria: "Feature works" }
    ];
    fs.writeFileSync(
      path.join(tempTestDir, ".cc-review-validation.json"),
      JSON.stringify({
        commands: [{
          command: process.execPath,
          args: ["-e", "process.exit(require('node:fs').existsSync('fixed.flag') ? 0 : 1)"],
          timeoutMs: 10_000,
        }],
      }),
      "utf8"
    );

    const reviewPrompts: string[] = [];
    mockSpawnHandler = (command, args) => {
      if (command !== "codex") return null;
      const mockProc = new MockChildProcess();
      mockProc.autoReviewStdout = false;
      process.nextTick(() => {
        if (args.includes("-o")) {
          fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
        } else {
          reviewPrompts.push(args.at(-1) || "");
          if (reviewPrompts.length === 1) {
            fs.writeFileSync(path.join(tempTestDir, "review-change.txt"), "first review changed the workspace", "utf8");
          } else {
            fs.writeFileSync(path.join(tempTestDir, "fixed.flag"), "fixed", "utf8");
          }
          mockProc.stdout.emit("data", Buffer.from(REVIEW_SHIP_OUTPUT));
        }
        mockProc.emit("close", 0, null);
      });
      return mockProc;
    };
    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    const result = await registeredTool.execute(
      "tool-call-after-all-validation-repair",
      {
        goal: "Build a workflow with post-review verification",
        reviewMode: "after-all",
        reviewRepairRounds: 2,
      },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.details.status, "completed");
    assert.equal(reviewPrompts.length, 2);
    assert.match(reviewPrompts[1], /Orchestrator post-review validation failed/);
    assert.match(reviewPrompts[1], /Verification command failed/);
    assert.ok(fs.existsSync(path.join(tempTestDir, "fixed.flag")));
  });

  it("slash command forwards --review-mode after-all", async () => {
    const mockTasks = [
      { title: "Task 1", description: "Implement A", acceptanceCriteria: "A works" },
      { title: "Task 2", description: "Implement B", acceptanceCriteria: "B works" }
    ];
    let reviewerCalls = 0;

    mockSpawnHandler = (command, args) => {
      if (command !== "codex") return null;
      const mockProc = new MockChildProcess();
      process.nextTick(() => {
        if (args.includes("-o")) {
          fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
        } else {
          reviewerCalls++;
        }
        mockProc.emit("close", 0, null);
      });
      return mockProc;
    };
    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    await registeredCommand.handler(
      "--review-mode after-all Build through slash command",
      { cwd: tempTestDir }
    );

    assert.equal(reviewerCalls, 1);
    assert.match(getSummaryText(sentMessages), /Completed and reviewed/);
  });

  it("subagent failure with retry and recovery", async () => {
    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];

    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            const oIndex = args.indexOf("-o");
            const outputPath = args[oIndex + 1];
            fs.writeFileSync(outputPath, JSON.stringify({ tasks: mockTasks }), "utf8");
            mockProc.emit("close", 0, null);
          } else {
            mockProc.emit("close", 0, null);
          }
        });
        return mockProc;
      }
      return null;
    };

    let subagentCalls = 0;
    mockSubagentHandler = async (toolName, params) => {
      subagentCalls++;
      if (subagentCalls === 1) {
        return {
          content: [{ type: "text", text: "Compilation failed on line 12" }],
          details: { results: [{ exitCode: 1, errorMessage: "Compilation failed on line 12" }] },
          isError: true
        };
      } else {
        assert.match(params.task, /Previous attempt feedback/);
        assert.match(params.task, /Compilation failed on line 12/);
        return {
          content: [{ type: "text", text: "Fixed compilation issue, now verified." }],
          details: { results: [{ exitCode: 0 }] }
        };
      }
    };

    const result = await registeredTool.execute(
      "tool-call-2",
      { goal: "Repair compilation error" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.details.status, "completed");
    assert.equal(subagentCalls, 2);

    const reportText = result.content[0].text;
    assert.match(reportText, /Completed and reviewed/);
  });

  it("partial result aggregation on unrecoverable failure", async () => {
    const mockTasks = [
      { title: "Task 1", description: "Successful task", acceptanceCriteria: "A is verified" },
      { title: "Task 2", description: "Failing task", acceptanceCriteria: "B is verified" },
      { title: "Task 3", description: "Skipped task", acceptanceCriteria: "C is verified" }
    ];

    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            const oIndex = args.indexOf("-o");
            const outputPath = args[oIndex + 1];
            fs.writeFileSync(outputPath, JSON.stringify({ tasks: mockTasks }), "utf8");
            mockProc.emit("close", 0, null);
          } else {
            mockProc.emit("close", 0, null);
          }
        });
        return mockProc;
      }
      return null;
    };

    let subagentCalls = 0;
    mockSubagentHandler = async (toolName, params) => {
      subagentCalls++;
      if (subagentCalls === 1) {
        return {
          content: [{ type: "text", text: "Task 1 completed successfully." }],
          details: { results: [{ exitCode: 0 }] }
        };
      } else {
        return {
          content: [{ type: "text", text: "Syntax error on line 45" }],
          details: { results: [{ exitCode: 1, errorMessage: "Syntax error on line 45" }] },
          isError: true
        };
      }
    };

    const result = await registeredTool.execute(
      "tool-call-3",
      { goal: "Multi-step app build", reviewMode: "per-task" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, true);
    assert.equal(result.details.status, "failed");
    assert.match(result.details.error, /Task execution failed unrecoverably/);

    const reportText = result.content[0].text;
    assert.match(reportText, /The workflow terminated early due to an unrecoverable task execution/);
    assert.match(reportText, /Task 1[\s\S]*Completed and reviewed/);
    assert.match(reportText, /Task 2[\s\S]*Failed \(subagent exit 1\)/);
    assert.match(reportText, /Task 3[\s\S]*Skipped \(not executed\)/);

    assert.match(reportText, /### ⚠️ Unresolved Items/);
    assert.match(reportText, /Task Skipped: "Task 3"/);
    assert.match(reportText, /Task Failed: "Task 2"/);
    assert.match(reportText, /In Task "Task 2": Syntax error on line 45/);

    assert.match(reportText, /### 💡 Suggested Actionable Steps to Recover/);
    assert.match(reportText, /Review the Error\/Validation Details/);
  });

  it("retry exhaustion for subagent and planning", async () => {
    // A. Subagent retry exhaustion
    const mockTasks = [
      { title: "Task 1", description: "Stubborn task", acceptanceCriteria: "A is verified" }
    ];

    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            const oIndex = args.indexOf("-o");
            const outputPath = args[oIndex + 1];
            fs.writeFileSync(outputPath, JSON.stringify({ tasks: mockTasks }), "utf8");
            mockProc.emit("close", 0, null);
          } else {
            mockProc.emit("close", 0, null);
          }
        });
        return mockProc;
      }
      return null;
    };

    let subagentCalls = 0;
    mockSubagentHandler = async () => {
      subagentCalls++;
      return {
        content: [{ type: "text", text: "Critical failure" }],
        details: { results: [{ exitCode: 1, errorMessage: "Critical failure" }] },
        isError: true
      };
    };

    const resultSubagentExhaustion = await registeredTool.execute(
      "tool-call-4a",
      { goal: "Goal with stubborn task" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(resultSubagentExhaustion.isError, true);
    assert.equal(subagentCalls, 3); // maxTaskExecutionRetries=2 → 3 total dispatches

    // B. Planning retry exhaustion
    let plannerCalls = 0;
    let plannerSchema: any;
    mockSpawnHandler = (command, args) => {
      if (command === "codex" && args.includes("-o")) {
        plannerCalls++;
        const schemaPath = args[args.indexOf("--output-schema") + 1];
        plannerSchema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          mockProc.emit("close", 1, null);
        });
        return mockProc;
      }
      return null;
    };

    const resultPlanExhaustion = await registeredTool.execute(
      "tool-call-4b",
      { goal: "Goal with broken planner" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(resultPlanExhaustion.isError, true);
    assert.equal(plannerCalls, 3); // maxPlanRetries is 3
    assert.deepEqual(plannerSchema.properties.tasks.items.required, [
      "title",
      "description",
      "acceptanceCriteria",
      "dependsOn",
    ]);
    assert.match(
      resultPlanExhaustion.content[0].text,
      /workflow failed during planning before any tasks were created/i
    );
    assert.doesNotMatch(resultPlanExhaustion.content[0].text, /successfully accomplished/i);
  });

  it("timeout/cancellation clean handling", async () => {
    const mockTasks = [
      { title: "Task 1", description: "Interactive task", acceptanceCriteria: "A is verified" },
      { title: "Task 2", description: "Future task", acceptanceCriteria: "B is verified" }
    ];

    let isSpawnKilled = false;
    let spawnedProc: MockChildProcess | null = null;

    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        spawnedProc = new MockChildProcess();
        mock.method(spawnedProc, "kill", (signal?: string) => {
          isSpawnKilled = true;
          spawnedProc?.emit("close", null, signal || "SIGTERM");
        });

        process.nextTick(() => {
          if (args.includes("-o")) {
            const oIndex = args.indexOf("-o");
            const outputPath = args[oIndex + 1];
            fs.writeFileSync(outputPath, JSON.stringify({ tasks: mockTasks }), "utf8");
            spawnedProc?.emit("close", 0, null);
          } else {
            spawnedProc?.emit("close", 0, null);
          }
        });
        return spawnedProc;
      }
      return null;
    };

    const abortController = new AbortController();

    let subagentCalls = 0;
    mockSubagentHandler = async (toolName, params, signal) => {
      subagentCalls++;
      abortController.abort();

      return new Promise((_, reject) => {
        if (signal?.aborted) {
          reject(new Error("Workflow aborted by user"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(new Error("Workflow aborted by user"));
        });
      });
    };

    const result = await registeredTool.execute(
      "tool-call-5",
      { goal: "Goal to abort" },
      abortController.signal,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, true);
    assert.equal(result.details.status, "failed");
    assert.match(result.details.error, /aborted by user/i);

    const reportText = result.content[0].text;
    assert.match(reportText, /The workflow was cancelled or timed out before completion/);
    assert.match(reportText, /Task 1[\s\S]*Cancelled \/ Timed out/);
    assert.match(reportText, /Task 2[\s\S]*Skipped/);
  });

  it("malformed subagent output and unresolved item handling", async () => {
    const mockTasks = [
      { title: "Task 1", description: "Check output formatting", acceptanceCriteria: "A is verified" }
    ];

    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            const oIndex = args.indexOf("-o");
            const outputPath = args[oIndex + 1];
            fs.writeFileSync(outputPath, JSON.stringify({ tasks: mockTasks }), "utf8");
            mockProc.emit("close", 0, null);
          } else {
            mockProc.emit("close", 0, null);
          }
        });
        return mockProc;
      }
      return null;
    };

    let subagentCalls = 0;
    mockSubagentHandler = async (toolName, params) => {
      subagentCalls++;
      if (subagentCalls === 1) {
        return {
          content: [{ type: "text", text: "Successfully completed task, but TODO: fix memory leak in handler." }],
          details: { results: [{ exitCode: 0 }] }
        };
      } else {
        return {
          content: [{ type: "text", text: "Memory leak resolved. All features verified." }],
          details: { results: [{ exitCode: 0 }] }
        };
      }
    };

    const result = await registeredTool.execute(
      "tool-call-6",
      { goal: "No TODOs allowed" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.details.status, "completed");
    assert.equal(subagentCalls, 2);

    const reportText = result.content[0].text;
    assert.match(reportText, /Completed and reviewed/);
  });

  it("persists a bounded human-readable log file and surfaces its path in the summary", async () => {
    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];
    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };
    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    const result = await registeredTool.execute(
      "tool-call-persisted-log",
      { goal: "Persisted-log goal" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    const logPath = path.join(tempTestDir, "workflow-logs.jsonl");
    assert.ok(fs.existsSync(logPath), "workflow-logs.jsonl should exist");
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    assert.ok(lines.length >= 3, `expected several persisted log lines, got ${lines.length}`);
    for (const line of lines) {
      const entry = JSON.parse(line);
      assert.ok(entry.id, "every persisted entry should have an id");
      assert.ok(entry.severity, "every persisted entry should have a severity");
      assert.ok(entry.message, "every persisted entry should have a message");
    }
    // The trace file is separate from the human-readable log file.
    const tracePath = findWorkflowTracePath(tempTestDir);
    assert.ok(fs.existsSync(tracePath), "trace file should still exist as a separate stream");
    assert.notEqual(logPath, tracePath);

    // Summary surfaces the persisted log path so users can open it after the TUI clears.
    assert.match(result.content[0].text, /Persisted Workflow Log/);
    assert.ok(result.content[0].text.includes(logPath), `summary should reference ${logPath}`);
  });

  it("emits compact onUpdate deltas instead of re-broadcasting full markdown snapshots", async () => {
    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];
    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };
    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    const updates: any[] = [];
    const onUpdate = (partial: any) => updates.push(partial);

    await registeredTool.execute(
      "tool-call-compact-deltas",
      { goal: "Delta cadence goal" },
      undefined,
      onUpdate,
      { cwd: tempTestDir }
    );

    assert.ok(updates.length > 0, "workflow should produce onUpdate events");
    const updateTexts = updates
      .map((u) => u?.content?.[0]?.text ?? "")
      .filter((t) => typeof t === "string" && t.length > 0);
    // Old behavior re-emitted the entire goal+phase+last-5 markdown block on every log().
    // Compact deltas should never include that big synthesized block on regular log lines.
    const bloatedSnapshots = updateTexts.filter((text) => /\*\*Goal\*\*: [^\n]+\n\*\*Phase\*\*:/i.test(text) && /\*\*Live Logs\*\*:/i.test(text));
    assert.equal(bloatedSnapshots.length, 0, `expected no full-snapshot updates, found ${bloatedSnapshots.length}`);
    // Most updates should be single severity-rendered lines.
    const longUpdates = updateTexts.filter((t) => t.split("\n").length > 3);
    assert.ok(longUpdates.length <= 1, `delta updates should generally be short; saw ${longUpdates.length} multi-line updates`);
  });

  it("renders explicit widget states for empty logs, warnings, and cancellation", async () => {
    const capture = createWidgetCaptureUi();

    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];
    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
            mockProc.emit("close", 0, null);
          } else {
            // Reviewer exits non-zero with warnings so the widget surfaces an explicit warning state.
            mockProc.autoReviewStdout = false;
            mockProc.stdout.emit(
              "data",
              Buffer.from(
                `${JSON.stringify({
                  verdict: "ship_with_warnings",
                  summary: "Minor review issues",
                  findings: [],
                })}\n`
              )
            );
            mockProc.stderr.emit("data", Buffer.from("review hiccup\n"));
            mockProc.emit("close", 1, null);
          }
        });
        return mockProc;
      }
      return null;
    };
    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    const result = await registeredTool.execute(
      "tool-call-widget-states",
      { goal: "Widget state goal" },
      undefined,
      undefined,
      { cwd: tempTestDir, ui: capture.ui },
    );

    assert.equal(result.isError, undefined);
    assert.ok(capture.widgetSnapshots.length > 0, "widget should be rendered at least once");
    const earliestSnapshot = capture.widgetSnapshots[0].join("\n");
    assert.match(earliestSnapshot, /● CC Review/, "compact widget should render a header");
    assert.doesNotMatch(earliestSnapshot, /Live Logs:/, "compact widget should not show live log tail");
    // Compact widget omits continuous info/debug logs; warnings surface as latest exception.
    const warningSeen = capture.widgetSnapshots.some((snap) =>
      snap.some((line) => /review hiccup|Minor review issues|ship_with_warnings|Warning/i.test(line))
    );
    assert.ok(warningSeen, "reviewer warning should surface as the latest exception line");
  });

  it("mounts the compact widget once during a workflow run and omits info log tail", async () => {
    let setWidgetCalls = 0;
    const capture = createWidgetCaptureUi();
    const originalSetWidget = capture.ui.setWidget;
    capture.ui.setWidget = (id, content) => {
      if (content !== undefined) setWidgetCalls++;
      originalSetWidget(id, content);
    };

    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" },
    ];
    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
            mockProc.emit("close", 0, null);
          } else {
            mockProc.emit("close", 0, null);
          }
        });
        return mockProc;
      }
      return null;
    };
    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] },
    });

    await registeredTool.execute(
      "tool-call-compact-widget-once",
      { goal: "Compact widget mount goal" },
      undefined,
      undefined,
      { cwd: tempTestDir, ui: capture.ui },
    );

    assert.equal(setWidgetCalls, 1, "runtime should register the widget exactly once");
    assert.ok(capture.widgetSnapshots.length > 1, "widget should refresh multiple times via invalidate");
    const widgetText = capture.widgetSnapshots.map((snap) => snap.join("\n")).join("\n");
    assert.match(widgetText, /● CC Review/);
    assert.doesNotMatch(widgetText, /Live Logs:/);
    assert.doesNotMatch(widgetText, /ℹ INFO/);
  });

  it("windows the task checklist with '... N more' affordance for large plans", () => {
    const window = computeChecklistWindow(20, 9, 8);
    assert.ok(window.endIndex - window.startIndex <= 8, "window should cap visible task count");
    assert.ok(window.hiddenBefore > 0, "should hide earlier tasks when current index is mid-plan");
    assert.ok(window.hiddenAfter > 0, "should hide later tasks when current index is mid-plan");

    const headAnchored = computeChecklistWindow(20, -1, 8);
    assert.equal(headAnchored.startIndex, 0);
    assert.equal(headAnchored.endIndex, 8);
    assert.equal(headAnchored.hiddenBefore, 0);
    assert.equal(headAnchored.hiddenAfter, 12);

    const small = computeChecklistWindow(5, 2, 8);
    assert.deepEqual(small, { startIndex: 0, endIndex: 5, hiddenBefore: 0, hiddenAfter: 0 });
  });

  it("configurable task checklist window size", () => {
    // 1) Test resolveCcReviewChecklistWindow with flags and env.
    const r1 = resolveCcReviewChecklistWindow({ flag: 12 });
    assert.equal(r1.window, 12);
    assert.equal(r1.source, "flag");

    const r2 = resolveCcReviewChecklistWindow({ env: { CC_REVIEW_CHECKLIST_WINDOW: "3" } });
    assert.equal(r2.window, 3);
    assert.equal(r2.source, "env");

    const r3 = resolveCcReviewChecklistWindow();
    assert.equal(r3.window, 8);
    assert.equal(r3.source, "default");

    const r4 = resolveCcReviewChecklistWindow({ flag: "invalid" });
    assert.equal(r4.window, 8);
    assert.equal(r4.source, "default");
    assert.equal(r4.invalidInput?.source, "flag");

    const r5 = resolveCcReviewChecklistWindow({ env: { CC_REVIEW_CHECKLIST_WINDOW: "-5" } });
    assert.equal(r5.window, 8);
    assert.equal(r5.source, "default");
    assert.equal(r5.invalidInput?.source, "env");

    // 2) Verify windows of 3, 8, and 20 on a task list of 10 tasks at different currentIndexes.
    // Window of 3, centered on index 5 of a 10-task list
    const w3 = computeChecklistWindow(10, 5, 3);
    assert.deepEqual(w3, { startIndex: 4, endIndex: 7, hiddenBefore: 4, hiddenAfter: 3 });

    // Window of 8, centered on index 5 of a 10-task list
    const w8 = computeChecklistWindow(10, 5, 8);
    assert.deepEqual(w8, { startIndex: 1, endIndex: 9, hiddenBefore: 1, hiddenAfter: 1 });

    // Window of 20, centered on index 5 of a 10-task list
    const w20 = computeChecklistWindow(10, 5, 20);
    assert.deepEqual(w20, { startIndex: 0, endIndex: 10, hiddenBefore: 0, hiddenAfter: 0 });

    // Coercion test: window of 0 or negative
    const wZero = computeChecklistWindow(10, 5, 0);
    assert.equal(wZero.endIndex - wZero.startIndex, 1, "0 window should coerce to at least 1");

    // 3) Verify buildCcReviewWidgetLines uses the resolvedChecklistWindow
    const dummyState = {
      goal: "Test goal",
      tasks: Array.from({ length: 10 }, (_, i) => ({ title: `Task ${i + 1}`, status: "completed" })),
      currentTaskIndex: 5,
      displayState: "executing",
      currentPhase: "Executing",
      liveLogs: [],
      resolvedLogLevel: "info",
      resolvedChecklistWindow: 3,
      persistedLogPath: "dummy.jsonl",
      findingsRollup: emptyFindingsRollup(),
    };

    const renderedLines = buildCcReviewWidgetLines(dummyState as any);
    // Rendered lines should contain earlier/later ellipses:
    const earlierLines = renderedLines.filter(line => line.includes("earlier task"));
    const laterLines = renderedLines.filter(line => line.includes("later task"));
    assert.equal(earlierLines.length, 1, "Should have 1 earlier tasks line");
    assert.equal(laterLines.length, 1, "Should have 1 later tasks line");
    assert.ok(earlierLines[0].includes("4 earlier tasks"), "Should show exactly 4 earlier tasks");
    assert.ok(laterLines[0].includes("3 later tasks"), "Should show exactly 3 later tasks");
  });

  it("truncates verbose widget lines with a single-char ellipsis", () => {
    const longGoal = "a".repeat(200);
    const truncated = truncateForWidget(`Goal: ${longGoal}`, 32);
    assert.equal(truncated.length, 32);
    assert.ok(truncated.endsWith("\u2026"), "truncated string should end with an ellipsis character");
    const short = truncateForWidget("short", 32);
    assert.equal(short, "short");
  });

  it("appendPersistedLogEntry rotates the JSONL file when it exceeds the line cap", () => {
    const filePath = path.join(tempTestDir, "rotation-target.jsonl");
    try { fs.rmSync(filePath, { force: true }); } catch {}
    let state = { filePath, appendedLineCount: 0 };
    for (let i = 0; i < 12; i++) {
      const entry = normalizeCcReviewLogEntry({ message: `entry-${i}` }, { sequence: i });
      state = appendPersistedLogEntry(state, entry, { maxLines: 5, keepLines: 3 });
    }
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
    assert.ok(lines.length <= 5, `rotated file should respect bound, got ${lines.length}`);
    const first = JSON.parse(lines[0]);
    assert.equal(first.type, "cc_review_log_rotation", "first surviving line should be the rotation marker");
    assert.ok(typeof first.droppedLineCount === "number" && first.droppedLineCount > 0);
  });

  it("appendPersistedLogEntry creates the log directory when it does not exist", () => {
    const nestedDir = path.join(tempTestDir, "nested", "log", "dir");
    const filePath = path.join(nestedDir, "test.jsonl");
    assert.ok(!fs.existsSync(nestedDir), "precondition: nested directory should not exist");
    const state = appendPersistedLogEntry(
      { filePath, appendedLineCount: 0 },
      normalizeCcReviewLogEntry({ message: "hello from nested dir" }, { sequence: 1 })
    );
    assert.ok(fs.existsSync(filePath), "log file should be created in a non-existent directory");
    assert.equal(state.filePath, filePath);
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    assert.ok(JSON.parse(lines[0]).message.includes("hello from nested dir"));
  });

  it("provides a configured built-in worker and supports legacy generator profiles", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-empty-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    try {
      const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-empty-cwd-"));
      const settingsDir = path.join(tempHome, ".pi", "agent");
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({
        defaultProvider: "google",
        defaultModel: "gemini-3.5-flash",
        defaultThinkingLevel: "medium",
        subagents: {
          agentOverrides: {
            worker: {
              model: "volcengine-coding/glm-5.2",
              thinking: "high",
            },
          },
        },
      }));

      const agent = discoverAgent("worker", "both", isolatedCwd);
      assert.ok(agent, "worker should be discoverable via the built-in fallback");
      assert.equal(agent?.name, "worker");
      assert.equal(agent?.filePath, "<builtin>");
      assert.equal(agent?.model, "volcengine-coding/glm-5.2");
      assert.equal(agent?.thinking, "high");
      assert.ok(/built-in worker subagent/i.test(agent?.systemPrompt || ""));
      // An unknown agent should still return undefined when no file is present.
      assert.equal(discoverAgent("definitely-missing-agent", "both", isolatedCwd), undefined);
      // The exported builder produces the same lightweight prompt.
      const builtin = buildBuiltinWorkerAgent();
      assert.equal(builtin.name, "worker");
      assert.equal(builtin.filePath, "<builtin>");

      const legacyDir = path.join(isolatedCwd, ".pi", "agents");
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, "generator.md"), [
        "---",
        "name: generator",
        "description: legacy executor profile",
        "---",
        "Legacy generator prompt.",
      ].join("\n"));
      const legacy = discoverAgent("worker", "both", isolatedCwd);
      assert.equal(legacy?.name, "worker");
      assert.equal(legacy?.filePath, path.join(legacyDir, "generator.md"));
      assert.equal(legacy?.systemPrompt.trim(), "Legacy generator prompt.");
      assert.equal(legacy?.model, "volcengine-coding/glm-5.2");
      assert.equal(legacy?.thinking, "high");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it("falls back to the default pi model when the worker override is absent", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-default-model-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    try {
      const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-default-model-cwd-"));
      const settingsDir = path.join(tempHome, ".pi", "agent");
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({
        defaultProvider: "google",
        defaultModel: "gemini-3.5-flash",
        defaultThinkingLevel: "high",
        subagents: {
          agentOverrides: {},
        },
      }));

      const agent = discoverAgent("worker", "both", isolatedCwd);
      assert.ok(agent, "worker should still be discoverable via the built-in fallback");
      assert.equal(agent?.model, "google/gemini-3.5-flash");
      assert.equal(agent?.thinking, "high");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it("classifies cc-review summary badges from canonical headline phrases", () => {
    assert.equal(classifyCcReviewSummary("The overarching goal has been successfully accomplished!"), "success");
    assert.equal(classifyCcReviewSummary("The workflow finished, but one or more task subprocesses reported warnings."), "warning");
    assert.equal(classifyCcReviewSummary("The workflow terminated early due to an unrecoverable task execution or validation failure."), "failed");
    assert.equal(classifyCcReviewSummary("The workflow was cancelled or timed out before completion."), "cancelled");
  });

  it("filters compact widget and onUpdate surfaces by logLevel while persisting the full JSONL log", async () => {
    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];
    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };
    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    const widgetSnapshots: string[][] = [];
    const updates: any[] = [];
    const captureCtx = {
      cwd: tempTestDir,
      ui: {
        setWidget: (_id: string, content: Parameters<typeof captureWidgetLines>[0]) => {
          const lines = captureWidgetLines(content);
          if (lines) widgetSnapshots.push(lines);
        },
      },
    };

    await registeredTool.execute(
      "tool-call-log-level-warning",
      { goal: "Log level filter goal", logLevel: "warning" },
      undefined,
      (partial) => updates.push(partial),
      captureCtx
    );

    const logPath = path.join(tempTestDir, "workflow-logs.jsonl");
    const persistedLines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    const persistedEntries = persistedLines.map((line) => JSON.parse(line));
    assert.ok(
      persistedEntries.some((entry) => entry.severity === "info"),
      "persisted workflow-logs.jsonl should still record info-level entries"
    );

    const widgetText = widgetSnapshots.map((snap) => snap.join("\n")).join("\n");
    assert.doesNotMatch(widgetText, /ℹ INFO/, "widget live-log slice should omit info lines when logLevel=warning");

    const updateTexts = updates
      .map((u) => u?.content?.[0]?.text ?? "")
      .filter((t) => typeof t === "string" && t.length > 0);
    const infoDeltas = updateTexts.filter((text) => /ℹ INFO/.test(text));
    assert.equal(infoDeltas.length, 0, "onUpdate deltas should omit info lines when logLevel=warning");
  });

  it("falls back to info for invalid logLevel and emits exactly one warning entry", async () => {
    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];
    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };
    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    const result = await registeredTool.execute(
      "tool-call-invalid-log-level",
      { goal: "Invalid log level goal", logLevel: "loud" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    const logPath = path.join(tempTestDir, "workflow-logs.jsonl");
    const persistedEntries = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const invalidWarnings = persistedEntries.filter(
      (entry) =>
        entry.severity === "warning" &&
        /Ignoring invalid log level/.test(entry.message) &&
        /loud/.test(entry.message)
    );
    assert.equal(invalidWarnings.length, 1, "invalid logLevel should produce exactly one warning entry");
  });

  it("uses CC_REVIEW_LOG_LEVEL as the env fallback for compact-surface filtering", async () => {
    process.env.CC_REVIEW_LOG_LEVEL = "error";
    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];
    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
          } else {
            mockProc.stdout.emit(
              "data",
              Buffer.from(
                `${JSON.stringify({
                  verdict: "ship",
                  summary: "Looks good",
                  findings: [],
                })}\n`
              )
            );
            mockProc.stderr.emit("data", Buffer.from("fatal: review subprocess error\n"));
          }
          mockProc.emit("close", args.includes("-o") ? 0 : 1, null);
        });
        return mockProc;
      }
      return null;
    };
    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    const updates: any[] = [];
    await registeredTool.execute(
      "tool-call-env-log-level",
      { goal: "Env log level goal" },
      undefined,
      (partial) => updates.push(partial),
      { cwd: tempTestDir }
    );

    const updateTexts = updates
      .map((u) => u?.content?.[0]?.text ?? "")
      .filter((t) => typeof t === "string" && t.length > 0);
    assert.ok(
      updateTexts.some((text) => /✖ ERROR/.test(text)),
      "error deltas should still appear when CC_REVIEW_LOG_LEVEL=error"
    );
    assert.equal(
      updateTexts.filter((text) => /ℹ INFO|⚠ WARN/.test(text)).length,
      0,
      "info/warning deltas should be filtered when CC_REVIEW_LOG_LEVEL=error"
    );
  });

  // -------------------------------------------------------------------------
  // Self-repair task-execution retry loop (maxTaskExecutionRetries)
  //
  // These tests bound the per-task subagent dispatch loop and verify that
  // a failing dispatch's stderr/error text is fed back into the next
  // attempt's prompt for self-repair.
  // -------------------------------------------------------------------------
  describe("task execution self-repair retry loop (maxTaskExecutionRetries)", () => {
    const SINGLE_TASK_PLAN = [
      { title: "Self-repair task", description: "Build feature X", acceptanceCriteria: "X passes" },
    ];

    function installCodexPlannerAndReviewerHandler() {
      mockSpawnHandler = (command, args) => {
        if (command !== "codex") return null;
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (isCodexPlannerArgs(args)) {
            const oIndex = args.indexOf("-o");
            const outputPath = args[oIndex + 1];
            fs.writeFileSync(outputPath, JSON.stringify({ tasks: SINGLE_TASK_PLAN }), "utf8");
            mockProc.emit("close", 0, null);
          } else {
            // Reviewer: emit a ship verdict so a successful subagent path
            // results in a completed task. (Failed subagent tasks halt the
            // workflow before reviewer is invoked.)
            emitMockReviewStdout(mockProc);
            mockProc.emit("close", 0, null);
          }
        });
        return mockProc;
      };
    }

    it("(c) dispatches exactly once when the first attempt succeeds", async () => {
      installCodexPlannerAndReviewerHandler();
      const dispatchedPrompts: string[] = [];
      mockSubagentHandler = async (_toolName, params) => {
        dispatchedPrompts.push(String(params.task));
        return {
          content: [{ type: "text", text: "All acceptance criteria verified on first try." }],
          details: { results: [{ exitCode: 0 }] },
        };
      };

      const result = await registeredTool.execute(
        "tool-call-self-repair-first-try",
        { goal: "Self-repair happy path" },
        undefined,
        undefined,
        { cwd: tempTestDir }
      );

      assert.equal(result.isError, undefined);
      assert.equal(result.details.status, "completed");
      assert.equal(dispatchedPrompts.length, 1, "first-try success must not retry");
      // The single dispatch must NOT contain self-repair feedback markers.
      assert.equal(
        /Previous attempt feedback/i.test(dispatchedPrompts[0]),
        false,
        "no failure-feedback should appear on the first dispatch"
      );
    });

    it("(a) re-dispatches once with the prior attempt's failure text on a single recoverable failure", async () => {
      installCodexPlannerAndReviewerHandler();
      const FAIL_STDERR =
        "E_TYPECHECK: TS2304 Cannot find name 'frobnicate' at src/foo.ts:42";
      const dispatchedPrompts: string[] = [];
      mockSubagentHandler = async (_toolName, params) => {
        dispatchedPrompts.push(String(params.task));
        if (dispatchedPrompts.length === 1) {
          return {
            content: [{ type: "text", text: FAIL_STDERR }],
            details: { results: [{ exitCode: 1, errorMessage: FAIL_STDERR, stderr: FAIL_STDERR }] },
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: "Fixed the typecheck and verified." }],
          details: { results: [{ exitCode: 0 }] },
        };
      };

      const result = await registeredTool.execute(
        "tool-call-self-repair-recover",
        { goal: "Fail once then recover" },
        undefined,
        undefined,
        { cwd: tempTestDir }
      );

      assert.equal(result.isError, undefined);
      assert.equal(result.details.status, "completed");
      assert.equal(
        dispatchedPrompts.length,
        2,
        "second attempt should succeed; loop must not dispatch a third time"
      );
      // Self-repair: the second prompt must contain feedback marker AND the
      // first attempt's failure text so the subagent can repair itself.
      assert.match(dispatchedPrompts[1], /Previous attempt feedback/);
      assert.ok(
        dispatchedPrompts[1].includes(FAIL_STDERR),
        `second dispatch must carry the prior failure text; got: ${dispatchedPrompts[1].slice(0, 400)}`
      );
      // The first dispatch must be free of self-repair feedback.
      assert.equal(/Previous attempt feedback/.test(dispatchedPrompts[0]), false);
      assert.equal(dispatchedPrompts[0].includes(FAIL_STDERR), false);
    });

    it("(b) stops after exactly maxTaskExecutionRetries+1 dispatches when every attempt fails", async () => {
      installCodexPlannerAndReviewerHandler();
      const dispatchedPrompts: string[] = [];
      mockSubagentHandler = async (_toolName, params) => {
        dispatchedPrompts.push(String(params.task));
        return {
          content: [{ type: "text", text: "Persistent failure" }],
          details: { results: [{ exitCode: 1, errorMessage: "Persistent failure" }] },
          isError: true,
        };
      };

      const result = await registeredTool.execute(
        "tool-call-self-repair-exhaust",
        { goal: "Always fails" },
        undefined,
        undefined,
        { cwd: tempTestDir }
      );

      assert.equal(result.isError, true);
      // Per spec: total dispatches == maxTaskExecutionRetries + 1.
      // With the default maxTaskExecutionRetries=2 → 3 dispatches.
      assert.equal(
        dispatchedPrompts.length,
        3,
        `expected exactly maxTaskExecutionRetries+1 (=3) dispatches, got ${dispatchedPrompts.length}`
      );
      // Each retry beyond the first must carry self-repair feedback from
      // the prior attempt.
      assert.equal(/Previous attempt feedback/.test(dispatchedPrompts[0]), false);
      assert.match(dispatchedPrompts[1], /Previous attempt feedback/);
      assert.match(dispatchedPrompts[2], /Previous attempt feedback/);
    });
  });

  it("P1-1: reviewer block triggers a bounded repair loop instead of aborting the workflow", async () => {
    const mockTasks = [
      { title: "Repair task", description: "Implement feature", acceptanceCriteria: "Feature works" }
    ];

    let reviewCallCount = 0;
    const REVIEW_BLOCK_OUTPUT = `Review found issues\n${JSON.stringify({
      verdict: "block",
      summary: "Critical bug found in implementation",
      findings: [{ priority: "P0", confidence: 0.9, message: "null pointer dereference", status: "unfixed" }],
    })}`;

    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        mockProc.autoReviewStdout = false;
        process.nextTick(() => {
          if (args.includes("--output-schema")) {
            const oIndex = args.indexOf("-o");
            fs.writeFileSync(args[oIndex + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
            mockProc.emit("close", 0, null);
          } else {
            reviewCallCount++;
            if (reviewCallCount === 1) {
              mockProc.stdout.emit("data", Buffer.from(REVIEW_BLOCK_OUTPUT));
            } else {
              mockProc.stdout.emit("data", Buffer.from(REVIEW_SHIP_OUTPUT));
            }
            mockProc.emit("close", 0, null);
          }
        });
        return mockProc;
      }
      return null;
    };

    let subagentCallCount = 0;
    mockSubagentHandler = async () => {
      subagentCallCount++;
      return {
        content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
        details: { results: [{ exitCode: 0 }] }
      };
    };

    const result = await registeredTool.execute(
      "tool-call-repair-loop",
      { goal: "Repair loop goal", reviewMode: "per-task", reviewRepairRounds: 2 },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined, "workflow should complete successfully after repair");
    assert.equal(result.details.status, "completed");
    assert.ok(subagentCallCount >= 2, `expected ≥2 subagent calls (initial + repair), got ${subagentCallCount}`);
    assert.equal(reviewCallCount, 2, `expected 2 review calls (block + ship), got ${reviewCallCount}`);
  });

  it("P1-1: reviewer block exhausts repair rounds and hard-fails", async () => {
    const mockTasks = [
      { title: "Unfixable task", description: "Implement feature", acceptanceCriteria: "Feature works" }
    ];

    let reviewCallCount = 0;
    const REVIEW_BLOCK_OUTPUT = `Review found issues\n${JSON.stringify({
      verdict: "block",
      summary: "Critical bug persists",
      findings: [{ priority: "P0", confidence: 0.9, message: "fatal error", status: "unfixed" }],
    })}`;

    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        mockProc.autoReviewStdout = false;
        process.nextTick(() => {
          if (args.includes("--output-schema")) {
            const oIndex = args.indexOf("-o");
            fs.writeFileSync(args[oIndex + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
            mockProc.emit("close", 0, null);
          } else {
            reviewCallCount++;
            mockProc.stdout.emit("data", Buffer.from(REVIEW_BLOCK_OUTPUT));
            mockProc.emit("close", 0, null);
          }
        });
        return mockProc;
      }
      return null;
    };

    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    const result = await registeredTool.execute(
      "tool-call-repair-exhaust",
      { goal: "Exhaust repair goal", reviewMode: "per-task", reviewRepairRounds: 2 },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /blocked by reviewer/i);
    assert.match(result.details.error, /repair round/);
    assert.equal(reviewCallCount, 3, `expected 3 review calls (1 + 2 repair), got ${reviewCallCount}`);
    assert.equal(result.details.status, "failed");
    assert.ok(result.details.meta);
    // Only the terminal (final-block) result is recorded as a durable task
    // result — intermediate blocked rounds are no longer appended (I1).
    assert.deepEqual(result.details.meta.taskOutcomes, {
      review_blocked: 1,
      failed: 0,
      warning: 0,
      completed: 0,
      cancelled: 0,
    });
    assert.equal(result.details.meta.topBlockers.length, 1);
    assert.equal(result.details.meta.topBlockers[0].message, "fatal error");
  });

  it("P2-1: persisted log is not truncated between runs (history preserved)", async () => {
    const mockTasks = [
      { title: "Log task", description: "Implement feature", acceptanceCriteria: "Feature works" }
    ];

    const makeSpawnHandler = () => (command: string, args: string[]) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("--output-schema")) {
            const oIndex = args.indexOf("-o");
            fs.writeFileSync(args[oIndex + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };

    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    mockSpawnHandler = makeSpawnHandler();
    await registeredTool.execute(
      "tool-call-log-run-1",
      { goal: "First run goal" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    const logPath = path.join(tempTestDir, "workflow-logs.jsonl");
    const linesAfterFirst = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    assert.ok(linesAfterFirst.length > 0, "log should have entries after first run");

    mockSpawnHandler = makeSpawnHandler();
    await registeredTool.execute(
      "tool-call-log-run-2",
      { goal: "Second run goal" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    const linesAfterSecond = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    assert.ok(
      linesAfterSecond.length > linesAfterFirst.length,
      `log should grow across runs (was ${linesAfterFirst.length}, now ${linesAfterSecond.length})`
    );
    const allEntries = linesAfterSecond.map((line) => JSON.parse(line));
    const boundaryEntries = allEntries.filter((e: any) => /Workflow run .* started/.test(e.message ?? ""));
    assert.ok(boundaryEntries.length >= 2, "should have ≥2 run-boundary entries");
  });

  it("regression test: continuous twice execution does not overwrite previous execution log", async () => {
    delete process.env.CC_REVIEW_LOG_FILE;

    const mockTasks = [
      { title: "Unique log task", description: "Implement feature", acceptanceCriteria: "Feature works" }
    ];

    const makeSpawnHandler = () => (command: string, args: string[]) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("--output-schema")) {
            const oIndex = args.indexOf("-o");
            fs.writeFileSync(args[oIndex + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };

    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    // Run 1
    mockSpawnHandler = makeSpawnHandler();
    const result1 = await registeredTool.execute(
      "tool-call-log-run-unique-1",
      { goal: "First run goal" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    // Find the log file written by run 1 (default: .cc-review/logs/<runId>/workflow-logs.jsonl)
    const listRunLogFiles = () => {
      const logsRoot = path.join(tempTestDir, ".cc-review", "logs");
      if (!fs.existsSync(logsRoot)) return [];
      return fs.readdirSync(logsRoot)
        .map((runId) => path.join(logsRoot, runId, "workflow-logs.jsonl"))
        .filter((p) => fs.existsSync(p));
    };
    const filesAfterFirst = listRunLogFiles();
    assert.equal(filesAfterFirst.length, 1, "There should be exactly one unique log file after first run");
    const firstLogPath = filesAfterFirst[0];
    const firstLogContent = fs.readFileSync(firstLogPath, "utf8");
    assert.match(firstLogContent, /=== Workflow run .* started/);

    // Run 2
    mockSpawnHandler = makeSpawnHandler();
    const result2 = await registeredTool.execute(
      "tool-call-log-run-unique-2",
      { goal: "Second run goal" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    // Find all log files after second run
    const filesAfterSecond = listRunLogFiles();
    assert.equal(filesAfterSecond.length, 2, "There should be exactly two unique log files after second run");

    // Identify first and second log files
    const secondLogPath = filesAfterSecond.find((p) => p !== firstLogPath);
    assert.ok(secondLogPath, "Should find the second log file");

    assert.notEqual(firstLogPath, secondLogPath, "Consecutive runs should generate different log file paths");

    // Verify first log contents are preserved and that the two files are distinct.
    const firstLogContentAfterSecondRun = fs.readFileSync(firstLogPath, "utf8");
    assert.equal(firstLogContentAfterSecondRun, firstLogContent, "First log content should be preserved intact after second run");

    // Verify second log contents are written to a new file and not identical to the first.
    const secondLogContent = fs.readFileSync(secondLogPath, "utf8");
    assert.notEqual(secondLogContent, firstLogContent, "Second run should write to a separate log file with its own content");
    assert.match(secondLogContent, /=== Workflow run .* started/);
  });

  it("explicit tool logFile parameter uses a fixed path and appends across runs", async () => {
    const mockTasks = [{ title: "Fixed log task", description: "Implement feature", acceptanceCriteria: "Feature works" }];

    const makeSpawnHandler = () => (command: string, args: string[]) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("--output-schema")) {
            const oIndex = args.indexOf("-o");
            fs.writeFileSync(args[oIndex + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };

    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task." }],
      details: { results: [{ exitCode: 0 }] },
    });

    mockSpawnHandler = makeSpawnHandler();
    const result1 = await registeredTool.execute(
      "tool-call-log-file-1",
      { goal: "First fixed log run", logFile: "custom-logs.jsonl" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    const fixedLogPath = path.join(tempTestDir, "custom-logs.jsonl");
    assert.ok(fs.existsSync(fixedLogPath), "fixed log file should be created");
    assert.ok(result1.content[0].text.includes(fixedLogPath), "summary should surface the fixed log path");
    const firstContent = fs.readFileSync(fixedLogPath, "utf8");
    assert.match(firstContent, /=== Workflow run .* started/);

    mockSpawnHandler = makeSpawnHandler();
    const result2 = await registeredTool.execute(
      "tool-call-log-file-2",
      { goal: "Second fixed log run", logFile: "custom-logs.jsonl" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    const secondContent = fs.readFileSync(fixedLogPath, "utf8");
    assert.ok(secondContent.length > firstContent.length, "fixed log file should append across runs");
    const boundaries = secondContent.trim().split("\n").filter((line) => /=== Workflow run .* started/.test(line));
    assert.equal(boundaries.length, 2, "fixed log should contain two run-boundary entries");
    assert.ok(result2.content[0].text.includes(fixedLogPath), "second summary should also surface the fixed log path");
  });

  it("slash command --log-file forwards a fixed log path and appends across runs", async () => {
    const mockTasks = [{ title: "Slash log task", description: "Implement feature", acceptanceCriteria: "Feature works" }];

    const makeSpawnHandler = () => (command: string, args: string[]) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("--output-schema")) {
            const oIndex = args.indexOf("-o");
            fs.writeFileSync(args[oIndex + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };

    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task." }],
      details: { results: [{ exitCode: 0 }] },
    });

    const slashLogPath = path.join(tempTestDir, "slash-logs.jsonl");
    const notifications: Array<{ message: string; level: string }> = [];

    mockSpawnHandler = makeSpawnHandler();
    await registeredCommand.handler(`Run slash fixed log --log-file ${slashLogPath}`, {
      cwd: tempTestDir,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    });

    assert.ok(fs.existsSync(slashLogPath), "slash command fixed log file should be created");
    const firstContent = fs.readFileSync(slashLogPath, "utf8");
    assert.match(firstContent, /=== Workflow run .* started/);

    mockSpawnHandler = makeSpawnHandler();
    await registeredCommand.handler(`Run slash fixed log again --log-file ${slashLogPath}`, {
      cwd: tempTestDir,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    });

    const secondContent = fs.readFileSync(slashLogPath, "utf8");
    assert.ok(secondContent.length > firstContent.length, "slash command fixed log should append across runs");
    const boundaries = secondContent.trim().split("\n").filter((line) => /=== Workflow run .* started/.test(line));
    assert.equal(boundaries.length, 2, "slash command fixed log should contain two run-boundary entries");
  });

  it("failed workflow execution attaches structured metadata details", async () => {
    // 1) verification plan load failure
    const validationConfigPath = path.join(tempTestDir, ".cc-review-validation.json");
    fs.writeFileSync(validationConfigPath, "{ malformed", "utf8");
    const badPlanResult = await registeredTool.execute(
      "tool-call-bad-plan",
      { goal: "Goal with bad verification plan" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );
    assert.equal(badPlanResult.isError, true);
    assert.equal(badPlanResult.details.status, "failed");
    assert.ok(badPlanResult.details.error);
    assert.ok(badPlanResult.details.meta);
    assert.deepEqual(badPlanResult.details.meta.taskOutcomes, {
      review_blocked: 0,
      completed: 0,
      failed: 0,
      warning: 0,
      cancelled: 0,
    });

    // 2) unexpected errors are wrapped and carry accumulated metadata
    fs.rmSync(validationConfigPath, { force: true });
    mockSpawnHandler = (command, args) => {
      throw new Error("Unexpected crash during planning");
    };

    const crashResult = await registeredTool.execute(
      "tool-call-unexpected-crash",
      { goal: "Always crashes" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );
    assert.equal(crashResult.isError, true);
    assert.equal(crashResult.details.status, "failed");
    assert.match(crashResult.details.error, /Unexpected crash during planning/);
    assert.ok(crashResult.details.meta);
    assert.deepEqual(crashResult.details.meta.taskOutcomes, {
      review_blocked: 0,
      completed: 0,
      failed: 0,
      warning: 0,
      cancelled: 0,
    });
  });

  it("transitions state and phase to failed on unrecoverable errors", async () => {
    const uiThemeMock = {
      fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    };
    const capture = createWidgetCaptureUi({ theme: uiThemeMock });

    // 1) verification plan load failure
    fs.writeFileSync(path.join(tempTestDir, ".cc-review-validation.json"), "{ malformed", "utf8");
    await registeredTool.execute(
      "tool-call-bad-plan-capture",
      { goal: "Goal with bad verification plan" },
      undefined,
      undefined,
      { cwd: tempTestDir, ui: capture.ui },
    );

    // Verify that the status bar was updated with error-colored failed status text
    const failedStatus = capture.statusSnapshots.find((s) => s.includes("[error]") && s.includes("Failed"));
    assert.ok(failedStatus, "Should find error-colored failed status");
    assert.match(failedStatus, /\[error\]\[CC Review\] Failed/);

    // Verify that the compact widget header reflects the failed state
    const hasFailedHeader = capture.widgetSnapshots.some((lines) =>
      lines.some((line) => /● CC Review.*Failed/.test(line))
    );
    assert.ok(hasFailedHeader, "Should find failed state in compact widget header");
    assert.equal(capture.widgetCleared(), true, "Failed workflow should clear its widget");
    assert.equal(capture.statusCleared(), true, "Failed workflow should clear its status");
  });

  describe("subagent model capture", () => {
    it("captures model information from configuration and runtime events", async () => {
      const mockTasks = [
        { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
      ];

      const originalHome = process.env.HOME;
      const originalUserProfile = process.env.USERPROFILE;
      process.env.HOME = tempTestDir;
      process.env.USERPROFILE = tempTestDir;

      // Temporary agent markdown structure for worker in virtual project directory
      const customAgentDir = path.join(tempTestDir, ".pi", "agents");
      fs.mkdirSync(customAgentDir, { recursive: true });
      fs.writeFileSync(
        path.join(customAgentDir, "worker.md"),
        `---
name: worker
model: configured-worker-model
---
System prompt override`
      );

      let capturedSubagentArgs: string[] = [];
      mockSpawnHandler = (command, args) => {
        if (command === "codex") {
          const mockProc = new MockChildProcess();
          process.nextTick(() => {
            if (args.includes("-o")) {
              fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
            } else {
              mockProc.stdout.emit("data", Buffer.from(REVIEW_SHIP_OUTPUT));
            }
            mockProc.emit("close", 0, null);
          });
          return mockProc;
        }

        // Catch the spawn of pi subagent worker
        const isNodeOrBun = /^(node|bun)(\.exe)?$/.test(path.basename(command).toLowerCase());
        const isPiLaunch = isNodeOrBun && args.some(a => a.includes("pi"));
        if (command === "pi" || isPiLaunch) {
          capturedSubagentArgs = args;
          const mockProc = new MockChildProcess();
          process.nextTick(() => {
            // Emit JSON events reporting actual model
            const event1 = { type: "model_select", model: { provider: "anthropic", id: "claude-3-5-sonnet-actual" } };
            const event2 = { type: "message_start", message: { role: "assistant", content: [], model: "claude-3-5-sonnet-actual", provider: "anthropic" } };
            const event3 = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Task completed successfully." }], model: "claude-3-5-sonnet-actual", provider: "anthropic" } };

            mockProc.stdout.emit("data", Buffer.from(JSON.stringify(event1) + "\n"));
            mockProc.stdout.emit("data", Buffer.from(JSON.stringify(event2) + "\n"));
            mockProc.stdout.emit("data", Buffer.from(JSON.stringify(event3) + "\n"));
            mockProc.emit("close", 0, null);
          });
          return mockProc;
        }
        return null;
      };

      const originalToolManager = piMock.toolManager;
      delete piMock.toolManager;

      try {
        const result = await registeredTool.execute(
          "cc-review-test-model-capture",
          { goal: "Verify model capture" },
          undefined,
          undefined,
          { cwd: tempTestDir }
        );

        assert.strictEqual(result.details.status, "completed");
        assert.ok(capturedSubagentArgs.includes("configured-worker-model"), "Should run subprocess with the configured model");

        // Verify model is rendered in the final summary report
        const summaryText = result?.content?.[0]?.text || getSummaryText(sentMessages);
        console.log("summaryText:", summaryText);
        assert.ok(
          summaryText.includes("Model:* `anthropic/claude-3-5-sonnet-actual`"),
          "Summary report should list the actual used subagent model"
        );

        // Verify workflow trace includes model name at start and end
        const tracePath = findWorkflowTracePath(tempTestDir);
        const traceLines = fs.readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

        const assignmentEvent = traceLines.find(
          (entry) => entry.event === "subagent_assignment" && entry.role === "executor"
        );
        assert.ok(assignmentEvent, "Should emit subagent_assignment event for executor");
        assert.strictEqual(assignmentEvent.model, "configured-worker-model", "Assignment event should include the configured worker model at launch time");

        const startEvent = traceLines.find(
          (entry) => entry.event === "tool_execution_start" && entry.toolName === "subagent"
        );
        assert.ok(startEvent, "Should emit tool_execution_start event for subagent");
        assert.strictEqual(startEvent.model, "configured-worker-model", "Start event should include the resolved/configured worker model");

        const endEvent = traceLines.find(
          (entry) => entry.event === "tool_execution_end" && entry.toolName === "subagent"
        );
        assert.ok(endEvent, "Should emit tool_execution_end event for subagent");
        assert.strictEqual(endEvent.model, "anthropic/claude-3-5-sonnet-actual", "End event should include the actual streamed model");

        // Extract task artifact path from summary text
        const artifactMatch = summaryText.match(/\*Artifact:\*\s*`([^`]+)`/);
        assert.ok(artifactMatch, "Should find artifact path in summary text");
        const artifactPath = artifactMatch[1];
        assert.ok(artifactPath && fs.existsSync(artifactPath), "Artifact path should exist");

        // Verify task artifact contains execution.model name
        const artifactData = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
        assert.strictEqual(artifactData.execution.model, "anthropic/claude-3-5-sonnet-actual", "Artifact should contain the actual streamed model name");
      } finally {
        piMock.toolManager = originalToolManager;
        process.env.HOME = originalHome;
        process.env.USERPROFILE = originalUserProfile;
      }
    });

    it("falls back gracefully and keeps missing model metadata non-fatal", async () => {
      const mockTasks = [
        { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
      ];

      const originalHome = process.env.HOME;
      const originalUserProfile = process.env.USERPROFILE;
      process.env.HOME = tempTestDir;
      process.env.USERPROFILE = tempTestDir;

      mockSpawnHandler = (command, args) => {
        if (command === "codex") {
          const mockProc = new MockChildProcess();
          process.nextTick(() => {
            if (args.includes("-o")) {
              fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
            } else {
              mockProc.stdout.emit("data", Buffer.from(REVIEW_SHIP_OUTPUT));
            }
            mockProc.emit("close", 0, null);
          });
          return mockProc;
        }

        const isNodeOrBun = /^(node|bun)(\.exe)?$/.test(path.basename(command).toLowerCase());
        const isPiLaunch = isNodeOrBun && args.some(a => a.includes("pi"));
        if (command === "pi" || isPiLaunch) {
          const mockProc = new MockChildProcess();
          process.nextTick(() => {
            // Emits standard non-metadata events
            const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done without model info." }] } };
            mockProc.stdout.emit("data", Buffer.from(JSON.stringify(event) + "\n"));
            mockProc.emit("close", 0, null);
          });
          return mockProc;
        }
        return null;
      };

      const originalToolManager = piMock.toolManager;
      delete piMock.toolManager;

      try {
        const result = await registeredTool.execute(
          "cc-review-test-no-model",
          { goal: "Verify missing model gracefully" },
          undefined,
          undefined,
          { cwd: tempTestDir }
        );

        assert.strictEqual(result.details.status, "completed", "Should execute successfully even without model metadata");
        const summaryText = result?.content?.[0]?.text || getSummaryText(sentMessages);
        assert.ok(!summaryText.includes("Model"), "Summary report should not list model if none was captured");
      } finally {
        piMock.toolManager = originalToolManager;
        process.env.HOME = originalHome;
        process.env.USERPROFILE = originalUserProfile;
      }
    });
  });

  it("demonstrates concurrent subagent execution and result order preservation", async () => {
    const mockTasks = [
      { title: "Parallel Task 1", description: "First job", acceptanceCriteria: "A is verified", dependsOn: [] },
      { title: "Parallel Task 2", description: "Second job", acceptanceCriteria: "B is verified", dependsOn: [] }
    ];

    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            const oIndex = args.indexOf("-o");
            const outputPath = args[oIndex + 1];
            fs.writeFileSync(outputPath, JSON.stringify({ tasks: mockTasks }), "utf8");
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };

    const activeCalls: number[] = [];
    let maxConcurrencyObserved = 0;

    mockSubagentHandler = async (toolName, params) => {
      activeCalls.push(1);
      maxConcurrencyObserved = Math.max(maxConcurrencyObserved, activeCalls.length);

      // Controlled delay to simulate work and allow the other task to start concurrently
      await new Promise((resolve) => setTimeout(resolve, 50));

      activeCalls.pop();
      return {
        content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
        details: { results: [{ exitCode: 0, model: "test-parallel-model" }] }
      };
    };

    const result = await registeredTool.execute(
      "tool-call-parallel",
      { goal: "Test parallel run", concurrencyLimit: 2, reviewMode: "after-all" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    assert.equal(maxConcurrencyObserved, 2, "Both tasks should run concurrently");

    const reportText = result.content[0].text;
    assert.match(reportText, /Parallel Task 1/);
    assert.match(reportText, /Parallel Task 2/);
  });


  describe("worker automatic concurrency policy in end-to-end execution", () => {
    const setupParallelMockTasks = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        title: `Auto Parallel Task ${i + 1}`,
        description: `Job ${i + 1}`,
        acceptanceCriteria: `Criterion ${i + 1} is verified`,
        dependsOn: [] as number[],
      }));

    const runAutoConcurrencyScenario = async (options: {
      cpuCount: number;
      taskCount: number;
      explicitConcurrencyLimit?: number;
    }) => {
      const mockTasks = setupParallelMockTasks(options.taskCount);
      const previousCpuCount = process.env.CC_REVIEW_CPU_COUNT;
      process.env.CC_REVIEW_CPU_COUNT = String(options.cpuCount);

      try {
        mockSpawnHandler = (command, args) => {
          if (command === "codex") {
            const mockProc = new MockChildProcess();
            process.nextTick(() => {
              if (args.includes("-o")) {
                const outputPath = args[args.indexOf("-o") + 1];
                fs.writeFileSync(outputPath, JSON.stringify({ tasks: mockTasks }), "utf8");
              }
              mockProc.emit("close", 0, null);
            });
            return mockProc;
          }
          return null;
        };

        const activeCalls: number[] = [];
        let maxConcurrencyObserved = 0;

        mockSubagentHandler = async () => {
          activeCalls.push(1);
          maxConcurrencyObserved = Math.max(maxConcurrencyObserved, activeCalls.length);
          await new Promise((resolve) => setTimeout(resolve, 50));
          activeCalls.pop();
          return {
            content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
            details: { results: [{ exitCode: 0, model: "test-parallel-model" }] },
          };
        };

        const params: any = {
          goal: "Test automatic concurrency",
          reviewMode: "after-all",
        };
        if (options.explicitConcurrencyLimit !== undefined) {
          params.concurrencyLimit = options.explicitConcurrencyLimit;
        }

        const result = await registeredTool.execute(
          "tool-call-auto-concurrency",
          params,
          undefined,
          undefined,
          { cwd: tempTestDir }
        );

        return { result, maxConcurrencyObserved };
      } finally {
        if (previousCpuCount === undefined) {
          delete process.env.CC_REVIEW_CPU_COUNT;
        } else {
          process.env.CC_REVIEW_CPU_COUNT = previousCpuCount;
        }
      }
    };

    it("uses the automatic CPU-based concurrency when no limit is configured", async () => {
      const { result, maxConcurrencyObserved } = await runAutoConcurrencyScenario({
        cpuCount: 4,
        taskCount: 6,
      });
      assert.equal(result.isError, undefined);
      assert.equal(result.details.meta.concurrency, 4, "meta should report the automatic concurrency");
      assert.match(result.content[0].text, /- \*Worker concurrency:\* 4/);
      assert.equal(maxConcurrencyObserved, 4, "automatic concurrency should cap the observed parallelism");
    });

    it("honors an explicit concurrencyLimit over the automatic CPU-based value", async () => {
      const { result, maxConcurrencyObserved } = await runAutoConcurrencyScenario({
        cpuCount: 16,
        taskCount: 4,
        explicitConcurrencyLimit: 2,
      });
      assert.equal(result.isError, undefined);
      assert.equal(result.details.meta.concurrency, 2, "meta should report the explicit limit");
      assert.match(result.content[0].text, /- \*Worker concurrency:\* 2/);
      assert.equal(maxConcurrencyObserved, 2, "explicit limit should cap concurrent execution");
    });

    it("clamps automatic concurrency to the lower boundary of 1", async () => {
      const { result, maxConcurrencyObserved } = await runAutoConcurrencyScenario({
        cpuCount: 0,
        taskCount: 2,
      });
      assert.equal(result.isError, undefined);
      assert.equal(result.details.meta.concurrency, 1, "meta should report the lower-bound concurrency");
      assert.match(result.content[0].text, /- \*Worker concurrency:\* 1/);
      assert.equal(maxConcurrencyObserved, 1, "zero CPUs must still execute at least one task at a time");
    });

    it("clamps automatic concurrency to the upper boundary of 8", async () => {
      const { result, maxConcurrencyObserved } = await runAutoConcurrencyScenario({
        cpuCount: 16,
        taskCount: 8,
      });
      assert.equal(result.isError, undefined);
      assert.equal(result.details.meta.concurrency, 8, "meta should report the upper-bound concurrency");
      assert.match(result.content[0].text, /- \*Worker concurrency:\* 8/);
      assert.equal(maxConcurrencyObserved, 8, "high CPU counts should be capped at the maximum concurrency");
    });

    it("caps automatic concurrency to the planned task count after planning", async () => {
      const { result, maxConcurrencyObserved } = await runAutoConcurrencyScenario({
        cpuCount: 16,
        taskCount: 3,
      });
      assert.equal(result.isError, undefined);
      assert.equal(result.details.meta.concurrency, 3, "meta should report task-count-capped concurrency");
      assert.match(result.content[0].text, /- \*Worker concurrency:\* 3/);
      assert.equal(
        maxConcurrencyObserved,
        3,
        "automatic concurrency should not exceed the number of planned tasks"
      );
    });

    it("honors CC_REVIEW_CONCURRENCY over the automatic CPU-based value", async () => {
      const previousConcurrency = process.env.CC_REVIEW_CONCURRENCY;
      process.env.CC_REVIEW_CONCURRENCY = "2";
      try {
        const { result, maxConcurrencyObserved } = await runAutoConcurrencyScenario({
          cpuCount: 16,
          taskCount: 6,
        });
        assert.equal(result.isError, undefined);
        assert.equal(result.details.meta.concurrency, 2, "meta should report the env override");
        assert.match(result.content[0].text, /- \*Worker concurrency:\* 2/);
        assert.equal(maxConcurrencyObserved, 2, "CC_REVIEW_CONCURRENCY should cap concurrent execution");
      } finally {
        if (previousConcurrency === undefined) {
          delete process.env.CC_REVIEW_CONCURRENCY;
        } else {
          process.env.CC_REVIEW_CONCURRENCY = previousConcurrency;
        }
      }
    });
  });

  it("verifies parallel-safe subagent logs and status updates with stable run/subagent IDs", async () => {
    const mockTasks = [
      { title: "Parallel Task 1", description: "First job", acceptanceCriteria: "A is verified", dependsOn: [] },
      { title: "Parallel Task 2", description: "Second job", acceptanceCriteria: "B is verified", dependsOn: [] }
    ];

    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            const oIndex = args.indexOf("-o");
            const outputPath = args[oIndex + 1];
            fs.writeFileSync(outputPath, JSON.stringify({ tasks: mockTasks }), "utf8");
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };

    const emittedEvents: any[] = [];
    const customOnUpdate = (update: any) => {
      emittedEvents.push(update);
    };

    mockSubagentHandler = async (toolName, params, signal, onUpdate) => {
      if (params.task.includes("Parallel Task 1")) {
        // Emit interleaved stream chunks
        onUpdate({ content: [{ type: "text", text: "Task 1 chunk A" }] });
        await new Promise((resolve) => setTimeout(resolve, 20));
        onUpdate({ content: [{ type: "text", text: "Task 1 chunk B" }] });
      } else if (params.task.includes("Parallel Task 2")) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        onUpdate({ content: [{ type: "text", text: "Task 2 chunk A" }] });
        await new Promise((resolve) => setTimeout(resolve, 20));
        onUpdate({ content: [{ type: "text", text: "Task 2 chunk B" }] });
      }

      return {
        content: [{ type: "text", text: "Successfully completed task." }],
        details: { results: [{ exitCode: 0, model: "test-parallel-model" }] }
      };
    };

    const result = await registeredTool.execute(
      "tool-call-parallel-safety",
      { goal: "Test parallel run safety", concurrencyLimit: 2, reviewMode: "after-all" },
      undefined,
      customOnUpdate,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);

    // Verify that every chunk event passed through onUpdate has the stable run/subagent ID and task index
    const task1Updates = emittedEvents.filter(e => e.content?.[0]?.text?.includes("Task 1 chunk"));
    const task2Updates = emittedEvents.filter(e => e.content?.[0]?.text?.includes("Task 2 chunk"));

    assert.ok(task1Updates.length >= 2, "Task 1 updates should be captured");
    assert.ok(task2Updates.length >= 2, "Task 2 updates should be captured");

    // All Task 1 updates should share the same stable subagentRunId and have taskIndex: 0
    const t1RunId = task1Updates[0]?.details?.subagentRunId;
    assert.ok(t1RunId, "Task 1 updates must have a stable subagentRunId");
    for (const update of task1Updates) {
      assert.strictEqual(update.details?.subagentRunId, t1RunId, "Task 1 run ID must be stable across updates");
      assert.strictEqual(update.details?.taskIndex, 0, "Task 1 updates must carry taskIndex: 0");
    }

    // All Task 2 updates should share the same stable subagentRunId and have taskIndex: 1
    const t2RunId = task2Updates[0]?.details?.subagentRunId;
    assert.ok(t2RunId, "Task 2 updates must have a stable subagentRunId");
    for (const update of task2Updates) {
      assert.strictEqual(update.details?.subagentRunId, t2RunId, "Task 2 run ID must be stable across updates");
      assert.strictEqual(update.details?.taskIndex, 1, "Task 2 updates must carry taskIndex: 1");
    }

    // Task 1 and Task 2 run IDs must be distinct
    assert.notStrictEqual(t1RunId, t2RunId, "Task 1 and Task 2 subagentRunIds must be distinct");

    // Now, let's verify the persisted logs in workflow-logs.jsonl
    const logFilePath = path.join(tempTestDir, "workflow-logs.jsonl");
    assert.ok(fs.existsSync(logFilePath), "workflow-logs.jsonl file must be persisted");
    const logLines = fs.readFileSync(logFilePath, "utf8").trim().split("\n");

    const parsedLogs = logLines.map(line => JSON.parse(line));
    const subagentLogs = parsedLogs.filter(log => log.details?.subagentRunId);

    assert.ok(subagentLogs.length > 0, "There should be logged subagent entries with run IDs");

    const t1Logs = subagentLogs.filter(log => log.details?.taskIndex === 0);
    const t2Logs = subagentLogs.filter(log => log.details?.taskIndex === 1);

    assert.ok(t1Logs.length > 0, "Task 1 logged entries should exist");
    assert.ok(t2Logs.length > 0, "Task 2 logged entries should exist");

    for (const log of t1Logs) {
      assert.strictEqual(log.details?.subagentRunId, t1RunId, "Task 1 log entry must have correct stable subagentRunId");
    }
    for (const log of t2Logs) {
      assert.strictEqual(log.details?.subagentRunId, t2RunId, "Task 2 log entry must have correct stable subagentRunId");
    }
  });

  it("verifies end-to-end model display with parallel execution", async () => {
    // Description of verification scenario:
    // This integration scenario launches multiple subagents concurrently with distinct, known model names.
    // It verifies that:
    // 1. Overlapping concurrent execution is proven through start/end timestamps.
    // 2. The UI is updated correctly and displays the precise model name for each subagent.
    // 3. No console/runtime errors occur during parallel status updates.

    const mockTasks = [
      { title: "Parallel Task 1", description: "First job", acceptanceCriteria: "A is verified", dependsOn: [] },
      { title: "Parallel Task 2", description: "Second job", acceptanceCriteria: "B is verified", dependsOn: [] }
    ];

    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            const oIndex = args.indexOf("-o");
            const outputPath = args[oIndex + 1];
            fs.writeFileSync(outputPath, JSON.stringify({ tasks: mockTasks }), "utf8");
          } else {
            // Reviewer
            mockProc.stdout.emit("data", Buffer.from(REVIEW_SHIP_OUTPUT));
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };

    const activeCalls: number[] = [];
    let maxConcurrencyObserved = 0;
    const executionTimestamps: Array<{ task: string; event: "start" | "end"; time: number }> = [];

    mockSubagentHandler = async (toolName, params, signal, onUpdate) => {
      const isTask1 = params.task.includes("Parallel Task 1");
      const taskTitle = isTask1 ? "Parallel Task 1" : "Parallel Task 2";
      const launchModel = isTask1 ? "google/gemini-3.5-flash" : "google/gemini-3.5-flash";
      const streamedModel = isTask1 ? "anthropic/claude-3-5-sonnet-parallel-1" : "openai/gpt-4o-parallel-2";

      executionTimestamps.push({ task: taskTitle, event: "start", time: Date.now() });
      activeCalls.push(1);
      maxConcurrencyObserved = Math.max(maxConcurrencyObserved, activeCalls.length);

      if (onUpdate) {
        onUpdate({
          content: [{ type: "text", text: `Tool start for ${taskTitle}` }],
          details: { results: [{ exitCode: 0, model: launchModel }] },
          model: launchModel,
        });
      }

      // Controlled delay to simulate concurrent work overlap
      await new Promise((resolve) => setTimeout(resolve, 80));

      if (onUpdate) {
        onUpdate({
          content: [{ type: "text", text: `In-progress update for ${taskTitle}` }],
          details: { results: [{ exitCode: 0, model: streamedModel }] },
          model: streamedModel,
        });
      }

      activeCalls.pop();
      executionTimestamps.push({ task: taskTitle, event: "end", time: Date.now() });

      return {
        content: [{ type: "text", text: `Successfully completed ${taskTitle}` }],
        details: { results: [{ exitCode: 0, model: streamedModel }] },
        model: streamedModel,
      };
    };

    // Capture UI widget rendering calls
    const capture = createWidgetCaptureUi();

    // Execute the cc_review tool with concurrencyLimit=2 and after-all reviewMode
    const result = await registeredTool.execute(
      "tool-call-parallel-ui-verify",
      { goal: "Verify parallel models and concurrency", concurrencyLimit: 2, reviewMode: "after-all" },
      undefined,
      undefined,
      { cwd: tempTestDir, ui: capture.ui },
    );

    // Verify successful execution with no errors
    assert.equal(result.isError, undefined);
    assert.equal(maxConcurrencyObserved, 2, "Both tasks must run concurrently");

    // Timing/Overlapping proof
    const t1Start = executionTimestamps.find(e => e.task === "Parallel Task 1" && e.event === "start")?.time;
    const t1End = executionTimestamps.find(e => e.task === "Parallel Task 1" && e.event === "end")?.time;
    const t2Start = executionTimestamps.find(e => e.task === "Parallel Task 2" && e.event === "start")?.time;
    const t2End = executionTimestamps.find(e => e.task === "Parallel Task 2" && e.event === "end")?.time;

    assert.ok(t1Start && t1End && t2Start && t2End, "All start and end timestamps must be recorded");
    assert.ok(t2Start < t1End, "Task 2 must start before Task 1 ends, demonstrating parallel overlap");
    assert.ok(t1Start < t2End, "Task 1 must start before Task 2 ends, demonstrating parallel overlap");

    // Verify model names are captured in final results and summary
    const summaryText = result.content[0].text;
    assert.match(summaryText, /anthropic\/claude-3-5-sonnet-parallel-1/, "Summary must show model for Task 1");
    assert.match(summaryText, /openai\/gpt-4o-parallel-2/, "Summary must show model for Task 2");

    // Verify that the UI first shows the configured model during execution,
    // then upgrades to the effective streamed model without regressing.
    let foundConfiguredModelInUI = false;
    let foundTask1ModelInUI = false;
    let foundTask2ModelInUI = false;
    let foundUnknownModelWhileRunning = false;

    for (const lines of capture.widgetSnapshots) {
      for (const line of lines) {
        if (line.includes("gemini-3.5-flash")) {
          foundConfiguredModelInUI = true;
        }
        if (line.includes("claude-3-5-sonnet-parallel-1")) {
          foundTask1ModelInUI = true;
        }
        if (line.includes("gpt-4o-parallel-2")) {
          foundTask2ModelInUI = true;
        }
        if (line.includes("Unknown model") && line.includes("Parallel Task")) {
          foundUnknownModelWhileRunning = true;
        }
      }
    }

    assert.ok(foundConfiguredModelInUI, "Configured model should be rendered before streamed model resolution");
    assert.ok(foundTask1ModelInUI, "Task 1 model name should be rendered in UI");
    assert.ok(foundTask2ModelInUI, "Task 2 model name should be rendered in UI");
    assert.equal(foundUnknownModelWhileRunning, false, "Running tasks should not regress to Unknown model once a configured model exists");
  });

  it("reports the final worker concurrency in the summary and meta", async () => {
    const mockTasks = [
      { title: "Task 1", description: "Implement feature A", acceptanceCriteria: "A is verified" }
    ];

    mockSpawnHandler = (command, args) => {
      if (command === "codex") {
        const mockProc = new MockChildProcess();
        process.nextTick(() => {
          if (args.includes("-o")) {
            fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ tasks: mockTasks }), "utf8");
          }
          mockProc.emit("close", 0, null);
        });
        return mockProc;
      }
      return null;
    };

    mockSubagentHandler = async () => ({
      content: [{ type: "text", text: "Successfully completed task. All acceptance criteria verified." }],
      details: { results: [{ exitCode: 0 }] }
    });

    // Default auto concurrency: summary/meta contain a valid positive integer.
    const autoResult = await registeredTool.execute(
      "tool-call-concurrency-auto",
      { goal: "Verify default concurrency is surfaced" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );
    assert.equal(autoResult.isError, undefined);
    assert.match(autoResult.content[0].text, /### ⚙️ Execution Configuration/);
    assert.match(autoResult.content[0].text, /- \*Worker concurrency:\* \d+/);
    assert.ok(Number.isInteger(autoResult.details?.meta?.concurrency), "meta.concurrency should be an integer");
    assert.ok(autoResult.details?.meta?.concurrency >= 1, "meta.concurrency should be at least 1");
    assert.ok(autoResult.details?.meta?.concurrency <= 8, "meta.concurrency should be capped at 8");

    // Explicit concurrency overrides the default and is reflected in summary/meta.
    const explicitResult = await registeredTool.execute(
      "tool-call-concurrency-explicit",
      { goal: "Verify explicit concurrency is respected", concurrency: 3 },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );
    assert.equal(explicitResult.isError, undefined);
    assert.match(explicitResult.content[0].text, /- \*Worker concurrency:\* 3/);
    assert.equal(explicitResult.details?.meta?.concurrency, 3);
  });
});

// ---------------------------------------------------------------------------
// Cross-task handoff (DOD-1..DOD-4): bounded prior task handoff
// ---------------------------------------------------------------------------

describe("buildPriorTaskHandoff produces a bounded, structured prior task handoff", () => {
  it("returns an empty string when there are no prior tasks (Task 1 case)", () => {
    assert.equal(buildPriorTaskHandoff([]), "");
    assert.equal(buildPriorTaskHandoff([] as any, { maxSize: 4096 }), "");
  });

  it("includes title, verdict, structured summary, filesChanged, and unresolvedItems", () => {
    const handoff = buildPriorTaskHandoff([
      {
        title: "Set up logging surface",
        status: "completed",
        effectiveVerdict: "ship",
        structuredReport: {
          status: "completed",
          summary: "Added structured log entries and severity rollup.",
          filesChanged: ["src/log.ts", "tests/log.test.ts"],
          unresolvedItems: ["Wire severity to widget"],
        },
      },
    ]);
    assert.match(handoff, /^Prior Tasks \(Handoff\):/);
    assert.match(handoff, /Task 1: Set up logging surface/);
    assert.match(handoff, /Status: completed/);
    assert.match(handoff, /Verdict: ship\b/);
    assert.match(handoff, /Summary: Added structured log entries/);
    assert.match(handoff, /Files: src\/log\.ts, tests\/log\.test\.ts/);
    assert.match(handoff, /Unresolved: Wire severity to widget/);
  });

  it("renders a verdict even when effectiveVerdict is absent (falls back to status)", () => {
    const handoff = buildPriorTaskHandoff([
      {
        title: "Partial task",
        status: "completed_with_warnings",
        structuredReport: { status: "partial", summary: "Did most of it." },
      },
    ]);
    assert.match(handoff, /Verdict: completed_with_warnings/);
    assert.match(handoff, /Status: partial/);
  });

  it("caps total size at the configured maxSize and appends a truncation marker", () => {
    const bigSummary = "x".repeat(2048);
    const manyTasks: Parameters<typeof buildPriorTaskHandoff>[0] = Array.from(
      { length: 20 },
      (_unused, i) => ({
        title: `Task title ${i + 1}`,
        status: "completed" as const,
        effectiveVerdict: "ship" as const,
        structuredReport: {
          status: "completed" as const,
          summary: bigSummary + ` end-${i}`,
          filesChanged: Array.from({ length: 30 }, (__, j) => `pkg/file_${i}_${j}.ts`),
          unresolvedItems: Array.from({ length: 20 }, (__, j) => `item ${i}-${j}`),
        },
      })
    );
    const handoff = buildPriorTaskHandoff(manyTasks);
    assert.ok(
      handoff.length <= 4096,
      `default cap should be 4096 chars, got ${handoff.length}`
    );
    assert.match(handoff, /^Prior Tasks \(Handoff\):/);
    assert.match(handoff, /… \(truncated\)/);
  });

  it("caps total size at a caller-supplied maxSize", () => {
    const bigSummary = "y".repeat(1024);
    const handoff = buildPriorTaskHandoff(
      Array.from({ length: 8 }, (_, i) => ({
        title: `T${i}`,
        effectiveVerdict: "ship" as const,
        structuredReport: { status: "completed" as const, summary: bigSummary },
      })),
      { maxSize: 512 }
    );
    assert.ok(handoff.length <= 512, `expected ≤512, got ${handoff.length}`);
    assert.match(handoff, /… \(truncated\)/);
  });

  it("preserves the most recent task when even one complete task block exceeds the cap", () => {
    const handoff = buildPriorTaskHandoff(
      Array.from({ length: 3 }, (_, i) => ({
        title: `T${i + 1}`,
        effectiveVerdict: "ship" as const,
        structuredReport: {
          status: "completed" as const,
          summary: `${`summary-${i + 1} `.repeat(100)}END-${i + 1}`,
        },
      })),
      { maxSize: 128 }
    );
    assert.ok(handoff.length <= 128, `expected ≤128, got ${handoff.length}`);
    assert.match(handoff, /\(2 earlier tasks omitted\)/);
    assert.match(handoff, /Task 3: T3/);
    assert.equal(handoff.includes("Task 1: T1"), false);
    assert.equal(handoff.includes("Task 2: T2"), false);
    assert.match(handoff, /… \(truncated\)/);
  });

  it("clips per-task summary, filesChanged, and unresolvedItems to keep individual tasks bounded", () => {
    const handoff = buildPriorTaskHandoff([
      {
        title: "Mega task",
        effectiveVerdict: "ship",
        structuredReport: {
          status: "completed",
          summary: "z".repeat(2000),
          filesChanged: Array.from({ length: 50 }, (_, i) => `f${i}.ts`),
          unresolvedItems: Array.from({ length: 30 }, (_, i) => `u${i}`),
        },
      },
    ], { perTaskSummaryChars: 80, perTaskMaxFiles: 4, perTaskMaxUnresolved: 3 });
    assert.match(handoff, /Files: f0\.ts, f1\.ts, f2\.ts, f3\.ts \(\+46 more\)/);
    assert.match(handoff, /Unresolved: u0; u1; u2 \(\+27 more\)/);
    // Summary line should be truncated under the per-task summary cap (≤80 chars after the "Summary: " label).
    const summaryMatch = handoff.match(/Summary: ([^\n]*)/);
    assert.ok(summaryMatch, "expected a summary line");
    assert.ok(
      summaryMatch![1].length <= 80,
      `expected per-task summary ≤80 chars, got ${summaryMatch![1].length}`
    );
  });

  it("excludes raw output, reviewer stdout/stderr, and log fragments from the handoff", () => {
    // The handoff input type does not even surface these fields. To prove the
    // exclusion, we pass a TaskResult-shaped object via the runtime adapter
    // and check the rendered handoff string never contains the poison strings.
    const POISON_RAW_OUTPUT = "POISON_RAW_OUTPUT_zzz";
    const POISON_REVIEWER_STDOUT = "POISON_REVIEWER_STDOUT_zzz";
    const POISON_REVIEWER_STDERR = "POISON_REVIEWER_STDERR_zzz";
    const POISON_LOG_FRAGMENT = "POISON_LOG_FRAGMENT_zzz";
    const POISON_FINDING_MESSAGE = "POISON_FINDING_MESSAGE_zzz";
    const POISON_VALIDATION_ERROR = "POISON_VALIDATION_ERROR_zzz";

    const taskResultLike: any = {
      title: "Has secrets",
      description: "ignored",
      executionCode: 0,
      reviewCode: 0,
      status: "completed",
      effectiveVerdict: "ship",
      // Raw model output — must never appear in handoff.
      output: POISON_RAW_OUTPUT,
      // Reviewer process output captured during execution — must never appear.
      reviewerExitDiagnostic: POISON_REVIEWER_STDERR,
      validationError: POISON_VALIDATION_ERROR,
      reviewResult: {
        verdict: "ship",
        summary: POISON_REVIEWER_STDOUT,
        findings: [
          { priority: "P0", confidence: 1, message: POISON_FINDING_MESSAGE, status: "fixed" },
        ],
      },
      // Pretend a "log fragment" was attached as a free-form field; the
      // adapter must not pick it up.
      logFragment: POISON_LOG_FRAGMENT,
      structuredReport: {
        status: "completed",
        summary: "Clean structured summary only.",
        filesChanged: ["a.ts"],
        unresolvedItems: [],
      },
    };
    const handoff = priorTaskHandoffFromResults([taskResultLike]);
    assert.match(handoff, /Summary: Clean structured summary only\./);
    for (const poison of [
      POISON_RAW_OUTPUT,
      POISON_REVIEWER_STDOUT,
      POISON_REVIEWER_STDERR,
      POISON_LOG_FRAGMENT,
      POISON_FINDING_MESSAGE,
      POISON_VALIDATION_ERROR,
    ]) {
      assert.equal(
        handoff.includes(poison),
        false,
        `handoff should never contain sensitive/raw field "${poison}", got: ${handoff}`
      );
    }
  });

  it("drops oldest tasks first and notes that earlier tasks were omitted when over maxTasks", () => {
    const inputs = Array.from({ length: 9 }, (_, i) => ({
      title: `T${i + 1}`,
      effectiveVerdict: "ship" as const,
      structuredReport: { status: "completed" as const, summary: `s${i + 1}` },
    }));
    const handoff = buildPriorTaskHandoff(inputs, { maxTasks: 3 });
    // Oldest dropped: T1..T6. Kept: T7..T9. Task indices reflect the original
    // chronological position.
    assert.match(handoff, /\(6 earlier tasks omitted\)/);
    assert.match(handoff, /Task 7: T7/);
    assert.match(handoff, /Task 8: T8/);
    assert.match(handoff, /Task 9: T9/);
    assert.equal(handoff.includes("Task 1: T1"), false);
  });
});

describe("buildSubagentTaskPrompt injects the prior task handoff into Task N≥2 prompts", () => {
  const task1 = {
    title: "Task one",
    description: "Do thing one",
    acceptanceCriteria: "Thing one is done",
  } as any;
  const task2 = {
    title: "Task two",
    description: "Do thing two",
    acceptanceCriteria: "Thing two is done",
  } as any;
  const parentSummary = "Parent goal summary";

  it("does not inject a handoff block on Task 1 (no prior tasks)", () => {
    const handoff = priorTaskHandoffFromResults([]);
    const prompt = buildSubagentTaskPrompt(task1, parentSummary, handoff);
    assert.equal(handoff, "");
    assert.equal(prompt.includes("Prior Tasks (Handoff):"), false);
    assert.match(prompt, /Task: Task one/);
    assert.match(prompt, /Parent Workflow Context \(Summary\): Parent goal summary/);
  });

  it("injects Task 1's title, verdict, summary, filesChanged, and unresolvedItems into Task 2's prompt", () => {
    const task1Result: any = {
      title: "Task one",
      description: "ignored",
      executionCode: 0,
      reviewCode: 0,
      status: "completed",
      effectiveVerdict: "ship",
      output: "RAW_MODEL_OUTPUT_DO_NOT_SHOW",
      structuredReport: {
        status: "completed",
        summary: "Implemented foo bar baz with care.",
        filesChanged: ["src/foo.ts", "tests/foo.test.ts"],
        unresolvedItems: ["Polish error messages"],
      },
    };
    const handoff = priorTaskHandoffFromResults([task1Result]);
    const prompt = buildSubagentTaskPrompt(task2, parentSummary, handoff);

    // The structured handoff block appears between parent context and the task body.
    assert.match(prompt, /Prior Tasks \(Handoff\):/);
    assert.match(prompt, /Task 1: Task one/);
    assert.match(prompt, /Verdict: ship\b/);
    assert.match(prompt, /Summary: Implemented foo bar baz with care\./);
    assert.match(prompt, /Files: src\/foo\.ts, tests\/foo\.test\.ts/);
    assert.match(prompt, /Unresolved: Polish error messages/);
    // Task 2's own body is still present.
    assert.match(prompt, /Task: Task two/);
    assert.match(prompt, /Description:\nDo thing two/);
    // Raw model output is never leaked into Task 2's prompt.
    assert.equal(prompt.includes("RAW_MODEL_OUTPUT_DO_NOT_SHOW"), false);
    // Stable ordering: handoff block appears before the Task: line and after the Parent context.
    const parentIdx = prompt.indexOf("Parent Workflow Context");
    const handoffIdx = prompt.indexOf("Prior Tasks (Handoff):");
    const taskIdx = prompt.indexOf("Task: Task two");
    assert.ok(parentIdx >= 0 && handoffIdx > parentIdx && taskIdx > handoffIdx,
      `expected parent < handoff < task ordering, got ${parentIdx}/${handoffIdx}/${taskIdx}`);
  });

  it("keeps Task N's prompt size bounded even when prior tasks are very large", () => {
    const priorResults: any[] = Array.from({ length: 12 }, (_, i) => ({
      title: `Heavy task ${i + 1}`,
      description: "ignored",
      executionCode: 0,
      reviewCode: 0,
      status: "completed",
      effectiveVerdict: "ship",
      output: "x".repeat(20000),
      structuredReport: {
        status: "completed",
        summary: "summary ".repeat(500),
        filesChanged: Array.from({ length: 40 }, (__, j) => `pkg/dir_${i}/file_${j}.ts`),
        unresolvedItems: Array.from({ length: 20 }, (__, j) => `pending-${i}-${j}`),
      },
    }));
    const handoff = priorTaskHandoffFromResults(priorResults);
    const prompt = buildSubagentTaskPrompt(task2, parentSummary, handoff);
    // The handoff portion of the prompt must be ≤ default 4096 cap.
    assert.ok(handoff.length <= 4096, `handoff cap exceeded: ${handoff.length}`);
    assert.match(handoff, /… \(truncated\)/);
    // The overall prompt stays comfortably bounded (handoff cap + small body).
    assert.ok(prompt.length < 8 * 1024, `prompt unexpectedly large: ${prompt.length}`);
  });
});

describe("configurable live-log tail length", () => {
  const baseState = {
    goal: "Test Goal",
    tasks: [],
    currentTaskIndex: -1,
    displayState: "initializing" as const,
    currentPhase: "Initializing",
    liveLogs: Array.from({ length: 15 }, (_, i) => ({
      id: `id-${i}`,
      timestamp: "2026-06-30T15:00:00.000Z",
      severity: "info" as const,
      source: "cc-review",
      pluginId: "cc-review",
      message: `Log line ${i + 1}`,
      sequence: i + 1,
    })),
    resolvedLogLevel: "info" as const,
    persistedLogPath: "workflow-logs.jsonl",
    findingsRollup: { shipCount: 0, warningCount: 0, blockCount: 0, openFindingsCount: 0 },
  };

  it("produces 0 log lines when tail length is resolved to 0", () => {
    const state = {
      ...baseState,
      resolvedWidgetLogLines: 0,
    };
    const lines = buildCcReviewWidgetLines(state);
    // Find how many rendered logs are there. In the widget, each live log starts with "   " or contains colored log entry line.
    // Our state has 15 logs, but resolved tail length is 0.
    // So there should be no log entries listed.
    const logLines = lines.filter(line => line.includes("Log line"));
    assert.equal(logLines.length, 0);
  });

  it("produces at most 5 log lines when tail length is resolved to 5 (default)", () => {
    const state = {
      ...baseState,
      resolvedWidgetLogLines: 5,
    };
    const lines = buildCcReviewWidgetLines(state);
    const logLines = lines.filter(line => line.includes("Log line"));
    assert.equal(logLines.length, 5);
    // Check they are the last 5 logs (Log line 11 to 15)
    assert.ok(logLines[0].includes("Log line 11"));
    assert.ok(logLines[4].includes("Log line 15"));
  });

  it("produces at most 10 log lines when tail length is resolved to 10", () => {
    const state = {
      ...baseState,
      resolvedWidgetLogLines: 10,
    };
    const lines = buildCcReviewWidgetLines(state);
    const logLines = lines.filter(line => line.includes("Log line"));
    assert.equal(logLines.length, 10);
    // Check they are the last 10 logs (Log line 6 to 15)
    assert.ok(logLines[0].includes("Log line 6"));
    assert.ok(logLines[9].includes("Log line 15"));
  });

  it("resolves the configurable tail length correctly based on environment and flags", () => {
    // 1) default
    const res1 = resolveCcReviewWidgetLogLines();
    assert.equal(res1.lines, 5);
    assert.equal(res1.source, "default");

    // 2) flag
    const res2 = resolveCcReviewWidgetLogLines({ flag: 10 });
    assert.equal(res2.lines, 10);
    assert.equal(res2.source, "flag");

    // 3) env
    const res3 = resolveCcReviewWidgetLogLines({ env: { CC_REVIEW_WIDGET_LOG_LINES: "8" } });
    assert.equal(res3.lines, 8);
    assert.equal(res3.source, "env");

    // 4) flag overrides env
    const res4 = resolveCcReviewWidgetLogLines({ flag: 3, env: { CC_REVIEW_WIDGET_LOG_LINES: "8" } });
    assert.equal(res4.lines, 3);
    assert.equal(res4.source, "flag");

    // 5) invalid env falls back to 5
    const res5 = resolveCcReviewWidgetLogLines({ env: { CC_REVIEW_WIDGET_LOG_LINES: "invalid" } });
    assert.equal(res5.lines, 5);
    assert.equal(res5.source, "default");
    assert.ok(res5.invalidInput);
    assert.equal(res5.invalidInput.source, "env");
    assert.equal(res5.invalidInput.raw, "invalid");
  });
});

describe("collapse consecutive identical log messages", () => {
  it("returns empty array for empty input", () => {
    const result = collapseConsecutiveLogEntries([]);
    assert.deepEqual(result, []);
  });

  it("returns same single element array", () => {
    const logs = [
      {
        id: "id-1",
        timestamp: "2026-06-30T15:00:00.000Z",
        severity: "info" as const,
        source: "cc-review",
        pluginId: "cc-review",
        message: "Unique msg",
        sequence: 1,
      },
    ];
    const result = collapseConsecutiveLogEntries(logs);
    assert.equal(result.length, 1);
    assert.equal(result[0].message, "Unique msg");
  });

  it("collapses consecutive duplicate logs and preserves meta of the last entry", () => {
    const logs = [
      {
        id: "id-1",
        timestamp: "2026-06-30T15:00:01.000Z",
        severity: "info" as const,
        source: "cc-review",
        pluginId: "cc-review",
        message: "Codex planner still running (30s)...",
        sequence: 1,
      },
      {
        id: "id-2",
        timestamp: "2026-06-30T15:00:02.000Z",
        severity: "info" as const,
        source: "cc-review",
        pluginId: "cc-review",
        message: "Codex planner still running (30s)...",
        sequence: 2,
      },
      {
        id: "id-3",
        timestamp: "2026-06-30T15:00:03.000Z",
        severity: "info" as const,
        source: "cc-review",
        pluginId: "cc-review",
        message: "  Codex planner still running (30s)... \n",
        sequence: 3,
      },
    ];

    const result = collapseConsecutiveLogEntries(logs);
    assert.equal(result.length, 1);
    assert.ok(result[0].message.includes("(x3)"));
    assert.equal(result[0].sequence, 3);
    assert.equal(result[0].timestamp, "2026-06-30T15:00:03.000Z");
  });

  it("resets counter when non-duplicate logs are in between", () => {
    const logs = [
      {
        id: "id-1",
        timestamp: "2026-06-30T15:00:01.000Z",
        severity: "info" as const,
        source: "cc-review",
        pluginId: "cc-review",
        message: "Heartbeat",
        sequence: 1,
      },
      {
        id: "id-2",
        timestamp: "2026-06-30T15:00:02.000Z",
        severity: "info" as const,
        source: "cc-review",
        pluginId: "cc-review",
        message: "Heartbeat",
        sequence: 2,
      },
      {
        id: "id-3",
        timestamp: "2026-06-30T15:00:03.000Z",
        severity: "info" as const,
        source: "cc-review",
        pluginId: "cc-review",
        message: "Different msg",
        sequence: 3,
      },
      {
        id: "id-4",
        timestamp: "2026-06-30T15:00:04.000Z",
        severity: "info" as const,
        source: "cc-review",
        pluginId: "cc-review",
        message: "Heartbeat",
        sequence: 4,
      },
    ];

    const result = collapseConsecutiveLogEntries(logs);
    assert.equal(result.length, 3);
    assert.ok(result[0].message.includes("Heartbeat"));
    assert.ok(result[0].message.includes("(x2)"));
    assert.equal(result[1].message, "Different msg");
    assert.equal(result[2].message, "Heartbeat");
    assert.ok(!result[2].message.includes("(x"));
  });

  it("integrates seamlessly inside buildCcReviewWidgetLines rendering", () => {
    const state = {
      goal: "Test Goal",
      tasks: [],
      currentTaskIndex: -1,
      displayState: "initializing" as const,
      currentPhase: "Initializing",
      liveLogs: [
        {
          id: "id-1",
          timestamp: "2026-06-30T15:00:01.000Z",
          severity: "info" as const,
          source: "cc-review",
          pluginId: "cc-review",
          message: "Codex planner still running (30s)...",
          sequence: 1,
        },
        {
          id: "id-2",
          timestamp: "2026-06-30T15:00:02.000Z",
          severity: "info" as const,
          source: "cc-review",
          pluginId: "cc-review",
          message: "Codex planner still running (30s)...",
          sequence: 2,
        },
      ],
      resolvedLogLevel: "info" as const,
      resolvedWidgetLogLines: 5,
      persistedLogPath: "workflow-logs.jsonl",
      findingsRollup: { shipCount: 0, warningCount: 0, blockCount: 0, openFindingsCount: 0 },
    };

    const lines = buildCcReviewWidgetLines(state);
    const logLines = lines.filter(line => line.includes("Codex planner still running"));
    assert.equal(logLines.length, 1);
    assert.ok(logLines[0].includes("(x2)"));
  });
});

describe("optimization spec: preflight, validation, logs, checkpoint", () => {
  it("runPreflight reports missing provider CLI with actionable text", () => {
    const result = runPreflight({
      provider: "claude",
      providerCli: "__cc_review_missing_cli_xyz__",
      checkPi: false,
      env: { PATH: "/nonexistent" },
    });
    assert.equal(result.ok, false);
    assert.match(result.errors[0] ?? "", /CC Review:.*claude.*PATH/i);
  });

  it("shouldSkipPreflight respects CC_REVIEW_SKIP_PREFLIGHT", () => {
    assert.equal(shouldSkipPreflight({ CC_REVIEW_SKIP_PREFLIGHT: "1" }), true);
    assert.equal(shouldSkipPreflight({}), false);
  });

  it("validateSubagentOutput fails prose-only output when text validation is disabled", () => {
    const result = validateSubagentOutput(
      {
        content: [{ type: "text", text: "All done. No issues found." }],
        details: { results: [{ exitCode: 0 }] },
      },
      { title: "T", description: "d", acceptanceCriteria: "a" },
      { allowTextValidation: false }
    );
    assert.equal(result.valid, false);
    assert.match(result.error ?? "", /missing valid trailing JSON/i);
  });

  it("validateSubagentOutput allows legacy text heuristics by default (transition period)", () => {
    const result = validateSubagentOutput(
      {
        content: [{ type: "text", text: "All done. No issues found." }],
        details: { results: [{ exitCode: 0 }] },
      },
      { title: "T", description: "d", acceptanceCriteria: "a" },
      { allowTextValidation: true }
    );
    assert.equal(result.valid, true);
    assert.equal(result.schemaParseStatus, "fallback_text");
  });

  it("resolveAllowTextValidation defaults true during transition and honors strict env", () => {
    assert.equal(resolveAllowTextValidation({}), true);
    assert.equal(resolveAllowTextValidation({ env: { CC_REVIEW_ALLOW_TEXT_VALIDATION: "0" } }), false);
    assert.equal(resolveAllowTextValidation({ env: { CC_REVIEW_ALLOW_TEXT_VALIDATION: "1" } }), true);
  });

  it("resolveCcReviewTracePath writes under .cc-review/logs/<runId>", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-trace-path-"));
    const p = resolveCcReviewTracePath(cwd, "run-abc");
    assert.equal(p, path.join(cwd, ".cc-review", "logs", "run-abc", "workflow-trace.jsonl"));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("checkpoint round-trips plan and task completion state for resume", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-checkpoint-"));
    const runId = "20260701T120000000Z-test01";
    writeCheckpoint(cwd, {
      schemaVersion: 1,
      runId,
      goal: "test goal",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      reviewProvider: "codex",
      reviewMode: "after-all",
      tasks: [{ title: "A", description: "d", acceptanceCriteria: "a" }],
      taskResults: [],
      completedTaskIndices: [],
      phase: "planning",
    });
    const loaded = loadCheckpoint(cwd, runId);
    assert.ok(loaded);
    assert.equal(loaded?.goal, "test goal");
    assert.equal(loaded?.tasks.length, 1);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("resume reruns failed or skipped tasks even when an old checkpoint marks them completed", () => {
    const tasks = ["failed", "completed", "skipped", "legacy"].map((title) => ({
      title,
      description: `${title} task`,
      acceptanceCriteria: `${title} criterion`,
    }));
    const checkpoint = {
      schemaVersion: 1 as const,
      runId: "resume-status-test",
      goal: "resume correctly",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      reviewProvider: "codex",
      reviewMode: "after-all",
      tasks,
      taskResults: [
        { title: "failed", description: "failed task", executionCode: 1, reviewCode: -1, status: "failed" as const },
        { title: "completed", description: "completed task", executionCode: 0, reviewCode: 0, status: "completed" as const },
        { title: "skipped", description: "skipped task", executionCode: -1, reviewCode: -1, status: "skipped" as const },
      ],
      // Simulates the corrupt format produced before the resume fix.
      completedTaskIndices: [0, 1, 2, 3],
      phase: "failed" as const,
    };

    assert.deepEqual([...resolveTasksToSkipOnResume(checkpoint)].sort((a, b) => a - b), [1, 3]);
    assert.deepEqual([...resolveTasksToSkipOnResume(checkpoint, 0)].sort((a, b) => a - b), []);
    assert.deepEqual([...resolveTasksToSkipOnResume(checkpoint, 2)].sort((a, b) => a - b), [0, 1]);
  });

  it("rebuilding resume state never records failed work as completed", () => {
    const failedResult = {
      title: "Broken task",
      description: "fails",
      executionCode: 1,
      reviewCode: -1,
      status: "failed" as const,
      unresolvedItems: ["Missing worker credentials"],
    };
    const failedState = rebuildStateBufferFromTaskResults("state-test", [failedResult]);
    assert.deepEqual(failedState.keyDecisions, []);
    assert.deepEqual(failedState.unresolvedItems, ["Missing worker credentials"]);

    const recoveredState = rebuildStateBufferFromTaskResults("state-test", [{
      ...failedResult,
      executionCode: 0,
      reviewCode: 0,
      status: "completed" as const,
      unresolvedItems: [],
    }]);
    assert.deepEqual(recoveredState.keyDecisions, ["Broken task: completed"]);
    assert.deepEqual(recoveredState.unresolvedItems, []);
  });

  it("restores compact after-all executions at their task indices", () => {
    const task = { title: "B", description: "d", acceptanceCriteria: "a" };
    const execution = {
      taskIndex: 1,
      task,
      startedAt: "2026-07-01T00:00:00.000Z",
      subagentResult: { code: 0 },
      subagentOutputText: "done",
      cachedSubagentResult: {},
      structuredReport: null,
      schemaParseStatus: "absent",
      result: {
        title: task.title,
        description: task.description,
        executionCode: 0,
        reviewCode: -1,
        status: "completed",
      },
    } as const;

    const restored = restoreBatchTaskExecutions([execution]);
    assert.equal(restored[0], undefined);
    assert.equal(restored[1], execution);
  });
});

// ---------------------------------------------------------------------------
// P0-1: Pi CLI spawn resolution (borrowed from pi-subagents' getPiSpawnCommand).
// Covers: explicit env override, blank override fallback, package root
// resolution, generic macOS/Linux fallback, Windows script fallback.
// ---------------------------------------------------------------------------
describe("pi-spawn resolution (P0-1)", () => {
  const baseArgs = ["--mode", "json", "-p"];

  it("env override CC_REVIEW_PI_BINARY takes highest priority", () => {
    const cmd = getPiSpawnCommand(baseArgs, {
      env: { CC_REVIEW_PI_BINARY: "/custom/pi" },
      platform: "darwin",
      execPath: "/usr/local/bin/node",
      argv1: "/some/other/script.ts",
    });
    assert.equal(cmd.command, "/custom/pi");
    assert.deepEqual(cmd.args, baseArgs);
    assert.equal(cmd.source, "env_override");
  });

  it("PI_SUBAGENT_PI_BINARY alias is respected when CC_REVIEW_PI_BINARY is absent", () => {
    const cmd = getPiSpawnCommand(baseArgs, {
      env: { PI_SUBAGENT_PI_BINARY: "/alias/pi" },
      platform: "linux",
      execPath: "/usr/bin/node",
      argv1: "/unrelated.ts",
    });
    assert.equal(cmd.command, "/alias/pi");
    assert.equal(cmd.source, "env_override");
  });

  it("blank/whitespace env override falls through to fallback", () => {
    const cmd = getPiSpawnCommand(baseArgs, {
      env: { CC_REVIEW_PI_BINARY: "   " },
      platform: "darwin",
      execPath: "/usr/local/bin/node",
      argv1: "/unrelated.ts",
    });
    assert.equal(cmd.source, "path_fallback");
    assert.equal(cmd.command, "pi");
  });

  it("CC_REVIEW_PI_BINARY takes priority over PI_SUBAGENT_PI_BINARY", () => {
    const cmd = getPiSpawnCommand(baseArgs, {
      env: {
        CC_REVIEW_PI_BINARY: "/primary/pi",
        PI_SUBAGENT_PI_BINARY: "/secondary/pi",
      },
      platform: "darwin",
      execPath: "/usr/local/bin/node",
      argv1: "/unrelated.ts",
    });
    assert.equal(cmd.command, "/primary/pi");
    assert.equal(cmd.source, "env_override");
  });

  it("argv[1] heuristic: pi entry script invoked through process.execPath on generic runtime", () => {
    const fakePiScript = "/home/user/projects/pi/packages/cli/dist/pi.mjs";
    const cmd = getPiSpawnCommand(baseArgs, {
      env: {},
      platform: "darwin",
      execPath: "/usr/local/bin/node",
      argv1: fakePiScript,
      existsSync: (p) => p === fakePiScript,
    });
    assert.equal(cmd.source, "argv_script");
    assert.equal(cmd.command, "/usr/local/bin/node");
    assert.deepEqual(cmd.args, [fakePiScript, ...baseArgs]);
  });

  it("argv[1] heuristic: skips bun virtual filesystem paths", () => {
    const cmd = getPiSpawnCommand(baseArgs, {
      env: {},
      platform: "darwin",
      execPath: "/usr/local/bin/bun",
      argv1: "/$bunfs/root/pi.mjs",
      existsSync: () => true,
    });
    // bunfs path is skipped, execPath is "bun" (generic runtime) → fallback to pi
    assert.equal(cmd.source, "path_fallback");
    assert.equal(cmd.command, "pi");
  });

  it("argv[1] heuristic: pi-coding-agent substring matches", () => {
    const fakeScript = "/opt/pi-coding-agent/cli.mjs";
    const cmd = getPiSpawnCommand(baseArgs, {
      env: {},
      platform: "linux",
      execPath: "/usr/bin/node",
      argv1: fakeScript,
      existsSync: (p) => p === fakeScript,
    });
    assert.equal(cmd.source, "argv_script");
    assert.deepEqual(cmd.args, [fakeScript, ...baseArgs]);
  });

  it("argv[1] heuristic: @earendil-works path matches", () => {
    const fakeScript = "/home/user/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/bin/pi.mjs";
    const cmd = getPiSpawnCommand(baseArgs, {
      env: {},
      platform: "darwin",
      execPath: "/usr/local/bin/node",
      argv1: fakeScript,
      existsSync: (p) => p === fakeScript,
    });
    assert.equal(cmd.source, "argv_script");
  });

  it("generic macOS/Linux fallback to pi on PATH when argv[1] is unrelated", () => {
    const cmd = getPiSpawnCommand(baseArgs, {
      env: {},
      platform: "darwin",
      execPath: "/usr/local/bin/node",
      argv1: "/home/user/test/runner.ts",
      existsSync: () => false,
    });
    assert.equal(cmd.source, "path_fallback");
    assert.equal(cmd.command, "pi");
    assert.deepEqual(cmd.args, baseArgs);
  });

  it("non-generic runtime with unrelated argv[1] reuses the current executable", () => {
    const cmd = getPiSpawnCommand(baseArgs, {
      env: {},
      platform: "darwin",
      execPath: "/usr/local/bin/custom-runtime",
      argv1: "/unrelated.ts",
      existsSync: () => false,
    });
    assert.equal(cmd.source, "current_executable");
    assert.equal(cmd.command, "/usr/local/bin/custom-runtime");
    assert.deepEqual(cmd.args, baseArgs);
  });

  it("compiled Bun Pi reuses its executable when argv[1] is virtual", () => {
    const cmd = getPiSpawnCommand(baseArgs, {
      env: {},
      platform: "darwin",
      execPath: "/Applications/Pi.app/Contents/MacOS/pi-agent",
      argv1: "/$bunfs/root/pi.mjs",
      existsSync: () => true,
    });
    assert.equal(cmd.source, "current_executable");
    assert.equal(cmd.command, "/Applications/Pi.app/Contents/MacOS/pi-agent");
    assert.deepEqual(cmd.args, baseArgs);
  });

  it("Windows: resolves CLI script from package.json bin via process.execPath", () => {
    const packageRoot = "/fake/pi-pkg";
    const binScript = "/fake/pi-pkg/dist/cli.mjs";
    const cmd = getPiSpawnCommand(baseArgs, {
      env: {},
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      argv1: "C:\\unrelated\\script.js",
      existsSync: (p) => p === binScript || p === path.join(packageRoot, "package.json"),
      readFileSync: (p) => {
        if (p === path.join(packageRoot, "package.json")) {
          return JSON.stringify({
            name: PI_CODING_AGENT_PACKAGE,
            bin: { pi: "dist/cli.mjs" },
          });
        }
        return "";
      },
      piPackageRoot: packageRoot,
    });
    assert.equal(cmd.source, "windows_package_bin");
    assert.equal(cmd.command, "C:\\Program Files\\nodejs\\node.exe");
    assert.deepEqual(cmd.args, [binScript, ...baseArgs]);
  });

  it("Windows: falls back to pi on PATH when package resolution fails", () => {
    const cmd = getPiSpawnCommand(baseArgs, {
      env: {},
      platform: "win32",
      execPath: "C:\\node.exe",
      argv1: "C:\\unrelated.js",
      existsSync: () => false,
      piPackageRoot: undefined,
    });
    assert.equal(cmd.source, "path_fallback");
    assert.equal(cmd.command, "pi");
  });

  it("Windows: argv[1] is a runnable script — uses it directly", () => {
    // Use a forward-slash absolute path so path.resolve works on the test
    // host (macOS). On real Windows the path would use backslashes.
    const scriptPath = "/fake/pi/cli.mjs";
    const cmd = getPiSpawnCommand(baseArgs, {
      env: {},
      platform: "win32",
      execPath: "C:\\node.exe",
      argv1: scriptPath,
      existsSync: (p) => p === scriptPath,
    });
    assert.equal(cmd.source, "windows_package_bin");
    assert.deepEqual(cmd.args, [scriptPath, ...baseArgs]);
  });

  it("findPiPackageRootFromEntry walks up to find the package", () => {
    const root = "/home/user/.npm/lib/node_modules/@earendil-works/pi-coding-agent";
    const entry = `${root}/dist/cli.mjs`;
    const result = findPiPackageRootFromEntry(entry, {
      existsSync: (p) => p === path.join(root, "package.json"),
      readFileSync: (p) => {
        if (p === path.join(root, "package.json")) {
          return JSON.stringify({ name: PI_CODING_AGENT_PACKAGE });
        }
        return "";
      },
    });
    assert.equal(result, root);
  });

  it("findPiPackageRootFromEntry returns undefined when package not found", () => {
    const result = findPiPackageRootFromEntry("/home/user/unrelated/script.mjs", {
      existsSync: () => false,
      readFileSync: () => "",
    });
    assert.equal(result, undefined);
  });

  it("formatResolvedPiCommand produces a readable label", () => {
    const cmd = getPiSpawnCommand(baseArgs, {
      env: { CC_REVIEW_PI_BINARY: "/custom/pi" },
      platform: "darwin",
      execPath: "/node",
      argv1: "/unrelated.ts",
    });
    const formatted = formatResolvedPiCommand(cmd);
    assert.match(formatted, /\[env_override\]/);
    assert.match(formatted, /\/custom\/pi/);
  });

  it("preflight reports resolved pi spawn command when env override is active", () => {
    const result = runPreflight({
      provider: "codex",
      providerCli: "__missing__",
      checkPi: true,
      env: { CC_REVIEW_PI_BINARY: "/custom/pi", PATH: "/nonexistent" },
    });
    assert.ok(result.resolved.piSpawn);
    assert.equal(result.resolved.piSpawn!.source, "env_override");
    assert.equal(result.resolved.piSpawn!.command, "/custom/pi");
    // Should not warn about pi missing on PATH since env override is active
    const piWarning = result.warnings.find((w) => w.includes("`pi`"));
    assert.equal(piWarning, undefined);
  });

  it("preflight warns about pi on PATH when fallback mode is needed", () => {
    const result = runPreflight({
      provider: "codex",
      providerCli: "__missing__",
      checkPi: true,
      env: { PATH: "/nonexistent" },
    });
    assert.ok(result.resolved.piSpawn);
    assert.equal(result.resolved.piSpawn!.source, "path_fallback");
    const piWarning = result.warnings.find((w) => w.includes("`pi`"));
    assert.ok(piWarning);
  });
});

// ---------------------------------------------------------------------------
// P0-2: Post-exit stdio guard (borrowed from pi-subagents).
// Simulates a child that emits `exit` without ever ending stdout/stderr (the
// classic "grandchildren keep stdio open" hang). The guard must destroy the
// streams so `close` fires and the parent promise resolves.
// ---------------------------------------------------------------------------
describe("post-exit stdio guard (P0-2)", () => {
  it("resolvePostExitGuardTimings returns defaults when env unset", () => {
    const timings = resolvePostExitGuardTimings({});
    assert.equal(timings.idleMs, DEFAULT_POST_EXIT_IDLE_MS);
    assert.equal(timings.hardMs, DEFAULT_POST_EXIT_HARD_MS);
  });

  it("resolvePostExitGuardTimings respects env overrides", () => {
    const timings = resolvePostExitGuardTimings({
      CC_REVIEW_POST_EXIT_IDLE_MS: "500",
      CC_REVIEW_POST_EXIT_HARD_MS: "2000",
    });
    assert.equal(timings.idleMs, 500);
    assert.equal(timings.hardMs, 2000);
  });

  it("resolvePostExitGuardTimings falls back on invalid input", () => {
    const timings = resolvePostExitGuardTimings({
      CC_REVIEW_POST_EXIT_IDLE_MS: "not-a-number",
      CC_REVIEW_POST_EXIT_HARD_MS: "-5",
    });
    assert.equal(timings.idleMs, DEFAULT_POST_EXIT_IDLE_MS);
    assert.equal(timings.hardMs, DEFAULT_POST_EXIT_HARD_MS);
  });

  it("destroys unended stdout/stderr after idle window post-exit", async () => {
    // Build a fake child process: an EventEmitter with stdout/stderr that are
    // PassThrough streams (so they don't auto-end). We emit `exit` but never
    // end the streams — the guard must destroy them.
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr });

    attachPostExitStdioGuard(child as any, { idleMs: 20, hardMs: 5000 });

    const stdoutDestroyed = new Promise<void>((resolve) => {
      stdout.on("close", () => resolve());
    });

    child.emit("exit", 0, null);

    // Streams should be destroyed within ~idleMs (20ms) plus tolerance.
    await Promise.race([
      stdoutDestroyed,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("stdout not destroyed in time")), 500)),
    ]);
    assert.ok(stdout.destroyed, "stdout should be destroyed after idle window");
  });

  it("idle timer resets on new data post-exit", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr });

    attachPostExitStdioGuard(child as any, { idleMs: 50, hardMs: 5000 });

    let destroyed = false;
    stdout.on("close", () => { destroyed = true; });

    child.emit("exit", 0, null);

    // Send data every 20ms for 150ms — idle timer should keep resetting.
    for (let i = 0; i < 7; i++) {
      await new Promise((r) => setTimeout(r, 20));
      if (!stdout.destroyed) stdout.write("x");
    }
    // After 140ms of continuous data (idleMs=50 never reached), not destroyed yet.
    assert.equal(destroyed, false, "stdout should not be destroyed while data flows");

    // Stop sending data — now the idle timer should fire.
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(destroyed, true, "stdout should be destroyed after data stops");
  });

  it("hard ceiling destroys streams regardless of data flow", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr });

    attachPostExitStdioGuard(child as any, { idleMs: 10000, hardMs: 60 });

    let destroyed = false;
    stdout.on("close", () => { destroyed = true; });

    child.emit("exit", 0, null);

    // Send data continuously — idle timer (10s) would never fire, but the hard
    // ceiling (60ms) must still destroy the stream.
    const interval = setInterval(() => stdout.write("x"), 10);
    try {
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(destroyed, true, "hard ceiling should destroy stdout even with continuous data");
    } finally {
      clearInterval(interval);
    }
  });

  it("normal close path clears timers without destroying streams", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr });

    const clearTimers = attachPostExitStdioGuard(child as any, { idleMs: 20, hardMs: 50 });

    child.emit("exit", 0, null);
    // Immediately emit close (normal completion) — timers should clear.
    child.emit("close", 0, null);

    // Give any would-be timers a chance to fire (they shouldn't).
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(stdout.destroyed, false, "stdout should NOT be destroyed on normal close");
    clearTimers();
    stdout.destroy();
    stderr.destroy();
  });

  it("cleanup function clears timers idempotently", () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr });

    const clearTimers = attachPostExitStdioGuard(child as any, { idleMs: 20, hardMs: 50 });
    child.emit("exit", 0, null);
    clearTimers();
    // Calling again should be a no-op (idempotent).
    clearTimers();
    stdout.destroy();
    stderr.destroy();
  });

  it("existing runSubprocess resolves when child exits but stdio stays open", async () => {
    // Regression-style test: spawn a real child that exits immediately but
    // leaves a grandchild holding stdout open. Without the guard, runSubprocess
    // would hang until the grandchild closes stdio.
    const script = `
      const { spawn } = require("node:child_process");
      // Spawn a grandchild that inherits stdout and sleeps 2s.
      const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], {
        stdio: "inherit",
        detached: true
      });
      grandchild.unref();
      process.exit(0);
    `;
    const result = await runSubprocess({
      label: "test-post-exit-guard",
      command: process.execPath,
      args: ["-e", script],
      cwd: os.tmpdir(),
      maxStreamBytes: 1024 * 1024,
    });
    // Must resolve with exit code 0 — the guard destroyed the inherited stdio.
    assert.equal(result.code, 0);
    assert.equal(result.aborted, false);
  });
});

// ---------------------------------------------------------------------------
// P1-1: Session-file continuity for fallback subagent execution.
// Verifies: default OFF (--no-session), env-gated ON (--session <file>),
// chaining behavior, parallel sibling independence, and session path exposure.
// ---------------------------------------------------------------------------
describe("session-file continuity (P1-1)", () => {
  it("selects the actual single dependency rather than the previous task index", () => {
    const paths = ["/sessions/task-0.json", "/sessions/task-1.json", undefined];
    assert.equal(resolvePriorTaskSessionPath(2, [1], paths), paths[0]);
    assert.equal(resolvePriorTaskSessionPath(2, [2], paths), paths[1]);
  });

  it("does not chain independent or multi-dependency tasks", () => {
    const paths = ["/sessions/task-0.json", "/sessions/task-1.json"];
    assert.equal(resolvePriorTaskSessionPath(1, [], paths), undefined);
    assert.equal(resolvePriorTaskSessionPath(2, [1, 2], paths), undefined);
  });

  it("preserves previous-task chaining for legacy ordered plans", () => {
    const paths = ["/sessions/task-0.json"];
    assert.equal(resolvePriorTaskSessionPath(1, undefined, paths), paths[0]);
  });

  it("resolveSessionContinuity defaults to disabled", () => {
    const config = resolveSessionContinuity({ env: {} });
    assert.equal(config.enabled, false);
    assert.equal(config.chain, false);
  });

  it("resolveSessionContinuity enables via CC_REVIEW_SESSION_CONTINUITY", () => {
    for (const val of ["1", "true", "yes", "TRUE"]) {
      const config = resolveSessionContinuity({ env: { [CC_REVIEW_SESSION_CONTINUITY_ENV]: val } });
      assert.equal(config.enabled, true, `expected enabled for "${val}"`);
    }
    for (const val of ["0", "false", "no", "", "random"]) {
      const config = resolveSessionContinuity({ env: { [CC_REVIEW_SESSION_CONTINUITY_ENV]: val } });
      assert.equal(config.enabled, false, `expected disabled for "${val}"`);
    }
  });

  it("resolveSessionContinuity enables chaining via CC_REVIEW_SESSION_CHAIN", () => {
    const config = resolveSessionContinuity({
      env: {
        [CC_REVIEW_SESSION_CONTINUITY_ENV]: "1",
        [CC_REVIEW_SESSION_CHAIN_ENV]: "1",
      },
    });
    assert.equal(config.enabled, true);
    assert.equal(config.chain, true);
  });

  it("resolveTaskSessionFile returns --no-session when continuity disabled", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-session-test-"));
    try {
      const config = { enabled: false, chain: false };
      const resolution = resolveTaskSessionFile(tmpDir, 0, "run-abc", config);
      assert.equal(resolution.sessionPath, undefined);
      assert.equal(resolution.priorSessionPath, undefined);
      assert.deepEqual(resolution.flag, ["--no-session"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolveTaskSessionFile returns --session <path> when continuity enabled", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-session-test-"));
    try {
      const config = { enabled: true, chain: false };
      const resolution = resolveTaskSessionFile(tmpDir, 2, "run-abc", config);
      assert.ok(resolution.sessionPath);
      assert.ok(resolution.sessionPath!.includes("sessions"));
      assert.ok(resolution.sessionPath!.includes("task-2"));
      assert.ok(resolution.sessionPath!.includes("run-abc"));
      assert.deepEqual(resolution.flag, ["--session", resolution.sessionPath!]);
      assert.equal(resolution.priorSessionPath, undefined);
      // sessions directory should be created
      assert.ok(fs.existsSync(path.join(tmpDir, "sessions")));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolveTaskSessionFile chains from prior session when chaining enabled and prior exists", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-session-test-"));
    try {
      // Create a fake prior session file
      const sessionsDir = path.join(tmpDir, "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const priorPath = path.join(sessionsDir, "task-0-run-abc.session.json");
      fs.writeFileSync(priorPath, "{}", "utf-8");

      const config = { enabled: true, chain: true };
      const resolution = resolveTaskSessionFile(tmpDir, 1, "run-abc", config, priorPath);
      // When chaining and prior exists, should reuse the prior path
      assert.equal(resolution.sessionPath, priorPath);
      assert.equal(resolution.priorSessionPath, priorPath);
      assert.deepEqual(resolution.flag, ["--session", priorPath]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolveTaskSessionFile does NOT chain when chaining disabled", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-session-test-"));
    try {
      const sessionsDir = path.join(tmpDir, "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const priorPath = path.join(sessionsDir, "task-0-run-abc.session.json");
      fs.writeFileSync(priorPath, "{}", "utf-8");

      const config = { enabled: true, chain: false };
      const resolution = resolveTaskSessionFile(tmpDir, 1, "run-abc", config, priorPath);
      // Chaining disabled → new file for this task, not the prior one
      assert.notEqual(resolution.sessionPath, priorPath);
      assert.ok(resolution.sessionPath!.includes("task-1"));
      assert.equal(resolution.priorSessionPath, undefined);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolveTaskSessionFile does NOT chain when prior session does not exist", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-session-test-"));
    try {
      const config = { enabled: true, chain: true };
      const nonexistentPrior = path.join(tmpDir, "nonexistent.session.json");
      const resolution = resolveTaskSessionFile(tmpDir, 1, "run-abc", config, nonexistentPrior);
      // Prior doesn't exist → new file for this task
      assert.ok(resolution.sessionPath);
      assert.ok(resolution.sessionPath!.includes("task-1"));
      assert.equal(resolution.priorSessionPath, undefined);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("parallel sibling tasks get distinct session files", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-session-test-"));
    try {
      const config = { enabled: true, chain: false };
      const task0 = resolveTaskSessionFile(tmpDir, 0, "run-abc", config);
      const task1 = resolveTaskSessionFile(tmpDir, 1, "run-abc", config);
      assert.notEqual(task0.sessionPath, task1.sessionPath);
      assert.ok(task0.sessionPath!.includes("task-0"));
      assert.ok(task1.sessionPath!.includes("task-1"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("describeSessionPath returns undefined for undefined input", () => {
    assert.equal(describeSessionPath(undefined), undefined);
  });

  it("describeSessionPath returns a readable label for a path", () => {
    const label = describeSessionPath("/some/dir/task-0-run-abc.session.json");
    assert.equal(label, "session:task-0-run-abc.session.json");
  });

  it("sequential two-task test: Task 2 can chain from Task 1's session path", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-session-test-"));
    try {
      const config = { enabled: true, chain: true };

      // Task 1 runs — gets its own session file.
      const task0Resolution = resolveTaskSessionFile(tmpDir, 0, "run-seq", config);
      assert.ok(task0Resolution.sessionPath);

      // Simulate Task 1 completing and writing a session file.
      fs.mkdirSync(path.dirname(task0Resolution.sessionPath!), { recursive: true });
      fs.writeFileSync(task0Resolution.sessionPath!, '{"messages":[]}', "utf-8");

      // Task 2 runs with Task 1's session path as priorSessionPath.
      const task1Resolution = resolveTaskSessionFile(tmpDir, 1, "run-seq", config, task0Resolution.sessionPath);
      // With chaining enabled and prior existing, Task 2 reuses Task 1's session.
      assert.equal(task1Resolution.sessionPath, task0Resolution.sessionPath);
      assert.equal(task1Resolution.priorSessionPath, task0Resolution.sessionPath);
      assert.deepEqual(task1Resolution.flag, ["--session", task0Resolution.sessionPath!]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// P1-3: Model fallback and attempted-model reporting.
// Verifies: candidate building, retryable failure classification, attempt
// summarization, and settings resolution.
// ---------------------------------------------------------------------------
describe("model fallback (P1-3)", () => {
  it("splitThinkingSuffix separates base model and thinking suffix", () => {
    assert.deepEqual(splitThinkingSuffix("claude-sonnet"), { baseModel: "claude-sonnet", thinkingSuffix: "" });
    assert.deepEqual(splitThinkingSuffix("claude-sonnet:high"), { baseModel: "claude-sonnet", thinkingSuffix: ":high" });
    assert.deepEqual(splitThinkingSuffix("provider/claude:low"), { baseModel: "provider/claude", thinkingSuffix: ":low" });
  });

  it("parseFallbackModels splits comma-separated string", () => {
    assert.deepEqual(parseFallbackModels("a, b, c"), ["a", "b", "c"]);
    assert.deepEqual(parseFallbackModels("a,, b,"), ["a", "b"]);
    assert.deepEqual(parseFallbackModels(""), []);
    assert.deepEqual(parseFallbackModels(undefined), []);
    assert.deepEqual(parseFallbackModels(123), []);
  });

  it("buildModelCandidates puts primary first, dedupes", () => {
    const candidates = buildModelCandidates({
      primaryModel: "primary-model",
      fallbackModels: ["fallback-a", "primary-model", "fallback-b"],
    });
    assert.deepEqual(candidates, ["primary-model", "fallback-a", "fallback-b"]);
  });

  it("buildModelCandidates handles undefined primary", () => {
    const candidates = buildModelCandidates({
      primaryModel: undefined,
      fallbackModels: ["fallback-a", "fallback-b"],
    });
    assert.deepEqual(candidates, ["fallback-a", "fallback-b"]);
  });

  it("buildModelCandidates returns empty when no models", () => {
    assert.deepEqual(buildModelCandidates({ primaryModel: undefined, fallbackModels: [] }), []);
  });

  it("isRetryableModelFailure detects rate limits", () => {
    assert.equal(isRetryableModelFailure("Rate limit exceeded"), true);
    assert.equal(isRetryableModelFailure("Too many requests (429)"), true);
    assert.equal(isRetryableModelFailure("quota exceeded"), true);
  });

  it("isRetryableModelFailure detects auth/key errors", () => {
    assert.equal(isRetryableModelFailure("Unauthorized: invalid API key"), true);
    assert.equal(isRetryableModelFailure("token expired"), true);
    assert.equal(isRetryableModelFailure("forbidden"), true);
  });

  it("isRetryableModelFailure detects model unavailable", () => {
    assert.equal(isRetryableModelFailure("model not found"), true);
    assert.equal(isRetryableModelFailure("Model is disabled"), true);
    assert.equal(isRetryableModelFailure("provider unavailable"), true);
  });

  it("isRetryableModelFailure detects network/timeout errors", () => {
    assert.equal(isRetryableModelFailure("connection refused"), true);
    assert.equal(isRetryableModelFailure("fetch failed"), true);
    assert.equal(isRetryableModelFailure("socket hang up"), true);
    assert.equal(isRetryableModelFailure("Request timed out"), true);
    assert.equal(isRetryableModelFailure("503 Service unavailable"), true);
  });

  it("isRetryableModelFailure returns false for non-retryable errors", () => {
    assert.equal(isRetryableModelFailure("Syntax error in task prompt"), false);
    assert.equal(isRetryableModelFailure("Task validation failed"), false);
    assert.equal(isRetryableModelFailure("File not found"), false);
    assert.equal(isRetryableModelFailure(undefined), false);
    assert.equal(isRetryableModelFailure(""), false);
  });

  it("formatModelAttemptNote includes next model when provided", () => {
    const attempt: ModelAttemptSummary = { model: "model-a", success: false, exitCode: 1, error: "rate limit" };
    const note = formatModelAttemptNote(attempt, "model-b");
    assert.match(note, /model-a failed: rate limit/);
    assert.match(note, /Retrying with model-b/);
  });

  it("formatModelAttemptNote omits next model when not provided", () => {
    const attempt: ModelAttemptSummary = { model: "model-a", success: false, exitCode: 1, error: "timeout" };
    const note = formatModelAttemptNote(attempt);
    assert.match(note, /model-a failed: timeout/);
    assert.doesNotMatch(note, /Retrying/);
  });

  it("summarizeAttemptedModels returns undefined for single attempt", () => {
    const attempts: ModelAttemptSummary[] = [
      { model: "model-a", success: true, exitCode: 0 },
    ];
    assert.equal(summarizeAttemptedModels(attempts), undefined);
  });

  it("summarizeAttemptedModels lists all attempts with status", () => {
    const attempts: ModelAttemptSummary[] = [
      { model: "model-a", success: false, exitCode: 1, error: "rate limit" },
      { model: "model-b", success: true, exitCode: 0 },
    ];
    const summary = summarizeAttemptedModels(attempts);
    assert.ok(summary);
    assert.match(summary!, /1\. model-a — failed \(rate limit\)/);
    assert.match(summary!, /2\. model-b — ok/);
  });

  it("resolveModelFallbackConfig reads frontmatter fallbackModels", () => {
    const config = resolveModelFallbackConfig({
      agentFrontmatter: { model: "primary", fallbackModels: "fb1, fb2" },
      agentName: "worker",
    });
    assert.equal(config.primaryModel, "primary");
    assert.deepEqual(config.fallbackModels, ["fb1", "fb2"]);
  });

  it("resolveModelFallbackConfig reads settings overrides", () => {
    const settings = {
      subagents: {
        agentOverrides: {
          worker: { model: "settings-primary", fallbackModels: "settings-fb1,settings-fb2" },
        },
      },
    };
    const config = resolveModelFallbackConfig({
      agentFrontmatter: {},
      settings,
      agentName: "worker",
    });
    assert.equal(config.primaryModel, "settings-primary");
    assert.deepEqual(config.fallbackModels, ["settings-fb1", "settings-fb2"]);
  });

  it("resolveModelFallbackConfig merges frontmatter and settings fallbacks, dedupes", () => {
    const settings = {
      defaultModel: "default-model",
      subagents: {
        agentOverrides: {
          worker: { fallbackModels: "fb2, fb3" },
        },
      },
    };
    const config = resolveModelFallbackConfig({
      agentFrontmatter: { model: "primary", fallbackModels: "fb1, fb2" },
      settings,
      agentName: "worker",
    });
    assert.equal(config.primaryModel, "primary");
    // fb1 from frontmatter, fb2 from both (deduped), fb3 from settings
    assert.deepEqual(config.fallbackModels, ["fb1", "fb2", "fb3"]);
  });

  it("resolveModelFallbackConfig falls back to defaultModel when no primary", () => {
    const settings = { defaultModel: "default-model" };
    const config = resolveModelFallbackConfig({
      agentFrontmatter: {},
      settings,
      agentName: "worker",
    });
    assert.equal(config.primaryModel, "default-model");
    assert.deepEqual(config.fallbackModels, []);
  });

  it("resolveModelFallbackConfig returns empty when nothing configured", () => {
    const config = resolveModelFallbackConfig({});
    assert.equal(config.primaryModel, undefined);
    assert.deepEqual(config.fallbackModels, []);
  });

  it("successful primary model — no fallback needed (candidates has 1 entry)", () => {
    const candidates = buildModelCandidates({
      primaryModel: "primary",
      fallbackModels: [],
    });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0], "primary");
  });

  it("retryable primary failure followed by fallback success — candidates ordered", () => {
    const candidates = buildModelCandidates({
      primaryModel: "primary",
      fallbackModels: ["fallback-a", "fallback-b"],
    });
    assert.deepEqual(candidates, ["primary", "fallback-a", "fallback-b"]);
    // Simulate: primary fails with retryable error, fallback-a succeeds
    const attempts: ModelAttemptSummary[] = [
      { model: "primary", success: false, exitCode: 1, error: "rate limit exceeded" },
      { model: "fallback-a", success: true, exitCode: 0 },
    ];
    assert.equal(isRetryableModelFailure(attempts[0]!.error), true);
    const summary = summarizeAttemptedModels(attempts);
    assert.ok(summary);
    assert.match(summary!, /primary — failed/);
    assert.match(summary!, /fallback-a — ok/);
  });

  it("non-retryable failure with no fallback — single candidate, no summary", () => {
    const candidates = buildModelCandidates({
      primaryModel: "primary",
      fallbackModels: [],
    });
    assert.equal(candidates.length, 1);
    const error = "Syntax error in generated code";
    assert.equal(isRetryableModelFailure(error), false);
    // Non-retryable → no fallback attempt, single entry → no summary
    const attempts: ModelAttemptSummary[] = [
      { model: "primary", success: false, exitCode: 1, error },
    ];
    assert.equal(summarizeAttemptedModels(attempts), undefined);
  });
});

// ---------------------------------------------------------------------------
// P1-2: Structured-output strict mode.
// Verifies: config resolution, file path/instruction generation, file reading
// and parsing, missing-file failure, and invalid-JSON failure.
// ---------------------------------------------------------------------------
describe("structured-output strict mode (P1-2)", () => {
  it("is wired into worker prompt construction and validation", () => {
    const executionPhaseSource = fs.readFileSync(
      path.join(process.cwd(), ".pi/extensions/cc-review/workflow/orchestrator/execution-phase.ts"),
      "utf-8",
    );
    assert.match(executionPhaseSource, /resolveStructuredOutputStrict\(\)/);
    assert.match(executionPhaseSource, /structuredOutput\?\.promptInstruction/);
    assert.match(executionPhaseSource, /readStructuredOutputFile\(structuredOutput\.outputPath\)/);
    assert.match(executionPhaseSource, /cachedSubagentResult = resultForValidation/);
  });

  it("resolveStructuredOutputStrict defaults to disabled", () => {
    assert.equal(resolveStructuredOutputStrict({}).enabled, false);
    assert.equal(resolveStructuredOutputStrict({ [CC_REVIEW_STRUCTURED_OUTPUT_STRICT_ENV]: "" }).enabled, false);
  });

  it("resolveStructuredOutputStrict enables via env", () => {
    for (const val of ["1", "true", "yes"]) {
      assert.equal(resolveStructuredOutputStrict({ [CC_REVIEW_STRUCTURED_OUTPUT_STRICT_ENV]: val }).enabled, true);
    }
    for (const val of ["0", "false", "no", "random"]) {
      assert.equal(resolveStructuredOutputStrict({ [CC_REVIEW_STRUCTURED_OUTPUT_STRICT_ENV]: val }).enabled, false);
    }
  });

  it("resolveStructuredOutputFile returns undefined when strict disabled", () => {
    const result = resolveStructuredOutputFile("/tmp/artifacts", 0, { enabled: false });
    assert.equal(result, undefined);
  });

  it("resolveStructuredOutputFile returns path and instruction when enabled", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-structured-test-"));
    try {
      const result = resolveStructuredOutputFile(tmpDir, 3, { enabled: true });
      assert.ok(result);
      assert.ok(result!.outputPath.includes("structured"));
      assert.ok(result!.outputPath.includes("task-3"));
      assert.ok(result!.promptInstruction.includes("REQUIRED"));
      assert.ok(result!.promptInstruction.includes(result!.outputPath));
      assert.ok(fs.existsSync(path.join(tmpDir, "structured")));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("readStructuredOutputFile returns found:false when file missing", () => {
    const result = readStructuredOutputFile("/nonexistent/path/task-0.json");
    assert.equal(result.found, false);
    assert.ok(result.error);
    assert.match(result.error!, /not found/i);
  });

  it("readStructuredOutputFile parses valid JSON", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-structured-test-"));
    try {
      const filePath = path.join(tmpDir, "task-0.json");
      const expected = { status: "completed", summary: "done" };
      fs.writeFileSync(filePath, JSON.stringify(expected), "utf-8");
      const result = readStructuredOutputFile(filePath);
      assert.equal(result.found, true);
      assert.deepEqual(result.parsed, expected);
      assert.equal(result.error, undefined);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("readStructuredOutputFile strips markdown code fences", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-structured-test-"));
    try {
      const filePath = path.join(tmpDir, "task-0.json");
      const expected = { status: "completed", summary: "done" };
      fs.writeFileSync(filePath, "```json\n" + JSON.stringify(expected) + "\n```", "utf-8");
      const result = readStructuredOutputFile(filePath);
      assert.equal(result.found, true);
      assert.deepEqual(result.parsed, expected);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("readStructuredOutputFile returns error for empty file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-structured-test-"));
    try {
      const filePath = path.join(tmpDir, "task-0.json");
      fs.writeFileSync(filePath, "", "utf-8");
      const result = readStructuredOutputFile(filePath);
      assert.equal(result.found, true);
      assert.equal(result.parsed, undefined);
      assert.match(result.error!, /empty/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("readStructuredOutputFile returns error for invalid JSON", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-structured-test-"));
    try {
      const filePath = path.join(tmpDir, "task-0.json");
      fs.writeFileSync(filePath, "{not valid json}", "utf-8");
      const result = readStructuredOutputFile(filePath);
      assert.equal(result.found, true);
      assert.equal(result.parsed, undefined);
      assert.match(result.error!, /invalid JSON/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("strict-mode-required task fails clearly when output file is missing", () => {
    // Simulate the strict-mode validation path: worker ran but didn't write
    // the structured output file. The read should report found:false with a
    // clear error that the caller can surface as a validation failure.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-structured-test-"));
    try {
      const resolution = resolveStructuredOutputFile(tmpDir, 0, { enabled: true });
      assert.ok(resolution);
      const result = readStructuredOutputFile(resolution!.outputPath);
      assert.equal(result.found, false);
      assert.ok(result.error);
      assert.match(result.error!, /not found/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("valid output is read and can be schema-checked by parseSubagentStructuredReport", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-structured-test-"));
    try {
      const filePath = path.join(tmpDir, "task-0.json");
      const expected = {
        status: "completed",
        summary: "Implemented the parser fix",
        filesChanged: ["src/parser.ts"],
        acceptanceCriteria: [
          { criterion: "handles null input", status: "met", evidence: "added null check" },
        ],
      };
      fs.writeFileSync(filePath, JSON.stringify(expected), "utf-8");
      const result = readStructuredOutputFile(filePath);
      assert.equal(result.found, true);
      assert.deepEqual(result.parsed, expected);
      // The caller would pass result.parsed to parseSubagentStructuredReport
      // or validate it directly; the file-read layer just provides the JSON.
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// P2-1: Completion mutation guard.
// Verifies: mutation expectation inference, mutating-bash classification,
// mutation tool call detection, and guard trigger logic.
// ---------------------------------------------------------------------------
describe("completion mutation guard (P2-1)", () => {
  it("expectsImplementationMutation: worker with implement intent", () => {
    assert.equal(expectsImplementationMutation("worker", "Implement the parser fix"), true);
    assert.equal(expectsImplementationMutation("worker", "Fix the null pointer bug"), true);
    assert.equal(expectsImplementationMutation("worker", "Refactor the auth module"), true);
    assert.equal(expectsImplementationMutation("worker", "Update the README"), true);
  });

  it("expectsImplementationMutation: review-only tasks do not expect mutation", () => {
    assert.equal(expectsImplementationMutation("worker", "Review only the changes"), false);
    assert.equal(expectsImplementationMutation("worker", "Return findings only"), false);
  });

  it("expectsImplementationMutation: explicit no-edit tasks do not expect mutation", () => {
    assert.equal(expectsImplementationMutation("worker", "Do not edit any files"), false);
    assert.equal(expectsImplementationMutation("worker", "Do not modify the source"), false);
  });

  it("expectsImplementationMutation: scoped no-edit still allows mutation", () => {
    assert.equal(expectsImplementationMutation("worker", "Fix the parser. Do not edit files outside src/"), true);
  });

  it("expectsImplementationMutation: research/scout agents do not expect mutation", () => {
    assert.equal(expectsImplementationMutation("research", "Find all usages of foo()"), false);
    assert.equal(expectsImplementationMutation("scout", "Investigate the architecture"), false);
  });

  it("expectsImplementationMutation: reviewer agent only expects mutation with explicit edit patterns", () => {
    assert.equal(expectsImplementationMutation("reviewer", "Review the changes"), false);
    assert.equal(expectsImplementationMutation("reviewer", "Must edit the files to fix issues"), true);
    assert.equal(expectsImplementationMutation("reviewer", "Apply the fixes directly"), true);
  });

  it("isMutatingBashCommand: detects file writes", () => {
    assert.equal(isMutatingBashCommand("echo hello > file.txt"), true);
    assert.equal(isMutatingBashCommand("cat config.json > backup.json"), true);
    assert.equal(isMutatingBashCommand("tee output.log"), true);
  });

  it("isMutatingBashCommand: detects file operations", () => {
    assert.equal(isMutatingBashCommand("rm temp.txt"), true);
    assert.equal(isMutatingBashCommand("mv a.txt b.txt"), true);
    assert.equal(isMutatingBashCommand("mkdir newdir"), true);
    assert.equal(isMutatingBashCommand("touch newfile.txt"), true);
  });

  it("isMutatingBashCommand: detects git mutations", () => {
    assert.equal(isMutatingBashCommand("git add -A"), true);
    assert.equal(isMutatingBashCommand("git commit -m msg"), true);
    assert.equal(isMutatingBashCommand("git push"), true);
  });

  it("isMutatingBashCommand: detects package installs", () => {
    assert.equal(isMutatingBashCommand("npm install express"), true);
    assert.equal(isMutatingBashCommand("pnpm add lodash"), true);
    assert.equal(isMutatingBashCommand("pip install requests"), true);
  });

  it("isMutatingBashCommand: detects sed -i", () => {
    assert.equal(isMutatingBashCommand("sed -i 's/foo/bar/' file.txt"), true);
  });

  it("isMutatingBashCommand: returns false for read-only commands", () => {
    assert.equal(isMutatingBashCommand("ls -la"), false);
    assert.equal(isMutatingBashCommand("cat file.txt"), false);
    assert.equal(isMutatingBashCommand("grep pattern file.txt"), false);
    assert.equal(isMutatingBashCommand("node --version"), false);
    assert.equal(isMutatingBashCommand(""), false);
  });

  it("hasMutationToolCall: detects edit tool", () => {
    const events: GuardedToolEvent[] = [{ name: "edit", arguments: { path: "file.txt" } }];
    assert.equal(hasMutationToolCall(events), true);
  });

  it("hasMutationToolCall: detects write tool", () => {
    const events: GuardedToolEvent[] = [{ name: "write", arguments: { file_path: "file.txt" } }];
    assert.equal(hasMutationToolCall(events), true);
  });

  it("hasMutationToolCall: detects mutating bash", () => {
    const events: GuardedToolEvent[] = [{ name: "bash", arguments: { command: "rm file.txt" } }];
    assert.equal(hasMutationToolCall(events), true);
  });

  it("hasMutationToolCall: returns false for read-only tools", () => {
    const events: GuardedToolEvent[] = [
      { name: "read", arguments: { path: "file.txt" } },
      { name: "bash", arguments: { command: "ls -la" } },
    ];
    assert.equal(hasMutationToolCall(events), false);
  });

  it("hasMutationToolCall: returns false for empty events", () => {
    assert.equal(hasMutationToolCall([]), false);
  });

  it("evaluateCompletionMutationGuard: triggers when mutation expected but not attempted", () => {
    const result = evaluateCompletionMutationGuard({
      agent: "worker",
      task: "Implement the parser fix",
      toolEvents: [{ name: "read", arguments: { path: "parser.ts" } }],
    });
    assert.equal(result.expectedMutation, true);
    assert.equal(result.attemptedMutation, false);
    assert.equal(result.triggered, true);
    assert.ok(result.reason);
  });

  it("evaluateCompletionMutationGuard: does not trigger when mutation expected and attempted", () => {
    const result = evaluateCompletionMutationGuard({
      agent: "worker",
      task: "Implement the parser fix",
      toolEvents: [{ name: "edit", arguments: { path: "parser.ts" } }],
    });
    assert.equal(result.expectedMutation, true);
    assert.equal(result.attemptedMutation, true);
    assert.equal(result.triggered, false);
    assert.equal(result.reason, undefined);
  });

  it("evaluateCompletionMutationGuard: does not trigger for review-only tasks", () => {
    const result = evaluateCompletionMutationGuard({
      agent: "worker",
      task: "Review only the changes and report findings",
      toolEvents: [],
    });
    assert.equal(result.expectedMutation, false);
    assert.equal(result.triggered, false);
  });

  it("evaluateCompletionMutationGuard: does not trigger for research agents", () => {
    const result = evaluateCompletionMutationGuard({
      agent: "research",
      task: "Investigate the codebase structure",
      toolEvents: [],
    });
    assert.equal(result.expectedMutation, false);
    assert.equal(result.triggered, false);
  });

  it("evaluateCompletionMutationGuard: read-only tools override task text", () => {
    const result = evaluateCompletionMutationGuard({
      agent: "worker",
      task: "Implement the parser fix",
      toolEvents: [],
      tools: ["read", "grep", "find"],
    });
    assert.equal(result.expectedMutation, false);
    assert.equal(result.triggered, false);
  });

  it("guard records a clear validation message when triggered", () => {
    const result = evaluateCompletionMutationGuard({
      agent: "worker",
      task: "Fix the authentication bug",
      toolEvents: [],
    });
    assert.equal(result.triggered, true);
    assert.ok(result.reason);
    assert.match(result.reason!, /expects file mutation/i);
    assert.match(result.reason!, /no edit\/write\/mutating-bash/i);
  });
});

// ---------------------------------------------------------------------------
// P2-2: Long-running and needs-attention control events.
// Verifies: tracker lifecycle, state classification, event deduplication,
// and label formatting.
// ---------------------------------------------------------------------------
describe("subagent control events (P2-2)", () => {
  const thresholds = { idleMs: 1000, longRunningMs: 5000, toolFailureThreshold: 3 };

  it("createSubagentActivityTracker initializes with sensible defaults", () => {
    const tracker = createSubagentActivityTracker(0, "2026-01-01T00:00:00.000Z");
    assert.equal(tracker.taskIndex, 0);
    assert.equal(tracker.completed, false);
    assert.equal(tracker.consecutiveToolFailures, 0);
    assert.equal(tracker.lastEmittedEvent, undefined);
    assert.ok(tracker.lastActivityMs > 0);
  });

  it("classifySubagentControlState returns active when recently active", () => {
    const tracker = createSubagentActivityTracker(0, new Date().toISOString());
    const now = Date.now();
    recordActivity(tracker, { timestamp: now });
    assert.equal(classifySubagentControlState(tracker, thresholds, now), "active");
  });

  it("classifySubagentControlState returns needs_attention when idle exceeds threshold", () => {
    const start = new Date(Date.now() - 100).toISOString();
    const tracker = createSubagentActivityTracker(0, start, { idleMs: 1000 });
    const now = Date.now() + 2000; // 2s after last activity
    assert.equal(classifySubagentControlState(tracker, thresholds, now), "needs_attention");
  });

  it("classifySubagentControlState returns active_long_running when total elapsed exceeds threshold", () => {
    const start = new Date(Date.now() - 6000).toISOString();
    const tracker = createSubagentActivityTracker(0, start, { longRunningMs: 5000 });
    const now = Date.now();
    recordActivity(tracker, { timestamp: now - 100 }); // recently active
    assert.equal(classifySubagentControlState(tracker, thresholds, now), "active_long_running");
  });

  it("classifySubagentControlState returns completed when tracker is completed", () => {
    const tracker = createSubagentActivityTracker(0);
    markCompleted(tracker);
    assert.equal(classifySubagentControlState(tracker, thresholds), "completed");
  });

  it("emitControlEvent returns needs_attention when idle", () => {
    const start = new Date(Date.now() - 100).toISOString();
    const tracker = createSubagentActivityTracker(0, start, thresholds);
    const now = Date.now() + 2000;
    const event = emitControlEvent(tracker, thresholds, now);
    assert.equal(event, "needs_attention");
    assert.equal(tracker.lastEmittedEvent, "needs_attention");
  });

  it("emitControlEvent deduplicates needs_attention", () => {
    const start = new Date(Date.now() - 100).toISOString();
    const tracker = createSubagentActivityTracker(0, start, thresholds);
    const now = Date.now() + 2000;
    const first = emitControlEvent(tracker, thresholds, now);
    const second = emitControlEvent(tracker, thresholds, now + 500);
    assert.equal(first, "needs_attention");
    assert.equal(second, undefined); // deduplicated
  });

  it("emitControlEvent returns active_long_running when long-running", () => {
    const start = new Date(Date.now() - 6000).toISOString();
    const tracker = createSubagentActivityTracker(0, start, thresholds);
    const now = Date.now();
    recordActivity(tracker, { timestamp: now - 100 });
    const event = emitControlEvent(tracker, thresholds, now);
    assert.equal(event, "active_long_running");
  });

  it("emitControlEvent returns repeated_tool_failures when threshold reached", () => {
    const tracker = createSubagentActivityTracker(0, new Date().toISOString(), thresholds);
    recordToolFailure(tracker);
    recordToolFailure(tracker);
    assert.equal(emitControlEvent(tracker, thresholds), undefined); // 2 < 3
    recordToolFailure(tracker);
    assert.equal(emitControlEvent(tracker, thresholds), "repeated_tool_failures"); // 3 >= 3
  });

  it("recordActivity with toolSuccess resets failure counter", () => {
    const tracker = createSubagentActivityTracker(0, new Date().toISOString(), thresholds);
    recordToolFailure(tracker);
    recordToolFailure(tracker);
    recordActivity(tracker, { toolSuccess: true });
    assert.equal(tracker.consecutiveToolFailures, 0);
    // Should not emit repeated_tool_failures now
    assert.equal(emitControlEvent(tracker, thresholds), undefined);
  });

  it("emitControlEvent resets dedup when activity resumes", () => {
    const start = new Date(Date.now() - 2000).toISOString();
    const tracker = createSubagentActivityTracker(0, start, thresholds);
    // Idle → emit needs_attention
    const now1 = Date.now();
    assert.equal(emitControlEvent(tracker, thresholds, now1), "needs_attention");
    // Activity resumes
    recordActivity(tracker, { timestamp: now1 + 100 });
    // Should reset lastEmittedEvent so it can fire again later
    assert.equal(tracker.lastEmittedEvent, undefined);
  });

  it("emitControlEvent returns undefined when completed", () => {
    const tracker = createSubagentActivityTracker(0);
    markCompleted(tracker);
    assert.equal(emitControlEvent(tracker, thresholds), undefined);
  });

  it("formatControlEventLabel produces readable labels", () => {
    assert.equal(formatControlEventLabel("active_long_running"), "long-running");
    assert.equal(formatControlEventLabel("needs_attention"), "idle · needs attention");
    assert.equal(formatControlEventLabel("repeated_tool_failures"), "repeated tool failures");
  });

  it("formatControlStateLabel produces readable labels", () => {
    assert.equal(formatControlStateLabel("active"), "");
    assert.equal(formatControlStateLabel("active_long_running"), "long-running");
    assert.equal(formatControlStateLabel("needs_attention"), "needs attention");
    assert.equal(formatControlStateLabel("idle"), "idle");
    assert.equal(formatControlStateLabel("completed"), "done");
  });

  it("buildControlEventLogPayload includes timing and failure data", () => {
    const start = new Date(Date.now() - 10000).toISOString();
    const tracker = createSubagentActivityTracker(2, start, thresholds);
    recordToolFailure(tracker);
    recordToolFailure(tracker);
    recordToolFailure(tracker);
    const payload = buildControlEventLogPayload(tracker, "repeated_tool_failures", thresholds);
    assert.equal(payload.controlEvent, "repeated_tool_failures");
    assert.equal(payload.taskIndex, 2);
    assert.ok(typeof payload.elapsedMs === "number");
    assert.ok(payload.elapsedMs! >= 10000);
    assert.equal(payload.consecutiveToolFailures, 3);
    assert.ok(payload.thresholds);
  });

  it("needs_attention takes priority over active_long_running for label", () => {
    // If a task is both long-running AND idle, needs_attention is more actionable.
    const start = new Date(Date.now() - 10000).toISOString();
    const tracker = createSubagentActivityTracker(0, start, thresholds);
    const now = Date.now();
    // lastActivity was at start, so idle for 10s > idleMs(1s), and total 10s > longRunningMs(5s)
    const state = classifySubagentControlState(tracker, thresholds, now);
    assert.equal(state, "needs_attention");
  });
});
