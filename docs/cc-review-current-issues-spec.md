# CC Review Orchestrator — Current Issues & Remediation Spec

Status: Open (findings only; no code changed)
Scope: `.pi/extensions/cc-review/` (modular implementation) and `docs/` + `README.md`
Date: 2026-07-01

This spec captures the most obvious problems still present in the plugin as of
the modular split (`da23a6b Split workflow.ts into modules under 1,500 lines
each.`). It is a companion to `docs/cc-review-reliability-issues-spec.md`, whose
P0-1..P2-1 items are confirmed implemented; the issues below are new/remaining.

## Verification baseline (current tree)

Everything below was found on a tree where the standard quality gates are green,
so these are logic/resource/documentation defects, not build breakage:

- `npm run typecheck` → exit 0.
- `node tests/cc-review-static.test.mjs` → 69/69 pass.
- `node --experimental-strip-types tests/cc-review-structured.test.ts` → 17/17 pass.
- `node --experimental-strip-types tests/cc-review-ui.test.ts` → 67/67 pass.
- `node --experimental-strip-types tests/cc-review-behavior.test.ts` → 219/219 pass.

Confirmed already-fixed from the prior reliability spec (not re-listed as issues):
configurable per-attempt task timeout (default 30 min), planner/reviewer
subprocess timeouts, timeout-abort reason no longer masked by stale stderr,
reviewer `block` now drives a bounded repair loop, structured-first validation,
and log rotation instead of per-run wipe.

Findings are ordered by impact.

---

## I1 (High) — Per-task repair loop records intermediate `review_blocked` results as durable task results

### Symptom
A task that the reviewer blocks in round 0 and then successfully repairs in a
later round can still cause the whole workflow to be reported as
"blocked by reviewer", with duplicate task rows and polluted rollups/checkpoints.

### Evidence
- The per-task review path runs inside `REPAIR_LOOP`:
  `.pi/extensions/cc-review/workflow/orchestrator/execution-phase.ts:606`
  ```ts
  REPAIR_LOOP: for (let repairRound = 0; ; repairRound++) {
  ```
- On **every** iteration it calls `rt.recordTaskResult(...)` at
  `.pi/extensions/cc-review/workflow/orchestrator/execution-phase.ts:1007`,
  *before* the `if (effectiveVerdict === "block")` branch at line `1029`, then
  `continue REPAIR_LOOP` (line `1056`) for another round.
- `recordTaskResult` only ever appends:
  `.pi/extensions/cc-review/workflow/orchestrator/runtime.ts:664`
  ```ts
  rt.recordTaskResult = (result: TaskResult, structured?: ...) => {
    rt.taskResults.push(result);
    rt.runStateBuffer = mergeTaskResultIntoStateBuffer(...);
    ...
  };
  ```
- The summary treats *any* `review_blocked` entry as a workflow block:
  `.pi/extensions/cc-review/workflow/summary.ts:143`
  ```ts
  const hasReviewBlocked = results.some((task) => task.status === "review_blocked");
  ```
  and later renders "The workflow was blocked by reviewer findings before
  completion." (summary.ts ~line 161).

### Root cause
The durable task result is written per repair iteration instead of once per task
at the loop's terminal outcome. A round-0 `review_blocked` row survives even
after a round-1 success, and `taskResults` accumulates one row per round.

### Impact
- Successful-after-repair tasks are reported as blocked/failed.
- Duplicate task rows in the summary, findings rollup, `runStateBuffer`, and
  persisted checkpoints.
- Stale/blocked handoff context can leak into later tasks.

### Proposed fix
Record the task result once, at the loop's terminal outcome (success, warnings,
or final block after exhausting `maxReviewRepairRounds`). Options:
- Buffer the latest result and only `recordTaskResult` after `break`/final-fail.
- Or make `recordTaskResult` overwrite by `taskIndex` instead of pushing.
Optionally persist each repair attempt as a separate *artifact*, but keep only
the final verdict in `taskResults`.

### Note
The `after-all` review path (`review-phase.ts`) uses a different structure
(`BATCH_REPAIR_LOOP` at review-phase.ts:114) and does not exhibit this exact
append-per-round pattern; this is a `per-task`-mode branch defect.

---

## I2 (High) — Post-review verification commands can hang or leak processes on timeout/cancel

### Symptom
A post-review verification command that ignores `SIGTERM`, or that spawns child
processes, can hang the workflow past its `timeoutMs`, and user cancellation may
not stop it.

### Evidence
- `runVerificationCommand` spawns directly and, on timeout, sends only
  `SIGTERM` to the parent:
  `.pi/extensions/cc-review/workflow/orchestrator/runtime.ts:425`
  ```ts
  const proc = childProcess.spawn(command.command, command.args, {
    cwd: rt.workflowCwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
  });
  ...
  if (command.timeoutMs) {
    timer = setTimeout(() => { timedOut = true; proc.kill("SIGTERM"); }, command.timeoutMs);
  }
  ```
  There is no `SIGKILL` escalation, no detached process-group kill, no
  `AbortSignal` listener, and the process is **not** registered in
  `rt.activeProcesses`.
- Workflow abort cleanup only kills registered active processes:
  `.pi/extensions/cc-review/workflow/orchestrator/runtime.ts:857` (abort handler).
- By contrast, every other subprocess goes through the hardened shared runner
  `runSubprocess` which uses a detached group and process-group kill:
  `.pi/extensions/cc-review/subprocess.ts:248`.

### Root cause
Verification commands bypass the shared subprocess safety path and implement a
weaker, non-cancellable, non-group-killing lifecycle of their own.

### Impact
- A stuck/ignoring-SIGTERM verification command can hang the run despite the
  timeout.
- Cancelling the workflow may leave verification children running.

### Proposed fix
Route verification commands through `runSubprocess` (or mirror it): detached
process group, `SIGTERM`→`SIGKILL` escalation, `AbortSignal` wiring, and
registration in `rt.activeProcesses` so abort cleanup covers them.

---

## I3 (Medium) — Reviewer that exits 0 without the required JSON verdict is silently treated as `ship`

### Symptom
A reviewer subprocess that exits 0 but omits the mandated structured
verdict/findings JSON green-lights the task with no auditable review result.

### Evidence
- Missing review JSON → `status: "absent"`:
  `.pi/extensions/cc-review/structured.ts:458`
  ```ts
  if (!jsonText) return { result: null, status: "absent", ambiguousHighSeverity: false };
  ```
- Malformed JSON → `status: "fallback_exit_code"` (structured.ts:463).
- `deriveEffectiveVerdict` only downgrades unparsed output when the reviewer exit
  code is non-zero; with exit 0 and no `reportedVerdict` it falls through to
  `ship`:
  `.pi/extensions/cc-review/structured.ts:579`
  ```ts
  if (input.reviewParseStatus !== "parsed" && input.reviewerExitCode !== 0) {
    return { effectiveVerdict: "ship_with_warnings", fallbackApplied: true };
  }
  ...
  return {
    effectiveVerdict: input.reviewerExitCode === 0 ? "ship" : "ship_with_warnings",
    fallbackApplied: input.reviewParseStatus !== "parsed",
  };
  ```

### Root cause
Exit code is trusted over contract compliance: absent structured output plus a
zero exit maps to a full `ship` (only `fallbackApplied` is flagged).

### Impact
A reviewer that fixed nothing and reported nothing can still pass a task with no
verdict/findings to audit.

### Proposed fix
Require `reviewParseStatus === "parsed"` for a clean `ship`. Treat `absent` /
`fallback_exit_code` as at least `ship_with_warnings` (surfaced as a warning),
or retry review once, even when the reviewer exits 0.

---

## I4 (Medium) — Documentation and README describe a monolithic single-file plugin that no longer exists

### Symptom
Following the install/debug docs can produce a broken extension and point
readers at impossible source locations.

### Evidence
- `README.md:19` (and the smoke checklist near README.md:170) say to install by
  copying only `.pi/extensions/cc-review.ts`.
- That file is now a 4-line re-export that depends on the sibling directory:
  `.pi/extensions/cc-review.ts:1`
  ```ts
  import registerCcReviewExtension from "./cc-review/workflow.ts";
  export * from "./cc-review/workflow.ts";
  export default registerCcReviewExtension;
  ```
- Debugging docs still cite nonexistent monolithic line numbers, e.g.
  `docs/subagent-workflow-inspection.md:11` references
  `runCcReviewWorkflow ... at line 4222` and `getSubagentExecutor ... at line
  3894`; `docs/review-plugin-entrypoints.md` similarly refers to a single
  `.pi/extensions/cc-review.ts` throughout.

### Root cause
Docs were not updated after `workflow.ts` was split into
`.pi/extensions/cc-review/**`.

### Impact
- "Copy one file" install instructions yield a broken plugin (the `cc-review/`
  tree is required).
- Line-number references are dead, slowing debugging and onboarding.

### Proposed fix
- Update install/checklist steps to copy `.pi/extensions/cc-review.ts` **plus**
  the entire `.pi/extensions/cc-review/` directory (or add a real bundling step
  that emits a single file).
- Replace monolithic line-number references with module paths/symbols.

---

## I5 (Low–Medium) — Duplicated execution/timeout logic across after-all and per-task branches

### Symptom
The subagent execute/timeout/retry logic is implemented twice with near-identical
code, so fixes tend to land in one mode but not the other (I1 above is an example
of per-task-only lifecycle drift).

### Evidence
- After-all branch timeout/abort block:
  `.pi/extensions/cc-review/workflow/orchestrator/execution-phase.ts:200`
- Per-task branch timeout/abort block:
  `.pi/extensions/cc-review/workflow/orchestrator/execution-phase.ts:672`
- The file also carries stale imports left over from the split (e.g. `fs`,
  `path`, planner/JSON helpers not used on this path):
  `.pi/extensions/cc-review/workflow/orchestrator/execution-phase.ts:1` onward.

### Root cause
The two review-timing modes were built as parallel copies rather than sharing a
single "execute worker task with retries + timeout" helper.

### Impact
- Divergence risk: correctness/timeout/state fixes must be applied twice.
- Dead imports obscure the real dependency surface (not caught because
  `noUnusedLocals` is not enabled).

### Proposed fix
Extract one shared helper that executes a worker task with retry/timeout and
returns a structured execution record; keep only mode-specific orchestration
around it. Remove stale imports or enable `noUnusedLocals` in `tsconfig.json`.

---

## Suggested remediation order

1. I1 — correctness: fix per-task result recording (biggest user-visible wrong
   outcome).
2. I2 — resource safety: route verification commands through the hardened
   subprocess runner.
3. I3 — review integrity: require parsed verdict for a clean `ship`.
4. I4 — docs: fix install instructions and stale line-number references.
5. I5 — refactor: de-duplicate execution/timeout logic; then I1-style drift is
   structurally prevented.
