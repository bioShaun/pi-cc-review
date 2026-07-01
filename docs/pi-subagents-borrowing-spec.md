# Pi Subagents Borrowing Spec for CC Review

Status: Proposed
Date: 2026-07-01
Source inspected: `/Users/guilixuan/test/pi/pi-subagents`
Target project: `pi-cc-review`
Primary target surface: `.pi/extensions/cc-review/`

## Problem

`pi-cc-review` already implements a focused CC Review workflow:

1. Plan tasks through the configured planner provider.
2. Execute planned tasks through the `worker` subagent contract.
3. Review either per task or after all tasks.
4. Persist artifacts, logs, findings, and checkpoints.

`pi-subagents` is a broader general-purpose subagent runtime with agents,
chains, async/background jobs, intercom, dynamic fanout, model fallback,
session files, structured output, and run control. The repositories overlap in
subagent execution concerns, but their product scopes are different. The right
approach is to borrow selected runtime patterns, not copy the plugin wholesale.

## Goals

- Identify concrete `pi-subagents` implementation patterns that can improve
  CC Review reliability, observability, and configuration compatibility.
- Separate low-risk local improvements from high-risk product-surface imports.
- Preserve CC Review's narrow orchestrator shape and existing artifact/review
  contracts.
- Define implementation phases and verification criteria for future work.

## Non-Goals

- Do not replace CC Review with the full `pi-subagents` runtime.
- Do not import async job management, intercom, slash-command management, or
  agent CRUD as part of this borrowing track.
- Do not expand CC Review into a general chain/fanout orchestration plugin.
- Do not require new external services.
- Do not remove the current structured JSON fallback behavior until a stricter
  replacement is proven in tests.

## Current CC Review Coverage

The current project already covers several areas that `pi-subagents` also
solves:

- Dependency-aware concurrent task execution:
  `.pi/extensions/cc-review/workflow/dependencies.ts`
- Subprocess timeout, trace logging, detached process groups, and output caps:
  `.pi/extensions/cc-review/subprocess.ts`
- Structured subagent and reviewer result parsing:
  `.pi/extensions/cc-review/structured.ts`
- Task artifacts, findings rollups, persisted logs, and checkpoints:
  `.pi/extensions/cc-review/workflow/`
- Review repair rounds and post-review validation:
  `.pi/extensions/cc-review/workflow/orchestrator/review-phase.ts`
- Widget/status rendering and compact log filtering:
  `.pi/extensions/cc-review/workflow/ui.ts`

These areas should be extended in place rather than replaced.

## Recommended Borrowing Areas

### P0-1: Pi CLI spawn resolution

Source:

- `src/runs/shared/pi-spawn.ts`
- `test/unit/pi-spawn.test.ts`

Current CC Review touchpoint:

- `.pi/extensions/cc-review/workflow/execution.ts`
  - `getPiInvocation(...)`
  - `runPiAgentSubprocess(...)`

Problem:

CC Review currently uses a local heuristic to decide whether to invoke
`process.execPath`, `process.argv[1]`, or `pi` from `PATH`. It works for the
common macOS path but is less complete than `pi-subagents`.

Borrowed pattern:

- Support an explicit environment override, e.g. `CC_REVIEW_PI_BINARY` or
  reuse-compatible `PI_SUBAGENT_PI_BINARY`.
- Resolve package-root based Pi entrypoints when running from installed Pi.
- Preserve Windows support by invoking the resolved Pi CLI script through
  `process.execPath`.
- Keep fallback to `pi` on `PATH`.

Expected benefit:

- Fewer "wrong Pi binary" and `ENOENT` failures.
- Better compatibility with packaged runtimes, local checkouts, and Windows.

Acceptance criteria:

- Unit tests cover explicit binary override, blank override fallback, package
  root resolution, generic macOS/Linux fallback, and Windows script fallback.
- Static test still verifies the subagent subprocess fallback uses documented
  Pi JSON mode.
- Preflight reports the resolved Pi command when fallback mode is needed.

### P0-2: Post-exit stdio guard

Source:

- `src/shared/post-exit-stdio-guard.ts`
- related subprocess tests in `pi-subagents`

Current CC Review touchpoint:

- `.pi/extensions/cc-review/subprocess.ts`
  - `runSubprocess(...)`

Problem:

CC Review resolves subprocess completion on `close`, which normally waits for
stdio to close. If a child exits while inherited descendants keep stdout/stderr
open, the parent can wait longer than intended.

Borrowed pattern:

- Attach a post-`exit` guard that destroys unended stdout/stderr after a short
  idle window and a hard ceiling.
- Keep the existing timeout and process-group kill behavior.

Expected benefit:

- Lower risk of hangs after planner/reviewer/subagent subprocess exit.
- Cleaner cancellation behavior when grandchildren inherit stdio.

Acceptance criteria:

- Tests simulate child `exit` without stream `end`; `runSubprocess` eventually
  resolves.
- Normal subprocesses with clean `close` are unaffected.
- Existing timeout/cancellation tests continue passing.

### P1-1: Session file and fork-context continuity

Source:

- `src/runs/shared/pi-args.ts`
- `src/shared/fork-context.ts`
- `src/runs/foreground/subagent-executor.ts`
- `test/unit/pi-args.test.ts`
- `test/unit/fork-context.test.ts`

Current CC Review touchpoint:

- `.pi/extensions/cc-review/workflow/execution.ts`
  - fallback currently invokes `pi --mode json -p --no-session`
- `workflow-optimization-criteria.md`
  - Criterion 1: Session & Context Continuity

Problem:

CC Review passes prior-task summaries and state buffer text, but fallback
subagent execution is still sessionless. That limits continuity and increases
rediscovery cost across sequential tasks.

Borrowed pattern:

- Add optional per-task session files for fallback subagent runs.
- Prefer explicit `--session <file>` when continuity is enabled.
- Keep `--no-session` as the default until behavior is stable.
- Store session file paths in task artifacts and checkpoint metadata.
- For parallel sibling tasks, avoid sharing one mutable session file unless the
  tasks are intentionally serialized.

Expected benefit:

- Better context continuity for sequential workflows.
- Easier resume/debug because child session files can be inspected.
- Progress toward the existing optimization criterion without adopting the full
  `pi-subagents` async runner.

Acceptance criteria:

- Sequential two-task test proves Task 2 can use state from Task 1 through the
  configured continuity path.
- Parallel after-all batches get distinct session files or remain no-session.
- Summary/artifacts include session path when present.
- The feature is gated by an option/env flag for rollout.

### P1-2: Structured output runtime

Source:

- `src/runs/shared/structured-output.ts`
- `src/runs/shared/subagent-prompt-runtime.ts`
- mock behavior in `test/support/mock-pi-script.mjs`

Current CC Review touchpoints:

- `.pi/extensions/cc-review/workflow/execution.ts`
  - `buildSubagentTaskPrompt(...)`
- `.pi/extensions/cc-review/structured.ts`
  - `parseSubagentStructuredReport(...)`
  - `validateStructuredSubagentReport(...)`
- `.pi/extensions/cc-review/workflow/validation.ts`

Problem:

CC Review asks the worker to end with a JSON object and then extracts the last
balanced JSON object from text. This is compatible but still prose-dependent.

Borrowed pattern:

- Provide a runtime schema path and output path.
- Register or expose a `structured_output` completion tool where the Pi runtime
  supports it.
- Fail the step if a structured-output-required task never writes the output.
- Keep the current text JSON parser as compatibility fallback during rollout.

Expected benefit:

- More deterministic machine-readable subagent completion.
- Fewer false positives from prose-only "done" responses.
- Cleaner separation between final narrative and structured result.

Acceptance criteria:

- Structured-output-required tasks fail clearly when the tool/file is missing.
- Valid output is schema-checked before workflow progression.
- Existing text-only worker behavior remains supported when the strict mode is
  disabled.
- Artifacts record whether the result came from `structured_output`, text JSON,
  or fallback text validation.

### P1-3: Model fallback and attempted-model reporting

Source:

- `src/runs/shared/model-fallback.ts`
- `src/agents/agents.ts`
- tests around `fallbackModels`

Current CC Review touchpoints:

- `.pi/extensions/cc-review/workflow/execution.ts`
  - `applyAgentModelOverride(...)`
  - `runPiAgentSubprocess(...)`
- `.pi/extensions/cc-review/workflow/summary.ts`

Problem:

CC Review records the configured/effective worker model, but it does not have a
bounded fallback sequence when a model is unavailable, rate-limited, or
misconfigured.

Borrowed pattern:

- Parse `fallbackModels` from worker frontmatter/settings.
- Build ordered model candidates from primary model plus fallback models.
- Retry only model/provider failures that match a conservative retryable list.
- Record attempted models in task results and artifacts.

Expected benefit:

- Less workflow failure due to transient or stale model configuration.
- Better diagnostics when a fallback was used.

Acceptance criteria:

- Tests cover successful primary model, retryable primary failure followed by
  fallback success, and non-retryable failure with no fallback.
- Summary and task artifacts list attempted models when more than one was used.
- Fallback attempts respect the existing task timeout and abort signal.

### P2-1: Completion mutation guard

Source:

- `src/runs/shared/completion-guard.ts`
- `src/runs/shared/long-running-guard.ts`
- `test/unit/completion-guard.test.ts`

Current CC Review touchpoints:

- `.pi/extensions/cc-review/workflow/execution.ts`
- `.pi/extensions/cc-review/workflow/orchestrator/execution-phase.ts`
- task validation and artifact writing paths

Problem:

For implementation tasks, a worker can return a plausible completion response
without actually mutating files. Current validation mostly checks final text and
structured criteria, not observed mutation intent.

Borrowed pattern:

- Infer whether a task expects mutation from the agent name and task text.
- Inspect streamed assistant/tool events for edit/write or mutating bash calls.
- If mutation was expected but no mutation was attempted, mark completion as
  suspicious and feed that back through the retry loop.

Expected benefit:

- Reduces false "completed" task results.
- Catches worker no-op failures before reviewer time is spent.

Acceptance criteria:

- Review-only and research/scout-style tasks do not trigger the guard.
- Implementation tasks with no edit/write/mutating command trigger retry or
  validation failure.
- The guard records a clear validation message in artifacts.

### P2-2: Long-running and needs-attention control events

Source:

- `src/runs/shared/subagent-control.ts`
- `src/shared/status-format.ts`
- `src/runs/background/async-job-tracker.ts`
- `test/unit/subagent-control.test.ts`

Current CC Review touchpoints:

- `.pi/extensions/cc-review/workflow/orchestrator/execution-phase.ts`
- `.pi/extensions/cc-review/workflow/ui.ts`
- `.pi/extensions/cc-review/workflow/logging.ts`

Problem:

CC Review has timeouts and streamed logs, but it does not distinguish:

- active but long-running
- idle / needs attention
- repeated tool failures before timeout

Borrowed pattern:

- Track last observed subagent activity.
- Emit typed control events such as `active_long_running` and
  `needs_attention`.
- Render compact labels in widget/status lines.
- Persist these control events to workflow logs.

Expected benefit:

- Users can tell the difference between a productive long task and a stalled
  one.
- Timeouts become a final guard instead of the only stall signal.

Acceptance criteria:

- Widget/status line reflects active-long-running and idle states.
- Persisted logs include typed control event payloads.
- Events are deduplicated per task/run so the UI is not spammed.

## Patterns Not Recommended for Import

### Full async/background runner

Source:

- `src/runs/background/*`
- `src/runs/foreground/subagent-executor.ts`

Reason:

CC Review already has its own synchronous workflow runtime, artifacts, logs,
checkpoints, and review phases. Importing the full async runner would duplicate
state machines and make the product surface much larger.

### Intercom bridge and result delivery

Source:

- `src/intercom/*`
- related nested result delivery paths

Reason:

Useful for the generic subagent plugin, but CC Review already reports through
`pi.sendMessage`, workflow artifacts, and widget/status surfaces. Intercom would
add a second coordination channel without solving a current P0.

### Agent management and slash command suite

Source:

- `src/agents/agent-management.ts`
- `src/slash/*`
- `/subagents-*` commands

Reason:

CC Review should consume the `worker` profile and settings. It should not own
agent CRUD, profile generation, or general subagent management.

### Dynamic fanout and workflow graph runtime

Source:

- `src/runs/shared/dynamic-fanout.ts`
- `src/runs/shared/workflow-graph.ts`
- `src/runs/shared/nested-render.ts`

Reason:

CC Review has a simpler dependency graph based on planned tasks and `dependsOn`.
Dynamic fanout is powerful but would change planning semantics and expand test
scope substantially.

### Worktree isolation

Source:

- `src/runs/shared/worktree.ts`

Reason:

Useful for independent parallel implementation tasks, but CC Review's review
and validation phases assume one active workspace. Worktree support should be a
separate design if needed.

## Implementation Plan

### Phase 1: Low-risk runtime hardening

1. Replace or extend `getPiInvocation(...)` with a resolver based on
   `pi-subagents`' `getPiSpawnCommand(...)` behavior.
2. Add post-exit stdio guard to `runSubprocess(...)`.
3. Add focused tests for both changes.

Expected files:

- `.pi/extensions/cc-review/workflow/execution.ts`
- `.pi/extensions/cc-review/subprocess.ts`
- `tests/cc-review-behavior.test.ts`
- `tests/cc-review-static.test.mjs`

### Phase 2: Deterministic execution metadata

1. Add optional session-file continuity for fallback subagent execution.
2. Add attempted-model/fallback-model recording.
3. Persist session/model metadata in task artifacts and summaries.

Expected files:

- `.pi/extensions/cc-review/workflow/execution.ts`
- `.pi/extensions/cc-review/workflow/orchestrator/execution-phase.ts`
- `.pi/extensions/cc-review/workflow/summary.ts`
- `.pi/extensions/cc-review/structured.ts`
- behavior and structured tests

### Phase 3: Stronger completion contracts

1. Add structured-output strict mode.
2. Add completion mutation guard for implementation tasks.
3. Add long-running/needs-attention control events.

Expected files:

- `.pi/extensions/cc-review/workflow/execution.ts`
- `.pi/extensions/cc-review/workflow/validation.ts`
- `.pi/extensions/cc-review/workflow/ui.ts`
- `.pi/extensions/cc-review/workflow/logging.ts`
- structured, behavior, and UI tests

## Verification Commands

Use the existing project checks:

```bash
node tests/cc-review-static.test.mjs
node --experimental-strip-types tests/cc-review-structured.test.ts
node --experimental-strip-types tests/cc-review-ui.test.ts
node --experimental-strip-types tests/cc-review-behavior.test.ts
npm run typecheck
```

For changes involving subprocess exit and stdio behavior, add targeted behavior
tests instead of relying only on full workflow tests.

## Decision Summary

Borrow:

- Pi CLI spawn resolution
- post-exit stdio guard
- session-file continuity
- structured-output runtime
- model fallback
- completion mutation guard
- long-running / needs-attention control events

Do not borrow yet:

- async/background runner
- intercom bridge
- agent management commands
- dynamic fanout workflow graph
- worktree isolation

The first two borrowed items are the safest immediate improvements. Session
continuity and structured output are the highest-leverage medium-term changes,
but they should be gated and rolled out with compatibility fallbacks.
