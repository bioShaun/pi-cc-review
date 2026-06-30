# CC Review Orchestrator: Development, Verification & Design Contract

This workspace contains the implementation and tests for the **CC Review Orchestrator** extension. This document provides clear guidelines for running the verification test suite, performing strict type-checks, and details the structural contracts that any future optimization work must preserve.

---

## 1. Directory Structure

- `.pi/extensions/cc-review.ts`: The main orchestrator extension code.
- `tests/cc-review-static.test.mjs`: Node native static assertion test suite verifying structural properties, schema structures, regex matches, and baseline compliance.
- `tests/cc-review-behavior.test.ts`: Node native behavioral test suite mocking the `pi` API and child processes to verify successful multi-step execution, retry loops, cancellation, output validation, and trace logging.
- `workflow-baseline.md`: System target and baseline specification.
- `workflow-optimization-criteria.md`: Concrete metrics and criteria for optimization.

---

## 2. Installation, Update, and Verification Guide

The extension is installed as the **CC Review** plugin in `.pi/extensions/cc-review.ts`.

Active user-facing entry points:

- Slash command: `/cc-review <goal>`
- Tool name for API/tool calls: `cc_review`
- Display label: `CC Review`

To install or update the plugin in a Pi workspace, place the current `.pi/extensions/cc-review.ts` file in that workspace's `.pi/extensions/` directory, replacing any older copy of the same file, then restart or reload Pi so extension registration is refreshed. This repository does not include a package manifest or registry release flow; the extension file is the installation artifact.

To guarantee code quality and prevent regression, developers must run the verification suites and TypeScript compiler checks after any changes.

### 2.1. Running the Test Suites

Both test suites use Node's native `node:test` runner and do not require external test frameworks.

```bash
# 1. Run the static verification tests
node tests/cc-review-static.test.mjs

# 2. Run the behavioral verification tests
node --experimental-strip-types tests/cc-review-behavior.test.ts

# 3. Run all tests together
node tests/cc-review-static.test.mjs && node --experimental-strip-types tests/cc-review-behavior.test.ts
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

- `per-task` (default): execute, validate, and review each task before starting the next task.
- `after-all`: execute and validate every task first, then invoke the reviewer once for the complete workflow. The final reviewer can fix cross-task integration issues, runs the configured post-review verification once, and writes the shared verdict into every task artifact.

Select the mode through one of these interfaces:

```bash
# Slash command
/cc-review --review-mode after-all <goal>

# Tool parameter
pi --mode json -p 'Use cc_review with goal "<goal>" and reviewMode "after-all"'

# Environment fallback
CC_REVIEW_MODE=after-all pi --mode json -p "Use cc_review to implement: <goal>"
```

An explicit `reviewMode` or `--review-mode` takes precedence over `CC_REVIEW_MODE`. Supported values are exactly `per-task` and `after-all`; omitted configuration defaults to `per-task`.

In `after-all` mode, an unrecoverable task execution or output-validation failure still halts immediately because there is no complete workflow to review.

### 2.4. Troubleshooting Provider Setup

- **Missing CLI**: if the selected provider's CLI (`codex` or `claude`) is not installed or not on `PATH`, install it or switch providers. The subprocess will fail with the CLI's own error message; CC Review does not preflight credentials.
- **Auth failures from the CLI**: if `claude` or `codex` reports an auth/login error inside the review step, run the CLI directly once (`claude` / `codex login`) to refresh its login session, or export `ANTHROPIC_API_KEY`/`CLAUDE_API_KEY` (Claude) or `CODEX_API_KEY`/`OPENAI_API_KEY` (Codex) and re-run. CC Review will record the non-zero review exit as `completed_with_warnings` and continue.
- **Unselected provider credentials**: only the selected backend's CLI is spawned. Missing credentials or missing CLI for the *unselected* provider never block the workflow.
- **Unexpected provider value**: set `reviewProvider`, `--provider`, or `CC_REVIEW_PROVIDER` to exactly `codex` or `claude`, or omit/unset provider selection to use the default Codex reviewer. Values are case/whitespace normalized, but empty, whitespace-only, and unsupported names fail with an invalid provider error such as `Invalid reviewProvider` or `Invalid CC_REVIEW_PROVIDER`.
- **Provider precedence confusion**: explicit `reviewProvider` or `--provider` values take precedence over `CC_REVIEW_PROVIDER`; `CC_REVIEW_PROVIDER` is used only when no explicit option is supplied.
- **Planning provider confusion**: provider selection applies to both planning and review.

### 2.5. Strict Type-Checking

The extension `.pi/extensions/cc-review.ts` must maintain **100% strict type safety**. It should compile with zero TypeScript diagnostics under Node's standard type configuration.

Since this workspace sits inside the Pi test environment, you can type-check the extension using the compiler and type definitions from the adjacent `adversarial` workspace:

```bash
# Run strict compilation and type check from the workspace root
../adversarial/node_modules/.bin/tsc --noEmit \
  --target es2022 \
  --moduleResolution bundler \
  --allowImportingTsExtensions \
  --typeRoots ../adversarial/node_modules/@types \
  --types node \
  --strict true \
  .pi/extensions/cc-review.ts
```

*Note: Clean strict type-checking must always return `exit code 0` with absolutely no output/errors.*

### 2.6. Manual Verification Checklist

Use this checklist after changes that affect plugin registration, provider selection, release packaging, or marketplace/display metadata. Do not commit real credentials or secret-bearing logs.

- [ ] **Install/load smoke test**: copy `.pi/extensions/cc-review.ts` into a clean Pi workspace's `.pi/extensions/` directory, restart or reload Pi, and confirm the active display name is **CC Review**.
- [ ] **Command and tool discovery**: confirm the slash command appears as `/cc-review <goal>` and API/tool usage exposes `cc_review` with label `CC Review`; no active command or tool alias should use the old pre-rename identity.
- [ ] **Default review path**: with `CC_REVIEW_PROVIDER` unset, run a small disposable goal and verify the workflow plans with Codex and reviews with the default Codex reviewer.
- [ ] **Claude review path**: run the same disposable goal with `CC_REVIEW_PROVIDER=claude` using mocked/test Claude credentials or a test Claude Code CLI login; verify planning still uses Codex and the review/fix phase invokes `claude -p`.
- [ ] **Missing selected-provider setup check**: in a disposable shell, temporarily uninstall the selected provider's CLI (`codex` or `claude`) from `PATH` and confirm the workflow surfaces the CLI's own error in the review step as `completed_with_warnings`. CC Review does not preflight credentials, so unset env vars alone will not trigger a CC Review error — the CLI's login session decides.
- [ ] **Marketplace/display metadata**: if publishing or packaging outside this repository, inspect the extension listing, marketplace card, screenshots, and generated help text for the **CC Review** name and `cc_review` tool ID.
- [ ] **Old-name repository search**: run `rg -n "codex[-_ ]workflow|Codex[- ]Workflow" .` and confirm matches are limited to historical migration notes/tests that intentionally describe old names, not active source or user-facing command documentation.
- [ ] **Automated regression commands**: run `node tests/cc-review-static.test.mjs`, `node --experimental-strip-types tests/cc-review-behavior.test.ts`, and the strict `tsc --noEmit ... .pi/extensions/cc-review.ts` command above.

### 2.7. Log Display and Observability

CC Review separates **durable observability** (full history on disk) from **compact live surfaces** (TUI widget and tool `onUpdate` deltas). The persisted `workflow-logs.jsonl` in the workspace root always records every normalized log entry for the run. The compact widget and `onUpdate` stream apply additional presentation rules so long goals, noisy info lines, and verbose bodies do not overwhelm the default view.

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

#### Compact widget affordances

- **Severity rollup line**: directly under the phase line, the widget shows a width-bounded `Σ …` summary counting errors, warnings, info, and debug entries across the in-memory buffer (for example, `Σ 1 error · 2 warnings · 5 info`). Only non-zero counts are shown; info/debug-only buffers collapse to a neutral `Σ no issues` line.
- **Redacted goal/title previews**: long goals and task titles are collapsed to a single line and capped (default 80 characters with an ellipsis) before terminal-width truncation. The full goal and task titles remain in the final markdown summary and persisted log.
- **Severity-aware live log lines**: the last five filtered log lines use theme-style prefixes (`DEBUG`, `INFO`, `WARN`, `ERROR`) with timestamps and source badges.
- **Summary message renderer**: slash-command completion uses `customType: "cc-review-summary"`. When Pi exposes `registerMessageRenderer` and the TUI primitives are available, the final report renders a compact success/warning/failed/cancelled badge with a one-line headline; expand to read the full markdown body. Headless/test environments without the renderer API keep the existing markdown fallback.

Structured trace output (`emitTrace` → stderr and `workflow-trace.jsonl`) is unchanged: it remains lightweight, redacted, and independent of the human-readable `workflow-logs.jsonl` file.

---

## 3. Strict Architectural Contracts to Preserve

Any optimization, modification, or refactoring work **must preserve** the following design contracts. The test suites explicitly verify these patterns.

### A. Subagent Integration Contract
- **Rule**: Planned task execution must preserve the standard `subagent` result contract and generator agent profile semantics.
- **Contract**: Prefer the extension API's tool manager when available, and otherwise use the built-in fallback that mirrors `_subagent` via `pi --mode json -p --no-session` while returning the same `content`, `details.results[0]`, and `isError` shape:
  ```typescript
  const executeSubagentTool = getSubagentExecutor(pi);
  const subagentResult = await executeSubagentTool("subagent", {
    agent: "generator",
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
- **Human-readable persistence**: normalized entries are also appended to `workflow-logs.jsonl` in the workspace root. This file is never filtered by `--log-level` / `CC_REVIEW_LOG_LEVEL`; only the compact widget and `onUpdate` delta stream honor the resolved minimum severity.

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
