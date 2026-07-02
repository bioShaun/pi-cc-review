# CC Review Orchestrator: Development, Verification & Design Contract

This workspace contains the implementation and tests for the **CC Review Orchestrator** extension. This document provides clear guidelines for running the verification test suite, performing strict type-checks, and details the structural contracts that any future optimization work must preserve.

---

## 1. Directory Structure

- `.pi/extensions/cc-review.ts`: Entry-point re-export that loads the modular extension from `.pi/extensions/cc-review/`.
- `.pi/extensions/cc-review/`: Modular extension tree (`workflow.ts`, `config.ts`, `providers.ts`, `structured.ts`, `subprocess.ts`, and `workflow/` orchestrator modules).
- `tests/cc-review-static.test.mjs`: Node native static assertion test suite verifying structural properties, schema structures, regex matches, and baseline compliance.
- `tests/cc-review-behavior.test.ts`: Node native behavioral test suite mocking the `pi` API and child processes to verify successful multi-step execution, retry loops, cancellation, output validation, and trace logging.
- `workflow-baseline.md`: System target and baseline specification.
- `workflow-optimization-criteria.md`: Concrete metrics and criteria for optimization.

---

## 2. Installation, Update, and Verification Guide

The extension is installed as the **CC Review** plugin. The entry point is `.pi/extensions/cc-review.ts`, which re-exports the modular implementation from `.pi/extensions/cc-review/`.

Active user-facing entry points:

- Slash command: `/cc-review <goal>`
- Tool name for API/tool calls: `cc_review`
- Display label: `CC Review`

To install or update the plugin in a Pi workspace, copy **both** `.pi/extensions/cc-review.ts` **and** the entire `.pi/extensions/cc-review/` directory into that workspace's `.pi/extensions/` directory, replacing any older copies, then restart or reload Pi so extension registration is refreshed. The entry-point file depends on the sibling directory; copying only `cc-review.ts` will produce a broken plugin.

To guarantee code quality and prevent regression, developers must run the verification suites and TypeScript compiler checks after any changes.

### 2.1. Running the Test Suites

Both test suites use Node's native `node:test` runner and do not require external test frameworks.

```bash
# 1. Run the static verification tests
node tests/cc-review-static.test.mjs

# 2. Run the structured schema tests
node --experimental-strip-types tests/cc-review-structured.test.ts

# 3. Run the UI regression tests
node --experimental-strip-types tests/cc-review-ui.test.ts

# 4. Run the behavioral verification tests
node --experimental-strip-types tests/cc-review-behavior.test.ts

# 5. Run all tests together
node tests/cc-review-static.test.mjs && \
  node --experimental-strip-types tests/cc-review-structured.test.ts && \
  node --experimental-strip-types tests/cc-review-ui.test.ts && \
  node --experimental-strip-types tests/cc-review-behavior.test.ts

# 6. Strict type-check
npm run typecheck
```

### 2.2. Review Provider Configuration

By default, Codex plans tasks and reviews each completed task. The explicit `reviewProvider` option or `CC_REVIEW_PROVIDER` selects both the planner and reviewer backend.

Supported review provider values are `codex` and `claude`:

- Explicit API/tool parameter: pass `reviewProvider: "codex"` or `reviewProvider: "claude"` with the `cc_review` tool call. This takes precedence over `CC_REVIEW_PROVIDER`.
- Slash command flag: pass `--provider codex`, `--provider=codex`, `--provider claude`, or `--provider=claude` before or after the goal text.
- Environment variable fallback: set `CC_REVIEW_PROVIDER=codex` or `CC_REVIEW_PROVIDER=claude` when no explicit option is supplied.
- Omitted option and unset environment variable: defaults to `codex` review.
- Empty, whitespace-only, or any other unsupported explicit/environment value: fails fast with a clear invalid provider error before the workflow proceeds.

Example commands:

```bash
# Default behavior: Codex plans and Codex reviews
pi --mode json -p "Use the cc_review tool to implement: <goal>"

# Slash command usage inside Pi without a provider option preserves existing behavior
/cc-review <goal>

# Slash command provider selection without exporting environment variables
/cc-review --provider claude <goal>
/cc-review --provider=codex <goal>

# API/tool parameter selection without exporting environment variables
pi --mode json -p 'Use the cc_review tool with goal "<goal>" and reviewProvider "claude"'
pi --mode json -p 'Use the cc_review tool with goal "<goal>" and reviewProvider "codex"'

# Environment fallback: use Claude for planning and review when no explicit option is passed
CC_REVIEW_PROVIDER=claude pi --mode json -p "Use the cc_review tool to implement: <goal>"

# Persist provider selection for the current shell
export CC_REVIEW_PROVIDER=claude
pi --mode json -p "Use the cc_review tool to implement: <goal>"
```

Backend initialization is selected-provider only: after `reviewProvider`, `--provider`, or `CC_REVIEW_PROVIDER` is normalized, the extension launches only the chosen CLI for planning and review. Authentication is delegated entirely to that CLI's own login session or environment.

Selected Codex review setup:

1. Ensure the `codex` CLI is on `PATH` for the review phase and is logged in (or has `CODEX_API_KEY`/`OPENAI_API_KEY` set if you prefer env auth).
2. Optionally choose the Codex review model with `CODEX_MODEL`.

Selected Claude review setup uses the Claude Code CLI in non-interactive print mode (`claude -p`), so the review process can inspect and edit the current workspace the same way the Codex reviewer can:

1. Install the Claude Code CLI and ensure `claude` is on `PATH`, then run `claude` once to complete its login (or set `ANTHROPIC_API_KEY`/`CLAUDE_API_KEY` if you prefer env auth).
2. Optionally choose the Claude review model with `CLAUDE_MODEL`.

```bash
# Easiest path: rely on the claude CLI's own login session — no env vars needed
/cc-review --provider claude <goal>

# Or, if you prefer env auth
export ANTHROPIC_API_KEY="<your Claude review key>"
export CLAUDE_MODEL=sonnet
pi --mode json -p "Use the cc_review tool with goal '<goal>' and reviewProvider 'claude'"
```

```bash
# Codex reviewer via env auth (CLI login also works without these vars)
export CODEX_API_KEY="<your Codex review key>"
export CODEX_MODEL="<optional Codex review model>"
pi --mode json -p "Use the cc_review tool to implement: <goal>"
```

### 2.3. Review Timing

CC Review supports two execution modes:

- `per-task`: execute, validate, and review each task before starting the next task.
- `after-all` (default): execute and validate every task first, then invoke the reviewer once for the complete workflow. The final reviewer can fix cross-task integration issues, runs the configured post-review verification once, and writes the shared verdict into every task artifact.

Select the mode through one of these interfaces:

```bash
# Slash command
/cc-review --review-mode after-all <goal>

# Tool parameter
pi --mode json -p 'Use cc_review with goal "<goal>" and reviewMode "after-all"'

# Environment fallback
CC_REVIEW_MODE=after-all pi --mode json -p "Use cc_review to implement: <goal>"
```

An explicit `reviewMode` or `--review-mode` takes precedence over `CC_REVIEW_MODE`. Supported values are exactly `per-task` and `after-all`; omitted configuration defaults to `after-all`.

In `after-all` mode, an unrecoverable task execution or output-validation failure still halts immediately because there is no complete workflow to review.

### 2.4. Troubleshooting Provider Setup

- **Missing CLI**: CC Review runs a lightweight preflight before planning (unless `CC_REVIEW_SKIP_PREFLIGHT=1`). Use `/cc-review --check` or `checkOnly: true` to validate the environment without starting a workflow. If the selected provider CLI is missing from `PATH`, you get a CC Review-owned error with remediation hints before any planner tokens are spent.
- **Auth failures from the CLI**: if `claude` or `codex` reports an auth/login error inside the review step, run the CLI directly once (`claude` / `codex login`) to refresh its login session, or export `ANTHROPIC_API_KEY`/`CLAUDE_API_KEY` (Claude) or `CODEX_API_KEY`/`OPENAI_API_KEY` (Codex) and re-run. CC Review will record the non-zero review exit as `completed_with_warnings` and continue.
- **Unselected provider credentials**: only the selected backend's CLI is spawned. Missing credentials or missing CLI for the *unselected* provider never block the workflow.
- **Unexpected provider value**: set `reviewProvider`, `--provider`, or `CC_REVIEW_PROVIDER` to exactly `codex` or `claude`, or omit/unset provider selection to use the default Codex reviewer. Values are case/whitespace normalized, but empty, whitespace-only, and unsupported names fail with an invalid provider error such as `Invalid reviewProvider` or `Invalid CC_REVIEW_PROVIDER`.
- **Provider precedence confusion**: explicit `reviewProvider` or `--provider` values take precedence over `CC_REVIEW_PROVIDER`; `CC_REVIEW_PROVIDER` is used only when no explicit option is supplied.
- **Planning provider confusion**: provider selection applies to both planning and review.

### 2.5. Strict Type-Checking

The extension `.pi/extensions/cc-review.ts` (and its modular `.pi/extensions/cc-review/` tree) must maintain **100% strict type safety**. It should compile with zero TypeScript diagnostics under Node's standard type configuration.

Install the pinned development dependencies once, then run the repository-local type-check script:

```bash
npm install
npm run typecheck
```

*Note: Clean strict type-checking must always return `exit code 0` with absolutely no output/errors.*

### 2.6. Manual Verification Checklist

Use this checklist after changes that affect plugin registration, provider selection, release packaging, or marketplace/display metadata. Do not commit real credentials or secret-bearing logs.

- [ ] **Install/load smoke test**: copy `.pi/extensions/cc-review.ts` **and** the `.pi/extensions/cc-review/` directory into a clean Pi workspace's `.pi/extensions/` directory, restart or reload Pi, and confirm the active display name is **CC Review**.
- [ ] **Command and tool discovery**: confirm the slash command appears as `/cc-review <goal>` and API/tool usage exposes `cc_review` with label `CC Review`; no active command or tool alias should use the old pre-rename identity.
- [ ] **Default review path**: with `CC_REVIEW_PROVIDER` unset, run a small disposable goal and verify the workflow plans with Codex and reviews with the default Codex reviewer.
- [ ] **Claude review path**: run the same disposable goal with `CC_REVIEW_PROVIDER=claude` using mocked/test Claude credentials or a test Claude Code CLI login; verify planning still uses Codex and the review/fix phase invokes `claude -p`.
- [ ] **Missing selected-provider setup check**: in a disposable shell, temporarily uninstall the selected provider's CLI (`codex` or `claude`) from `PATH` and confirm the workflow surfaces the CLI's own error in the review step as `completed_with_warnings`. CC Review does not preflight credentials, so unset env vars alone will not trigger a CC Review error — the CLI's login session decides.
- [ ] **Marketplace/display metadata**: if publishing or packaging outside this repository, inspect the extension listing, marketplace card, screenshots, and generated help text for the **CC Review** name and `cc_review` tool ID.
- [ ] **Old-name repository search**: run `rg -n "codex[-_ ]workflow|Codex[- ]Workflow" .` and confirm matches are limited to historical migration notes/tests that intentionally describe old names, not active source or user-facing command documentation.
- [ ] **Automated regression commands**: run `node tests/cc-review-static.test.mjs`, `node --experimental-strip-types tests/cc-review-structured.test.ts`, `node --experimental-strip-types tests/cc-review-ui.test.ts`, `node --experimental-strip-types tests/cc-review-behavior.test.ts`, and `npm run typecheck` (wraps `tsc --noEmit` via `tsconfig.json`).

### 2.7. Log Display and Observability

CC Review separates **durable observability** (full history on disk) from **compact live surfaces** (TUI widget and tool `onUpdate` deltas). By default each run writes logs under `.cc-review/logs/<runId>/` (`workflow-logs.jsonl` and `workflow-trace.jsonl`). Set `CC_REVIEW_LOG_ROOT=1` to restore legacy workspace-root log files. Explicit `--log-file` / `CC_REVIEW_LOG_FILE` behavior is unchanged.

#### Minimum log level (`--log-level` / `CC_REVIEW_LOG_LEVEL`)

Filter which severities appear on compact surfaces without hiding them from the persisted log:

- **Explicit API/tool parameter**: pass `logLevel: "debug"`, `"info"`, `"warning"`, or `"error"` with the `cc_review` tool call. This takes precedence over `CC_REVIEW_LOG_LEVEL`.
- **Slash command flag**: pass `--log-level warning`, `--log-level=error`, or place the flag before/after the goal text.
- **Environment fallback**: set `CC_REVIEW_LOG_LEVEL=warning` (or `debug` / `info` / `error`) when no explicit option is supplied.
- **Default**: when omitted and unset, compact surfaces use `info` as the minimum severity (`debug` lines are filtered out of the widget/`onUpdate` path only).
- **Aliases**: `warn` maps to `warning`; `fatal` maps to `error`. Values are trimmed and case-insensitive.
- **Invalid values**: unknown, empty, or whitespace-only explicit flag values fall back to `info` and emit exactly one warning entry in the persisted log; the workflow does not crash.

Example commands:

```bash
# Show only warnings and errors in the widget / onUpdate stream
/cc-review --log-level warning Implement the auth refactor

# Same control through the tool API
pi --mode json -p 'Use the cc_review tool with goal "Ship the dashboard" and logLevel "error"'

# Shell-wide fallback when no explicit option is passed
export CC_REVIEW_LOG_LEVEL=warning
pi --mode json -p "Use the cc_review tool to implement: <goal>"
```

#### Log sources (`--log-sources` / `CC_REVIEW_LOG_SOURCES`)

Optionally restrict compact widget and `onUpdate` logs to a comma-separated allow-list of `planner`, `subagent`, `reviewer`, and `cc-review`:

```bash
/cc-review --log-sources planner,subagent Implement the auth refactor
CC_REVIEW_LOG_SOURCES=reviewer,cc-review pi --mode json -p "Use cc_review to implement: <goal>"
```

The tool parameter is `logSources`. Explicit values override the environment, invalid values show all sources with one warning, and persisted logs remain unfiltered (the persisted JSONL log file is never filtered).

#### Compact widget affordances

- **Severity rollup line**: directly under the phase line, the widget shows a width-bounded `Σ …` summary counting errors, warnings, info, and debug entries across the in-memory buffer (for example, `Σ 1 error · 2 warnings · 5 info`). Only non-zero counts are shown; info/debug-only buffers collapse to a neutral `Σ no issues` line.
- **Redacted goal/title previews**: long goals and task titles are collapsed to a single line and capped (default 80 characters with an ellipsis) before terminal-width truncation. The full goal and task titles remain in the final markdown summary and persisted log.
- **Severity-aware live log lines**: the last five filtered log lines use theme-style prefixes (`DEBUG`, `INFO`, `WARN`, `ERROR`) with timestamps and source badges.
- **Readable provider activity**: Codex JSONL events and Claude Code `stream-json` events are buffered to complete lines and translated into actions such as `Running command`, `Using tool`, `Updated files`, `Thinking`, and `run completed`. Unknown or malformed provider JSON is omitted from the compact display instead of exposing raw payloads.
- **Summary message renderer**: slash-command completion uses `customType: "cc-review-summary"`. When Pi exposes `registerMessageRenderer` and the TUI primitives are available, the final report renders a compact success/warning/failed/cancelled badge with a one-line headline; expand to read the full markdown body. Headless/test environments without the renderer API keep the existing markdown fallback.

Structured trace output (`emitTrace` → stderr and `workflow-trace.jsonl`) is unchanged: it remains lightweight, redacted, and independent of the human-readable persisted JSONL log file.

#### Execution timeouts (`--task-timeout` / `CC_REVIEW_TASK_TIMEOUT_MS`)

The per-attempt subagent execution timeout is configurable. The default is 30 minutes (1800000 ms); set it to `0` to disable the timeout entirely.

- **Explicit API/tool parameter**: pass `taskTimeoutMs: 1800000` with the `cc_review` tool call. This takes precedence over `CC_REVIEW_TASK_TIMEOUT_MS`.
- **Slash command flag**: pass `--task-timeout 600000` or `--task-timeout=0` before or after the goal text.
- **Environment fallback**: set `CC_REVIEW_TASK_TIMEOUT_MS=600000` when no explicit option is supplied.
- **Default**: when omitted and unset, the timeout is 1800000 ms (30 min).

Planner and reviewer subprocess timeouts are separately configurable via `CC_REVIEW_PLANNER_TIMEOUT_MS` and `CC_REVIEW_REVIEWER_TIMEOUT_MS` (default 600000 ms / 10 min each). A planner timeout triggers a retry with backoff; a reviewer timeout degrades to `completed_with_warnings` instead of aborting the workflow.

```bash
# Allow subagent tasks up to 45 minutes per attempt
/cc-review --task-timeout 2700000 Implement the large refactor

# Disable the subagent timeout entirely (use with caution)
CC_REVIEW_TASK_TIMEOUT_MS=0 pi --mode json -p "Use the cc_review tool to implement: <goal>"
```

#### Reviewer repair loop (`reviewRepairRounds`)

By default, `after-all` review uses two explicit phases. The first reviewer invocation is inspection-only and emits each actionable issue as `[Review Finding]`. When findings exist, CC Review emits `[Repair Started]`, re-dispatches the reviewer with the structured findings, runs repository verification, and emits `[Repair Completed]` only after validation passes. A failed or still-blocked repair emits `[Repair Failed]`.

Reviewer file changes require a repository-owned `.cc-review-validation.json`. This repository includes one that runs the static, structured, UI, and behavioral suites; failed commands are included in the next repair prompt and rerun after the fix.

The default is `1`, allowing one repair/re-review round after inspection. Set it to `0` to disable repair and hard-fail if the initial review remains blocked. Configure it through any interface:

```bash
# Slash command
/cc-review --review-repair-rounds 3 <goal>

# Tool parameter
pi --mode json -p 'Use cc_review with goal "<goal>" and reviewRepairRounds 3'

# Environment fallback
CC_REVIEW_MAX_REPAIR_ROUNDS=3 pi --mode json -p "Use the cc_review tool to implement: <goal>"
```

An explicit `reviewRepairRounds` or `--review-repair-rounds` takes precedence over `CC_REVIEW_MAX_REPAIR_ROUNDS`.

#### Worker concurrency (`--concurrency` / `CC_REVIEW_CONCURRENCY`)

When no explicit limit is configured, CC Review automatically derives the worker parallel count from the available CPUs (`os.cpus().length`, overridable via `CC_REVIEW_CPU_COUNT` for tests). The auto value is bounded between **1** and **8**, then further capped by the number of planned tasks after the planner finishes. Explicit configuration always wins over the automatic policy.

- **Explicit API/tool parameter**: pass `concurrency: 3` or `concurrencyLimit: 3` with the `cc_review` tool call. This takes precedence over `CC_REVIEW_CONCURRENCY`.
- **Slash command flag**: pass `--concurrency 3`, `--concurrency=3`, `--concurrency-limit 3`, or `--concurrency-limit=3` before or after the goal text.
- **Environment fallback**: set `CC_REVIEW_CONCURRENCY=3` when no explicit option is supplied.
- **Default**: when omitted and unset, concurrency is auto-computed from CPU count (bounded 1–8, capped by task count).
- **Observability**: the final value appears in the `### ⚙️ Execution Configuration` section of the summary report, in `CcReviewSummaryMeta.concurrency`, and in the `execution_config` trace event.

Example commands:

```bash
# Let CC Review auto-schedule workers (e.g. 6 on a 6-core machine, capped at 8)
/cc-review Implement the auth refactor

# Cap parallel workers explicitly
/cc-review --concurrency 2 Implement the auth refactor
/cc-review --concurrency-limit=4 Implement the auth refactor

# Shell-wide fallback
export CC_REVIEW_CONCURRENCY=2
pi --mode json -p "Use the cc_review tool to implement: <goal>"

# Pin CPU count for deterministic tests (does not affect explicit --concurrency)
CC_REVIEW_CPU_COUNT=4 node --experimental-strip-types tests/cc-review-behavior.test.ts
```

#### Execution log file (`--log-file` / `CC_REVIEW_LOG_FILE`)

By default, each workflow run writes under `.cc-review/logs/<runId>/workflow-logs.jsonl`. Consecutive runs use separate run directories. To reuse a fixed path across runs (append mode), pass `--log-file <path>` or set `CC_REVIEW_LOG_FILE`. Set `CC_REVIEW_LOG_ROOT=1` for legacy workspace-root `workflow-logs-<runId>.jsonl` files.

```bash
# Default: unique per-run log file (no overwrite of prior runs)
/cc-review Implement the feature

# Fixed path: append across runs to the same file
/cc-review --log-file ./my-cc-review.log.jsonl Implement the feature
CC_REVIEW_LOG_FILE=./my-cc-review.log.jsonl pi --mode json -p "Use cc_review to implement: <goal>"
```

#### Workflow control (`--plan-only`, `--resume`, role models)

- **Plan only**: `/cc-review --plan-only <goal>` or `planOnly: true` — run the planner, write `cc-review-artifacts/<runId>/plan.json`, and exit without subagents or reviewers.
- **Resume**: `/cc-review --resume <runId> <goal>` or `resumeRunId` — skip only successfully completed tasks in `checkpoint.json`; failed, blocked, cancelled, and skipped tasks run again. Use `--from-task N` (0-based) to force a starting index. Checkpoints are updated after each task and on abort.
- **Role models**: `CC_REVIEW_PLANNER_MODEL` and `CC_REVIEW_REVIEWER_MODEL` override provider default models for planning and review only; worker model continues from pi agent settings.
- **Structured validation**: set `CC_REVIEW_ALLOW_TEXT_VALIDATION=0` or `allowTextValidation: false` to require trailing structured JSON from workers (transition default remains legacy text heuristics enabled).

---

## 3. Strict Architectural Contracts to Preserve

Any optimization, modification, or refactoring work **must preserve** the following design contracts. The test suites explicitly verify these patterns.

### A. Subagent Integration Contract
- **Rule**: Planned task execution must preserve the standard `subagent` result contract and worker agent profile semantics.
- **Contract**: Prefer the extension API's tool manager when available, and otherwise use the built-in fallback that mirrors `_subagent` via `pi --mode json -p --no-session` while returning the same `content`, `details.results[0]`, and `isError` shape:
  ```typescript
  const executeSubagentTool = getSubagentExecutor(pi);
  const subagentResult = await executeSubagentTool("subagent", {
    agent: "worker",
    task: subagentPrompt,
    agentScope: "user",
  }, signal, onUpdate, ctx);
  ```
- **Rationale**: This preserves agent profile management and compatibility across runtimes where `pi.toolManager.executeTool` may or may not be exposed.

### B. Headless Compatibility & Optional Chaining
- **Rule**: Avoid direct dependencies on a TUI or graphic interface.
- **Contract**: All calls to UI utilities, input prompts, status updates, or notifications must use optional chaining and tolerate headless runs where `ctx` or `ctx.ui` are undefined:
  ```typescript
  ctx?.ui?.notify?.("Message", "info");
  await pi.sendMessage?.({ ... });
  ```

### C. Lightweight Trace Observability
- **Rule**: Workflow steps must be instrumented with minimal trace logging without leaking sensitive file or prompt content.
- **Contract**: Utilize `emitTrace` to output JSON lines to stderr and `workflow-trace.jsonl` on key events. Payloads must stay lightweight (e.g., logging `goal.length` instead of raw goals, and indexing tasks without copying heavy descriptions).
- **Subprocess events** (`tool_execution_start`/`tool_execution_end` with `source: "subprocess"`) must not receive content arguments, and must correctly preserve closed process exit codes or signal outcomes.
- **Human-readable persistence**: normalized entries are appended to a per-run `workflow-logs-<runId>.jsonl` file in the workspace root (or to a fixed path when `--log-file` / `CC_REVIEW_LOG_FILE` is set). This file is never filtered by `--log-level` / `CC_REVIEW_LOG_LEVEL`; only the compact widget and `onUpdate` delta stream honor the resolved minimum severity.

### D. Explicit State Transitions
- **Rule**: The orchestrator must keep a deterministic record of active execution steps.
- **Contract**: Use clear transition functions that manage the state machine:
  - `transitionToPlanning()` (sets task index to `-1`)
  - `setPlannedTasks(tasks)`
  - `transitionToExecuting(index)`
  - `transitionToReviewing(index)`
  - `transitionToComplete()` (sets index to `tasks.length`)

### E. Output Validation & Acceptance Criteria
- **Rule**: Output must conform to specified acceptance criteria and schema requirements.
- **Contract**: Subagents must be defined with clear `acceptanceCriteria` properties. The orchestrator must parse and validate results before merging, checking for unresolved notes, warning/error tokens, or unmet criteria.

### F. Multi-Tiered Retries & Self-Repair Loops
- **Rule**: Minor syntax errors, transient rate limits, or failing subtasks must trigger automatic correction attempts.
- **Contract**: 
  - If a subagent task execution fails, it must be retried with structured error feedback (previous attempt logs/reasons) provided directly to the next attempt instead of failing immediately.
  - Implement configurable retry limits: `maxPlanRetries` (default 3), `maxTaskExecutionRetries` (default 2), and bounded exponential backoff retries for network/transient failures.

### G. Isolated Temporary Directories
- **Rule**: Never leave file clutter or risk resource collisions in the shared temporary directory.
- **Contract**: Always generate a unique path via `fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-"))` to store intermediate files. Ensure complete cleanup by wrapping execution in a `try...finally` block that recursively removes the directory on completion, failure, or user cancellation.

### H. Graceful Cancellation of Process Groups
- **Rule**: Spawning external processes must not leave zombie or orphaned child processes.
- **Contract**: Spawn processes detached (`detached: true`). When aborting, send `SIGTERM` to the entire process group (`-proc.pid`) to allow descendants to cleanly shut down. Wait briefly before issuing a fallback `SIGKILL` to prevent hanging workflows.
