# CC Review Log Display Reference Patterns

Scope: reference collection only. This task does **not** change CC Review runtime logging behavior in `.pi/extensions/cc-review.ts`; it extracts patterns from local Pi examples that can inform a later implementation story.

Screenshots were not captured because the review was performed from source in this non-interactive workspace. The written notes below describe the observable behaviors each plugin would present in Pi's TUI.

## Reference plugins inspected

| Reference | Location | Relevant observable behavior |
| --- | --- | --- |
| Todo extension | `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/todo.ts` | Custom `renderCall`/`renderResult` colors tool title/action/id with `toolTitle`, `muted`, `dim`, `accent`, `success`, and `error`; collapsed list shows first five items plus `... N more`; expanded view shows more detail; `/todos` command has a dedicated component with progress count, width-safe `truncateToWidth(...)`, empty state (`No todos yet...`), and Escape-to-close help text. |
| Plan Mode extension | `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/plan-mode/index.ts` | Uses `ctx.ui.setStatus("plan-mode", ...)` for compact persistent phase/progress (`📋 completed/total` or `⏸ plan`), `ctx.ui.setWidget("plan-todos", ...)` for grouped checklist progress, success/dim/strikethrough styling for completed steps, `ctx.ui.notify(...)` for mode changes, and `pi.sendMessage(...)` for completion/plan-step summaries. |
| Custom message renderer example | `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/message-renderer.ts` | Registers `status-update` message renderer; displays severity badges (`[INFO]`, `[WARN]`, `[ERROR]`) using success/warning/error colors; wraps output in `customMessageBg`; stores `level` and `timestamp` in `details`; shows the timestamp only when expanded. |
| Truncated tool example | `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/truncated-tool.ts` | Uses explicit truncation limits, reports `No matches found` empty state, displays partial state (`Searching...`), summarizes result as match count, marks truncated output with warning color, shows only first 20 lines in expanded view, and writes full output to a temp file path for copy/export/re-read affordance. |
| Tools selector extension | `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/tools.ts` | Uses `SettingsList` to toggle many items immediately and persist choices. It is not a log viewer, but its settings-list pattern is useful for future source/severity filters. Pi docs also show `SettingsList(..., { enableSearch: true })` for searchable toggle lists. |

## Behavior notes by log-display concern

- **Severity styling:** `message-renderer.ts`, `todo.ts`, and `truncated-tool.ts` consistently map status to theme colors: success for completion, warning for partial/truncated states, error for failures, muted/dim for secondary context. CC Review currently encodes severity mostly in string prefixes such as `[... Error]`; adopting theme-colored badges would make planner/reviewer/subagent failure paths easier to scan.
- **Timestamps:** `message-renderer.ts` stores a timestamp in `details` and reveals it only when expanded. This fits CC Review because timestamps are useful for diagnosing slow planner/reviewer/subagent phases but would be noisy in the compact widget.
- **Grouping and progress:** `plan-mode/index.ts` keeps a compact footer status and a checklist widget grouped by work item. CC Review already has phases and tasks; the stronger pattern is to show concise grouped state (`Planning`, `Task 2/5 executing`, `Reviewing`) while keeping detailed stream lines below or behind expansion.
- **Filtering and search:** `tools.ts` demonstrates immediate, persisted toggles; Pi TUI docs show searchable `SettingsList`. For CC Review this suggests optional filters by `severity`, `source` (`planner`, `subagent`, `reviewer`), `taskIndex`, and `attempt`, but the first implementation should keep a small default set rather than building a complex log console.
- **Copy/export affordances:** `truncated-tool.ts` writes full output to a temp file and tells the user where it is. CC Review should similarly persist a bounded human-readable/structured UI log alongside `workflow-trace.jsonl`, with a clear path users can open/copy when compact TUI output is truncated.
- **Collapsed details:** `todo.ts`, `message-renderer.ts`, and `truncated-tool.ts` all keep default views compact and reveal extra rows, timestamps, and raw output only when expanded. CC Review should not stream full stdout/stderr into the default widget; it should show badges/counts and make details opt-in.
- **Empty states:** `todo.ts` uses `No todos` / `No todos yet...`; `truncated-tool.ts` uses `No matches found`. CC Review should have explicit `No logs yet`, `Waiting for planner output`, and `No reviewer warnings` states rather than a blank or stale widget.
- **Error states:** `todo.ts` renders validation errors with `theme.fg("error", ...)`; `message-renderer.ts` colors `error` severity; `truncated-tool.ts` throws command failures but displays no-match as non-error. CC Review should distinguish fatal errors, warnings, cancellations, retries, timeouts, and benign empty output.
- **Width and verbosity control:** `todo.ts` and `custom-footer.ts` use `truncateToWidth(...)`; `truncated-tool.ts` caps line/byte volume and points to full output. CC Review should truncate long log lines, avoid full goal/task text in compact output, and keep redaction/truncation rules separate from trace minimization.

## Prioritized patterns to adopt for CC Review

1. **Introduce typed UI log events before rendering.** Use fields such as `timestamp`, `severity`, `source`, `phase`, `taskIndex`, `attempt`, `message`, and optional `detailsPath/details`. This addresses the current audit issue where human logs and structured trace logs are split and interleaved planner/reviewer/subagent streams only have string prefixes.
2. **Render severity/source badges with Pi theme colors.** Adopt `[INFO]`, `[WARN]`, `[ERROR]`, `[RETRY]`, `[TIMEOUT]`, and source badges styled like `message-renderer.ts`/`todo.ts`; map current planner/reviewer/subagent stderr and validation failures to consistent severities.
3. **Keep the default view compact, with expandable details.** Show phase, task progress, and the most recent high-value lines by default; expose timestamps, raw stderr/stdout snippets, retry feedback, and validation details only in expanded renderer/message views.
4. **Group logs by phase/task/attempt.** Borrow Plan Mode's status/widget split: footer for current phase (`Planning`, `Executing task 2/5`, `Reviewing task 2/5`) and widget/body grouped by task checklist plus recent scoped events. This is important when subagent streams and reviewer streams overlap or retry.
5. **Persist/export the full bounded log.** Follow `truncated-tool.ts`: when compact UI truncates, write a structured human-readable log file (for example under the workspace next to `workflow-trace.jsonl`) and display the path for copy/export/re-read. Preserve current minimal `workflow-trace.jsonl` for machine lifecycle events.
6. **Add explicit empty, partial, warning, failed, timeout, and cancelled states.** Use clear states such as `No logs yet`, `Waiting for planner output`, `Reviewer warning`, `Retrying 2/3`, `Timed out after 300s`, and `Cancelled by user` rather than relying on raw subprocess text.
7. **Apply width-safe truncation and redaction in UI logs.** Use Pi truncation utilities and `truncateToWidth(...)`; keep full raw output opt-in and avoid displaying raw full goals, task descriptions, prompts, and subprocess stderr in compact surfaces.
8. **Add lightweight filters after the event model exists.** Use the `SettingsList`/toggle pattern for source and severity filters only after events carry stable metadata; do not try to parse filters from current string prefixes.

## Patterns intentionally not adopted yet

- **Full-screen modal log viewer from the Todo `/todos` component:** useful as a reference for empty states and width handling, but not the first choice for CC Review because long-running workflows need live visibility without taking over the editor for the whole run.
- **Replacing the entire footer like `custom-footer.ts`:** CC Review should use a namespaced `setStatus("cc-review-status", ...)` entry so it coexists with model, branch, and other extension statuses.
- **Animated global working indicators from `working-indicator.ts`:** attractive but too global; CC Review phases are better represented as explicit status text and per-source events.
- **Unbounded expanded raw stdout/stderr:** not adopted because current audit notes sensitive/verbose live output risk. Raw details should be truncated, redacted, and exported to a file path when needed.
- **Browser console or web panel logging:** not adopted because the inspected Pi references are TUI/extension examples and this project has no browser/web panel surface.
- **Complex searchable filter console as the first deliverable:** source/severity filters are valuable, but they should follow typed event metadata and tests; implementing them first would add UI complexity without fixing split trace/live models.
- **Persisting every human log line as conversation-visible session entries:** avoided because it can bloat sessions and expose prompts/stdout to the model context. Prefer a bounded workspace artifact plus compact displayed messages.

## Applicability to current CC Review audit

The current audit in `docs/plugin-log-surface-audit.md` identifies rolling five-line loss, noisy full `onUpdate` snapshots, split trace/live models, sensitive verbose display, no dedicated renderer/panel, partial subprocess buffering, and weak widget/update tests. The reference patterns above directly address those issues while preserving the documentation-only scope of this story.
