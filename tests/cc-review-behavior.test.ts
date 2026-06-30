import test, { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import child_process from "node:child_process";
import { mock } from "node:test";
import { EventEmitter } from "node:events";

import ccReviewExtension, {
  appendPersistedLogEntry,
  buildBuiltinGeneratorAgent,
  buildCcReviewStatusText,
  buildCcReviewWidgetLines,
  buildPriorTaskHandoff,
  buildSubagentTaskPrompt,
  priorTaskHandoffFromResults,
  classifyCcReviewSummary,
  computeChecklistWindow,
  countCcReviewTaskOutcomesFromSummary,
  discoverAgent,
  filterCcReviewLogEntries,
  formatSubprocessStreamLine,
  inferSubprocessStreamSeverity,
  formatCcReviewSummaryHeadline,
  formatPhaseSeverityLine,
  normalizeCcReviewLogEntry,
  previewWidgetText,
  renderCcReviewLogEntry,
  resolveCcReviewLogLevel,
  resolveReviewMode,
  summarizeLogSeverities,
  summarizeSubagentToolActivity,
  truncateForWidget,
} from "../.pi/extensions/cc-review.ts";

const plainWidgetTheme = { fg: (_color: string, text: string) => text };

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
    const source = fs.readFileSync(".pi/extensions/cc-review.ts", "utf8");
    const widgetSection = source.slice(source.indexOf("export function buildCcReviewWidgetLines"));
    assert.match(
      widgetSection,
      /formatPhaseSeverityLine\(state\.currentPhase, state\.liveLogs, \{ theme \}\)/
    );
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
  it("uses explicit value, environment fallback, and the per-task default", () => {
    assert.equal(resolveReviewMode(" after-all "), "after-all");
    assert.equal(
      resolveReviewMode(undefined, { CC_REVIEW_MODE: "per-task" } as NodeJS.ProcessEnv),
      "per-task"
    );
    assert.equal(resolveReviewMode(undefined, {} as NodeJS.ProcessEnv), "per-task");
  });

  it("rejects unsupported explicit and environment values", () => {
    assert.throws(() => resolveReviewMode("batch"), /Invalid reviewMode value "batch"/);
    assert.throws(
      () => resolveReviewMode(undefined, { CC_REVIEW_MODE: "later" } as NodeJS.ProcessEnv),
      /Invalid CC_REVIEW_MODE value "later"/
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

class MockChildProcess extends EventEmitter {
  pid = 99999;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  autoReviewStdout = false;
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
    assert.equal(registeredTool.parameters.properties.reviewProvider.enum, undefined);
    assert.equal((piMock as any).codex_workflow, undefined);
    assert.equal((piMock as any).codexWorkflow, undefined);
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
      { goal: "Build with Claude reviewer" },
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

    const tracePath = path.join(tempTestDir, "workflow-trace.jsonl");
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
      { goal: "Build with Claude request" },
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

    const result = await registeredTool.execute(
      "tool-call-1",
      { goal: "Build a perfect calculator app" },
      undefined,
      undefined,
      { cwd: tempTestDir }
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.details.status, "completed");

    assert.equal(plannerCalls, 1);
    assert.equal(subagentCalls, 2);
    assert.equal(reviewerCalls, 2);

    const reportText = result.content[0].text;
    assert.match(reportText, /## 🏆 CC Review Orchestrator Report/);
    assert.match(reportText, /Calculator/i);
    assert.match(reportText, /Completed and reviewed/);
    assert.match(reportText, /Task 1/);
    assert.match(reportText, /Task 2/);

    const tracePath = path.join(tempTestDir, "workflow-trace.jsonl");
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
    assert.deepEqual(artifactFiles, ["task-001.json", "task-002.json"]);
    for (const artifactFile of artifactFiles) {
      const artifact = JSON.parse(
        fs.readFileSync(path.join(artifactRoot, runDirs[0], artifactFile), "utf8")
      );
      assert.equal(artifact.review.effectiveVerdict, "ship");
      assert.equal(artifact.workflow.haltedOnReview, false);
    }
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
      { goal: "Multi-step app build" },
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
    mockSpawnHandler = (command, args) => {
      if (command === "codex" && args.includes("-o")) {
        plannerCalls++;
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
    const tracePath = path.join(tempTestDir, "workflow-trace.jsonl");
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
    const widgetSnapshots: string[][] = [];
    const statusSnapshots: string[] = [];
    const captureCtx = {
      cwd: tempTestDir,
      ui: {
        setWidget: (_id: string, content: Parameters<typeof captureWidgetLines>[0]) => {
          const lines = captureWidgetLines(content);
          if (lines) widgetSnapshots.push(lines);
        },
        setStatus: (_id: string, value: string | undefined) => {
          if (value) statusSnapshots.push(value);
        },
      },
    };

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
      captureCtx
    );

    assert.equal(result.isError, undefined);
    assert.ok(widgetSnapshots.length > 0, "widget should be rendered at least once");
    const earliestSnapshot = widgetSnapshots[0].join("\n");
    // Before logs accumulate the renderer should advertise an explicit empty state OR a planning phase.
    assert.ok(
      /No logs yet|Planning tasks|Waiting for planner/.test(earliestSnapshot),
      `earliest widget snapshot should show an explicit empty/planning state, got:\n${earliestSnapshot}`
    );
    // Every snapshot should advertise the persisted log file.
    assert.ok(widgetSnapshots.every((snap) => snap.some((line) => line.includes("workflow-logs.jsonl"))),
      "every widget snapshot should reference the persisted log file name");
    // After the reviewer warning we should see the warning marker somewhere in the trail.
    const warningSeen = widgetSnapshots.some((snap) => snap.some((line) => /Warning:/i.test(line)));
    assert.ok(warningSeen, "reviewer warning should surface in the widget");
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

  it("provides a built-in generator fallback when no agent file is installed", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-empty-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    try {
      const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-empty-cwd-"));
      const agent = discoverAgent("generator", "both", isolatedCwd);
      assert.ok(agent, "generator should be discoverable via the built-in fallback");
      assert.equal(agent?.name, "generator");
      assert.equal(agent?.filePath, "<builtin>");
      assert.ok(/built-in generator subagent/i.test(agent?.systemPrompt || ""));
      // An unknown agent should still return undefined when no file is present.
      assert.equal(discoverAgent("definitely-missing-agent", "both", isolatedCwd), undefined);
      // The exported builder produces the same lightweight prompt.
      const builtin = buildBuiltinGeneratorAgent();
      assert.equal(builtin.name, "generator");
      assert.equal(builtin.filePath, "<builtin>");
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
