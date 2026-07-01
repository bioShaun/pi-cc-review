# Oh My Pi Lessons Implementation Spec

## Status

Draft implementation spec for CC Review Orchestrator.

This document uses the user's definition of `omp`: **oh-my-pi** (`can1357/oh-my-pi`), a batteries-included fork of Pi with `/review`, `/advisor`, task subagents, structured review findings, and artifact-oriented agent outputs.

Note: the older `docs/omp-research-scope.md` and `docs/omp-architecture-survey.md` currently interpret `omp` as Oh My Posh. For this feature track, those documents are not the source of truth.

## Problem

CC Review already has the core orchestration loop:

1. Plan tasks.
2. Execute each task through the `worker` subagent.
3. Run a per-task reviewer/fixer.
4. Summarize the workflow.

The weak point is that several important decisions are still inferred from free-form text:

- Subagent validation scans output for tokens such as `todo:`, `unresolved:`, `failed to`, and acceptance-criteria phrases.
- Reviewer outcome relies mostly on subprocess exit code and text logs, not a typed verdict.
- The final report truncates subagent output and does not persist a task-level artifact with the full machine-readable result.
- UI surfaces can display severity-colored logs, but they do not yet have structured review findings to render as verdict/finding cards.

Oh My Pi's review/subagent subsystem suggests the same direction for all of these: parent workflows should consume schema-validated objects, not prose.

## Goals

- Persist complete per-task artifacts so users can inspect the full task execution and review output after the compact UI is gone.
- Make subagent completion machine-readable with a JSON contract and a compatibility fallback for existing text-only agents.
- Make reviewer output machine-readable with a verdict and prioritized findings.
- Sort and display findings by priority so blocking issues float to the top.
- Preserve current behavior where the reviewer may directly fix workspace files before reporting its verdict.
- Keep the rollout incremental and compatible with existing `generator` agent definitions through the legacy profile fallback.

## Non-Goals

- Do not replace the linear plan -> execute -> review workflow with a realtime advisor loop in this increment.
- Do not remove text-output compatibility from custom subagents.
- Do not make reviewer JSON-only if that prevents it from editing files.
- Do not redesign the whole TUI before structured findings exist.
- Do not introduce new external services or mandatory dependencies.

## Current Code Touchpoints

- `.pi/extensions/cc-review.ts`
  - `TaskResult`: currently stores task title, description, exit codes, truncated output source, validation error, unresolved items, warning name, and status.
  - `buildSubagentTaskPrompt(...)`: prompt point for requiring a structured final report.
  - `extractSubagentText(...)`: current source of subagent text.
  - `validateSubagentOutput(...)`: current text-token validation path.
  - `buildReviewPrompt(...)`: prompt point for requiring reviewer verdict/findings after any in-place fixes.
  - `runProcess(...)`: currently does not persist aggregate stdout/stderr in `ProcessResult.output`.
  - `buildSummaryReport(...)`: current final markdown renderer and 500-character subagent truncation.
  - `appendPersistedLogEntry(...)`: existing durable JSONL pattern to mirror for task artifacts.

## Proposed Data Contracts

### Subagent Final Report

The worker subagent should end its response with one JSON object. The orchestrator should attempt to parse the last balanced JSON object from the final assistant text.

```json
{
  "status": "completed",
  "summary": "Implemented the requested change and verified it with tests.",
  "filesChanged": [".pi/extensions/cc-review.ts", "tests/cc-review-behavior.test.ts"],
  "unresolvedItems": [],
  "acceptanceCriteria": [
    {
      "criterion": "Workflow records full task output",
      "status": "met",
      "evidence": "Task artifacts are written under cc-review-artifacts/"
    }
  ]
}
```

Schema:

- `status`: required enum, `completed | partial | blocked`.
- `summary`: required string.
- `filesChanged`: optional string array.
- `unresolvedItems`: optional string array.
- `acceptanceCriteria`: optional array of objects:
  - `criterion`: required string.
  - `status`: required enum, `met | not_met | unknown`.
  - `evidence`: optional string.

Validation rules:

- `completed` with no `not_met`, no `unknown`, and no unresolved items is valid.
- `partial` or `blocked` is invalid for workflow progression.
- Any `not_met` criterion is invalid.
- `unknown` should be treated as invalid unless a later reviewer explicitly fixes and clears it.
- If JSON parsing fails, preserve today's text-token validation as fallback and record `schemaParseStatus: "fallback_text"`.

### Reviewer Result

The reviewer still receives the instruction to inspect and fix workspace files. After fixing or deciding no fix is needed, it should end with one JSON object:

```json
{
  "verdict": "ship",
  "summary": "No blocking issues remain after review.",
  "findings": [
    {
      "priority": "P2",
      "confidence": 0.78,
      "file": ".pi/extensions/cc-review.ts",
      "message": "The artifact path should be included in the final summary for discoverability.",
      "status": "fixed"
    }
  ]
}
```

Schema:

- `verdict`: required enum, `ship | ship_with_warnings | block`.
- `summary`: required string.
- `findings`: required array.
- Finding fields:
  - `priority`: required enum, `P0 | P1 | P2 | P3`.
  - `confidence`: required number, `0 <= confidence <= 1`.
  - `file`: optional string.
  - `line`: optional integer.
  - `message`: required string.
  - `status`: required enum, `fixed | unfixed | not_applicable`.

Verdict rules:

- Any `P0` or `P1` finding with `status: "unfixed"` forces `block`.
- `P2` or `P3` unfixed findings allow `ship_with_warnings`.
- Empty findings with successful review process maps to `ship`.
- Reviewer process exit code remains important: non-zero exit should produce `ship_with_warnings` or `block` depending on parseable findings, and should keep the old warning behavior as fallback.

## Task Artifact Format

Write one JSON file per task:

```json
{
  "schemaVersion": 1,
  "taskIndex": 0,
  "task": {
    "title": "Persist per-task artifacts",
    "description": "...",
    "acceptanceCriteria": "..."
  },
  "execution": {
    "exitCode": 0,
    "status": "completed",
    "rawOutput": "...",
    "structuredReport": {},
    "schemaParseStatus": "parsed"
  },
  "review": {
    "provider": "codex",
    "exitCode": 0,
    "rawOutput": "...",
    "rawError": "",
    "result": {}
  },
  "validation": {
    "valid": true,
    "error": null,
    "unresolvedItems": []
  },
  "timestamps": {
    "startedAt": "2026-06-26T00:00:00.000Z",
    "completedAt": "2026-06-26T00:00:10.000Z"
  }
}
```

Storage:

- Directory: `<cwd>/cc-review-artifacts/`
- File name: `task-001.json`, `task-002.json`, etc.
- Reset behavior: remove or overwrite only CC Review's own artifact files at workflow start.
- Summary behavior: include the artifact path for each task, replacing the current 500-character output dump.

## Implementation Plan

### Phase 1: Per-task Artifacts

Add artifact persistence before changing model contracts.

Implementation steps:

1. Add `WORKFLOW_ARTIFACT_DIR = "cc-review-artifacts"`.
2. Add `TaskArtifact` types.
3. Add helper `writeTaskArtifact(cwd, artifact)` returning the absolute file path.
4. Extend `TaskResult` with `artifactPath?: string`.
5. Capture reviewer stdout/stderr in `runProcess(...)` or in the reviewer call site.
6. Write an artifact after each task reaches a terminal task result.
7. Update `buildSummaryReport(...)` to show `Artifact: <path>` and stop truncating subagent output into the summary by default.

Acceptance criteria:

- A successful run writes one artifact per executed task.
- A failed or validation-failed task still writes an artifact.
- The final summary links or prints absolute artifact paths.
- Existing log behavior remains unchanged.

### Phase 2: Subagent Schema

Add structured parsing with text fallback.

Implementation steps:

1. Update `buildSubagentTaskPrompt(...)` to require a final JSON object.
2. Reuse the shared `extractBalancedJsonObject(text, "last")` helper from `.pi/extensions/cc-review/structured.ts` for subagent final-JSON parsing (the planner path uses the same helper with `"first"`).
3. Add `parseSubagentStructuredReport(text)`.
4. Update `validateSubagentOutput(...)` to prefer the structured report.
5. Store parse status and structured report in the task artifact.
6. Keep fallback text validation when parsing fails.

Acceptance criteria:

- Valid `completed` JSON passes validation.
- `blocked`, `partial`, unresolved items, or unmet criteria fail validation.
- Text-only output still follows the existing validation path.
- Tests cover parsed, invalid, and fallback cases.

### Phase 3: Reviewer Verdict and Findings

Add structured review output without removing file-fixing behavior.

Implementation steps:

1. Update `buildReviewPrompt(...)` to require final JSON after any in-place fixes.
2. Add `ReviewFinding` and `ReviewResult` types.
3. Capture reviewer stdout/stderr.
4. Parse reviewer output into `ReviewResult`.
5. Add fallback mapping from exit code to a synthetic review result.
6. Extend `TaskResult` with `reviewResult?: ReviewResult`.
7. Update workflow status:
   - `block` should halt or mark task failed, depending on existing early-termination policy.
   - `ship_with_warnings` should map to `completed_with_warnings`.
   - `ship` should map to reviewed success.

Acceptance criteria:

- Findings are sorted `P0 -> P1 -> P2 -> P3`, then by confidence descending.
- Unfixed `P0/P1` blocks progression.
- Non-zero reviewer exit still surfaces a warning even when no JSON is parseable.
- Summary includes verdict and findings.

### Phase 4: Summary and TUI Rendering

Use the new structures to improve display.

Implementation steps:

1. Add a workflow-level findings rollup.
2. Add a verdict line for each task in the final markdown summary.
3. Add a "Review Findings" section sorted by priority.
4. Keep artifact paths near each task.
5. Optionally add compact widget rollups:
   - verdict count
   - number of P0/P1 blockers
   - number of warnings

Acceptance criteria:

- Blocking findings appear before non-blocking findings.
- Summary can be understood without opening artifacts.
- Artifacts contain enough raw output to debug parser issues.

### Phase 5: Role-based Model Routing

Defer until structured contracts are stable.

Implementation sketch:

- Add role-level config, for example:
  - `CC_REVIEW_PLANNER_MODEL`
  - `CC_REVIEW_EXECUTOR_MODEL`
  - `CC_REVIEW_REVIEWER_MODEL`
- Preserve provider precedence rules already used by `reviewProvider` and `CC_REVIEW_PROVIDER`.
- Avoid changing default behavior.

## Test Plan

Add or extend tests in `tests/cc-review-behavior.test.ts` and `tests/cc-review-static.test.mjs`.

Behavior tests:

- Writes artifact for successful task.
- Writes artifact for failed task before halting.
- Parses valid subagent JSON.
- Rejects subagent JSON with `blocked` status.
- Falls back to existing text validation when JSON is absent.
- Parses reviewer `ship`, `ship_with_warnings`, and `block`.
- Sorts review findings by priority.
- Preserves warning behavior for non-zero reviewer exit.

Static tests:

- Review prompt requires final JSON verdict.
- Subagent prompt requires final JSON report.
- Summary references `artifactPath`.
- Artifact schema version is present.

## Migration and Compatibility

- Existing user-installed generator agents remain supported as legacy worker profiles through fallback text validation.
- Existing review providers remain supported because final JSON parsing is additive.
- Existing `workflow-logs.jsonl` and `workflow-trace.jsonl` behavior stays unchanged.
- Summary output changes from inline truncated subagent output to artifact path plus structured status.

## Risks

- Models may emit prose around JSON. Mitigation: parse the last balanced JSON object and persist raw output in artifacts.
- Reviewer may fix files and then fail to emit valid JSON. Mitigation: keep exit-code warning path and raw artifact output.
- Custom agents may resist strict schema. Mitigation: fallback path and clear artifact parse status.
- Blocking verdict policy could surprise users if a reviewer flags unfixed P1 after the executor succeeded. Mitigation: start with conservative `completed_with_warnings` for parse failures and only halt on explicit `verdict: "block"`.

## Recommended First Commit Scope

The smallest useful first commit is Phase 1 only:

- Add task artifact persistence.
- Capture reviewer stdout/stderr.
- Add `artifactPath` to `TaskResult`.
- Update summary to point to artifacts.
- Add tests for success and failure artifact writing.

This creates the storage foundation needed by every later schema and UI improvement without changing model behavior.
