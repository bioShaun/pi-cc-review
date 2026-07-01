# CC Review Orchestrator: System Target and Baseline Specification

This document clarifies the workflow target ("此流程") defined in `.pi/extensions/cc-review.ts` and its relation to the subagent extension (`_subagent`). It documents the current inputs, outputs, state transitions, and system pain points.

---

## 1. Workflow Target & Architecture Clarification

### What is "此流程" (The Workflow)?
"此流程" refers to the **CC Review Orchestrator** implemented by `.pi/extensions/cc-review.ts`, which implements an autonomous agentic loop by coordinating two execution surfaces:
1. **External review/planning CLIs**: Codex CLI (`codex exec`) is always used for high-level **task planning** (Phase 1). Per-task **review/code patching** (Phase 2B) uses the configured reviewer selected by `CC_REVIEW_PROVIDER`: Codex by default, or Claude via `claude -p` when `CC_REVIEW_PROVIDER=claude`.
2. **Standard `subagent` tool**: Used for step-by-step **task execution** (Phase 2A) within the workspace through `pi.toolManager.executeTool("subagent", ...)` when available, with the documented subprocess fallback implemented in `getSubagentExecutor(...)`.

It bridges the gap between high-level planning and precise code execution by iteratively running tasks, checking results, and repairing faults on the fly.

### Relation to `_subagent` Extension Hooks
- **Delegated Coupling**: `.pi/extensions/cc-review.ts` does not import `_subagent` internals directly. It delegates through the public extension API by resolving `pi.toolManager.executeTool` in `getSubagentExecutor(...)`.
- **Subagent Dispatch**: Planned subtasks prefer `pi.toolManager.executeTool` when the runtime exposes it and otherwise use the implemented `pi --mode json -p --no-session` fallback that mirrors `_subagent` behavior. Codex planning and configured review remain the only provider-specific subprocess behavior.
- **Standard Agent Profiles**: Planned subtasks are dispatched to the `worker` profile with `agentScope: "user"`, allowing the standard `subagent` tool to own profile discovery, settings inheritance, safety controls, and execution details.

---

## 1.1. Code-Tied Execution Path Map

Concrete locations in `.pi/extensions/cc-review.ts`:

1. **Triggers**:
   - Slash command registration starts at `registerCommand("cc-review", ...)` and calls `runCcReviewWorkflow(...)` after collecting the goal.
   - Tool registration starts at `registerTool({ name: "cc_review", ... })` and calls `runCcReviewWorkflow(...)` with an `AbortSignal` and `onUpdate` callback.
2. **Subagent Creation / Dispatch**:
   - `getSubagentExecutor(pi)` resolves `pi.toolManager.executeTool`.
   - Planned subtasks are dispatched with `executeSubagentTool("subagent", { agent: "worker", task: attemptPrompt, agentScope: "user", cwd }, signal, onUpdate, ctx)`.
   - `getSubagentExitCode(...)` maps subagent tool results to deterministic execution codes.
3. **Planning and Task Collection**:
   - Codex planning arguments are built in `codexPlanArgs`.
   - The planner result file is read, parsed as JSON, and converted into `tasks` after schema output is produced.
4. **Task Execution and Stream Collection**:
   - The execution loop starts at `for (let i = 0; i < tasks.length; i++)`.
   - Subagent `onUpdate` text is streamed into live logs and forwarded to the caller's `onUpdate`.
   - Tool start/end trace events are emitted around each subagent execution attempt.
5. **Review and Result Collection**:
   - Review arguments are built through `reviewProviderConfig.buildArgs({ task })` and dispatched through `runProcess(...)` using the configured reviewer command.
   - Per-task execution/review exit codes, validation errors, unresolved items, and statuses are stored in `taskResults`.
   - The final report summarizes completed, warning, failed, validation-failed, skipped, and cancelled states.
6. **Retries and Observability**:
   - Structured trace event logger (`emitTrace`) implemented to support lightweight structured logging across all key stages (workflow start, subagent assignment, tool execution, retry, completion, and failure).
   - Multi-tiered retries implemented for Phase 1 (up to `maxPlanRetries = 3` for planning JSON schema validation/subprocess errors, with exponential backoff) and Phase 2 (up to `maxTaskExecutionRetries = 2` for task execution subprocess errors).
   - Bounded retries for transient subagent failures (up to `maxTransientRetries = 3` with exponential backoff) when transient errors (e.g. rate limits, timeouts, connection resets) are detected, with clear stop conditions.
   - Actionable fallback path that appends concrete "Suggested Actionable Steps to Recover" to the final summary report whenever a task fails or halts unrecoverably.
7. **Cancellation and Errors**:
   - Cancellation is checked by `throwIfAborted()` before major workflow phases and task attempts.
   - The abort handler sends `SIGTERM` to tracked Codex process groups, then escalates to `SIGKILL` after a short grace period.
   - `runProcess(...)` handles spawn errors, subprocess timeouts, and child close-after-abort as controlled workflow failures.

---

## 2. Current Baseline Specifications

### 2.1. Inputs
1. **Goal String (`goal`)**:
   - Received via slash-command argument (e.g. `/cc-review <goal>`),
   - Or as an argument of the registered tool `cc_review({ goal: "..." })`,
   - Or via interactive TUI prompt `ctx.ui.input(...)` if empty.
2. **Structured JSON Task Schema**:
   - A hardcoded task breakdown schema defined inside the extension to specify the expected JSON output form of Codex:
     ```json
     {
       "type": "object",
       "properties": {
         "tasks": {
           "type": "array",
           "items": {
            "type": "object",
            "properties": {
              "title": { "type": "string" },
              "description": { "type": "string" },
              "acceptanceCriteria": { "type": "string" }
            },
            "required": ["title", "description", "acceptanceCriteria"],
             "additionalProperties": false
           }
         }
       },
       "required": ["tasks"],
       "additionalProperties": false
     }
     ```
3. **Workspace State (`ctx.cwd`)**:
   - The files in the active directory where the delegated subagent and the configured reviewer do their work.

### 2.2. Outputs
1. **Final Summary Report (Markdown)**:
   - A Markdown report detailing the completed tasks and their status.
   - In slash-command mode, sent to the main session using `pi.sendMessage` with `customType: "cc-review-summary"`.
   - In tool mode, returned as the tool execution response content.
   - If task execution fails after retries, the workflow terminates early and records failed/skipped states. If the configured reviewer exits non-zero, the report records a warning status with the relevant exit codes instead of claiming full success.
2. **File Mutations**:
   - Direct, in-place edits to the workspace files made by the delegated subagent task execution and subsequent configured review-and-fix steps.
3. **Dynamic TUI Dashboard & Progress Indicators**:
   - An interactive widget named `cc-review-widget` displayed in the TUI containing the active task list, current status (Completed `✔`, In Progress `▸`, Pending `☐`), current phase, and a rolling log of the last 5 output events.
   - A status bar item named `cc-review-status` indicating the active phase.

---

## 3. Workflow State Transitions (State Machine)

```
 [User Input/Goal] 
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│ State: Initializing                                     │
│ - Registers abort signal listener                       │
│ - Prepares schema and temporary file paths              │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│ State: Planning Tasks via Codex                         │
│ - Spawns: `codex exec` with --output-schema and -o      │
│ - Transitions:                                          │
│   ├─ Success (0): Parse tasks list JSON -> Begin Loop   │
│   └─ Failure (!= 0): Throw error -> Cleanup & Exit      │
│ - If process spawn itself errors: controlled failure     │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼  (Loop through task i = 1 to N)
┌─────────────────────────────────────────────────────────┐
│ Loop Entry State: Executing Task i/N                    │
│ - Calls: `pi.toolManager.executeTool("subagent", ...)`  │
│ - Action: Stream subagent updates into logs/onUpdate    │
│ - Transitions:                                          │
│   ├─ Valid exit 0: Move to Review Phase                 │
│   ├─ Invalid/failing output: Retry with feedback         │
│   └─ Exhausted retries: Halt and summarize partial work │
│ - If tool execution itself errors: controlled failure    │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│ State: Reviewing Task i/N                               │
│ - Spawns configured reviewer (`codex exec` or `claude`) │
│ - Action: Identifies bugs/errors, patches files in-place│
│ - Transitions:                                          │
│   ├─ Exit 0: Log success                                │
│   ├─ Exit != 0: Log warning, still continue             │
│   ├─ Next Task (i < N): Increment i -> Executing Task i │
│   └─ Final Task (i = N): Loop End -> Move to Complete   │
│ - If process spawn itself errors: controlled failure     │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│ State: Complete / Cleanup                               │
│ - Action: Formats report, removes temp files, clears TUI│
└─────────────────────────────────────────────────────────┘
```

---

## 4. Current Pain Points & System Limitations

Before making behavioral changes, preserve these known constraints and remaining optimization targets:

1. **Subagent Session Continuity**:
   - Planned subtasks are delegated to the standard `subagent` tool, but the orchestrator still needs an explicit contract for preserving cross-task state beyond workspace file mutations and summarized parent context.
2. **Codex Executable Discovery**:
   - The orchestrator still assumes `codex` is globally present on the shell path. Spawn-time failures such as `ENOENT` are converted into controlled workflow errors by `runProcess(...)`, but executable discovery remains a future hardening target.
3. **Review-Loop Depth**:
   - Task execution has retry/self-repair feedback, but the configured review phase is still a single pass. Non-zero review exits are recorded as warnings rather than triggering a bounded review repair loop.
4. **Status Reporting Surface**:
   - UI calls use optional chaining and tolerate headless contexts. Future work should preserve this behavior while adding higher-fidelity event classification.
5. **Cancellation Boundaries**:
   - Planner and configured-reviewer subprocesses are tracked as detached process groups and receive `SIGTERM` followed by `SIGKILL`. Subagent cancellation is delegated through `AbortSignal`; future optimization should verify the delegated tool propagates cancellation to its own children.
6. **Temporary Directory Contract**:
   - Planning schemas and outputs live inside a per-run `fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-"))` directory and are removed in `finally`. Future work must keep all transient workflow artifacts inside this isolated directory.
