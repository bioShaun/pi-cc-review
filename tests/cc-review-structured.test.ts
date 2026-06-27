import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  deriveEffectiveVerdict,
  generateWorkflowRunId,
  parseReviewResult,
  parseSubagentStructuredReport,
  sortReviewFindings,
  validateStructuredSubagentReport,
  writeTaskArtifact,
  WORKFLOW_ARTIFACT_DIR,
} from "../.pi/extensions/cc-review-structured.ts";

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
