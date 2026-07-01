# CC Review plugin entry points and historical rename notes

This is a historical implementation note from the inspection story that preceded the rename to **CC Review**. Old names below are intentionally retained only to document pre-rename inventory and explain why no compatibility aliases were kept in active code.

## Current review execution entry points

- Extension module: `.pi/extensions/cc-review.ts` exports `ccReviewExtension(pi)`.
- User-facing triggers:
  - Slash command registration: `pi.registerCommand("cc-review", ...)`; the handler parses provider, log-level, and `--review-mode` flags before calling `runCcReviewWorkflow(...)`.
  - Tool registration: `pi.registerTool({ name: "cc_review", label: "CC Review", ... })`; `execute(...)` forwards `reviewProvider`, `logLevel`, and `reviewMode`.
- Shared workflow entry point: `runCcReviewWorkflow(...)` performs planning, subagent execution, configurable per-task or after-all review, report generation, cleanup, and UI clearing.
- Review phase:
  - After a task is executed and validated, `transitionToReviewing(i)` sets the phase and logs the configured reviewer invocation.
  - `resolveReviewProviderConfig(...)` accepts an explicit provider value before falling back to `CC_REVIEW_PROVIDER`, validates supported values (`codex` and `claude`), defaults to Codex when neither source is set, and initializes exactly one selected backend through `initializeSelectedReviewBackend(...)`.
  - The selected backend factory does **not** preflight credentials; authentication is delegated entirely to the chosen CLI (`codex` or `claude`), matching how the planner already invokes `codex`. The unselected provider's credentials, model, and CLI are never required.
  - The slash command and tool descriptions advertise both explicit provider selection (`--provider claude` / `reviewProvider`) and the `CC_REVIEW_PROVIDER=claude` fallback so command help surfaces the Claude selection path.
  - `reviewProviderConfig.buildArgs({ task })` builds provider-specific review input: Codex keeps the existing `codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox` subprocess path, while Claude runs `claude -p --dangerously-skip-permissions --no-session-persistence` with the same review prompt.
  - Review dispatch calls `runProcess(reviewProviderConfig.label, reviewProviderConfig.command, reviewArgs, ...)` for both providers so each reviewer runs in the workflow cwd and can inspect or patch workspace files.
  - Review exit handling still records non-zero review exits as `completed_with_warnings`; it does not retry review failures.

## Provider/model assumptions

- Plugin identity is now **CC Review**; the default provider implementation remains Codex-backed for planning and review.
- Planning provider: the normalized provider selects either `codex exec` with an output schema or `claude -p` with JSON extracted from stdout.
- Review provider: selected first through the explicit tool/command option (`reviewProvider` or `--provider`) and then through `CC_REVIEW_PROVIDER` via `resolveReviewProviderConfig(...)`; supported values are `codex` (default) and `claude`, and the normalized provider is used to initialize the matching entry in `REVIEW_BACKEND_FACTORIES`.
- Review credentials and models: the chosen review CLI (`codex` or `claude`) handles its own auth via its login session or env vars. Optional model selection per provider: Codex reads `CODEX_MODEL`; Claude reads `CLAUDE_MODEL`. CC Review itself does not preflight credentials; the CLI's own auth error surfaces as a non-zero review exit recorded as `completed_with_warnings`.
- Execution provider: task implementation is delegated to `agent: "worker"` through `getSubagentExecutor(pi)`. If `pi.toolManager.executeTool` exists, it is used; otherwise code falls back to discovering a local/user agent and spawning `pi --mode json -p --no-session` through `runPiAgentSubprocess(...)`.
- Subagent model assumptions: `discoverAgent(...)` reads project agents from `<cwd>/.pi/agents` and user agents from `~/.pi/agent/agents`, and `applyAgentModelOverride(...)` applies `~/.pi/agent/settings.json` model and thinking overrides for the `worker` agent. A legacy `generator.md` profile is accepted when no `worker.md` exists, but it runs under the `worker` identity and override.
- Claude review argument selection is present through the shared prompt builder, and optional Claude model selection is handled through `CLAUDE_MODEL`. Tests mock this subprocess path and use fake Claude credentials instead of live authentication.

## Current provider selection control path

This section has been updated from the original inspection note; the explicit provider option is now implemented in runtime behavior.

- **CLI/user parameters**:
  - `.pi/extensions/cc-review.ts` `CcReviewParams` accepts required `goal` plus optional `reviewProvider` with supported values `codex` and `claude`, so API/tool callers can pass a review provider explicitly without setting environment variables.
  - `.pi/extensions/cc-review.ts` `pi.registerTool(...).execute(...)` forwards `params.goal` and `params.reviewProvider` into `runCcReviewWorkflow(pi, params.goal, ctx, onUpdate, signal, { reviewProvider: params.reviewProvider })`.
  - `.pi/extensions/cc-review.ts` `pi.registerCommand("cc-review", ...)` parses optional `--provider <value>`, `--provider=<value>`, `--review-provider <value>`, or `--review-provider=<value>` flags before treating the remaining slash command argument string as the goal text, then calls `runCcReviewWorkflow(pi, goal, ctx, undefined, undefined, { reviewProvider })`.
  - Existing invocations without the option still work unchanged: `/cc-review <goal>` treats the full argument string as the goal, and `cc_review` tool calls that provide only `goal` still use environment/default behavior.
- **Environment variables**:
  - `.pi/extensions/cc-review.ts` `resolveReviewProviderConfig(explicitProvider, env = process.env)` is the sole review-provider defaulting and validation point. It uses an explicit `reviewProvider`/slash flag value first, otherwise reads `env.CC_REVIEW_PROVIDER`, returns Codex when neither source is set, normalizes configured values with `trim().toLowerCase()`, accepts only `codex` and `claude`, throws `Invalid reviewProvider` or `Invalid CC_REVIEW_PROVIDER` for empty, whitespace-only, or unsupported values, and then calls `initializeSelectedReviewBackend(normalizedProvider, env)`.
  - `.pi/extensions/cc-review.ts` `initializeSelectedReviewBackend(...)` dispatches to `REVIEW_BACKEND_FACTORIES[provider].initialize(env)`, so only the normalized selected backend is constructed. No credential preflight occurs; auth is delegated to the chosen CLI subprocess.
  - `.pi/extensions/cc-review.ts` `buildCodexReviewArgs(task, env = process.env)` separately reads `CODEX_MODEL` only for Codex review, and `.pi/extensions/cc-review.ts` `buildClaudeReviewArgs(task, env = process.env)` separately reads `CLAUDE_MODEL` only for Claude review.
- **Config files**:
  - There is no package manifest, extension manifest, project config, or settings file in this repository that selects Codex vs Claude for review.
  - `.pi/extensions/cc-review.ts` `applyAgentModelOverride(...)` reads `~/.pi/agent/settings.json` for the `worker` subagent model, and `discoverAgent(...)` can read `<cwd>/.pi/agents` or `~/.pi/agent/agents`; these affect task execution subagents, not planner/reviewer provider selection.
- **Runtime client/subprocess initialization**:
  - `.pi/extensions/cc-review.ts` `runCcReviewWorkflow(...)` calls `resolveReviewProviderConfig(options.reviewProvider)` once at workflow start, before planning, so invalid explicit/environment provider values fail before planner or reviewer subprocesses are spawned. Credential/auth problems surface later from the CLI subprocess itself (recorded as `completed_with_warnings`).
  - Planning uses the normalized provider: Codex writes schema-constrained output to a temporary file, while Claude returns JSON on stdout.
  - Review uses `.pi/extensions/cc-review.ts` `REVIEW_BACKEND_FACTORIES` and `reviewProviderConfig.buildArgs({ task })`. In `per-task` mode this runs after every task; in `after-all` mode it runs once with the overall goal and every task's acceptance criteria.
  - `.pi/extensions/cc-review.ts` `runProcess(reviewProviderConfig.label, reviewProviderConfig.command, reviewArgs, ...)` is the shared subprocess launcher for both reviewers and is responsible for cwd, environment inheritance, detached process groups, tracing, timeout handling, and spawn/exit errors.

The explicit provider and review-timing insertion points are implemented through `reviewProvider` and `reviewMode`, with `CC_REVIEW_PROVIDER` and `CC_REVIEW_MODE` environment fallbacks.

## Current plugin naming surfaces

- File path/name: `.pi/extensions/cc-review.ts`.
- Exported function: `ccReviewExtension`.
- Params schema symbol: `CcReviewParams`.
- Main workflow function: `runCcReviewWorkflow`.
- Slash command: `"cc-review"`.
- Tool name: `"cc_review"`.
- Tool label: `"CC Review"`.
- User-facing strings include `Starting CC Review`, `CC Review completed`, `CC Review failed`, `### CC Review Orchestrator`, `## 🏆 CC Review Orchestrator Report`, and `[CC Review]`.
- Message custom type: `"cc-review-summary"`.
- Widget/status IDs: `"cc-review-widget"`, `"cc-review-status"`.
- Temp path prefixes: `"cc-review-"`, `"cc-review-subagent-"`.
- Trace file remains `workflow-trace.jsonl` because it is a generic workflow trace artifact, not plugin metadata.
- Provider labels in trace payloads remain `agent: "codex"` for planner, use the configured review provider for reviewer, and `agent: "worker"` for executor because they describe runtime providers, not plugin identity.

## Historical old-name inventory retained intentionally

The following old names are retained in this document only as historical notes from the pre-rename inspection; active source and tests must not register or advertise them:

- Historical slash command: `codex-workflow`.
- Historical tool name: `codex_workflow`.
- Historical display label: `Codex Workflow`.
- Historical product/report name: `Codex-Workflow Orchestrator`.
- Historical implementation path: `.pi/extensions/codex-workflow.ts`.
- Historical test paths: `tests/codex-workflow-static.test.mjs` and `tests/codex-workflow-behavior.test.ts`.
- Historical UI/message IDs: `codex-workflow-widget`, `codex-workflow-status`, and `codex-workflow-summary`.
- Historical temp prefixes: `codex-workflow-` and `codex-workflow-subagent-`.

No compatibility aliases were kept because this workspace has no manifest, package registry metadata, or migration contract requiring old command/tool names to continue working; keeping aliases would make repository search report old user-facing names in active code.

## Manifests, package config, and CI

- No package.json was found in the workspace.
- No extension manifest file was found under `.pi/` beyond `.pi/extensions/cc-review.ts`.
- No CI configuration was found: no `.github/`, workflow YAML, or other CI files appeared in the repository file scan.

## Existing tests and missing coverage

Existing tests relevant to provider/rename work:

- `node tests/cc-review-static.test.mjs` covers static source/doc contracts, including command/tool names, Codex planning assumptions, review provider configuration, trace/event strings, temp prefixes, state transitions, validation, retries, cancellation patterns, and old-name absence in active surfaces.
- `node --experimental-strip-types tests/cc-review-behavior.test.ts` covers mocked multi-step execution, provider selection tests, Codex planner/default reviewer subprocess dispatch, Claude reviewer selection, invalid provider handling, subagent retry/recovery, partial failure aggregation, timeout/cancellation, malformed output handling, and new metadata registration.

Potential future coverage:

- Tests for model-specific Claude settings if this repository later introduces review model configuration.
- Tests proving planning provider and review provider can be configured independently if planning provider selection is added later.
- Tests for provider credential discovery if credentials become part of this repository's contract.
