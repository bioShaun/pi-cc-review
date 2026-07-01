# CC Review Orchestrator — Reliability Issues & Remediation Spec

Status: Implemented
Scope: `.pi/extensions/cc-review.ts`
Date: 2026-06-30
Implemented: 2026-06-30

All seven issues (P0-1 through P2-1) have been implemented and verified.
Static tests: 62/62 pass. Behavior tests: 138/138 pass. Strict tsc: exit 0.

This spec captures the concrete defects found while investigating "the plugin
errors a lot when used", with the supporting evidence, the root cause of each,
and a proposed fix. Findings are ordered by impact. Every claim here is grounded
in the source file, the persisted `workflow-trace.jsonl` / `workflow-logs.jsonl`,
or a live `pi` / `claude` invocation captured during the investigation.

---

## Environment context (for reproducing)

- `pi` version: `0.80.2` (`/opt/homebrew/bin/pi`)
- `claude` version: `2.1.185` (`/Users/guilixuan/.local/bin/claude`)
- `codex` present at `/opt/homebrew/bin/codex`
- Worker model and thinking level come from the user's pi config, not the plugin:
  `~/.pi/agent/settings.json` →
  `subagents.agentOverrides.worker.{model,thinking}`.
- The execution subagent uses the `worker` identity. It prefers `worker.md`,
  accepts `~/.pi/agent/agents/generator.md` as a legacy profile fallback, and
  otherwise uses the built-in worker prompt. It is spawned as
  `pi --mode json -p --no-session ...`.

---

## P0-1 — Hardcoded 5-minute execution timeout kills real tasks

### Symptom
Tasks abort after exactly 5 minutes with `exitCode 143` (SIGTERM) and are
reported as `Subagent aborted` → unrecoverable failure. This is the single most
frequent failure in the trace.

### Evidence
- `.pi/extensions/cc-review.ts` (execution loop):
  ```ts
  const subagentTimeoutMs = 300000;
  const timeoutTimer = setTimeout(() => {
    log(`[Timeout] Subagent task execution exceeded timeout of ${subagentTimeoutMs}ms. Aborting subagent...`);
    taskAbortController.abort(new Error(`Subagent execution timed out after ${subagentTimeoutMs}ms`));
  }, subagentTimeoutMs);
  ```
- `workflow-trace.jsonl` repeatedly shows `tool_execution_start` →
  `tool_execution_end exitCode:143` separated by exactly 300s, e.g. 06-25 task 3:
  `00:25:30 → 00:30:30` then retry `00:30:30 → 00:35:30`, then
  `failure: Task execution failed unrecoverably`.

### Root cause
The per-attempt subagent timeout is hardcoded to 300000 ms. Real coding subagent
runs routinely exceed 5 minutes, so they are killed mid-flight. Both retries use
the same too-short ceiling, so the whole task fails.

### Proposed fix
- Make the timeout configurable via tool param / slash flag / env
  (`CC_REVIEW_TASK_TIMEOUT_MS` or similar), with a much larger default
  (e.g. 20–30 min) or "no timeout" option.
- Keep the timeout per-attempt but surface its real reason (see P0-2).

---

## P0-2 — Timeout reason is masked by stale stderr (mis-attribution)

### Symptom
When a task times out, the reported error is NOT "timed out"; it is whatever
text happens to be in the subprocess stderr. In the 06-25 runs this was a
harmless model warning, which made the failure look like a model problem.

### Evidence
- The timeout aborts with `new Error("Subagent execution timed out after 300000ms")`,
  but that error never reaches the user.
- `runPiAgentSubprocess` builds the error from stderr:
  ```ts
  errorMessage: isError ? (stderr || (wasAborted ? "Subagent aborted" : ...)) : undefined,
  ```
- The retry/failure trace therefore recorded:
  `error: 'Warning: Model "glm-5.1" not found for provider "volcengine-coding". Using custom model id.'`
  even though tasks 0/1/2 in the same run succeeded with that exact model — proving
  the warning was harmless and the true cause was the 300s timeout (`exitCode 143`).

### Root cause
On abort/timeout, the orchestrator surfaces residual stderr as the failure
reason instead of the abort cause. The harmless warning is the only line in
stderr, so it gets promoted to "the error", hiding the timeout.

### Note / correction
This corrects an earlier hypothesis that "benign stderr warnings are treated as
task failures". The warning was not the trigger; the timeout was. The real bug
is error mis-attribution that obscures the timeout.

### Proposed fix
- Distinguish abort-by-timeout from abort-by-user and from genuine non-zero
  exits; carry the abort reason explicitly through `SubagentToolResult`.
- Classify timeouts as transient so the backoff/retry path engages with the
  correct reason (`isTransientError` already matches `"timeout"`, but it never
  sees that string because the message is replaced by stderr).

---

## P0-3 — Planner/reviewer (claude/codex) produce no visible output for minutes

### Symptom
During planning/review the user sees nothing from claude/codex for the entire
duration, making it impossible to tell whether the run is working or hung.

### Evidence
- Planner/reviewer are spawned in buffered (non-streaming) mode:
  - claude: `["-p", "--dangerously-skip-permissions", "--no-session-persistence", prompt]`
  - codex: `["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", ...]`
  - No `--output-format stream-json --verbose` (claude) or equivalent.
- `claude -p` without stream flags buffers all output and flushes only at the
  end, so `logSubprocessStreamLines(log, chunk, "stdout", "planner")` receives
  data only when the process finishes.
- `pi --mode json` (the generator path) DOES emit incremental events
  (`message_update`/`text_delta`, plus `tool_execution_start/end` on tool use),
  but the plugin's `handleLine` ignores `message_update`/`text_delta` and only
  forwards `tool_execution_start`, erroring `tool_execution_end`, and the final
  `message_end`. So token-level "thinking"/text progress is never surfaced.

### Root cause
Two separate observability gaps:
1. claude/codex are invoked without streaming flags → buffered output.
2. The pi-subagent NDJSON parser handles only a subset of event types and drops
   the incremental text/thinking stream.

### Proposed fix
- claude planner/reviewer: add `--output-format stream-json --verbose` and parse
  the streamed events; codex: enable its streaming output mode.
- Generator parser: also forward `message_update`/`text_delta` (throttled) so the
  live log shows progress, not just discrete tool calls.
- Emit a periodic heartbeat log line while any subprocess is running.

---

## P0-4 — Planning/review phases have no timeout (silent infinite hang)

### Symptom
The planner can hang indefinitely with zero output. The latest 06-30 run got
stuck in planning and never progressed.

### Evidence
- `runProcess(plannerLabel, plannerCommand, plannerArgs, onStdout, onStderr)` is
  called WITHOUT the optional `timeoutMs` argument. `runProcess` only installs a
  timer when `timeoutMs` is provided.
- `workflow-trace.jsonl` 06-30: `workflow_start` (00:06:40) → Claude planner
  `tool_execution_start` (00:06:40) → **no `tool_execution_end`**.
- `workflow-logs.jsonl` contains exactly one line for that run:
  `"Planning workflow with Claude reviewer..."` and nothing after.

### Root cause
Only the execution subagent has a timeout. Planning and review subprocesses have
none, so a stuck claude/codex hangs forever with no recovery and no signal.

### Proposed fix
- Pass a configurable `timeoutMs` to `runProcess` for planner and reviewer.
- On planner timeout, apply the existing retry/backoff loop (already present for
  non-zero exits).

---

## P1-1 — Reviewer "block" verdict hard-fails the whole workflow (no fix loop)

### Symptom
A single task blocked by the reviewer throws and aborts the entire workflow;
later tasks never run, even though the design contract promises self-repair.

### Evidence
- Per-task review path:
  ```ts
  if (effectiveVerdict === "block") {
    log(`[Workflow Halted] Blocked by reviewer on: "${task.title}".`);
    ...
    throw new WorkflowError(`Blocked by reviewer on: "${task.title}"`, summary);
  }
  ```
- `workflow-trace.jsonl` 06-27: `failure: Blocked by reviewer on: "1. Add bounded cross-task context handoff"`
  on task 0 — the run ended there.
- README "Strict Architectural Contracts" §F promises multi-tiered retries and
  self-repair loops with structured feedback to the next attempt.

### Root cause
The block path throws immediately instead of feeding the reviewer's findings
back to the generator for a bounded fix-and-re-review loop.

### Proposed fix
- On `block`, dispatch a bounded repair round: pass the reviewer findings to the
  generator as `retryFeedback`, re-run validation, then re-review, up to a
  configurable `maxReviewRepairRounds`. Only hard-fail after the bound is hit.

---

## P1-2 — Output validation relies on fragile free-text substring/regex matching

### Symptom
Otherwise-successful tasks can be marked "unresolved work" because of incidental
words in the subagent's prose.

### Evidence
- `validateSubagentOutput` fallback path flags lines containing
  `todo:`, `fixme:`, `unresolved:`, `pending:`, or `could not` / `failed to` /
  `unable to`.
- Acceptance-criterion check builds:
  ```ts
  const rx = new RegExp(`(failed|not met|pending|todo|unresolved|skip).*${critEscaped}`, "i");
  ```
  which matches any narrative sentence that uses those words near the criterion
  text (false positives).

### Root cause
Heuristic text scanning over free-form output is inherently noisy and produces
false "incomplete" verdicts.

### Proposed fix
- Prefer the structured JSON report (already supported via
  `parseSubagentStructuredReport`) and treat the free-text scan as a last resort
  only; tighten or remove the broad regex criterion match.

---

## P2-1 — Persisted log is wiped every run (no history)

### Symptom
`workflow-logs.jsonl` only ever reflects the latest run; past runs cannot be
audited.

### Evidence
- At workflow start:
  ```ts
  // Reset prior session file so the persisted log reflects only this run.
  try { fs.rmSync(persistedLogState.filePath, { force: true }); } catch { /* ignore */ }
  ```
- The file currently holds a single line from the 06-30 run.

### Root cause
The persisted log is intentionally truncated per run, conflicting with the
README claim that it "always records every normalized log entry" and removing
post-mortem visibility (which made diagnosing the failures above harder).

### Proposed fix
- Archive per run (e.g. `cc-review-artifacts/<runId>/workflow-logs.jsonl`) or
  append with a run-id boundary marker instead of truncating.

---

## Clarification: glm-5.1 is not a plugin defect

The plugin contains no reference to `glm` or `volcengine`; it only passes through
the worker model selected by `subagents.agentOverrides.worker.model` or agent
frontmatter `model`. The `glm-5.1` warning was:
- Emitted by pi itself ("Model not found for provider ... Using custom model id")
  because `glm-5.1` was not in `~/.pi/agent/models.json` at the time.
- Harmless — tasks using it succeeded in the same run.
- Only surfaced as an "error" because of the mis-attribution bug in P0-2.

At the time of this incident review, the model had been changed to `glm-5.2`;
`glm-5.1` last appeared on 06-25 and not in any later reviewed run.

---

## Suggested remediation order

1. P0-1 + P0-2: configurable/longer execution timeout with correct timeout reason.
2. P0-3 + P0-4: streaming output for claude/codex, heartbeat, and a planning
   timeout — restores "is it alive?" visibility.
3. P1-1: reviewer-block repair loop.
4. P1-2: structured-first validation.
5. P2-1: log archival.
