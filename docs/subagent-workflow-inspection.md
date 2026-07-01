# Implementation Note: Subagent Orchestration & UI Data Flow

This document maps the subagent workflow, orchestration entrypoints, UI state representation, and execution model for the CC Review system. It serves as a guide for subsequent tasks implementing features like subagent model name rendering and parallel subagent execution.

---

## 1. Subagent Orchestration & Creation Entrypoint

The entire workflow is managed within the CC Review extension.

- **Main Tool Entrypoint:** 
  - Registered tool: `cc_review` via `pi.registerTool` in `.pi/extensions/cc-review.ts`.
  - Execution delegates to: `runCcReviewWorkflow` (defined in `.pi/extensions/cc-review.ts` at line `4222`).

- **Subagent Dispatch / Invocation:**
  - Inside `runCcReviewWorkflow`, Phase 2 (Task Execution Loop) handles task dispatch.
  - It resolves the executor using `getSubagentExecutor(pi)` (defined in `.pi/extensions/cc-review.ts` at line `3894`), returning a `SubagentToolExecutor`.
  - It executes the subagent tool with parameters:
    ```typescript
    {
      agent: "worker",
      task: attemptPrompt,
      agentScope: "both",
      cwd: ctx?.cwd ?? process.cwd(),
    }
    ```
  - `getSubagentExecutor` falls back to spawning `pi` as a subprocess via `runPiAgentSubprocess` (defined in `.pi/extensions/cc-review.ts` at line `3639`) using the discovered worker definition.

---

## 2. UI Data Flow & Event Payloads

Subagents are represented in the TUI through state properties in the widget, live log objects, and event streams.

### A. Widget State Properties
The UI state is managed via `CcReviewWidgetState` in `.pi/extensions/cc-review.ts`. Key properties related to the subagents include:
- `tasks`: An array of `readonly { title: string; status?: TaskStatus; model?: string }[]` representing the overall task breakdown, execution outcomes, and optional resolved model labels.
- `currentTaskIndex`: The index of the active subagent task.
- `displayState`: A string indicating the orchestration status (`"executing"`, `"retrying"`, `"reviewing"`, `"complete"`, `"warning"`, `"failed"`, `"cancelled"`).
- `liveLogs`: A chronological stream of normalized `CcReviewLogEntry` items.

### B. Subagent Status & Verification Data Types
- Task statuses are driven by the `TaskStatus` type defined in `.pi/extensions/cc-review/structured.ts`:
  ```typescript
  export type TaskStatus =
    | "completed"
    | "completed_with_warnings"
    | "failed"
    | "validation_failed"
    | "review_blocked";
  ```
- Individual task results are recorded in a `TaskResult` structure after execution.
- Subagent model metadata is carried as optional `model` fields on `SubagentResult`, `SubagentToolResult`, `TaskResult`, and widget task rows. Historical results without `model` remain valid; the widget renders `Unknown model` only for active/running rows where the model has not yet been resolved.

### C. Log Payload
Subagent streams and execution progress are normalized into `CcReviewLogEntry` objects:
```typescript
export interface CcReviewLogEntry {
  id: string;
  timestamp: string;
  severity: CcReviewLogSeverity; // "debug" | "info" | "warning" | "error"
  source: string;               // "subagent" for logs originating from subagents
  pluginId: string;
  message: string;
  details?: unknown;
  sequence: number;
}
```

### D. Streaming Updates
While the subagent process executes, standard error output is parsed in `runPiAgentSubprocess` for NDJSON events (such as `tool_execution_start`, `tool_execution_end`, `message_update`, `text_delta`, and `message_end`). These events are throttled and forwarded as `onUpdate({ content: [{ type: "text", text: ... }] })` payloads to stream real-time reasoning to the caller.

---

## 3. UI Rendering Components

Three distinct UI elements display the status of subagent tasks:

1. **TUI Widget (`cc-review-widget`):** 
   - Set via `ctx.ui.setWidget("cc-review-widget", ...)` in `.pi/extensions/cc-review.ts` inside `refreshWorkflowUi()`.
   - Rendered using `buildCcReviewWidgetLines(state, options)` (line `1888`), which builds a formatted multi-line block showing the goal, task checklist with status icons (derived from `getTaskVisuals`), current phase, findings rollup, and a live tail of filtered `liveLogs`.

2. **Status Bar (`cc-review-status`):**
   - Set via `ctx.ui.setStatus("cc-review-status", statusText)` in `updateDisplayState()` to display a concise, colored status line in the TUI status area.

3. **Message Renderers:**
   - Custom renderers registered via `pi.registerMessageRenderer` for `"cc-review-findings"` and `"cc-review-summary"` render rich message blocks in the pi chat message pane.

---

## 4. Execution Model (Serial vs. Parallel)

Subagent execution is dependency-aware.

- In `after-all` review mode, `runCcReviewWorkflow` builds execution levels with `buildAfterAllExecutionBatches(tasks)`.
- Tasks may run concurrently up to `CC_REVIEW_CONCURRENCY`, `--concurrency`, `--concurrency-limit`, or tool params `concurrency` / `concurrencyLimit` (default `4`) only when the planner marks them with explicit compatible `dependsOn` metadata.
- Missing `dependsOn` metadata is treated conservatively as an ordered dependency on the previous task, preserving the prior handoff semantics for older plans and sequential workflows.
- Each dependency batch captures a stable prior-task handoff before launching its tasks, so sibling tasks in the same parallel batch do not race to include one another's partial results.

Example dependency-aware dispatch shape:
  ```typescript
  const executionBatches = buildAfterAllExecutionBatches(tasks);
  for (const batch of executionBatches) {
    const batchPriorHandoff = priorTaskHandoffFromResults(completedTaskResults);
    await runWithConcurrencyLimit(resolvedConcurrency, batch, async ({ task, index }) => {
      const subagentPrompt = buildSubagentTaskPrompt(task, parentContext, batchPriorHandoff);
      // execute subagent for this task/index
    });
  }
  ```
