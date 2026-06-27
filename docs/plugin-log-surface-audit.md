# CC Review Plugin Log Surface Audit

Scope: current CC Review logging UI/workflow only. This note documents where logs are produced, stored, transported, and rendered so future log-display optimization work can target the right surfaces without changing provider selection, task execution, or retry behavior. This audit is documentation-only; runtime behavior remains unchanged.

## Relevant files, functions, and components

### Runtime source

- `.pi/extensions/cc-review.ts`
  - `emitTrace(ctx, event, payload = {})`: creates structured workflow trace events, writes each JSON line to `process.stderr`, and appends it to `<cwd>/workflow-trace.jsonl` using `fs.appendFileSync(...)`.
  - `runCcReviewWorkflow(...)`: main log coordinator. It owns `currentPhase`, `currentTaskIndex`, `tasks`, `taskResults`, and the in-memory `liveLogs: string[]` ring buffer.
  - Local `log(message)` inside `runCcReviewWorkflow(...)`: strips ANSI, pushes human-readable messages into `liveLogs`, caps the buffer at 50 entries, refreshes `ctx.ui.setWidget("cc-review-widget", ...)`, refreshes `ctx.ui.setStatus("cc-review-status", ...)`, and sends a markdown snapshot through tool `onUpdate` when available.
  - State transition helpers `transitionToPlanning`, `setPlannedTasks`, `transitionToExecuting`, `transitionToReviewing`, and `transitionToComplete`: emit phase/task log messages that drive the widget and status text.
  - `runProcess(label, command, args, onStdout, onStderr, timeoutMs?)`: shared subprocess wrapper for planner/reviewer commands. It emits structured trace events (`tool_execution_start`, `tool_execution_end`, `failure`) and delegates stdout/stderr chunks to caller-provided handlers.
  - Planner stream handlers in the `runProcess("Codex planner", ...)` call: split stdout into `[Codex Planner] ...` log lines and stderr into `[Codex Planner Error] ...` log lines.
  - Reviewer stream handlers in the `runProcess(reviewProviderConfig.label, ...)` call: split stdout into `[Codex reviewer] ...` or `[Claude reviewer] ...` log lines and stderr into matching `Error` log lines.
  - Subagent execution path: `getSubagentExecutor(...)` chooses in-process `pi.toolManager.executeTool` when present or `runPiAgentSubprocess(...)` fallback; the execution loop wraps subagent `onUpdate` messages as `[Subagent] ...` log lines while also forwarding the original partial update to the caller.
  - `runPiAgentSubprocess(...)`: fallback Pi subprocess log collection. It parses JSON stdout lines for `message_end` assistant text, forwards final assistant text through `onUpdate`, buffers stderr into `stderrBuf`, includes spawn errors, and returns a `SubagentToolResult` with `content`, `details.results[0].stderr`, `details.results[0].errorMessage`, `details.results[0].exitCode`, and `isError`.
  - Error/retry log producers: planning retry logs, subagent timeout/transient retry logs, `[Subagent Execution Done]`, `[Subagent Execution Failure]`, `[Workflow Halted]`, `[Review Warning]`, `[Review Done]`, abort logs, completion/failure trace events.
  - `buildSummaryReport(goal, taskResults, tasks)`: renders final persisted conversation output as markdown, including task status, truncated subagent output summaries, unresolved items, and recovery steps.
  - Slash command handler: uses `ctx.ui.notify(...)` for start/success/failure and `pi.sendMessage({ customType: "cc-review-summary", ... })` to show the final report.
  - Tool `execute(...)`: emits initial `onUpdate` text (`Starting CC Review...`) and returns final summary content/details to the caller.
  - Debug-only `process.stderr.write("[cc-review] spawning: ...")` in `runPiAgentSubprocess(...)` when `CC_REVIEW_DEBUG` is set.

### Documentation and generated artifacts

- `workflow-trace.jsonl`: current structured trace artifact in the workspace root. It is newline-delimited JSON, appended by `emitTrace`, and includes historical workflow events.
- `README.md`: design contract section `Lightweight Trace Observability` documents JSON-lines output to stderr and `workflow-trace.jsonl`, with minimal payloads.
- `docs/review-plugin-entrypoints.md`: existing implementation note describing entry points, trace-file naming, and provider labels.
- `workflow-baseline.md` and `workflow-optimization-criteria.md`: describe expected live logs, trace events, widget/status behavior, and future criteria for real-time streaming.

### UI surfaces currently used

- Terminal/stderr: structured JSON trace lines from `emitTrace`; optional debug spawn line when `CC_REVIEW_DEBUG` is enabled.
- Workspace file: `<cwd>/workflow-trace.jsonl` stores structured trace events but not human-readable `liveLogs`.
- TUI widget: `ctx.ui.setWidget("cc-review-widget", widgetLines)` shows goal, task checklist, current phase, and the last 5 human-readable live logs.
- TUI status/footer: `ctx.ui.setStatus("cc-review-status", `[CC Review] ${currentPhase}`)` shows current phase.
- Tool streaming: `onUpdate({ content: [{ type: "text", text: "### CC Review Orchestrator\n..." }] })` repeatedly sends the whole current goal/phase/last-5-log markdown snapshot; subagent partials are also forwarded unchanged.
- Conversation summary: slash command uses `pi.sendMessage(... customType: "cc-review-summary" ...)`; tool execution returns the markdown report in `content[0].text`.
- `registerMessageRenderer("cc-review-summary", ...)`: when Pi exposes the renderer API and `@earendil-works/pi-tui` primitives are available, the final report shows a compact severity badge/header with the full markdown body behind the expanded view. Registration is best-effort and skipped in headless/test environments without the TUI runtime.
- Persisted human log: `<cwd>/workflow-logs.jsonl` stores normalized `CcReviewLogEntry` JSON lines for the full run (unfiltered by log level).
- No `renderCall`, `renderResult`, browser console, web panel, or dedicated persisted human-log panel beyond `workflow-logs.jsonl` exists in this repository.

## Current logging flow

1. Tool or slash command starts the workflow and, for tool calls, sends `Starting CC Review...` via `onUpdate`.
2. `runCcReviewWorkflow(...)` resolves provider configuration and immediately calls `emitTrace(ctx, "workflow_start", { goalLength, reviewProvider })`.
3. Human-readable status messages call local `log(...)`. `log(...)` strips ANSI, updates `liveLogs`, redraws the TUI widget/status when `ctx.ui` exists, and emits a full markdown snapshot via `onUpdate`.
4. Planner and reviewer subprocesses run through `runProcess(...)`. The wrapper emits structured start/end/failure trace records; stdout/stderr chunk handlers produce human-readable `[Planner]`, `[Planner Error]`, `[Reviewer]`, or `[Reviewer Error]` live logs.
5. Subagent execution emits structured `_subagent` start/end trace events around the call. Subagent partial text is logged as `[Subagent] ...` and forwarded to the original `onUpdate` callback.
6. Retry, timeout, abort, validation, review-warning, completion, and failure paths each add a mix of human-readable live logs and structured trace events.
7. At workflow end, `buildSummaryReport(...)` creates the final markdown report. `finally` clears `cc-review-widget` and `cc-review-status`, leaving only the final summary and `workflow-trace.jsonl` as durable surfaces.

## Current log data model / fields

### Structured trace JSONL (`emitTrace`)

Every trace entry has:

- `type`: always `"workflow_trace"`.
- `event`: workflow event name.
- `timestamp`: ISO timestamp generated at emission time.

Known event-specific fields in current code/artifacts:

- `workflow_start`: `goalLength`, `reviewProvider`.
- `subagent_assignment`: `role` (`planner`, `executor`, `reviewer`), `agent`, optional `taskIndex`, optional `attempt`.
- `tool_execution_start`: for subprocesses: `label`, `command`, `source: "subprocess"`; for subagent execution: `taskIndex`, `toolName: "subagent"`, `source: "_subagent"`.
- `tool_execution_end`: subprocess fields `label`, `command`, `source`, `exitCode`, optional `signal`; subagent fields `taskIndex`, `toolName`, `source`, `exitCode`.
- `retry`: `phase`, optional `taskIndex`, `attempt`, `maxAttempts`, `error`.
- `failure`: `error`, or `phase`, `label`, `command`, `exitCode`, `signal`, `timeoutMs`, `taskIndex` depending on failure point.
- `completion`: `status` (`success` or `warning`), `tasksCount`.

Trace constraints: payloads intentionally avoid raw goal text, task titles, subprocess args, and prompt content. Trace is machine-readable but there is no index, rotation, schema file, retention policy, or UI reader for it.

### Human-readable live logs (`liveLogs`)

- Shape: plain strings after `stripAnsi(message).trim()`.
- Storage: in-memory only during a workflow; capped at 50 messages.
- Rendered subset: last 5 entries in the widget and in each markdown `onUpdate` snapshot.
- Typical prefixes: `[Codex Planner]`, `[Codex Planner Error]`, `[Subagent]`, `[Timeout]`, `[Transient Error]`, `[Subagent Execution Done]`, `[Subagent Execution Failure]`, `[Workflow Halted]`, `[Codex reviewer]`, `[Claude reviewer]`, `[... Error]`, `[Review Warning]`, `[Review Done]`.
- Additional state rendered with logs: full goal text, task list titles, task progress symbols (`✔`, `▸`, `☐`), and current phase.

### Subprocess/subagent result fields

- `ProcessResult`: `code`, optional `output` (currently not populated by `runProcess`).
- `SubagentToolResult`: `content: [{ type, text }]`, `details.results[0].agent`, `exitCode`, `stderr`, `errorMessage`, and top-level `isError`.
- `TaskResult`: `title`, `description`, `executionCode`, `reviewCode`, `output`, `validationError`, `unresolvedItems`, `reviewWarningName`, and `status` (`completed`, `completed_with_warnings`, `failed`, `validation_failed`, `skipped`, `cancelled`). These fields feed the final summary rather than the live log widget.

## Constraints and current gaps/issues

1. **Rolling display loses context.** The widget and `onUpdate` snapshot show only the last 5 `liveLogs`; the in-memory buffer keeps 50 and is cleared at the end, while only structured trace JSONL persists. Users cannot inspect full human-readable planner/reviewer/subagent output after completion unless it is also in the final summary or terminal scrollback.
2. **`onUpdate` is noisy and repetitive.** Every `log(...)` emits a full markdown block with goal, phase, and last 5 logs instead of a small structured delta. Subagent partials are also forwarded separately, so consumers can receive duplicate or interleaved updates with different shapes.
3. **Human logs and trace logs are split.** Structured trace events have useful lifecycle fields but omit text; live logs include text but no stable severity/source/task metadata beyond string prefixes. Correlating a visible log line to a trace entry requires timestamp/order inference.
4. **Potential sensitive or overly verbose display.** The widget/onUpdate includes the full goal and task descriptions, and subprocess stdout/stderr lines are displayed verbatim. Trace events intentionally avoid raw prompts, but live logs do not have equivalent redaction, truncation, or per-source verbosity controls.
5. **No dedicated renderer/panel.** The plugin uses a basic string-array widget and raw markdown updates. It does not use `registerMessageRenderer`, `renderCall`/`renderResult`, custom TUI components, expandable details, severity coloring, filtering, search, or a persisted log viewer like stronger Pi UI extensions often do.
6. **Terminal/headless behavior is uneven.** `emitTrace` always writes JSON to `process.stderr` and appends `workflow-trace.jsonl`, including in non-TUI modes. UI calls are guarded with optional chaining, but headless users mainly see repeated markdown tool updates plus stderr JSON lines; no browser console or web panel output exists.
7. **Subprocess buffering is partial.** `runProcess(...)` streams stdout/stderr to logs but does not store aggregate stdout/stderr in `ProcessResult.output`; `runPiAgentSubprocess(...)` buffers stderr and final assistant text but ignores non-JSON stdout lines from the fallback Pi process.
8. **Widget scalability limits.** The widget prints all task titles once tasks are planned and can grow tall on large task lists. Long lines are not explicitly width-truncated in this plugin; it relies on Pi widget rendering behavior.

## Addressed gaps (log-display increment)

The following items from **Constraints and current gaps/issues** above are now partially or fully addressed in `.pi/extensions/cc-review.ts`. Original gap descriptions are retained for historical context; this section records the current mitigation only.

| Gap | Status | Mitigation |
| --- | --- | --- |
| 1. Rolling display loses context | **Partially addressed** | `workflow-logs.jsonl` persists the full normalized human-readable log for the run and the final summary links to it. The in-widget tail remains capped at five lines. |
| 2. `onUpdate` is noisy and repetitive | **Addressed** | `log()` emits per-entry compact deltas via `renderCcReviewLogEntry` instead of re-broadcasting a full goal/phase/last-5 markdown block on every line. |
| 3. Human logs and trace logs are split | **Partially addressed** | Live logs are normalized `CcReviewLogEntry` objects with `severity`, `source`, `timestamp`, and `message` before rendering or persistence. Trace JSONL remains separate and redacted. |
| 4. Potential sensitive or overly verbose display | **Partially addressed** | `previewWidgetText` redacts long goals/task titles on compact surfaces; `filterCcReviewLogEntries` plus `--log-level` / `CC_REVIEW_LOG_LEVEL` hide lower-severity lines from the widget/`onUpdate` path while persistence stays complete. |
| 5. No dedicated renderer/panel | **Partially addressed** | Severity-aware log rendering, widget rollup line, windowed checklist, and a `cc-review-summary` message renderer with success/warning/failed badges. No standalone log viewer panel yet. |
| 6. Terminal/headless behavior is uneven | **Unchanged** | UI calls remain optional-chained; headless users still see tool `onUpdate` deltas and stderr/trace JSONL. |
| 7. Subprocess buffering is partial | **Unchanged** | Streaming behavior is the same; aggregate stdout is still not stored in `ProcessResult.output`. |
| 8. Widget scalability limits | **Partially addressed** | `computeChecklistWindow` caps visible tasks; `truncateForWidget` and `previewWidgetText` bound line width and long text. |

## Existing tests and missing coverage

Existing tests touching this area:

- `tests/cc-review-static.test.mjs`
  - Asserts `emitTrace(...)` exists and key events are emitted (`workflow_start`, `subagent_assignment`, `tool_execution_start`, `tool_execution_end`, `retry`, `completion`, `failure`).
  - Asserts trace payloads avoid `goalPreview`, `taskTitle`, and subprocess `args`, and include `goalLength`/`taskIndex` minimal fields.
  - Asserts optional UI calls for `setWidget` and `setStatus`, summary construction, state transitions, retries, cancellation, and static docs/contracts.
- `tests/cc-review-behavior.test.ts`
  - Mocks child-process stdout/stderr and subagent `onUpdate` for successful, provider-specific, failure, retry, and timeout paths.
  - Verifies `workflow-trace.jsonl` is created and the first entry has `type: "workflow_trace"` and `event: "workflow_start"`.
  - Exercises stderr/stdout path examples such as planner success, reviewer success/failure, Claude output, rate limit, and subagent progress.
- `README.md`, `workflow-baseline.md`, and `workflow-optimization-criteria.md` contain observability contracts that static tests reference.

Missing or weak coverage:

- No direct assertions on the exact `cc-review-widget` line content, last-5-log behavior, task-list rendering, or status footer text.
- No direct tests for `onUpdate` cadence, duplicate/interleaved subagent partial forwarding, or whether consumers can parse updates as deltas.
- No tests for log redaction/truncation of full goals, task descriptions, stdout/stderr, or subagent text.
- No tests for large task counts, very long log lines, terminal width handling, browser console output, custom message renderers, expandable panels, filtering, or persisted human-readable logs.
- No schema/contract test for `workflow-trace.jsonl` beyond minimal static regex checks and first-entry behavior assertions.

## Implementation-relevant opportunities for a future logging UI story

- Introduce a typed internal log event model (`source`, `severity`, `phase`, `taskIndex`, `message`, `timestamp`) and derive both human UI and trace output from it.
- Persist a bounded human-readable or structured UI log alongside `workflow-trace.jsonl`, with redaction/truncation rules separate from trace minimization.
- Replace repeated full markdown `onUpdate` snapshots with structured deltas plus an occasional compact state summary.
- Use Pi custom rendering patterns (`setWidget` with components, `registerMessageRenderer`, or `renderResult`) for severity colors, expandable details, and a compact default view.
- Add tests that assert widget/status/update behavior without changing the workflow semantics covered by existing provider/subagent tests.
