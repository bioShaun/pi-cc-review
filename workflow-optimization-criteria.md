# CC Review Orchestrator: Optimization Criteria Specification

> Date: 2026-06-23  
> Status: Proposed  
> Baseline Document: `workflow-baseline.md`  
> Target Implementation: `.pi/extensions/cc-review.ts`  
> Scope: Define concrete, measurable, and verifiable optimization criteria to guide the next development and hardening iterations.

---

## 1. Overview of Optimization Goals

This document translates the architectural pain points identified in `workflow-baseline.md` into a set of **Measurable Optimization Criteria**. 

The goal of this optimization is to preserve the move away from isolated, generic task-execution subprocesses and continue hardening the CC Review Orchestrator into a context-aware, highly reliable agentic orchestrator. We aim to achieve this by:
- **Reducing redundant/wasteful operations** (especially expensive subagent and Codex calls).
- **Ensuring strict session and context continuity** across sequential subtasks.
- **Integrating natively with the standard `_subagent` system** for unified agent execution, easy configuration, and safety.
- **Enhancing resilience and error recovery** via multi-tiered retry and self-repair loops.
- **Providing bulletproof, headless-safe status reporting and cancellation.**

---

## 2. Measurable Optimization Criteria

Each of the following criteria maps to a specific pain point from the baseline, defining exactly how success will be measured and verified.

### Criterion 1: Session & Context Continuity (Lower Latency & Fewer Redundant Calls)
* **Goal**: Make delegated subagent subtasks build on the context, state, and credentials of preceding tasks instead of depending only on workspace file mutations and repeated setup.
* **Measurable Criteria**:
  1. **Cumulative Context Passing**: Sequential tasks must run within the *same* continuous execution session, or pass a serialized state/diff buffer containing the exact workspace history, logs, and derived variables from previous runs.
  2. **Reduced Re-initialization**: The time spent on environment/subagent initialization after the first subtask must be reduced by $\ge 50\%$.
  3. **Context Verification**: If Task 1 sets a workspace configuration, creates a local state variable, or installs a package, Task 2 must be able to read and utilize it immediately without any redundant setup calls.
* **Verification Method**:
  - Run a 2-task workflow where Task 1 writes a temporary variable/config and Task 2 reads and outputs it. The workflow must succeed, and Task 2 initialization time must be at least 50% lower than Task 1 initialization time when measured from subagent dispatch to first structured output event.

### Criterion 2: Integration with `_subagent` Extension (Easier Configuration & Unified Execution)
* **Goal**: Preserve the standard `subagent` result contract and worker profile semantics across runtimes where the in-process tool manager may or may not be exposed.
* **Measurable Criteria**:
  1. **Contract-Preserving Dispatch**: Planned subtasks in `cc-review.ts` must flow through `getSubagentExecutor(pi)` and return the canonical `content`, `details.results[0]`, and `isError` shape.
  2. **Standard Agent Profiles**: Subtask execution must target specialized agents (e.g., `worker`, `evaluator`, `reviewer`) with `agentScope` semantics matching the standard `subagent` tool.
  3. **Configuration Inheritance**: The orchestrator must inherit and respect model overrides, safety filters, custom tool limits, and timeouts defined in standard configurations (e.g., `settings.json` or `.pi/agents`) instead of hardcoding provider behavior.
* **Verification Method**:
  - Static Code Audit: planned-task execution must call `getSubagentExecutor(pi)`, invoke the returned executor with tool name `subagent`, and parse results via `getSubagentExitCode(...)`. A narrow `grep -E 'spawn\("pi"'` check is insufficient for auditing this path because it misses indirect invocations such as `spawn(piInvocation.command, piInvocation.args, ...)` in the documented fallback.
  - Config Test: Setting a custom model or timeout in the local `subagent` configuration file is automatically reflected in the subtask execution logs.

### Criterion 3: Headless-Resilient, High-Fidelity Status Reporting (Clearer Status Reporting)
* **Goal**: Provide transparent, real-time logging and status updates that never crash in headless or minimally-equipped runtime environments.
* **Measurable Criteria**:
  1. **UI-Safe Notifications**: Every interaction with `ctx.ui` must be fully resilient to headless contexts by checking the specific UI object/method before calling it (for example, `ctx.ui?.setStatus?.(...)`). A `ctx.hasUI` check alone is not sufficient because misconfigured contexts can set `hasUI` without providing a compatible `ctx.ui` implementation.
  2. **Real-time Event Streaming**: 100% of subagent tool updates and planner/configured-reviewer subprocess stdout/stderr streams must be handled in real time. Crucial events, such as `tool_execution_start`, `tool_execution_end`, and text updates, must be dispatched live to the `onUpdate` callback where available.
  3. **No Buffer Loss**: Subprocess stream handlers must preserve trailing output on completion, ensuring no final logs or outputs are truncated.
* **Verification Method**:
  - Headless Run: Run the entire workflow in a headless environment with `ctx.ui` mocked to `undefined`. The run must complete with **0 uncaught exceptions**.
  - Stream Event Check: Assert that `onUpdate` is called at least once per subtask tool execution with the correct structured logs.

### Criterion 4: Multi-Tiered Retry & Self-Repair Loops (Safer Retries & Better Failure Recovery)
* **Goal**: Prevent workflow aborts due to transient failures or minor syntax issues by introducing structured retry and repair mechanisms.
* **Measurable Criteria**:
  1. **Configurable Retry Policies**: Implement structured retry parameters:
     - `maxPlanRetries`: Default 3. Used when Codex returns invalid JSON schemas during the planning phase.
     - `maxTaskExecutionRetries`: Default 2. Used when task execution fails or returns non-zero codes.
  2. **Self-Repair Feedback Loop**: When a task execution fails, the orchestrator must capture the stderr/logs of the failure and feed them back to the subagent or configured reviewer to perform an in-place automated repair, rather than failing immediately or blindly continuing.
* **Verification Method**:
  - Simulate a transient JSON format error in the Codex planner. Confirm that the orchestrator retries up to `maxPlanRetries` and successfully recovers when valid JSON is returned on a subsequent attempt.
  - Simulate an in-place code compilation error. Verify that the self-repair loop is triggered, providing the error message to the repair agent, and resolves the issue successfully.

### Criterion 5: Early Termination & Graceful Error Recovery (Better Failure Recovery)
* **Goal**: Stop wasteful review calls on completely broken bases when error recovery fails, mapping exit states precisely.
* **Measurable Criteria**:
  1. **Early Termination Gate**: If a task execution fails and all retry/self-repair attempts are exhausted, the orchestrator must halt the workflow immediately in tool/headless mode. Interactive slash-command mode may prompt the user, but the default and timeout path must halt rather than unconditionally proceeding to the configured review phase.
  2. **Wasteful Call Reduction**: In a multi-task workflow, if Task $i$ fails unrecoverably, the number of subsequent configured review calls and subsequent subtask executions must be **exactly 0**.
  3. **Strict Exit Code Mapping**: Every non-zero subprocess or subagent exit code must be captured, preserved, and mapped to the current summary classifications (`failed`, `validation_failed`, `completed_with_warnings`, `skipped`, or `cancelled`) in the final summary report.
* **Verification Method**:
  - Inject an unrecoverable failure in Task 1. Verify that the workflow halts immediately, that no configured reviewer subprocess is called for the failed task, and that the final report reports `Failed (subagent exit N)` with the exact exit code.

### Criterion 6: Subprocess Group Abort Grace (Safer Cancellation)
* **Goal**: Ensure 100% clean termination of spawned child processes and their descendants on abort, avoiding zombie processes.
* **Measurable Criteria**:
  1. **Process Group Tracking**: All orchestrator-owned planner and configured-reviewer subprocesses (currently `codex exec` for planning and `codex exec` or `claude -p` for review) must be detached (`detached: true`) so they run in their own process groups. Delegated subagent execution must receive and honor the workflow `AbortSignal`.
  2. **Graceful Escalation**: Upon an abort signal, the orchestrator must send `SIGTERM` to the entire process group (using `-pid`) to allow graceful cleanup. It must wait for a 500ms grace period before sending `SIGKILL` to forcefully terminate any remaining processes.
  3. **Zero Orphaned Children**: After cancellation, the count of orphaned child processes from the orchestrator must be **exactly 0**.
* **Verification Method**:
  - Trigger a workflow run, initiate a heavy subtask, and immediately trigger the abort signal. Use system monitoring (`ps` or `pgrep`) to assert that all child and grandchild processes of the orchestrator are terminated.

### Criterion 7: Secure Temporary Directory Isolation (Safer Resource Management)
* **Goal**: Replace ad-hoc, collision-prone temporary file paths with a secure, isolated temporary directory.
* **Measurable Criteria**:
  1. **Isolated Temp Folder**: The orchestrator must create a uniquely named, isolated directory per run using a standard safe method: `fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-"))` or the async equivalent.
  2. **Zero Clutter Footprint**: All transient JSON schemas, planning outputs, and intermediate files must reside solely inside this isolated directory.
  3. **Guaranteed Cleanup**: A robust, error-proof `finally` block must recursively delete the entire directory and its contents upon workflow success, failure, or cancellation.
* **Verification Method**:
  - Run the workflow. Verify that the custom temp directory is created and populated. Assert that upon exit (whether successful, failed, or aborted), the run-specific `cc-review-*` directory is completely removed and leaves **exactly 0 net files attributable to that run** in `os.tmpdir()`.

---

## 3. Metric & Acceptance Criteria Summary Table

| Metric Category | Target Baseline | Measurable Optimization Criterion | Verification Instrument |
| :--- | :--- | :--- | :--- |
| **Session Continuity** | Isolated `--no-session` | Re-use session / pass context state across tasks. Setup overhead drops by $\ge 50\%$. | 2-Task state inheritance test |
| **Subagent Integration** | Contract-preserving `subagent` execution | Dispatch through `getSubagentExecutor(pi)` and preserve standard result shape/profile semantics. | Robust static audit + config inheritance test |
| **Status Reporting** | Risk of UI crashes | 0 crashes in headless environments; real-time event streaming to `onUpdate`. | Headless mock execution |
| **Safer Retries** | No retry logic | `maxPlanRetries = 3`, `maxTaskExecutionRetries = 2`. In-place self-repair loop. | Injection of transient/compile errors |
| **Failure Recovery** | Proceed blindly on exit != 0 | Stop immediately on unrecoverable execution failure; 0 wasteful subsequent calls. | Non-zero exit code injection |
| **Cancellation Grace** | Immediate `SIGKILL` on PID | Detached process groups; `SIGTERM` $\rightarrow$ 500ms wait $\rightarrow$ `SIGKILL` to `-pid`. | Abort test + process table audit |
| **Resource Isolation** | Shared `os.tmpdir()` files | Uniquely isolated directory via `mkdtemp`; guaranteed recursive cleanup. | Temp directory existence check |

---

## 4. Implementation Phases

To ensure a structured and low-risk delivery, the implementation of these criteria should be divided into three phases:

### Phase I: Reliability & Isolation (P0)
* Implement **Criterion 7 (Secure Temporary Directory Isolation)** to prevent file collisions.
* Implement **Criterion 6 (Subprocess Group Abort Grace)** to guarantee process cleanup.
* Update status reporting and notification APIs to be **Criterion 3 (Headless-Resilient)**.

### Phase II: Core Integration & Failure Recovery (P1)
* Preserve **Criterion 2 (Official `_subagent` Contract Integration)**, leveraging standard agent profiles and settings across both in-process and subprocess-fallback runtimes.
* Implement **Criterion 5 (Early Termination)** to prevent wasted downstream actions on fatal execution errors.
* Implement precise exit code mapping for the final summary report.

### Phase III: Intelligence & Context (P2)
* Implement **Criterion 1 (Session & Context Continuity)** to enable seamless state-transfer between tasks.
* Integrate **Criterion 4 (Multi-Tiered Retry & Self-Repair Loops)** to allow the subagent/configured reviewer to automatically heal compile and syntax errors before completing the phase.

---

## 5. Verification & Compliance Controls

To ensure that future optimization work preserves this core contract, developers must strictly adhere to the following verification and typing checklist before merging any changes:

1. **Strict TypeScript Compliance**:
   - The extension must compile cleanly with zero TypeScript diagnostics under the `--strict true` compiler flag.
   - Run verification command:
     ```bash
     ../adversarial/node_modules/.bin/tsc --noEmit --target es2022 --moduleResolution bundler --typeRoots ../adversarial/node_modules/@types --types node --strict true .pi/extensions/cc-review.ts
     ```

2. **Static Code Validation**:
   - The code architecture must satisfy all assertions inside the static verification test suite.
   - Run command:
     ```bash
     node tests/cc-review-static.test.mjs
     ```

3. **Behavioral Integrity**:
   - Execution paths, retry loops, error states, and cancellation flows must pass all mocked behavior tests.
   - Run command:
     ```bash
     node --experimental-strip-types tests/cc-review-behavior.test.ts
     ```
