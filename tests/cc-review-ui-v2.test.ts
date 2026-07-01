import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildUiSnapshot,
  createDefaultOverlayState,
  resolveDefaultSelectedTaskIndex,
  generateFindingId,
  toActiveForm,
  type CcReviewUiSnapshot,
  type FindingUiRecord,
  type TaskUiRecord,
} from "../.pi/extensions/cc-review/workflow/ui/model.ts";

import {
  sortFindings,
  filterFindingsBySeverity,
  groupFindingsByFile,
  findAdjacentFinding,
  findAdjacentFile,
  getFindingsForFile,
  getHighestUnresolvedSeverity,
  getLatestExceptionLog,
  resolveRetainedSelection,
  resolveRetainedFile,
  countTasksByStatus,
} from "../.pi/extensions/cc-review/workflow/ui/selectors.ts";

import {
  detectPiUiCapabilities,
  resolveDetailEntryPoints,
  formatFooterEntryHint,
  canRenderCustomOverlay,
  DEFAULT_PI_UI_CAPABILITIES,
} from "../.pi/extensions/cc-review/workflow/ui/pi-adapter.ts";

import {
  renderCompactWidget,
} from "../.pi/extensions/cc-review/workflow/ui/compact-widget.ts";
import { measureVisibleWidth } from "../.pi/extensions/cc-review/workflow/ui.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<FindingUiRecord> = {}): FindingUiRecord {
  return {
    id: "f1",
    priority: "P2",
    file: "src/parser.ts",
    line: 42,
    message: "issue",
    status: "unfixed",
    ...overrides,
  };
}

function makeTask(index: number, overrides: Partial<TaskUiRecord> = {}): TaskUiRecord {
  return {
    index,
    title: `Task ${index + 1}`,
    activeForm: `Working on task ${index + 1}…`,
    description: "desc",
    status: "pending",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Model tests
// ---------------------------------------------------------------------------

describe("UI model (Spec2 Phase 0)", () => {
  it("generateFindingId is stable for the same inputs", () => {
    const id1 = generateFindingId("run-1", 0, "file.ts", 10, "P1", 0);
    const id2 = generateFindingId("run-1", 0, "file.ts", 10, "P1", 0);
    assert.equal(id1, id2);
  });

  it("generateFindingId differs for different inputs", () => {
    const id1 = generateFindingId("run-1", 0, "file.ts", 10, "P1", 0);
    const id2 = generateFindingId("run-1", 1, "file.ts", 10, "P1", 0);
    assert.notEqual(id1, id2);
  });

  it("toActiveForm converts title to active form", () => {
    assert.equal(toActiveForm("Implement parser"), "Working on implement parser…");
    // Title ending with "ing" uses the title directly (lowercased).
    assert.equal(toActiveForm("Refactoring"), "refactoring…");
    assert.equal(toActiveForm(""), "Working…");
  });

  it("createDefaultOverlayState returns closed tasks view", () => {
    const state = createDefaultOverlayState();
    assert.equal(state.isOpen, false);
    assert.equal(state.view, "tasks");
    assert.equal(state.focusedPanel, "navigation");
    assert.equal(state.severityFilter, "all");
    assert.equal(state.scrollOffset, 0);
  });

  it("resolveDefaultSelectedTaskIndex prefers running task", () => {
    const snapshot: CcReviewUiSnapshot = {
      runId: "r1",
      goal: "g",
      displayState: "executing",
      phase: "executing",
      startedAt: new Date().toISOString(),
      currentTaskIndex: 0,
      tasks: [
        makeTask(0, { status: "completed" }),
        makeTask(1, { status: "running" }),
        makeTask(2, { status: "pending" }),
      ],
      findings: [],
      logs: [],
      attempts: [],
      findingsRollup: { tasksReviewed: 0, ship: 0, shipWithWarnings: 0, blocked: 0, unfixedP0: 0, unfixedP1: 0, unfixedP2P3: 0 } as any,
      persistedLogPath: "",
      artifactRunDir: "",
    };
    assert.equal(resolveDefaultSelectedTaskIndex(snapshot), 1);
  });

  it("resolveDefaultSelectedTaskIndex falls back to first pending", () => {
    const snapshot: CcReviewUiSnapshot = {
      runId: "r1",
      goal: "g",
      displayState: "executing",
      phase: "executing",
      startedAt: new Date().toISOString(),
      currentTaskIndex: 0,
      tasks: [
        makeTask(0, { status: "completed" }),
        makeTask(1, { status: "pending" }),
      ],
      findings: [],
      logs: [],
      attempts: [],
      findingsRollup: { tasksReviewed: 0, ship: 0, shipWithWarnings: 0, blocked: 0, unfixedP0: 0, unfixedP1: 0, unfixedP2P3: 0 } as any,
      persistedLogPath: "",
      artifactRunDir: "",
    };
    assert.equal(resolveDefaultSelectedTaskIndex(snapshot), 1);
  });

  it("resolveDefaultSelectedTaskIndex falls back to first blocker", () => {
    const snapshot: CcReviewUiSnapshot = {
      runId: "r1",
      goal: "g",
      displayState: "failed",
      phase: "failed",
      startedAt: new Date().toISOString(),
      currentTaskIndex: 0,
      tasks: [
        makeTask(0, { status: "completed" }),
        makeTask(1, { status: "failed" }),
      ],
      findings: [],
      logs: [],
      attempts: [],
      findingsRollup: { tasksReviewed: 0, ship: 0, shipWithWarnings: 0, blocked: 0, unfixedP0: 0, unfixedP1: 0, unfixedP2P3: 0 } as any,
      persistedLogPath: "",
      artifactRunDir: "",
    };
    assert.equal(resolveDefaultSelectedTaskIndex(snapshot), 1);
  });

  it("resolveDefaultSelectedTaskIndex falls back to last task when all complete", () => {
    const snapshot: CcReviewUiSnapshot = {
      runId: "r1",
      goal: "g",
      displayState: "completed",
      phase: "completed",
      startedAt: new Date().toISOString(),
      currentTaskIndex: 0,
      tasks: [
        makeTask(0, { status: "completed" }),
        makeTask(1, { status: "completed" }),
      ],
      findings: [],
      logs: [],
      attempts: [],
      findingsRollup: { tasksReviewed: 0, ship: 0, shipWithWarnings: 0, blocked: 0, unfixedP0: 0, unfixedP1: 0, unfixedP2P3: 0 } as any,
      persistedLogPath: "",
      artifactRunDir: "",
    };
    assert.equal(resolveDefaultSelectedTaskIndex(snapshot), 1);
  });
});

// ---------------------------------------------------------------------------
// Selector tests
// ---------------------------------------------------------------------------

describe("UI selectors (Spec2 Phase 0)", () => {
  it("sortFindings orders by priority then file then line", () => {
    const findings: FindingUiRecord[] = [
      makeFinding({ id: "a", priority: "P2", file: "b.ts", line: 10 }),
      makeFinding({ id: "b", priority: "P1", file: "a.ts", line: 5 }),
      makeFinding({ id: "c", priority: "P2", file: "a.ts", line: 3 }),
      makeFinding({ id: "d", priority: "P0", file: "z.ts", line: 100 }),
    ];
    const sorted = sortFindings(findings);
    assert.deepEqual(sorted.map((f) => f.id), ["d", "b", "c", "a"]);
  });

  it("filterFindingsBySeverity filters by priority", () => {
    const findings: FindingUiRecord[] = [
      makeFinding({ id: "a", priority: "P1" }),
      makeFinding({ id: "b", priority: "P2" }),
      makeFinding({ id: "c", priority: "P1" }),
    ];
    assert.equal(filterFindingsBySeverity(findings, "all").length, 3);
    assert.equal(filterFindingsBySeverity(findings, "P1").length, 2);
    assert.equal(filterFindingsBySeverity(findings, "P3").length, 0);
  });

  it("groupFindingsByFile groups by file path", () => {
    const findings: FindingUiRecord[] = [
      makeFinding({ id: "a", file: "a.ts", line: 1 }),
      makeFinding({ id: "b", file: "b.ts", line: 1 }),
      makeFinding({ id: "c", file: "a.ts", line: 10 }),
    ];
    const groups = groupFindingsByFile(findings);
    assert.equal(groups.size, 2);
    assert.equal(groups.get("a.ts")!.length, 2);
    assert.equal(groups.get("b.ts")!.length, 1);
  });

  it("findAdjacentFinding wraps around", () => {
    const findings: FindingUiRecord[] = [
      makeFinding({ id: "a", priority: "P1" }),
      makeFinding({ id: "b", priority: "P2" }),
      makeFinding({ id: "c", priority: "P3" }),
    ];
    assert.equal(findAdjacentFinding(findings, undefined, "next")!.id, "a");
    assert.equal(findAdjacentFinding(findings, "a", "next")!.id, "b");
    assert.equal(findAdjacentFinding(findings, "c", "next")!.id, "a");
    assert.equal(findAdjacentFinding(findings, "a", "previous")!.id, "c");
  });

  it("findAdjacentFile wraps around", () => {
    const findings: FindingUiRecord[] = [
      makeFinding({ id: "a", file: "a.ts" }),
      makeFinding({ id: "b", file: "b.ts" }),
      makeFinding({ id: "c", file: "c.ts" }),
    ];
    assert.equal(findAdjacentFile(findings, undefined, "next"), "a.ts");
    assert.equal(findAdjacentFile(findings, "a.ts", "next"), "b.ts");
    assert.equal(findAdjacentFile(findings, "c.ts", "next"), "a.ts");
    assert.equal(findAdjacentFile(findings, "a.ts", "previous"), "c.ts");
  });

  it("getFindingsForFile returns sorted findings for a file", () => {
    const findings: FindingUiRecord[] = [
      makeFinding({ id: "a", file: "a.ts", line: 10, priority: "P2" }),
      makeFinding({ id: "b", file: "a.ts", line: 5, priority: "P1" }),
      makeFinding({ id: "c", file: "b.ts", line: 1 }),
    ];
    const result = getFindingsForFile(findings, "a.ts");
    assert.equal(result.length, 2);
    assert.equal(result[0]!.id, "b"); // P1 before P2
  });

  it("getHighestUnresolvedSeverity returns highest non-fixed priority", () => {
    const findings: FindingUiRecord[] = [
      makeFinding({ id: "a", priority: "P3", status: "unfixed" }),
      makeFinding({ id: "b", priority: "P1", status: "fixed" }),
      makeFinding({ id: "c", priority: "P2", status: "unfixed" }),
    ];
    const snapshot = { findings } as any;
    assert.equal(getHighestUnresolvedSeverity(snapshot), "P2");
  });

  it("getHighestUnresolvedSeverity returns undefined when all fixed", () => {
    const findings: FindingUiRecord[] = [
      makeFinding({ id: "a", priority: "P1", status: "fixed" }),
    ];
    const snapshot = { findings } as any;
    assert.equal(getHighestUnresolvedSeverity(snapshot), undefined);
  });

  it("getLatestExceptionLog returns error over warning", () => {
    const logs = [
      { id: "1", severity: "warning", message: "warn" },
      { id: "2", severity: "error", message: "err" },
      { id: "3", severity: "warning", message: "warn2" },
    ] as any[];
    const result = getLatestExceptionLog(logs);
    assert.equal(result?.id, "2");
  });

  it("getLatestExceptionLog returns warning when no error", () => {
    const logs = [
      { id: "1", severity: "info", message: "info" },
      { id: "2", severity: "warning", message: "warn" },
    ] as any[];
    const result = getLatestExceptionLog(logs);
    assert.equal(result?.id, "2");
  });

  it("getLatestExceptionLog returns undefined when no warnings/errors", () => {
    const logs = [
      { id: "1", severity: "info", message: "info" },
    ] as any[];
    assert.equal(getLatestExceptionLog(logs), undefined);
  });

  it("resolveRetainedSelection keeps selected id when still present", () => {
    const findings: FindingUiRecord[] = [
      makeFinding({ id: "a" }),
      makeFinding({ id: "b" }),
    ];
    assert.equal(resolveRetainedSelection(findings, "b"), "b");
  });

  it("resolveRetainedSelection falls back to first when selected disappears", () => {
    const findings: FindingUiRecord[] = [
      makeFinding({ id: "a" }),
      makeFinding({ id: "b" }),
    ];
    assert.equal(resolveRetainedSelection(findings, "gone"), "a");
  });

  it("resolveRetainedFile keeps selected file when still present", () => {
    const findings: FindingUiRecord[] = [
      makeFinding({ id: "a", file: "a.ts" }),
      makeFinding({ id: "b", file: "b.ts" }),
    ];
    assert.equal(resolveRetainedFile(findings, "b.ts"), "b.ts");
  });

  it("resolveRetainedFile falls back to first file when selected disappears", () => {
    const findings: FindingUiRecord[] = [
      makeFinding({ id: "a", file: "a.ts" }),
      makeFinding({ id: "b", file: "b.ts" }),
    ];
    assert.equal(resolveRetainedFile(findings, "gone.ts"), "a.ts");
  });

  it("countTasksByStatus counts each status correctly", () => {
    const tasks: TaskUiRecord[] = [
      makeTask(0, { status: "completed" }),
      makeTask(1, { status: "running" }),
      makeTask(2, { status: "pending" }),
      makeTask(3, { status: "failed" }),
      makeTask(4, { status: "completed_with_warnings" }),
    ];
    const counts = countTasksByStatus(tasks);
    assert.equal(counts.completed, 2); // completed + completed_with_warnings
    assert.equal(counts.running, 1);
    assert.equal(counts.pending, 1);
    assert.equal(counts.failed, 1);
    assert.equal(counts.total, 5);
  });
});

// ---------------------------------------------------------------------------
// Pi adapter tests
// ---------------------------------------------------------------------------

describe("Pi capability adapter (Spec2 Phase 0)", () => {
  it("detectPiUiCapabilities returns defaults for empty API", () => {
    const caps = detectPiUiCapabilities(null);
    assert.deepEqual(caps, DEFAULT_PI_UI_CAPABILITIES);
  });

  it("detectPiUiCapabilities detects custom() as focusable+overlay", () => {
    const pi = { ui: { custom: () => {} } };
    const caps = detectPiUiCapabilities(pi);
    assert.equal(caps.focusableWidget, true);
    assert.equal(caps.customOverlay, true);
  });

  it("detectPiUiCapabilities detects requestRender", () => {
    const pi = { ui: { requestRender: () => {} } };
    const caps = detectPiUiCapabilities(pi);
    assert.equal(caps.requestRender, true);
  });

  it("detectPiUiCapabilities detects shortcuts", () => {
    const pi = { registerShortcut: () => {} };
    const caps = detectPiUiCapabilities(pi);
    assert.equal(caps.shortcuts, true);
  });

  it("resolveDetailEntryPoints always includes command fallback", () => {
    const caps = { ...DEFAULT_PI_UI_CAPABILITIES };
    const entries = resolveDetailEntryPoints(caps);
    assert.ok(entries.some((e) => e.kind === "command"));
    assert.equal(entries.length, 1); // only command when nothing else available
  });

  it("resolveDetailEntryPoints includes widget_focus when focusable", () => {
    const caps = { ...DEFAULT_PI_UI_CAPABILITIES, focusableWidget: true };
    const entries = resolveDetailEntryPoints(caps);
    assert.equal(entries[0]!.kind, "widget_focus");
    assert.ok(entries.some((e) => e.kind === "command"));
  });

  it("resolveDetailEntryPoints includes shortcut when available", () => {
    const caps = { ...DEFAULT_PI_UI_CAPABILITIES, shortcuts: true };
    const entries = resolveDetailEntryPoints(caps);
    assert.ok(entries.some((e) => e.kind === "shortcut"));
  });

  it("formatFooterEntryHint shows command when no capabilities", () => {
    const hint = formatFooterEntryHint(DEFAULT_PI_UI_CAPABILITIES);
    assert.match(hint, /\/cc-review-details/);
  });

  it("formatFooterEntryHint shows Enter when focusable", () => {
    const caps = { ...DEFAULT_PI_UI_CAPABILITIES, focusableWidget: true };
    const hint = formatFooterEntryHint(caps);
    assert.match(hint, /Enter/);
    assert.match(hint, /\/cc-review-details/);
  });

  it("canRenderCustomOverlay requires both customOverlay and focusableWidget", () => {
    assert.equal(canRenderCustomOverlay(DEFAULT_PI_UI_CAPABILITIES), false);
    assert.equal(canRenderCustomOverlay({ ...DEFAULT_PI_UI_CAPABILITIES, customOverlay: true }), false);
    assert.equal(canRenderCustomOverlay({ ...DEFAULT_PI_UI_CAPABILITIES, focusableWidget: true }), false);
    assert.equal(canRenderCustomOverlay({ ...DEFAULT_PI_UI_CAPABILITIES, customOverlay: true, focusableWidget: true }), true);
  });
});

// ---------------------------------------------------------------------------
// Compact widget renderer tests (Spec2 Phase 1)
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<CcReviewUiSnapshot> = {}): CcReviewUiSnapshot {
  return {
    runId: "run-1",
    goal: "Fix the parser",
    displayState: "executing",
    phase: "executing",
    startedAt: new Date().toISOString(),
    currentTaskIndex: 1,
    tasks: [
      makeTask(0, { status: "completed", title: "Plan implementation", activeForm: "Planning implementation…" }),
      makeTask(1, { status: "running", title: "Review parser changes", activeForm: "Reviewing parser changes…", effectiveModel: "anthropic/sonnet", startedAt: new Date(Date.now() - 81000).toISOString() }),
      makeTask(2, { status: "pending", title: "Add validation tests", activeForm: "Adding validation tests…" }),
    ],
    findings: [],
    logs: [],
    attempts: [],
    findingsRollup: { tasksReviewed: 0, ship: 0, shipWithWarnings: 0, blocked: 0, unfixedP0: 0, unfixedP1: 1, unfixedP2P3: 7 } as any,
    persistedLogPath: "",
    artifactRunDir: "",
    ...overrides,
  };
}

describe("Compact widget renderer (Spec2 Phase 1)", () => {
  it("renders header with progress and phase", () => {
    const snapshot = makeSnapshot();
    const result = renderCompactWidget(snapshot, { width: 80 });
    assert.ok(result.lines[0]!.includes("CC Review"));
    assert.ok(result.lines[0]!.includes("executing") || result.lines[0]!.includes("Executing"));
  });

  it("renders task lines with status icons", () => {
    const snapshot = makeSnapshot();
    const result = renderCompactWidget(snapshot, { width: 80 });
    const taskLines = result.lines.filter((l) => l.includes("Plan") || l.includes("Reviewing") || l.includes("validation"));
    assert.ok(taskLines.length >= 2);
    assert.ok(taskLines.some((l) => l.includes("✔"))); // completed
    assert.ok(taskLines.some((l) => l.includes("▸"))); // running
  });

  it("renders findings summary at >= 50 cols", () => {
    const snapshot = makeSnapshot();
    const result = renderCompactWidget(snapshot, { width: 80 });
    assert.ok(result.lines.some((l) => l.includes("Findings")));
    assert.ok(result.lines.some((l) => l.includes("P1") && l.includes("P2")));
  });

  it("renders footer at >= 50 cols", () => {
    const snapshot = makeSnapshot();
    const result = renderCompactWidget(snapshot, { width: 80 });
    assert.ok(result.lines.some((l) => l.includes("Enter details")));
  });

  it("hides footer at < 50 cols", () => {
    const snapshot = makeSnapshot();
    const result = renderCompactWidget(snapshot, { width: 40 });
    assert.ok(!result.lines.some((l) => l.includes("Enter details")));
  });

  it("shows only current task at < 50 cols", () => {
    const snapshot = makeSnapshot({ currentTaskIndex: 1 });
    const result = renderCompactWidget(snapshot, { width: 40 });
    const taskLines = result.lines.filter((l) => /^\s+[○▸✔⚠✘]/.test(l));
    assert.equal(taskLines.length, 1);
    assert.ok(taskLines[0]!.includes("Reviewing") || taskLines[0]!.includes("parser"));
  });

  it("keeps the current task in the medium-width task window", () => {
    const tasks = Array.from({ length: 8 }, (_, index) =>
      makeTask(index, { status: index === 6 ? "running" : "completed" }),
    );
    const result = renderCompactWidget(
      makeSnapshot({ tasks, currentTaskIndex: 6 }),
      { width: 80 },
    );
    assert.ok(result.lines.some((line) => line.includes("task 7")));
    assert.ok(!result.lines.some((line) => line.includes("task 1…")));
  });

  it("shows latest error log when present", () => {
    const snapshot = makeSnapshot({
      logs: [
        { id: "1", timestamp: new Date().toISOString(), severity: "error", source: "subagent", pluginId: "cc-review", message: "Validation command failed", sequence: 1 },
      ] as any,
    });
    const result = renderCompactWidget(snapshot, { width: 80 });
    assert.ok(result.lines.some((l) => l.includes("Validation command failed")));
  });

  it("prefers error over warning in latest exception", () => {
    const snapshot = makeSnapshot({
      logs: [
        { id: "1", timestamp: new Date().toISOString(), severity: "warning", source: "cc-review", pluginId: "cc-review", message: "warn msg", sequence: 1 },
        { id: "2", timestamp: new Date().toISOString(), severity: "error", source: "subagent", pluginId: "cc-review", message: "error msg", sequence: 2 },
      ] as any,
    });
    const result = renderCompactWidget(snapshot, { width: 80 });
    assert.ok(result.lines.some((l) => l.includes("error msg")));
    assert.ok(!result.lines.some((l) => l.includes("warn msg")));
  });

  it("all lines fit within width at 40 cols", () => {
    const snapshot = makeSnapshot();
    const result = renderCompactWidget(snapshot, { width: 40 });
    for (const line of result.lines) {
      assert.ok(line.length <= 40, `line too long (${line.length}): ${line}`);
    }
  });

  it("bounds CJK and emoji content by terminal columns", () => {
    const snapshot = makeSnapshot({
      tasks: [
        makeTask(0, {
          status: "running",
          title: "修复中文解析器和终端显示",
          activeForm: "正在修复中文解析器和终端显示🔧…",
        }),
      ],
      currentTaskIndex: 0,
    });
    const result = renderCompactWidget(snapshot, { width: 20 });
    for (const line of result.lines) {
      assert.ok(
        measureVisibleWidth(line) <= 20,
        `line too wide (${measureVisibleWidth(line)} columns): ${line}`,
      );
    }
  });

  it("all lines fit within width at 80 cols", () => {
    const snapshot = makeSnapshot();
    const result = renderCompactWidget(snapshot, { width: 80 });
    for (const line of result.lines) {
      assert.ok(line.length <= 80, `line too long (${line.length}): ${line}`);
    }
  });

  it("all lines fit within width at 120 cols", () => {
    const snapshot = makeSnapshot();
    const result = renderCompactWidget(snapshot, { width: 120 });
    for (const line of result.lines) {
      assert.ok(line.length <= 120, `line too long (${line.length}): ${line}`);
    }
  });

  it("handles empty tasks gracefully", () => {
    const snapshot = makeSnapshot({ tasks: [] });
    const result = renderCompactWidget(snapshot, { width: 80 });
    assert.ok(result.lines.length > 0);
    assert.ok(result.lines[0]!.includes("CC Review"));
  });

  it("handles empty findings gracefully", () => {
    const snapshot = makeSnapshot({
      findingsRollup: { tasksReviewed: 0, ship: 0, shipWithWarnings: 0, blocked: 0, unfixedP0: 0, unfixedP1: 0, unfixedP2P3: 0 } as any,
    });
    const result = renderCompactWidget(snapshot, { width: 80 });
    assert.ok(result.lines.some((l) => l.includes("none")));
  });

  it("uses spinner frame for running tasks", () => {
    const snapshot = makeSnapshot();
    const result = renderCompactWidget(snapshot, { width: 80, spinnerFrame: "◐" });
    assert.ok(result.lines.some((l) => l.includes("◐")));
  });

  it("shows model for running task at >= 50 cols", () => {
    const snapshot = makeSnapshot();
    const result = renderCompactWidget(snapshot, { width: 80 });
    const runningLine = result.lines.find((l) => l.includes("Reviewing"));
    assert.ok(runningLine);
    assert.ok(runningLine!.includes("sonnet"));
  });
});
