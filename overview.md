# Architecture deepening — application results

## What was applied

### Prerequisite: static suite → behavioral (DONE)
Converted `cc-review-static.test.mjs` from source-text grep locks to behavioral trust. Removed 11 categories of blocking greps. Both suites pass (65 static + 169 behavior).

### #5 Log adapters (DONE — full)
- Replaced `summarizeCodexItem` + inline claude branches with `codexSummarizer` + `claudeSummarizer` adapter objects behind a `StreamSummarizer` interface
- Added `formatSubprocessStreamLineRich` (internal, carries severity hints)
- `formatSubprocessStreamLine` export preserved as thin wrapper
- `createSubprocessStreamLogger` gained optional `provider` param (backward-compatible)
- Added `resolveNestedAssistantText` shared helper (deduplicates the 3-way nested-text fallback)
- `MAX_REDISPATCH_DEPTH = 2` bounds recursion

### #3 Subprocess runner (DONE — module-level + subagent adapter)
- Added `runSubprocess` deep module at module level: spawn + lifecycle + teardown + trace (no content)
- Added `sendSignalToProcessGroup` + `killProcessGroup` helpers (§3.H compliant: detached, SIGTERM→-pid→500ms→SIGKILL→-pid)
- Rewrote `runPiAgentSubprocess` as thin adapter: NDJSON parsing + model extraction + temp file stay; spawn/buffer/abort-kill delegated to runner
- `runProcess` / `runVerificationCommand` / `onAbort` remain in workflow body (handed off to #1)

### #1 State machine (DONE — high-value subset)
- Added `abortWorkflow()` and `failWorkflow()` named transitions — closes the bypass gap at 4 direct-write sites
- Fixed `clearRetry` latent bug: now snapshots `preRetryDisplayState` before entering retry, restores from it on clear (was inferring phase from `currentTaskIndex` which is wrong during reviewing-phase retries)
- Full WorkflowState class extraction deferred (24 call-site conversions in a 2430-line function — dedicated session needed)

## Verification

| Suite | Result |
|---|---|
| `node tests/cc-review-static.test.mjs` | **65/65 pass** |
| `node --experimental-strip-types tests/cc-review-behavior.test.ts` | **169/169 pass** |
| `node --experimental-strip-types tests/cc-review-ui.test.ts` | **67/67 pass** |

## What remains

- **#1 full class extraction**: WorkflowStateImpl class absorbing 18 closure vars + 24 direct-write conversions — mechanical but large
- **#3 handoff**: `runProcess` / `runVerificationCommand` / `onAbort` adapters (live in workflow body, need #1 first)
- **#2 execution dedup**: after-all / per-task pipeline consolidation (needs #1 full)
- **#4 config table**: table-driven config resolution (biggest test churn)
- **#6 planner seam**: speculative, only if third provider is plausible
