import "./mock-tui.ts";
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import ccReviewExtension, {
  buildCcReviewWidgetLines,
  buildCcReviewStatusText,
  getStatusColorForDisplayState,
  classifyCcReviewSummary,
  countCcReviewTaskOutcomesFromSummary,
  formatCcReviewSummaryHeadline,
  measureVisibleWidth,
  emptyFindingsRollup,
  getTaskVisuals,
  appendPersistedLogEntry,
  resolveCcReviewLogSources,
  parseCcReviewCommandArgs,
  type CcReviewWidgetState,
  type CcReviewLogEntry,
} from "../.pi/extensions/cc-review.ts";

const plainWidgetTheme = { fg: (_color: string, text: string) => text };

// Mock default state template
function createBaseState(custom: Partial<CcReviewWidgetState> = {}): CcReviewWidgetState {
  return {
    goal: "Implement a feature with great performance and high test coverage",
    tasks: [
      { title: "Initialize the repository and basic configuration" },
      { title: "Write baseline features and business logic" },
      { title: "Write unit tests and perform coverage review" },
    ],
    currentTaskIndex: 1,
    displayState: "executing",
    currentPhase: "Running unit tests...",
    liveLogs: [
      { timestamp: "2026-06-30T12:00:00.000Z", severity: "info", source: "test", message: "Starting tests..." },
      { timestamp: "2026-06-30T12:00:01.000Z", severity: "info", source: "test", message: "Tests succeeded" },
    ],
    resolvedLogLevel: "info",
    resolvedWidgetLogLines: 3,
    resolvedChecklistWindow: 5,
    persistedLogPath: "/workspace/workflow-logs.jsonl",
    findingsRollup: emptyFindingsRollup(),
    taskStatuses: ["completed", undefined, undefined],
    ...custom,
  };
}

describe("CC Review UI Regression Tests", () => {
  // 1. Status Bar Tests (buildCcReviewStatusText)
  describe("buildCcReviewStatusText with various states", () => {
    it("handles planning/initializing with no tasks", () => {
      const state = {
        tasks: [],
        currentTaskIndex: 0,
        displayState: "planning" as const,
        currentPhase: "Planning",
      };
      const text = buildCcReviewStatusText(state);
      assert.match(text, /Planning/);
    });

    it("handles planning with tasks", () => {
      const state = {
        tasks: [{}, {}],
        currentTaskIndex: 0,
        displayState: "planning" as const,
        currentPhase: "Planning",
      };
      const text = buildCcReviewStatusText(state);
      assert.match(text, /Task 0\/2 Planning/);
    });

    it("handles executing status", () => {
      const state = {
        tasks: [{}, {}, {}],
        currentTaskIndex: 1,
        displayState: "executing" as const,
        currentPhase: "Executing",
      };
      const text = buildCcReviewStatusText(state);
      assert.match(text, /Task 2\/3 Executing/);
    });

    it("handles reviewing status", () => {
      const state = {
        tasks: [{}, {}],
        currentTaskIndex: 0,
        displayState: "reviewing" as const,
      };
      const text = buildCcReviewStatusText(state);
      assert.match(text, /Task 1\/2 Reviewing/);
    });

    it("handles warning status", () => {
      const state = {
        tasks: [{}, {}],
        currentTaskIndex: 1,
        displayState: "warning" as const,
      };
      const text = buildCcReviewStatusText(state);
      assert.match(text, /Task 2\/2 Warning/);
    });

    it("handles retrying status with retryState", () => {
      const state = {
        tasks: [{}, {}],
        currentTaskIndex: 0,
        displayState: "retrying" as const,
        retryState: { attempt: 2, maxAttempts: 3 },
      };
      const text = buildCcReviewStatusText(state);
      assert.match(text, /Task 1\/2 Retrying \u27f32\/3/);
    });

    it("handles complete status", () => {
      const state = {
        tasks: [{}, {}],
        currentTaskIndex: 2,
        displayState: "complete" as const,
      };
      const text = buildCcReviewStatusText(state);
      assert.match(text, /Task 2\/2 Complete/);
    });

    it("handles cancelled status with progress", () => {
      const state = {
        tasks: [{}, {}],
        currentTaskIndex: 1,
        displayState: "cancelled" as const,
      };
      const text = buildCcReviewStatusText(state);
      assert.match(text, /Task 2\/2 Cancelled/);
    });

    it("handles cancelled status without progress", () => {
      const state = {
        tasks: [],
        currentTaskIndex: 0,
        displayState: "cancelled" as const,
      };
      const text = buildCcReviewStatusText(state);
      assert.match(text, /Cancelled/);
    });

    it("handles timeout status with progress", () => {
      const state = {
        tasks: [{}, {}, {}],
        currentTaskIndex: 1,
        displayState: "timeout" as const,
      };
      const text = buildCcReviewStatusText(state);
      assert.match(text, /Task 2\/3 Timeout/);
    });

    it("handles timeout status without progress", () => {
      const state = {
        tasks: [],
        currentTaskIndex: 0,
        displayState: "timeout" as const,
      };
      const text = buildCcReviewStatusText(state);
      assert.match(text, /Timeout/);
    });
  });

  // 1b. Status Bar Color Mapping Tests (getStatusColorForDisplayState)
  describe("getStatusColorForDisplayState helper", () => {
    it("maps displayStates to correct theme colors", () => {
      assert.equal(getStatusColorForDisplayState("initializing"), "accent");
      assert.equal(getStatusColorForDisplayState("planning"), "accent");
      assert.equal(getStatusColorForDisplayState("executing"), "accent");
      assert.equal(getStatusColorForDisplayState("reviewing"), "accent");
      assert.equal(getStatusColorForDisplayState("complete"), "success");
      assert.equal(getStatusColorForDisplayState("retrying"), "warning");
      assert.equal(getStatusColorForDisplayState("warning"), "warning");
      assert.equal(getStatusColorForDisplayState("failed"), "error");
      assert.equal(getStatusColorForDisplayState("cancelled"), "error");
      assert.equal(getStatusColorForDisplayState("timeout"), "error");
    });

    it("handles failed status with and without task progress", () => {
      assert.match(buildCcReviewStatusText({
        tasks: [{}, {}],
        currentTaskIndex: 0,
        displayState: "failed",
      }), /Task 1\/2 Failed/);
      assert.match(buildCcReviewStatusText({
        tasks: [],
        currentTaskIndex: -1,
        displayState: "failed",
      }), /Failed/);
    });
  });

  // 2. Summary Badge and Headline (classifyCcReviewSummary, countCcReviewTaskOutcomesFromSummary, formatCcReviewSummaryHeadline)
  describe("CcReview Summary processing", () => {
    it("classifies and counts success states", () => {
      const summary = "Some report text...\n**Status:** completed successfully accomplished";
      const badge = classifyCcReviewSummary(summary);
      assert.equal(badge, "success");

      const counts = countCcReviewTaskOutcomesFromSummary(summary);
      assert.equal(counts.completed, 1);
      assert.equal(counts.failed, 0);

      const headline = formatCcReviewSummaryHeadline(counts);
      assert.match(headline, /1 完成 · 0 警告 · 0 失败/);
    });

    it("classifies and counts failed/warning states", () => {
      const summary = "Report:\n**Status:** failed\n**Status:** blocked by reviewer\n**Status:** warning";
      const badge = classifyCcReviewSummary(summary);
      assert.equal(badge, "failed");

      const counts = countCcReviewTaskOutcomesFromSummary(summary);
      assert.equal(counts.completed, 0);
      assert.equal(counts.warnings, 1);
      assert.equal(counts.failed, 2);

      const headline = formatCcReviewSummaryHeadline(counts);
      assert.match(headline, /0 完成 · 1 警告 · 2 失败/);
    });

    it("classifies cancelled state", () => {
      const summary = "The workflow was cancelled or timed out.";
      const badge = classifyCcReviewSummary(summary);
      assert.equal(badge, "cancelled");
    });
  });

  // 3. Widget Line Length Validation under 40, 80, 120 Columns
  describe("buildCcReviewWidgetLines width constraints", () => {
    const widths = [40, 80, 120];

    const testStates = [
      {
        name: "No tasks / planning",
        state: createBaseState({
          tasks: [],
          displayState: "planning",
          liveLogs: [],
        }),
      },
      {
        name: "Executing",
        state: createBaseState({
          displayState: "executing",
          currentTaskIndex: 1,
        }),
      },
      {
        name: "Warning",
        state: createBaseState({
          displayState: "warning",
          lastTaskWarning: "Subagent warnings reported for testing",
        }),
      },
      {
        name: "Failed",
        state: createBaseState({
          displayState: "failed",
          taskStatuses: ["completed", "failed", undefined],
        }),
      },
      {
        name: "Timeout",
        state: createBaseState({
          displayState: "timeout",
          taskStatuses: ["completed", "failed", undefined],
        }),
      },
      {
        name: "Cancelled",
        state: createBaseState({
          displayState: "cancelled",
        }),
      },
      {
        name: "Complete",
        state: createBaseState({
          displayState: "complete",
          currentTaskIndex: 3,
          taskStatuses: ["completed", "completed", "completed"],
        }),
      },
    ];

    for (const width of widths) {
      for (const tState of testStates) {
        it(`ensures all lines are <= ${width} cols for state: "${tState.name}"`, () => {
          const lines = buildCcReviewWidgetLines(tState.state, {
            width,
            theme: plainWidgetTheme,
          });

          for (const line of lines) {
            const visibleWidth = measureVisibleWidth(line);
            assert.ok(
              visibleWidth <= width,
              `Line "${line}" has visible width ${visibleWidth} which exceeds max columns ${width}`
            );
          }
        });
      }
    }
  });

  // 4. Multibyte CJK (Chinese) character wrapping and truncation
  describe("Multibyte handling in Widget lines", () => {
    const widths = [40, 80, 120];

    it("correctly handles and truncates Chinese content in goals, tasks, and warnings", () => {
      const stateWithChinese = createBaseState({
        goal: "完成一个包含高度优化的系统并建立非常精细的UI回归测试，确保在所有列宽下都不发生换行超长或溢出",
        tasks: [
          { title: "建立UI回归测试文件用来测试40、80和120列的完美布局" },
          { title: "优化现有的组件化UI辅助函数确保中英文内容不超宽" },
        ],
        currentTaskIndex: 0,
        displayState: "warning",
        lastTaskWarning: "当前发现一个非常非常长并且需要截断的警告信息，以测试中文字符下的可见字符宽度限制",
        liveLogs: [
          { timestamp: "2026-06-30T12:00:00.000Z", severity: "warning", source: "test", message: "这是一个包含中文字符和英文混杂的日志：Testing Chinese layout correctness." }
        ],
      });

      for (const width of widths) {
        const lines = buildCcReviewWidgetLines(stateWithChinese, {
          width,
          theme: plainWidgetTheme,
        });

        for (const line of lines) {
          const visibleWidth = measureVisibleWidth(line);
          assert.ok(
            visibleWidth <= width,
            `Line "${line}" has visible width ${visibleWidth} which exceeds max columns ${width} under Chinese text testing`
          );
        }
      }
    });
  });

  // 5. Compact Layout validations on narrow terminals (< 50 columns)
  describe("Compact layout on narrow terminals (< 50 columns)", () => {
    const narrowWidths = [32, 40, 49];
    const nonCompactWidths = [50];

    it("verifies narrow widths (32, 40, 49) trigger compact layout and trim decorations/meta", () => {
      const state = createBaseState({
        goal: "Develop amazing features and verify with comprehensive tests",
        tasks: [
          { title: "Task number one" },
          { title: "Task number two" },
          { title: "Task number three" },
        ],
        currentTaskIndex: 1,
        displayState: "warning",
        lastTaskWarning: "Warning: Low disk space detected on remote runner",
      });

      for (const width of narrowWidths) {
        const lines = buildCcReviewWidgetLines(state, {
          width,
          theme: plainWidgetTheme,
        });

        // 1) Width Safety: all lines must conform to the width budget
        for (const line of lines) {
          const visibleWidth = measureVisibleWidth(line);
          assert.ok(
            visibleWidth <= width,
            `Line "${line}" exceeds width limit ${width} (actual: ${visibleWidth})`
          );
        }

        // 2) Border/Divider omission
        const hasDivider = lines.some((line) => line.includes("\u2501"));
        assert.ok(!hasDivider, `Compact mode at width ${width} should omit decorative dividers.`);

        // 3) 'Goal:' label abbreviation
        const hasGoalLabel = lines.some((line) => line.includes("Goal:"));
        assert.ok(!hasGoalLabel, `Compact mode at width ${width} should omit the 'Goal:' text.`);

        // 4) Checklist Window strictly constrained to 1 active task
        // We look for lines containing '[Task ' which is our task indicator
        const taskLines = lines.filter((line) => line.includes("[Task "));
        assert.equal(
          taskLines.length,
          1,
          `Compact mode at width ${width} should limit task checklist strictly to 1 active task (found ${taskLines.length})`
        );

        // 5) Verification of omission of headers and paths
        const hasLogsHeader = lines.some((line) => line.includes("Live Logs:"));
        const hasFullPath = lines.some((line) => line.includes("Full log:"));
        assert.ok(!hasLogsHeader, `Compact mode at width ${width} should omit 'Live Logs:' header.`);
        assert.ok(!hasFullPath, `Compact mode at width ${width} should omit 'Full log:' path.`);

        // 6) Essential warning state and current task is prioritized and present
        const hasWarning = lines.some((line) => line.includes("Low disk"));
        assert.ok(hasWarning, `Compact mode at width ${width} must retain the critical warning.`);

        const hasActiveTask = lines.some((line) => line.includes("Task 2/3"));
        assert.ok(hasActiveTask, `Compact mode at width ${width} must display the current active task.`);
      }
    });

    it("verifies width 50 does NOT trigger compact layout and keeps standard elements", () => {
      const state = createBaseState({
        goal: "Develop amazing features and verify with comprehensive tests",
        tasks: [
          { title: "Task number one" },
          { title: "Task number two" },
          { title: "Task number three" },
        ],
        currentTaskIndex: 1,
        displayState: "executing",
      });

      const width = 50;
      const lines = buildCcReviewWidgetLines(state, {
        width,
        theme: plainWidgetTheme,
      });

      // 1) Width Safety
      for (const line of lines) {
        const visibleWidth = measureVisibleWidth(line);
        assert.ok(
          visibleWidth <= width,
          `Line "${line}" exceeds standard width limit of 50 (actual: ${visibleWidth})`
        );
      }

      // 2) Keep standard dividers
      const hasDivider = lines.some((line) => line.includes("\u2501"));
      assert.ok(hasDivider, `Width 50 should retain decorative dividers.`);

      // 3) Keep 'Goal:' text
      const hasGoalLabel = lines.some((line) => line.includes("Goal:"));
      assert.ok(hasGoalLabel, `Width 50 should keep standard 'Goal:' label.`);

      // 4) Keep 'Live Logs:' header and 'Full log:' path
      const hasLogsHeader = lines.some((line) => line.includes("Live Logs:"));
      const hasFullPath = lines.some((line) => line.includes("Full log:"));
      assert.ok(hasLogsHeader, `Width 50 should keep 'Live Logs:' header.`);
      assert.ok(hasFullPath, `Width 50 should keep 'Full log:' path.`);
    });
  });

  // 6. Task Status Visual Semantics Tests
  describe("Task Status Visual Semantics - getTaskVisuals pure function", () => {
    const statuses: Array<"completed" | "completed_with_warnings" | "failed" | "validation_failed" | "review_blocked" | "skipped" | "cancelled" | "running" | "pending"> = [
      "completed",
      "completed_with_warnings",
      "failed",
      "validation_failed",
      "review_blocked",
      "skipped",
      "cancelled",
      "running",
      "pending",
    ];

    it("ensures each status maps to unique, stable marker and distinct colors", () => {
      const markers = new Set<string>();
      for (const status of statuses) {
        const visuals = getTaskVisuals(status);
        assert.ok(visuals.marker, `Status ${status} must have a non-empty marker`);
        assert.ok(visuals.markerColor, `Status ${status} must have a non-empty markerColor`);
        assert.ok(visuals.titleColor, `Status ${status} must have a non-empty titleColor`);

        // Check uniqueness of symbols (markers)
        assert.ok(!markers.has(visuals.marker), `Marker '${visuals.marker}' for status '${status}' is not unique!`);
        markers.add(visuals.marker);

        // Specific assertions to ensure completed_with_warnings, skipped, cancelled do not look like normal success
        if (status === "completed_with_warnings") {
          assert.equal(visuals.markerColor, "warning");
          assert.equal(visuals.titleColor, "warning");
        }
        if (status === "skipped") {
          assert.equal(visuals.markerColor, "muted");
          assert.equal(visuals.titleColor, "dim");
        }
        if (status === "cancelled") {
          assert.equal(visuals.markerColor, "muted");
          assert.equal(visuals.titleColor, "dim");
        }
      }
    });
  });

  describe("Task Status Visual Semantics - renderer integration", () => {
    it("renders each task state accurately with different markers and colors", () => {
      const state = createBaseState({
        tasks: [
          { title: "Task 1: Completed" },
          { title: "Task 2: Warning" },
          { title: "Task 3: Failed" },
          { title: "Task 4: Valid Failed" },
          { title: "Task 5: Blocked" },
          { title: "Task 6: Skipped" },
          { title: "Task 7: Cancelled" },
          { title: "Task 8: Running (Implicit)" },
          { title: "Task 9: Pending (Implicit)" },
        ],
        currentTaskIndex: 7,
        taskStatuses: [
          "completed",
          "completed_with_warnings",
          "failed",
          "validation_failed",
          "review_blocked",
          "skipped",
          "cancelled",
          undefined, // index 7 -> running fallbacks
          undefined, // index 8 -> pending fallbacks
        ],
        resolvedChecklistWindow: 10,
      });

      const themeMock = {
        fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
      };

      const lines = buildCcReviewWidgetLines(state, {
        width: 120,
        theme: themeMock,
      });

      // Filter to the checklist section
      const taskLines = lines.filter((line) => line.includes("[Task "));

      assert.equal(taskLines.length, 9);

      // Verify each rendered task line has the exact expected marker and colors
      // Task 1: Completed -> ✔ in [success], title in [dim]
      assert.match(taskLines[0], /\[success\]\u2714\[\/success\].*\[dim\]Task 1/);
      // Task 2: Warning -> ⚠️ in [warning], title in [warning]
      assert.match(taskLines[1], /\[warning\]\u26a0\[\/warning\].*\[warning\]Task 2/);
      // Task 3: Failed -> ✘ in [error], title in [error]
      assert.match(taskLines[2], /\[error\]\u2718\[\/error\].*\[error\]Task 3/);
      // Task 4: Valid Failed -> ✖ in [error], title in [error]
      assert.match(taskLines[3], /\[error\]\u2716\[\/error\].*\[error\]Task 4/);
      // Task 5: Blocked -> ⛔ in [error], title in [error]
      assert.match(taskLines[4], /\[error\]\u26d4\[\/error\].*\[error\]Task 5/);
      // Task 6: Skipped -> ↪ in [muted], title in [dim]
      assert.match(taskLines[5], /\[muted\]\u21aa\[\/muted\].*\[dim\]Task 6/);
      // Task 7: Cancelled -> ⊘ in [muted], title in [dim]
      assert.match(taskLines[6], /\[muted\]\u2298\[\/muted\].*\[dim\]Task 7/);
      // Task 8: Running (Implicit) -> ▸ in [accent], title in [text]
      assert.match(taskLines[7], /\[accent\]\u25b8\[\/accent\].*\[text\]Task 8/);
      // Task 9: Pending (Implicit) -> ☐ in [dim], title in [muted]
      assert.match(taskLines[8], /\[dim\]\u2610\[\/dim\].*\[muted\]Task 9/);
    });
  });

  // 6b. Failed, Cancelled, and Timeout Widget State Rendering
  describe("Failed, Cancelled, and Timeout Widget State Rendering", () => {
    it("renders Failed state with 'Workflow failed' in theme error color", () => {
      const state = createBaseState({
        displayState: "failed",
      });
      const themeMock = {
        fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
      };
      const lines = buildCcReviewWidgetLines(state, {
        width: 120,
        theme: themeMock,
      });
      const failedLine = lines.find((l) => l.includes("Workflow failed"));
      assert.ok(failedLine, "Should find 'Workflow failed' line");
      assert.match(failedLine, /\[error\].*Workflow failed.*\[\/error\]/);
    });

    it("renders Cancelled state with 'Cancelled by user' in theme error color", () => {
      const state = createBaseState({
        displayState: "cancelled",
      });
      const themeMock = {
        fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
      };
      const lines = buildCcReviewWidgetLines(state, {
        width: 120,
        theme: themeMock,
      });
      const cancelledLine = lines.find((l) => l.includes("Cancelled by user"));
      assert.ok(cancelledLine, "Should find 'Cancelled by user' line");
      assert.match(cancelledLine, /\[error\].*Cancelled by user.*\[\/error\]/);
    });

    it("renders Timeout state with 'Timed out' in theme error color", () => {
      const state = createBaseState({
        displayState: "timeout",
      });
      const themeMock = {
        fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
      };
      const lines = buildCcReviewWidgetLines(state, {
        width: 120,
        theme: themeMock,
      });
      const timeoutLine = lines.find((l) => l.includes("Timed out"));
      assert.ok(timeoutLine, "Should find 'Timed out' line");
      assert.match(timeoutLine, /\[error\].*Timed out.*\[\/error\]/);
    });
  });

  // 6c. Subagent Model Display in TUI Widget Checklist
  describe("Subagent Model Display in TUI Widget Checklist", () => {
    it("renders model name when present and fallback to 'Unknown model' when absent for non-pending tasks", () => {
      const state = createBaseState({
        tasks: [
          { title: "Task with explicit model", status: "completed", model: "anthropic/claude-3-5" },
          { title: "Task with missing model", status: "completed" },
          { title: "Task in pending status", status: "pending" },
        ],
        taskStatuses: ["completed", "completed", undefined],
        currentTaskIndex: 2,
      });

      const themeMock = {
        fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
      };

      const lines = buildCcReviewWidgetLines(state, {
        width: 120,
        theme: themeMock,
      });

      const taskLines = lines.filter((line) => line.includes("[Task "));
      assert.equal(taskLines.length, 3);

      // Task 1: Completed with model -> displays the model name
      assert.match(taskLines[0], /\[muted\]\[anthropic\/claude-3-5\]\[\/muted\]/);
      // Task 2: Completed with missing model -> displays 'Unknown model' fallback
      assert.match(taskLines[1], /\[muted\]\[Unknown model\]\[\/muted\]/);
      // Task 3: Pending task -> does not show model display at all
      assert.doesNotMatch(taskLines[2], /Unknown model/);
    });
  });

  // 7. Log Filtering and Hidden Hints Tests
  describe("Log Filtering and Hidden Hints", () => {
    it("displays '1 log hidden' when exactly one log is filtered out", () => {
      const state = createBaseState({
        resolvedLogLevel: "info",
        liveLogs: [
          { timestamp: "2026-06-30T12:00:00.000Z", severity: "info", source: "test", message: "Info log" },
          { timestamp: "2026-06-30T12:00:01.000Z", severity: "debug", source: "test", message: "Debug log" },
        ],
      });

      const lines = buildCcReviewWidgetLines(state, { width: 80, theme: plainWidgetTheme });
      const hiddenLine = lines.find(line => line.includes("hidden"));
      assert.ok(hiddenLine, "Should find a line with hidden status info");
      assert.match(hiddenLine, /1 log hidden/);
    });

    it("displays 'N logs hidden' when multiple logs are filtered out", () => {
      const state = createBaseState({
        resolvedLogLevel: "warning",
        liveLogs: [
          { timestamp: "2026-06-30T12:00:00.000Z", severity: "info", source: "test", message: "Info log" },
          { timestamp: "2026-06-30T12:00:01.000Z", severity: "debug", source: "test", message: "Debug log" },
          { timestamp: "2026-06-30T12:00:02.000Z", severity: "warning", source: "test", message: "Warning log" },
        ],
      });

      const lines = buildCcReviewWidgetLines(state, { width: 80, theme: plainWidgetTheme });
      const hiddenLine = lines.find(line => line.includes("hidden"));
      assert.ok(hiddenLine, "Should find a line with hidden status info");
      assert.match(hiddenLine, /2 logs hidden/);
    });

    it("does not show hint line when no filtering occurs", () => {
      const state = createBaseState({
        resolvedLogLevel: "debug",
        liveLogs: [
          { timestamp: "2026-06-30T12:00:00.000Z", severity: "info", source: "test", message: "Info log" },
          { timestamp: "2026-06-30T12:00:01.000Z", severity: "debug", source: "test", message: "Debug log" },
        ],
      });

      const lines = buildCcReviewWidgetLines(state, { width: 80, theme: plainWidgetTheme });
      const hasHiddenHint = lines.some(line => line.includes("hidden"));
      assert.strictEqual(hasHiddenHint, false, "Should not display hidden logs count hint");
    });

    it("ensures hint text respects narrow terminal width constraints", () => {
      const state = createBaseState({
        resolvedLogLevel: "warning",
        liveLogs: [
          { timestamp: "2026-06-30T12:00:00.000Z", severity: "info", source: "test", message: "Info log" },
          { timestamp: "2026-06-30T12:00:01.000Z", severity: "debug", source: "test", message: "Debug log" },
        ],
      });

      const narrowWidths = [32, 40, 49];
      for (const w of narrowWidths) {
        const lines = buildCcReviewWidgetLines(state, { width: w, theme: plainWidgetTheme });
        const hiddenLine = lines.find(line => line.includes("hidden"));
        assert.ok(hiddenLine, `Should find hidden log hint at width ${w}`);
        assert.ok(measureVisibleWidth(hiddenLine) <= w, `Hint line length must be <= ${w}`);
      }
    });

    it("ensures appendPersistedLogEntry persists all logs directly to file regardless of logLevel filtering", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-test-"));
      const testFilePath = path.join(tempDir, "workflow-logs-test.jsonl");
      
      let pState = { filePath: testFilePath, appendedLineCount: 0 };
      
      const logsToPersist = [
        { timestamp: "2026-06-30T12:00:00.000Z", severity: "debug", source: "test", message: "Debug level log" },
        { timestamp: "2026-06-30T12:00:01.000Z", severity: "info", source: "test", message: "Info level log" },
        { timestamp: "2026-06-30T12:00:02.000Z", severity: "warning", source: "test", message: "Warning level log" },
        { timestamp: "2026-06-30T12:00:03.000Z", severity: "error", source: "test", message: "Error level log" },
      ];
      
      for (const log of logsToPersist) {
        pState = appendPersistedLogEntry(pState, log);
      }
      
      const fileContent = fs.readFileSync(testFilePath, "utf8");
      const linesContent = fileContent.trim().split("\n");
      assert.strictEqual(linesContent.length, 4, "Should write all 4 log entries to workflow-logs.jsonl file");
      
      // Verify debug log is inside the file
      assert.ok(fileContent.includes("Debug level log"), "File should contain debug log even if filtered in widget");
      assert.ok(fileContent.includes("Info level log"), "File should contain info log");
      assert.ok(fileContent.includes("Warning level log"), "File should contain warning log");
      assert.ok(fileContent.includes("Error level log"), "File should contain error log");
      
      // Clean up
      fs.unlinkSync(testFilePath);
      fs.rmdirSync(tempDir);
    });
  });

  // 8. Log Sources Filtering and Widget Display Tests
  describe("Log Sources Filtering and Widget Display", () => {
    // DOD-1: Precedence resolution and combinations
    it("resolves sources with correct precedence and normalizes combination inputs", () => {
      // Flag precedence
      const res1 = resolveCcReviewLogSources({
        flag: "PLANNER, subagent",
        env: { CC_REVIEW_LOG_SOURCES: "reviewer" },
      });
      assert.strictEqual(res1.source, "flag");
      assert.deepEqual(res1.sources, ["planner", "subagent"]);

      // Env precedence
      const res2 = resolveCcReviewLogSources({
        env: { CC_REVIEW_LOG_SOURCES: "   REVIEWER,   cc-review  " },
      });
      assert.strictEqual(res2.source, "env");
      assert.deepEqual(res2.sources, ["reviewer", "cc-review"]);

      // Default (undefined)
      const res3 = resolveCcReviewLogSources({});
      assert.strictEqual(res3.source, "default");
      assert.strictEqual(res3.sources, undefined);

      // Empty configuration parses as [] (empty whitelist)
      const res4 = resolveCcReviewLogSources({ flag: "" });
      assert.strictEqual(res4.source, "flag");
      assert.deepEqual(res4.sources, []);

      const res5 = resolveCcReviewLogSources({ flag: "  ,  " });
      assert.strictEqual(res5.source, "flag");
      assert.deepEqual(res5.sources, []);
    });

    it("parses --log-sources flag correctly via command args parser", () => {
      const parsed = parseCcReviewCommandArgs("Run some goal --log-sources planner,subagent");
      assert.strictEqual(parsed.goal, "Run some goal");
      assert.strictEqual(parsed.logSources, "planner,subagent");

      const parsedEmpty = parseCcReviewCommandArgs("Run some goal --log-sources");
      assert.strictEqual(parsedEmpty.goal, "Run some goal");
      assert.strictEqual(parsedEmpty.logSources, "");
    });

    it("parses and validates --review-repair-rounds", () => {
      const spaced = parseCcReviewCommandArgs("Run some goal --review-repair-rounds 2");
      assert.strictEqual(spaced.goal, "Run some goal");
      assert.strictEqual(spaced.reviewRepairRounds, 2);

      const equals = parseCcReviewCommandArgs("--review-repair-rounds=0 Run once");
      assert.strictEqual(equals.goal, "Run once");
      assert.strictEqual(equals.reviewRepairRounds, 0);

      assert.match(
        parseCcReviewCommandArgs("Run --review-repair-rounds -1").error ?? "",
        /Expected a non-negative integer/
      );
      assert.match(
        parseCcReviewCommandArgs("Run --review-repair-rounds=1.5").error ?? "",
        /Expected a non-negative integer/
      );
    });

    it("parses and validates --concurrency aliases", () => {
      const spaced = parseCcReviewCommandArgs("Run some goal --concurrency 3");
      assert.strictEqual(spaced.goal, "Run some goal");
      assert.strictEqual(spaced.concurrency, 3);

      const equals = parseCcReviewCommandArgs("--concurrency-limit=2 Run in parallel");
      assert.strictEqual(equals.goal, "Run in parallel");
      assert.strictEqual(equals.concurrency, 2);

      assert.match(
        parseCcReviewCommandArgs("Run --concurrency 0").error ?? "",
        /Expected a positive integer/
      );
      assert.match(
        parseCcReviewCommandArgs("Run --concurrency-limit=1.5").error ?? "",
        /Expected a positive integer/
      );
    });

    // DOD-2: Invalid sources fallback and invalidInput property
    it("handles invalid sources by falling back to undefined and exposing invalidInput", () => {
      const res1 = resolveCcReviewLogSources({ flag: "planner,invalid_src" });
      assert.strictEqual(res1.sources, undefined);
      assert.strictEqual(res1.source, "default");
      assert.ok(res1.invalidInput);
      assert.strictEqual(res1.invalidInput.source, "flag");
      assert.strictEqual(res1.invalidInput.raw, "planner,invalid_src");

      const res2 = resolveCcReviewLogSources({ env: { CC_REVIEW_LOG_SOURCES: "wrong" } });
      assert.strictEqual(res2.sources, undefined);
      assert.strictEqual(res2.source, "default");
      assert.ok(res2.invalidInput);
      assert.strictEqual(res2.invalidInput.source, "env");
      assert.strictEqual(res2.invalidInput.raw, "wrong");
    });

    // DOD-3: Filtering affecting widget display and hidden logs count rollups
    it("correctly filters widget logs and counts hidden logs including source filtering", () => {
      const state = createBaseState({
        resolvedLogSources: ["planner", "subagent"],
        liveLogs: [
          { timestamp: "2026-06-30T12:00:00.000Z", severity: "info", source: "planner", message: "Planner message" },
          { timestamp: "2026-06-30T12:00:01.000Z", severity: "info", source: "reviewer", message: "Reviewer message (filtered out)" },
          { timestamp: "2026-06-30T12:00:02.000Z", severity: "info", source: "subagent", message: "Subagent message" },
          { timestamp: "2026-06-30T12:00:03.000Z", severity: "debug", source: "planner", message: "Planner debug (filtered by default info severity)" },
        ],
      });

      const lines = buildCcReviewWidgetLines(state, { width: 80, theme: plainWidgetTheme });
      
      // We expect planner/subagent info logs to be shown
      const hasPlanner = lines.some(line => line.includes("Planner message"));
      const hasSubagent = lines.some(line => line.includes("Subagent message"));
      const hasReviewer = lines.some(line => line.includes("Reviewer message"));
      const hasDebug = lines.some(line => line.includes("Planner debug"));

      assert.ok(hasPlanner, "Planner message should be kept");
      assert.ok(hasSubagent, "Subagent message should be kept");
      assert.strictEqual(hasReviewer, false, "Reviewer message should be filtered by sources");
      assert.strictEqual(hasDebug, false, "Debug message should be filtered by severity");

      // Verify hidden count rolls up both
      const hiddenLine = lines.find(line => line.includes("hidden"));
      assert.ok(hiddenLine, "Should display hidden logs hint");
      assert.match(hiddenLine, /2 logs hidden/, "Should report 2 hidden logs (1 from source, 1 from severity)");
    });

    // DOD-4: Widget active filter header display
    it("displays active source filter state in the widget header in non-compact mode", () => {
      // 1) Active filter displaying sources
      const state1 = createBaseState({
        resolvedLogSources: ["planner", "subagent"],
        liveLogs: [{ timestamp: "2026-06-30T12:00:00.000Z", severity: "info", source: "planner", message: "Log" }],
      });
      const lines1 = buildCcReviewWidgetLines(state1, { width: 80, theme: plainWidgetTheme });
      const hasActiveHeader = lines1.some(line => line.includes("Live Logs (sources: planner, subagent):"));
      assert.ok(hasActiveHeader, "Header should mention active sources planner, subagent");

      // 2) Active empty filter displaying 'none'
      const state2 = createBaseState({
        resolvedLogSources: [],
        liveLogs: [{ timestamp: "2026-06-30T12:00:00.000Z", severity: "info", source: "planner", message: "Log" }],
      });
      const lines2 = buildCcReviewWidgetLines(state2, { width: 80, theme: plainWidgetTheme });
      const hasNoneHeader = lines2.some(line => line.includes("Live Logs (sources: none):"));
      assert.ok(hasNoneHeader, "Header should mention 'sources: none' when whitelist is empty");

      // 3) Standard header when no filter is applied
      const state3 = createBaseState({
        resolvedLogSources: undefined,
        liveLogs: [{ timestamp: "2026-06-30T12:00:00.000Z", severity: "info", source: "planner", message: "Log" }],
      });
      const lines3 = buildCcReviewWidgetLines(state3, { width: 80, theme: plainWidgetTheme });
      const hasDefaultHeader = lines3.some(line => line.trim() === "📝 Live Logs:");
      assert.ok(hasDefaultHeader, "Header should fallback to standard 'Live Logs:' when source filter is not active");
    });
  });

  // 9. cc-review-summary Custom Message Renderer Tests
  describe("cc-review-summary Custom Message Renderer", () => {
    let registeredRenderer: Function | undefined;
    const mockPi = {
      registerCommand() {},
      registerTool() {},
      registerMessageRenderer(type: string, renderer: any) {
        if (type === "cc-review-summary") {
          registeredRenderer = renderer;
        }
      },
    };

    ccReviewExtension(mockPi as any);

    it("DOD-1: prefers structured CcReviewSummaryMeta to extract counts precisely", () => {
      assert.ok(registeredRenderer, "Renderer must have been registered");
      
      const message = {
        content: "This text has misleading counts like 99 完成 · 99 警告 · 99 失败",
        details: {
          taskOutcomes: {
            completed: 3,
            warning: 1,
            failed: 0,
            review_blocked: 1,
          },
          topBlockers: [],
        },
      };

      const mockTheme = {
        fg: (color: string, text: string) => `fg(${color})[${text}]`,
        bg: (color: string, text: string) => `bg(${color})[${text}]`,
      };

      const box = registeredRenderer!(message, { expanded: false }, mockTheme);
      const textNode = box.children[0];
      assert.ok(textNode, "Box should have a text child");
      
      // Since completed=3, warning=1, failed=0+review_blocked(1)=1
      // The expected headline is "3 完成 · 1 警告 · 1 失败"
      assert.match(textNode.text, /3 完成 · 1 警告 · 1 失败/);
      assert.ok(!textNode.text.includes("99"), "Should not parse counts from markdown content when meta is present");
    });

    it("DOD-2: appends top blocker in fold state and preserves full report in expanded state", () => {
      assert.ok(registeredRenderer, "Renderer must have been registered");

      const message = {
        content: "Here is the markdown content.",
        details: {
          taskOutcomes: { completed: 1, warning: 0, failed: 1, review_blocked: 0 },
          topBlockers: [
            { priority: "P0", message: "Critical bug in authentication logic", file: "auth.ts", status: "unfixed" }
          ],
        },
      };

      const mockTheme = {
        fg: (color: string, text: string) => `fg(${color})[${text}]`,
        bg: (color: string, text: string) => `bg(${color})[${text}]`,
      };

      // 1) Fold state (expanded=false)
      const boxFold = registeredRenderer!(message, { expanded: false }, mockTheme);
      const textFold = boxFold.children[0].text;
      
      assert.match(textFold, /top blocker: \[P0\] Critical bug in authentication logic/);
      assert.match(textFold, /expand for full report/);

      // 2) Expanded state (expanded=true)
      const boxExpanded = registeredRenderer!(message, { expanded: true }, mockTheme);
      const textExpanded = boxExpanded.children[0].text;
      
      const titleLine = textExpanded.split("\n")[0];
      assert.ok(!titleLine.includes("top blocker"), "Expanded headline should not append top blocker");
      assert.match(textExpanded, /Here is the markdown content\./);
    });

    it("DOD-3: gracefully falls back to regex counts and badge when details/meta is absent", () => {
      assert.ok(registeredRenderer, "Renderer must have been registered");

      const messageWithoutDetails = {
        content: "A fallback report\n**Status:** completed\n**Status:** warning\n**Status:** failed",
        details: undefined,
      };

      const mockTheme = {
        fg: (color: string, text: string) => `fg(${color})[${text}]`,
        bg: (color: string, text: string) => `bg(${color})[${text}]`,
      };

      const box = registeredRenderer!(messageWithoutDetails, { expanded: false }, mockTheme);
      const textNode = box.children[0];
      
      assert.match(textNode.text, /1 完成 · 1 警告 · 1 失败/);
      assert.match(textNode.text, /CC Review WARN/);
    });
  });

  // 10. cc_review Tool Rendering Tests
  describe("cc_review Tool Rendering", () => {
    let registeredTool: any = undefined;
    const mockPi = {
      registerCommand() {},
      registerTool(tool: any) {
        if (tool.name === "cc_review") {
          registeredTool = tool;
        }
      },
      registerMessageRenderer() {},
    };

    ccReviewExtension(mockPi as any);

    const mockTheme = {
      fg: (color: string, text: string) => `fg(${color})[${text}]`,
      bg: (color: string, text: string) => `bg(${color})[${text}]`,
      bold: (text: string) => `bold(${text})`,
    };

    it("DOD-1: renderCall correctly displays a compact, truncated goal preview along with provider and reviewMode", () => {
      assert.ok(registeredTool, "Tool must have been registered");
      assert.ok(typeof registeredTool.renderCall === "function", "renderCall must be defined");

      const args = {
        goal: "This is an extremely long goal that should definitely be truncated because it exceeds forty characters of length",
        reviewProvider: "claude",
        reviewMode: "per-task",
      };

      const result = registeredTool.renderCall(args, mockTheme, {});
      assert.ok(result, "renderCall should return a component");
      assert.match(result.text, /cc_review/);
      assert.match(result.text, /This is an extremely long goal that sho\u2026/); // 40 chars limit
      assert.match(result.text, /provider: claude/);
      assert.match(result.text, /mode: per-task/);
    });

    it("DOD-2: renderResult handles streaming/partial progress and extracts last non-empty line", () => {
      assert.ok(typeof registeredTool.renderResult === "function", "renderResult must be defined");

      const partialResult = {
        content: [
          { type: "text", text: "Starting CC Review...\n[Subagent] Step 1 done" },
          { type: "text", text: "[Subagent] Running step 2...\n[Subagent] Complete step 2" }
        ],
        details: {
          goal: "A short goal",
          reviewProvider: "codex",
          reviewMode: "after-all",
        },
      };

      const component = registeredTool.renderResult(partialResult, { isPartial: true }, mockTheme);
      assert.ok(component, "renderResult should return a component for partial runs");
      assert.match(component.text, /Running/);
      assert.match(component.text, /Progress: \[Subagent\] Complete step 2/);
    });

    it("DOD-2: renderResult distinguishes finished states (success, warning, failed, cancelled)", () => {
      const renderDetails = {
        goal: "My goal",
        reviewProvider: "claude",
        reviewMode: "per-task",
      };

      // 1) Success
      const successResult = {
        content: [{ type: "text", text: "Summary report" }],
        details: {
          ...renderDetails,
          meta: {
            taskOutcomes: { completed: 3, warning: 0, failed: 0 }
          }
        }
      };
      const compSuccess = registeredTool.renderResult(successResult, { expanded: false }, mockTheme);
      assert.match(compSuccess.text, /Success/);
      assert.match(compSuccess.text, /provider: claude/);
      assert.match(compSuccess.text, /mode: per-task/);

      // 2) Warning
      const warningResult = {
        content: [{ type: "text", text: "Summary report with warnings" }],
        details: {
          ...renderDetails,
          meta: {
            taskOutcomes: { completed: 2, warning: 1, failed: 0 }
          }
        }
      };
      const compWarning = registeredTool.renderResult(warningResult, { expanded: false }, mockTheme);
      assert.match(compWarning.text, /Warning/);

      // 3) Failed
      const failedResult = {
        content: [{ type: "text", text: "Summary report with failures" }],
        details: {
          ...renderDetails,
          meta: {
            taskOutcomes: { completed: 2, warning: 0, failed: 1 }
          }
        }
      };
      const compFailed = registeredTool.renderResult(failedResult, { expanded: false }, mockTheme);
      assert.match(compFailed.text, /Failed/);

      // 4) Cancelled
      const cancelledResult = {
        isError: true,
        details: {
          ...renderDetails,
          error: "Workflow aborted by user",
        }
      };
      const compCancelled = registeredTool.renderResult(cancelledResult, { expanded: false }, mockTheme);
      assert.match(compCancelled.text, /Cancelled/);

      const structuredCancelledResult = {
        content: [{ type: "text", text: "Localized summary text without cancellation keywords" }],
        details: {
          ...renderDetails,
          meta: {
            taskOutcomes: { completed: 1, warning: 0, failed: 0, review_blocked: 0, cancelled: 1 },
          },
        },
      };
      const compStructuredCancelled = registeredTool.renderResult(
        structuredCancelledResult,
        { expanded: false },
        mockTheme,
      );
      assert.match(compStructuredCancelled.text, /Cancelled/);
    });

    it("DOD-2: renderResult appends full content when expanded=true", () => {
      const result = {
        content: [{ type: "text", text: "This is the complete markdown report details." }],
        details: {
          goal: "A goal",
          reviewProvider: "codex",
          reviewMode: "after-all",
          meta: {
            taskOutcomes: { completed: 1, warning: 0, failed: 0 }
          }
        }
      };
      // Collapsed (expanded=false)
      const compCollapsed = registeredTool.renderResult(result, { expanded: false }, mockTheme);
      assert.ok(!compCollapsed.text.includes("complete markdown report"), "Collapsed result should not include full report");

      // Expanded (expanded=true)
      const compExpanded = registeredTool.renderResult(result, { expanded: true }, mockTheme);
      assert.match(compExpanded.text, /complete markdown report/);
    });

    it("DOD-2 & DOD-3: renderResult extracts non-default provider and mode values from result.details, defaulting safely when details are absent", () => {
      // 1) Non-default values (claude and per-task)
      const resultClaude = {
        content: [{ type: "text", text: "Summary report" }],
        details: {
          goal: "Specific Goal",
          reviewProvider: "claude",
          reviewMode: "per-task",
          meta: {
            taskOutcomes: { completed: 1, warning: 0, failed: 0 }
          }
        }
      };
      const compClaude = registeredTool.renderResult(resultClaude, { expanded: false }, mockTheme);
      assert.match(compClaude.text, /provider: claude/);
      assert.match(compClaude.text, /mode: per-task/);

      // 2) Partial mode non-default values
      const compClaudePartial = registeredTool.renderResult(resultClaude, { isPartial: true }, mockTheme);
      assert.match(compClaudePartial.text, /provider: claude/);
      assert.match(compClaudePartial.text, /mode: per-task/);

      // 3) Default values when details is completely absent (undefined)
      const resultNoDetails = {
        content: [{ type: "text", text: "Summary report" }]
      };
      const compNoDetails = registeredTool.renderResult(resultNoDetails, { expanded: false }, mockTheme);
      assert.match(compNoDetails.text, /provider: codex/);
      assert.match(compNoDetails.text, /mode: after-all/);

      // 4) Default values when details properties are missing
      const resultMissingProps = {
        content: [{ type: "text", text: "Summary report" }],
        details: {
          goal: "Empty properties goal"
        }
      };
      const compMissingProps = registeredTool.renderResult(resultMissingProps, { expanded: false }, mockTheme);
      assert.match(compMissingProps.text, /provider: codex/);
      assert.match(compMissingProps.text, /mode: after-all/);
    });

    it("DOD-3: handles headless environments safely by returning undefined when pi-tui cannot load", async () => {
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const Module = require("node:module");
      const originalRequire = Module.prototype.require;
      Module.prototype.require = function (id: string) {
        if (id === "@earendil-works/pi-tui") {
          throw new Error("Cannot find module");
        }
        return originalRequire.apply(this, arguments);
      };

      try {
        const resCall = registeredTool.renderCall({}, mockTheme, {});
        assert.equal(resCall, undefined, "renderCall should return undefined in headless");

        const resResult = registeredTool.renderResult({}, {}, mockTheme);
        assert.equal(resResult, undefined, "renderResult should return undefined in headless");
      } finally {
        Module.prototype.require = originalRequire;
      }
    });
  });
});
