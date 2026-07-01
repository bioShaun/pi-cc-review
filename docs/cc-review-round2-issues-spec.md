# CC Review Orchestrator — Round 2 Issues & Remediation Spec

Status: Open (findings only; no code changed)
Scope: `.pi/extensions/cc-review/` (modular implementation)
Date: 2026-07-01

This spec captures problems found in a **second-pass review** performed after
the Round 1 remediation (`docs/cc-review-current-issues-spec.md`, I1–I5) landed.
Round 1's items are confirmed implemented and covered by the existing test
suite; the issues below are new findings surfaced by reading the full source
tree rather than re-running the (green) test suite.

## Verification baseline (current tree)

Everything below was found on a tree where the standard quality gates are green,
so these are logic/design defects, not build breakage:

- `npm run typecheck` → exit 0.
- `node tests/cc-review-static.test.mjs` → 69/69 pass.
- `node --experimental-strip-types tests/cc-review-structured.test.ts` → 20/20 pass.
- `node --experimental-strip-types tests/cc-review-ui.test.ts` → 67/67 pass.
- `node --experimental-strip-types tests/cc-review-behavior.test.ts` → 219/219 pass.

Confirmed already-fixed from Round 1 (not re-listed as issues):
`recordTaskResult` overwrite-by-index (I1), verification commands routed
through the hardened subprocess runner (I2), `deriveEffectiveVerdict` requires
`reviewParseStatus === "parsed"` for a clean `ship` (I3), docs/README updated
for the modular split (I4), and `noUnusedLocals` enabled to catch dead imports
(I5 partial — the full execution-branch de-duplication is still open and
re-listed below as R5).

Finding identifiers are retained for discussion continuity. The remediation
order at the end reflects the revised impact and dependency analysis. The `R`
prefix denotes Round 2.

---

## R1 (High) — `after-all` execution is not checkpointed in a form that final review can resume

### Symptom
In the default `after-all` review mode, each task that completes during the
parallel execution phase updates `rt.taskResults[i]` directly but **never** calls
`recordTaskResult`. As a result the run-state buffer is not merged and no
checkpoint is persisted per task. If the workflow crashes, times out, or is
cancelled mid-execution, resuming it loses the record of tasks that had already
finished — they are re-run from scratch.

Merely routing these assignments through `recordTaskResult` is necessary but
not sufficient. Doing so would make completed tasks skippable on resume, while
the transient `rt.batchTaskExecutions` records required by final review are not
serialized or reconstructed. A resumed run could therefore skip worker
execution but omit those tasks from post-review validation, artifact rewriting,
and final result enrichment.

This is the same class of defect as Round 1's I1, but on the **other** execution
branch: I1 fixed the per-task path's *append-per-round* behavior; the after-all
path was never wired through `recordTaskResult` at all.

### Evidence
- The after-all execution branch assigns directly to the result slot:
  `.pi/extensions/cc-review/workflow/orchestrator/execution-phase.ts:454`
  ```ts
  rt.taskResults[i] = res; // Assign directly to correct index
  ```
  and again at `.pi/extensions/cc-review/workflow/orchestrator/execution-phase.ts:479`
  ```ts
  rt.taskResults[i] = result; // Assign directly to correct index
  ```
  Neither site calls `recordTaskResult`, `mergeTaskResultIntoStateBuffer`, or
  `persistRunCheckpoint`.

- By contrast, the per-task branch routes every terminal outcome through
  `recordTaskResult`:
  `.pi/extensions/cc-review/workflow/orchestrator/execution-phase.ts:851`,
  `:1004`, and `:1057`.

- `recordTaskResult` does three things, only the first of which the after-all
  direct assignment replicates:
  `.pi/extensions/cc-review/workflow/orchestrator/runtime.ts:654`
  ```ts
  rt.recordTaskResult = (taskIndex, result, structured?) => {
    rt.taskResults[taskIndex] = result;                       // (1) slot assign
    rt.runStateBuffer = mergeTaskResultIntoStateBuffer(...);  // (2) state buffer — SKIPPED in after-all
    try { rt.persistRunCheckpoint("executing"); } catch {}    // (3) checkpoint  — SKIPPED in after-all
  };
  ```

- The after-all path persists a checkpoint only once, at the top of the phase:
  `.pi/extensions/cc-review/workflow/orchestrator/execution-phase.ts` calls
  `rt.persistRunCheckpoint("executing")` before the batch loop begins, not per
  task.

- Resume restores `tasks`, `taskResults`, and `taskStatuses`, but not
  `batchTaskExecutions` (`runtime.ts:350–362`). Skipped tasks therefore have no
  execution record in the collection consumed by final review.

- Final-review validation and artifact/result updates iterate
  `rt.batchTaskExecutions` (`review-phase.ts:171–180` and `:251–312`). A
  completed task skipped during resume is absent from both loops.

### Root cause
The after-all branch was written with a direct `taskResults[i] = …` assignment
to satisfy the "overwrite by index" requirement, but it predates (or missed)
the introduction of `recordTaskResult` as the single chokepoint that also
maintains the state buffer and writes incremental checkpoints. In addition,
the checkpoint schema models terminal task results but not the intermediate
"execution complete, batch review pending" state needed by after-all mode.

### Impact
- **Resume loses completed work.** After a crash/cancel in `after-all` mode,
  `resumeRunId` cannot reconstruct which tasks already finished, because the
  state buffer and checkpoint were never updated per task. Completed tasks are
  re-executed, wasting subagent runs and risking conflicting workspace edits.
- **A naïve checkpoint fix creates an incomplete review.** If execution results
  become skippable without restoring review inputs, resumed runs can
  vacuously pass rerun validation and leave skipped tasks with `reviewCode: -1`
  or missing final artifacts.
- **State buffer drift.** `rt.runStateBuffer` (fed into later task prompts via
  `formatStateBufferForPrompt`) is stale during after-all execution, so later
  batches run without visibility of earlier batches' completed results.
- **Inconsistent invariant.** Two execution branches maintain `taskResults`
  differently; any future code that assumes "a result in `taskResults` implies
  a checkpoint was written" is wrong in after-all mode.

### Proposed fix
Define and persist an explicit per-task execution snapshot for after-all mode.
It must contain enough information for final review to process a skipped task
without rerunning its worker (at minimum the task index, timing/model metadata,
raw or structured execution evidence, validation result, and task result).
Successful execution should also write an execution-stage artifact or another
durable equivalent.

Then:

1. Route both direct result assignments through a single recording operation
   that updates `taskResults`, the state buffer, the durable execution snapshot,
   and the checkpoint.
2. On resume, reconstruct the final-review input collection from those durable
   snapshots before skipping completed worker tasks.
3. After batch review, persist the reviewed status and review payload so the
   checkpoint no longer represents execution-only state.

Add an end-to-end behavioral test that interrupts an after-all run after one
task completes, resumes it, verifies that the worker is not rerun, and asserts
that every task still participates in final validation, receives a final
artifact/result, and appears correctly in the completed checkpoint and summary.

---

## R2 (Low–Medium) — Execution display state has duplicated ownership and ambiguous scalar semantics

### Symptom
In `after-all` mode with `concurrency > 1`, multiple tasks execute concurrently
while the widget contract still exposes a scalar `currentTaskIndex`. Both
`transitionToExecuting` and `updateExecutionPhase` derive and write the display
fields from `taskStatuses`, duplicating ownership of the same presentation
state. The current implementation deterministically chooses the first running
task, but that convention is implicit and easy to break when either helper is
changed.

### Evidence
- The concurrent callback marks the task running and calls
  `transitionToExecuting`:
  `.pi/extensions/cc-review/workflow/orchestrator/execution-phase.ts:113`
  ```ts
  rt.transitionToExecuting(i);
  ```
  inside `runWithConcurrencyLimit` (execution-phase.ts:97).

- `transitionToExecuting` derives single-valued display state from
  `rt.taskStatuses`:
  `.pi/extensions/cc-review/workflow/orchestrator/runtime.ts:555`
  ```ts
  rt.transitionToExecuting = (index: number) => {
    const task = rt.getTaskOrThrow(index);
    rt.currentTaskIndex = index;
    setTaskConfiguredModel(rt.taskModels, index, rt.resolvedWorkerModel);
    const runningIndices = rt.taskStatuses
      .map((status, idx) => (status === "running" ? idx : -1))
      .filter((idx) => idx !== -1);
    if (runningIndices.length > 1) {
      rt.currentTaskIndex = runningIndices[0];
      rt.currentPhase = `Executing Tasks ${taskNumbers} concurrently`;
    } else {
      rt.currentTaskIndex = index;
      rt.currentPhase = `Executing Task ${index + 1}/...`;
    }
    ...
  };
  ```

- A separate helper `updateExecutionPhase` (runtime.ts:536) computes the same
  multi-task display string from `taskStatuses` and is called from
  execution-phase.ts:455 and :499. It duplicates the ownership and formatting
  logic of `transitionToExecuting`.

### Root cause
Runtime display state is modeled as scalar presentation fields while the
execution model permits N concurrent tasks. `taskStatuses` already provides the
canonical running set, but two helpers independently translate it into the
scalar display contract.

### Impact
- **Ambiguous UI contract.** `currentTaskIndex` has no documented meaning when
  several tasks run; today it means "lowest running task index."
- **Maintenance hazard.** Two functions (`transitionToExecuting`,
  `updateExecutionPhase`) own the same fields with overlapping logic; fixes to
  one don't propagate to the other.

### Proposed fix
Keep `taskStatuses` as the canonical execution state and consolidate display
derivation into one helper, e.g. `refreshExecutionDisplayFromStatuses`.
`transitionToExecuting` should perform the task-start side effects and then
delegate to that helper; completion should call the same helper. Document
`currentTaskIndex` as the lowest running index (or replace it with a
multi-task-aware display field in a separate UI change). Add a deterministic
test that starts two tasks, completes them in reverse order, and checks the
phase/current-index values after each transition.

---

## R3 (Medium) — Unexpected concurrent callback errors do not abort in-flight siblings

### Symptom
When an after-all task callback throws outside the explicit unrecoverable
validation branch, `runWithConcurrencyLimit` stops *starting* new tasks but has
no cancellation channel for already-started siblings. Those siblings continue
to consume subagent resources and edit the shared workspace until they settle.

### Evidence
- `runWithConcurrencyLimit` breaks the launch loop on first error but still
  awaits all started promises via `allSettled`:
  `.pi/extensions/cc-review/workflow/dependencies.ts:14`
  ```ts
  export async function runWithConcurrencyLimit<T>(...) {
    const executing = new Set<Promise<void>>();
    const started: Promise<void>[] = [];
    let firstError: unknown;
    for (let i = 0; i < items.length; i++) {
      if (firstError !== undefined) break;       // stop launching
      const p = fn(items[i], i);
      started.push(p);
      executing.add(p);
      p.then(() => executing.delete(p), (error) => { ...; firstError = error; });
      if (executing.size >= concurrencyLimit) {
        await Promise.race(executing).catch(...);
      }
    }
    const settled = await Promise.allSettled(started);  // wait for ALL, no cancel
    ...
    if (firstError !== undefined) throw firstError;
  }
  ```
  There is no `AbortController`, no shared cancel signal, and no way for the
  caller to abort siblings.

- The after-all execution callback does maintain per-task
  `taskAbortControllers[i]` and aborts *other* tasks only inside its own
  hard-fail branch:
  `.pi/extensions/cc-review/workflow/orchestrator/execution-phase.ts:458`
  ```ts
  for (const controller of taskAbortControllers) {
    controller.abort();
  }
  throw new Error(`Task execution failed unrecoverably on: ...`);
  ```
  This covers the normal unrecoverable-validation path. A generic throw from
  elsewhere in the callback (for example artifact/checkpoint or orchestration
  code) propagates without aborting siblings.

### Root cause
`runWithConcurrencyLimit` is a pure concurrency primitive with no cancellation
semantics. The execution-phase callback has its own partial cancellation logic
for one failure mode but not for the general case. There is no shared
"batch-failed" abort signal wired between the two.

### Impact
- **Wasted work.** After an unexpected callback failure, sibling subagents keep
  running to completion, burning tokens/time.
- **Workspace corruption risk.** Concurrent subagents editing the same files
  after one has already failed can produce a workspace state that's neither
  the pre-failure state nor a coherent post-failure state, confusing the
  subsequent review phase.
- **Slow failure propagation.** The user-visible "workflow failed" can be
  delayed by the slowest sibling task rather than surfacing promptly.

### Proposed fix
Give the concurrency primitive an explicit cooperative-cancellation contract,
for example:

```ts
runWithConcurrencyLimit(limit, items, async (item, index, signal) => { ... })
```

Create one batch `AbortController`; abort it on the first rejection and chain
its signal into each task's attempt controller. Continue awaiting
`Promise.allSettled(started)` after abort so no background task can keep editing
the workspace after the workflow returns. Cancellation should make settlement
prompt, not bypass settlement. Add tests for both the existing validation-fail
path and an unexpected callback throw, asserting sibling signals fire, no new
items start, and the helper does not return until all started callbacks settle.

---

## R4 (Medium) — Planner output has no structural validation; malformed tasks reach execution

### Symptom
The planner's JSON output is parsed and only checked for `tasks.length > 0`.
Individual tasks are never validated for required fields (`title`,
`description`, `acceptanceCriteria`). A planner that returns well-formed JSON
with malformed task objects (e.g. missing `acceptanceCriteria`, or `title: 42`)
passes planning and fails much later in execution with a confusing error.

### Evidence
- Planning parses and stores tasks with only an emptiness check:
  `.pi/extensions/cc-review/workflow/orchestrator/planning-phase.ts:245`
  ```ts
  try {
    const outputData = JSON.parse(rawPlanJson);
    rt.tasks = Array.isArray(outputData?.tasks) ? outputData.tasks : [];
    if (rt.tasks.length === 0) {
      throw new Error(`${rt.reviewProviderConfig.label} returned an empty task list`);
    }
    break;
  } catch (err: any) { ... }
  ```
  No validation of `typeof task.title`, `typeof task.description`,
  `typeof task.acceptanceCriteria`, or `Array.isArray(task.dependsOn)`.

- The JSON schema written to `rt.schemaPath` (planning-phase.ts:23) does
  declare these as required, but only codex uses `--output-schema` to enforce
  it (planning-phase.ts:69). The claude path (planning-phase.ts:82 onward) has
  no native schema enforcement and relies on prompt instructions alone.

- Downstream code assumes the fields exist, e.g.
  `execution-phase.ts:98` spreads `task.title` / `task.description` into
  prompts; `dependencies.ts:50` reads `task.dependsOn`.

### Root cause
Schema enforcement is provider-dependent (codex enforces, claude doesn't), and
even on the codex path the *post-hoc* parse never re-validates. The schema is
treated as a planner-side hint rather than an orchestrator-side contract.

### Impact
- **Late, confusing failures.** A malformed task from claude planning surfaces
  as `undefined` in a prompt or a TypeError deep in dependency resolution,
  far from the actual defect.
- **Retry wasted.** The planner retry loop (planning-phase.ts:128) retries on
  JSON.parse errors but not on structural-validation errors, so a structurally
  broken-but-parseable plan isn't retried — it's accepted and fails downstream.

### Proposed fix
Add a provider-independent parser/validator that accepts `unknown` and returns
either validated `Task[]` or a precise validation error. It must check:

- `tasks` is a non-empty array;
- `title`, `description`, and `acceptanceCriteria` are non-empty strings;
- optional `dependsOn` is an array of integers in `1..tasks.length`;
- dependencies do not reference the task itself; and
- the resulting dependency graph is acyclic.

Do not coerce dependency strings to numbers or silently discard out-of-range
dependencies. Call the validator immediately after JSON parsing; on failure,
treat it like a parse error and retry with backoff. Add tests for missing/wrong
field types, blank strings, string dependencies, out-of-range/self
dependencies, cycles, and a valid plan for each provider path.

---

## R5 (Medium) — `execution-phase.ts` after-all and per-task branches are ~1000 lines of duplicated logic

### Symptom
The subagent execute / retry / timeout / validation / early-termination-gate
logic is implemented twice in `execution-phase.ts` (1082 lines total): once for
the `after-all` branch (lines 59–541) and once for the `per-task` branch
(lines 543–1080). The two copies drift, and fixes land in one but not the
other — R1 above is a direct consequence (the per-task branch was migrated to
`recordTaskResult` for I1; the after-all branch was not).

### Evidence
- After-all branch spans execution-phase.ts:59–541 (~480 lines).
- Per-task branch spans execution-phase.ts:543–1080 (~540 lines).
- Both implement: subagent prompt assembly, `maxTaskExecutionAttempts` retry
  loop, transient-error classification, timeout/abort handling, validation,
  artifact writing, and terminal result recording — with near-identical
  structure but divergent details (R1's missing `recordTaskResult`, different
  early-termination gating, different `taskResults[i]` vs `recordTaskResult`
  usage).

### Root cause
The two review-timing modes were built as parallel copies rather than sharing
a single "execute worker task with retries + timeout → structured execution
record" helper. Round 1's I5 called this out but the de-duplication was
deferred; `noUnusedLocals` (I5's partial fix) catches dead imports but cannot
catch behavioral divergence between two live copies.

### Impact
- **Divergence is the bug factory.** R1 exists solely because the I1 fix
  touched only the per-task copy. Any future fix to execution lifecycle must be
  applied twice, and there is no test asserting the two modes behave
  identically for the shared concerns.
- **Review burden.** A 1082-line file with two near-duplicate halves is hard to
  review; subtle differences are easy to miss.

### Proposed fix
Extract a single `executeWorkerTask(rt, task, index, opts) =>
Promise<TaskExecutionRecord>` helper that owns: prompt assembly, retry loop,
transient classification, timeout/abort, validation, and artifact writing. Both
branches call it and then apply only their mode-specific orchestration
(after-all: batch scheduling + final review; per-task: inline review loop).
This structurally prevents R1-class drift. This is the same work called out by
Round 1 I5; it remains the highest-leverage refactor in the file.

---

## R6 (Low–Medium) — `const rt = {} as WorkflowRuntime` defeats TypeScript initialization checking

### Symptom
`createWorkflowRuntime` constructs the runtime as an empty object cast to
`WorkflowRuntime`, then assigns ~24 fields and ~24 methods across ~450 lines.
TypeScript cannot verify that every property is assigned before first use, so a
missed initialization silently produces `undefined is not a function` at
runtime rather than a compile error.

### Evidence
- The runtime is born as an unchecked cast:
  `.pi/extensions/cc-review/workflow/orchestrator/runtime.ts:209`
  ```ts
  const rt = {} as WorkflowRuntime;
  rt.pi = pi;
  rt.goal = goal;
  // ... ~450 lines of manual assignment ...
  return rt;
  ```
- `WorkflowRuntime` is an interface (runtime.ts:120), so the cast is structurally
  permissive — TypeScript will not flag a missing method as long as the cast
  itself compiles.

### Root cause
The runtime was built as a bag of closures over a shared mutable object rather
than a class. This pattern predates the modular split; Round 1's overview noted
"#1 full class extraction deferred."

### Impact
- **Silent init bugs.** Forgetting to assign a method (e.g. during a refactor)
  compiles cleanly and fails at the first call site.
- **No initialization order checking.** Some closures reference others (e.g.
  `recordTaskResult` calls `persistRunCheckpoint`); the cast provides no
  guarantee that `persistRunCheckpoint` is assigned before `recordTaskResult`
  is *invoked*, only before the factory returns.
- **Hard to read.** The 450-line factory function obscures the runtime's
  actual shape and dependency graph.

### Proposed fix
Convert `WorkflowRuntime` to a `class` with fields declared on the class and
methods as real methods (or initialized in the constructor). This lets
`--strict` property-initialization checking catch missing assignments. This is
a mechanical but large refactor; it can be done incrementally by converting one
group of methods at a time. (Same work called out by Round 1 overview "#1 full
class extraction deferred.")

---

## R7 (Low) — `reviewedTaskCount` semantics differ between review modes

### Symptom
`rt.reviewedTaskCount` is incremented per reviewed task in `per-task` mode but
hard-set to `1` in `after-all` mode. Callers that check `> 0` to mean "at least
one review happened" work, but any future logic that treats it as a count will
be wrong in after-all mode.

### Evidence
- Per-task mode increments per task:
  `.pi/extensions/cc-review/workflow/orchestrator/execution-phase.ts:1003`
  ```ts
  rt.reviewedTaskCount += 1;
  ```
  and `:1056`.
- After-all mode sets it to a constant:
  `.pi/extensions/cc-review/workflow/orchestrator/review-phase.ts:328`
  ```ts
  rt.reviewedTaskCount = 1;
  ```
- The only consumer is a `> 0` guard:
  `.pi/extensions/cc-review/workflow/orchestrator/index.ts:144`
  ```ts
  if (!rt.rollupEmitted && isCancelled && rt.reviewedTaskCount > 0) { ... }
  ```

### Root cause
The field was added for the per-task mode's "how many tasks have been reviewed"
semantics; after-all mode (which reviews all tasks in one batch) set it to `1`
as a "reviews happened" flag. The two semantics coexist under one field.

### Impact
Low today (only a `> 0` check reads it). Becomes a latent bug if any future
code uses `reviewedTaskCount` as an actual count (e.g. for progress reporting
or rollup sizing).

### Proposed fix
Rename the field to a boolean such as `hasCompletedReview` and set it only after
a review result has been processed in either mode. Keep review-pass counts or
task-coverage counts as separate fields if they are needed later. Add tests for
the cancellation/partial-rollup guard in both review modes.

---

## R8 (Low–Medium) — Batch review has no first-class result model and uses a task-0 ownership convention

### Symptom
In `after-all` mode, one review covers the complete workflow, but the result
model only has per-task `reviewResult` fields. The implementation stores the
batch payload on task 0 so summary/meta aggregation sees it exactly once; all
other tasks receive the shared verdict/status but no structured review payload.
This avoids duplicate findings, but the ownership convention is implicit and
does not survive naturally if task-level result handling changes.

### Evidence
- The after-all result-writing loop conditionally stores the structured result:
  `.pi/extensions/cc-review/workflow/orchestrator/review-phase.ts:306`
  ```ts
  Object.assign(execution.result, {
    reviewCode: reviewProcessResult.exitCode,
    reviewWarningName: rt.reviewProviderConfig.warningName,
    status: batchStatus,
    artifactPath,
    reviewResult: index === 0 ? reviewResultObject ?? undefined : undefined,
    reportedVerdict,
    effectiveVerdict,
    blockReason: derived.blockReason,
    reviewerExitDiagnostic,
  });
  ```
- The full review payload *is* written to every task's artifact JSON
  (review-phase.ts:269–281, `review.result: reviewResultObject`), so the
  artifact is complete, while the in-memory summary model uses task 0 as the
  single aggregation owner.

- Summary and metadata aggregate findings by iterating every task result:
  `.pi/extensions/cc-review/workflow/summary.ts:194–196` and
  `.pi/extensions/cc-review/structured.ts:810–825`. Storing the same payload on
  every task would duplicate findings and blockers N times.

### Root cause
The data model has no workflow-level or batch-level review result, so a
per-task slot is being used as an undocumented surrogate owner.

### Impact
- **Fragile aggregation contract.** Moving or copying the payload without
  understanding the task-0 convention can either drop the batch findings or
  duplicate them.
- **Debugging friction.** Inspecting `taskResults` after an after-all run
  does not make the batch ownership explicit.

### Proposed fix
Add a first-class optional `batchReviewResult` (or workflow review record) to
the runtime result and checkpoint schema. Summary, metadata, findings rollup,
and resume logic must consume it once. Keep per-task `reviewResult` for
per-task mode; do not copy the batch payload to every task. During migration,
either retain task 0 as a documented compatibility projection or update all
consumers atomically. Add tests asserting the batch findings appear exactly
once in summary/meta before and after checkpoint resume.

---

## Suggested remediation order

1. **R1** — correctness/resume: persist reconstructable after-all execution
   snapshots and restore them for final review. Do not ship only the
   `recordTaskResult` call-site change.
2. **R3** — resource safety: add cooperative batch cancellation while retaining
   `allSettled` cleanup.
3. **R4** — robustness: validate planner output structurally. Cheap to add,
   prevents confusing late-stage failures.
4. **R5** — refactor: de-duplicate the two execution branches. Largest effort
   but structurally prevents R1-class drift going forward. Do this after R1/R3
   land so the extraction incorporates the fixes.
5. **R8** — data model: introduce a first-class batch review result while the
   checkpoint/resume model is already being changed for R1.
6. **R2** — UI maintainability: consolidate display-state derivation and
   document scalar `currentTaskIndex` semantics.
7. **R6** — type safety: convert `WorkflowRuntime` to a class. Mechanical but
   large; can be staged.
8. **R7** — cleanup: replace the overloaded review count with the boolean
   semantics its only consumer requires.
