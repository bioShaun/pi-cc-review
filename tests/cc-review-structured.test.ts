import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  deriveEffectiveVerdict,
  extractBalancedJsonObject,
  generateWorkflowRunId,
  parseReviewResult,
  parseSubagentStructuredReport,
  sortReviewFindings,
  validateStructuredSubagentReport,
  writeTaskArtifact,
  WORKFLOW_ARTIFACT_DIR,
  buildSummaryMeta,
} from "../.pi/extensions/cc-review/structured.ts";

test("parseSubagentStructuredReport accepts completed JSON at end of text", () => {
  const text = `Done.\n${JSON.stringify({
    status: "completed",
    summary: "All good",
    unresolvedItems: [],
  })}`;
  const parsed = parseSubagentStructuredReport(text);
  assert.equal(parsed.status, "parsed");
  assert.equal(parsed.report?.status, "completed");
});

test("invalid subagent schema does not fall back to text", () => {
  const text = `Looks fine in prose\n${JSON.stringify({ status: "completed" })}`;
  const parsed = parseSubagentStructuredReport(text);
  assert.equal(parsed.status, "invalid_schema");
  assert.equal(parsed.report, null);
});

test("deriveEffectiveVerdict blocks on unfixed P1 even when reported ship", () => {
  const derived = deriveEffectiveVerdict({
    reportedVerdict: "ship",
    findings: [
      {
        priority: "P1",
        confidence: 0.9,
        message: "Still broken",
        status: "unfixed",
      },
    ],
    reviewerExitCode: 0,
    reviewParseStatus: "parsed",
    ambiguousHighSeverity: false,
    postReviewValidationFailed: false,
  });
  assert.equal(derived.effectiveVerdict, "block");
  assert.equal(derived.blockReason, "unfixed_high_severity");
});

test("writeTaskArtifact uses per-run directory and atomic write", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-artifact-test-"));
  const runId = generateWorkflowRunId();
  const artifactPath = writeTaskArtifact(cwd, runId, {
    schemaVersion: 1,
    runId,
    taskIndex: 0,
    task: { title: "T", description: "D", acceptanceCriteria: "A" },
    execution: {
      exitCode: 0,
      status: "completed",
      rawOutput: "raw",
      structuredReport: null,
      schemaParseStatus: "absent",
    },
    review: {
      provider: "codex",
      reviewerExitCode: 0,
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
    validation: { valid: true, error: null, unresolvedItems: [] },
    postReviewValidation: {
      required: false,
      workspaceChanged: false,
      passed: true,
      error: null,
      commands: [],
    },
    workflow: { haltedOnReview: false, haltedOnExecution: false },
    timestamps: { startedAt: "2026-06-26T00:00:00.000Z", completedAt: "2026-06-26T00:00:01.000Z" },
  });

  assert.match(artifactPath, new RegExp(`${WORKFLOW_ARTIFACT_DIR}/${runId}/task-001\\.json$`));
  assert.equal(fs.existsSync(`${artifactPath}.tmp`), false);
  const saved = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.runId, runId);
});

test("sortReviewFindings orders P0 before P3 and confidence within priority", () => {
  const sorted = sortReviewFindings([
    { priority: "P3", confidence: 0.99, message: "low", status: "unfixed" },
    { priority: "P0", confidence: 0.1, message: "high", status: "unfixed" },
    { priority: "P0", confidence: 0.9, message: "higher confidence", status: "unfixed" },
  ]);
  assert.deepEqual(
    sorted.map((finding) => finding.message),
    ["higher confidence", "high", "low"]
  );
});

test("validateStructuredSubagentReport rejects blocked status", () => {
  const result = validateStructuredSubagentReport({
    status: "blocked",
    summary: "blocked",
  });
  assert.equal(result.valid, false);
});

test("parseReviewResult normalizes ambiguous P0 status to unfixed and invalid_schema", () => {
  const parsed = parseReviewResult(
    JSON.stringify({
      verdict: "ship",
      summary: "ok",
      findings: [{ priority: "P0", confidence: 0.5, message: "maybe" }],
    })
  );
  assert.equal(parsed.status, "invalid_schema");
  assert.equal(parsed.result?.findings[0]?.status, "unfixed");
  assert.equal(parsed.ambiguousHighSeverity, true);
});

test("extractBalancedJsonObject returns first object with leading prose (first mode)", () => {
  const raw = `Planner notes:\nHere is the plan that follows\n{"tasks":[{"title":"A"}]}\nTrailing chatter {"ignored":true}`;
  const extracted = extractBalancedJsonObject(raw, "first");
  assert.equal(extracted, '{"tasks":[{"title":"A"}]}');
});

test("extractBalancedJsonObject returns final object with trailing prose (last mode)", () => {
  const raw = `Preamble {"early":1}\nMore text\n{"final":{"nested":true}}\nDone.`;
  const extracted = extractBalancedJsonObject(raw, "last");
  assert.equal(extracted, '{"final":{"nested":true}}');
});

test("extractBalancedJsonObject prefers fenced JSON blocks and respects position", () => {
  const raw = [
    "intro {\"loose\":0}",
    "```json",
    '{"fenced":"one"}',
    "```",
    "middle prose",
    "```json",
    '{"fenced":"two"}',
    "```",
    "tail {\"trailing\":9}",
  ].join("\n");
  assert.equal(extractBalancedJsonObject(raw, "first"), '{"fenced":"one"}');
  assert.equal(extractBalancedJsonObject(raw, "last"), '{"trailing":9}');
});

test("extractBalancedJsonObject ignores braces inside strings and escapes", () => {
  const raw = 'noise {"text":"a } b { c","value":{"k":1}} after';
  assert.equal(
    extractBalancedJsonObject(raw, "first"),
    '{"text":"a } b { c","value":{"k":1}}'
  );
});

test("extractBalancedJsonObject returns undefined for unbalanced or empty input", () => {
  assert.equal(extractBalancedJsonObject("", "first"), undefined);
  assert.equal(extractBalancedJsonObject("", "last"), undefined);
  assert.equal(extractBalancedJsonObject("no braces here", "first"), undefined);
  // Opening brace with no matching close should not produce a candidate.
  assert.equal(extractBalancedJsonObject('prefix {"unterminated":[1, 2', "first"), undefined);
});

test("buildSummaryMeta aggregates cancelled results without incrementing failed", () => {
  const taskResults = [
    { status: "cancelled" as const }
  ];
  const meta = buildSummaryMeta(taskResults);
  assert.equal(meta.taskOutcomes.cancelled, 1);
  assert.equal(meta.taskOutcomes.failed, 0);
  assert.equal(meta.taskOutcomes.review_blocked, 0);
  assert.equal(meta.taskOutcomes.warning, 0);
  assert.equal(meta.taskOutcomes.completed, 0);
});

test("buildSummaryMeta aggregates failed and validation_failed results into failed", () => {
  const taskResults = [
    { status: "failed" as const },
    { status: "validation_failed" as const }
  ];
  const meta = buildSummaryMeta(taskResults);
  assert.equal(meta.taskOutcomes.failed, 2);
  assert.equal(meta.taskOutcomes.cancelled, 0);
});

test("buildSummaryMeta handles mixed-outcome aggregation correctly", () => {
  const taskResults = [
    { status: "completed" as const },
    { status: "completed_with_warnings" as const },
    { status: "failed" as const },
    { status: "cancelled" as const },
    { status: "review_blocked" as const }
  ];
  const meta = buildSummaryMeta(taskResults);
  assert.equal(meta.taskOutcomes.completed, 1);
  assert.equal(meta.taskOutcomes.warning, 1);
  assert.equal(meta.taskOutcomes.failed, 1);
  assert.equal(meta.taskOutcomes.cancelled, 1);
  assert.equal(meta.taskOutcomes.review_blocked, 1);
});

test("buildSummaryMeta propagates an optional concurrency value into the summary meta", () => {
  const meta = buildSummaryMeta([{ status: "completed" as const }], { concurrency: 4 });
  assert.equal(meta.concurrency, 4);
});

test("buildSummaryMeta leaves concurrency absent when no options are provided", () => {
  const meta = buildSummaryMeta([{ status: "completed" as const }]);
  assert.equal(meta.concurrency, undefined);
});
