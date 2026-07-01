import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function readTypeScriptTree(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const target = `${root}/${entry.name}`;
      if (entry.isDirectory()) return readTypeScriptTree(target);
      return entry.isFile() && entry.name.endsWith(".ts") ? [fs.readFileSync(target, "utf8")] : [];
    })
    .join("\n");
}

const source = [
  fs.readFileSync(".pi/extensions/cc-review.ts", "utf8"),
  readTypeScriptTree(".pi/extensions/cc-review"),
].join("\n");
const baseline = fs.readFileSync("workflow-baseline.md", "utf8");
const criteria = fs.readFileSync("workflow-optimization-criteria.md", "utf8");
const logAudit = fs.readFileSync("docs/plugin-log-surface-audit.md", "utf8");
const referenceSummary = fs.readFileSync("docs/log-display-reference-patterns.md", "utf8");

test("subprocess runner handles spawn errors and cancellation", () => {
  assert.match(source, /export async function runSubprocess\(/);
  assert.match(source, /proc\.on\("error", \(err: Error\) => \{/);
  assert.match(source, /failed to start: \$\{subprocessResult\.spawnError\.message\}/);
  assert.match(source, /signal\?\.aborted/);
  assert.match(source, /throw new Error\("Workflow aborted by user"\)/);
});

test("subprocess runner caps stream output and skips stdout retention when line parsing", () => {
  assert.match(source, /SUBPROCESS_OUTPUT_TRUNCATED_MARKER/);
  assert.match(source, /resolveSubprocessStreamMaxBytes/);
  assert.match(source, /retainStdoutBuffer = !onStdoutLine/);
  assert.match(source, /appendStreamText\(/);
});

test("cc_review rejects nested workflow invocation", () => {
  assert.match(source, /enterCcReviewWorkflowNest/);
  assert.match(source, /CC_REVIEW_NEST_DEPTH/);
  assert.match(source, /Nested invocation is blocked/);
});

test("built-in worker forbids cc_review dogfooding and full-suite runs", () => {
  assert.match(source, /NEVER invoke the cc_review tool/);
  assert.match(source, /test-name-pattern/);
});

test("slash command notifications tolerate headless contexts", () => {
  assert.doesNotMatch(source, /ctx\.ui\.notify/);
  assert.match(source, /ctx\?\.ui\?\.notify\?\./);
  assert.match(source, /ctx\?\.ui\?\.input/);
  assert.match(source, /ctx\?\.ui\?\.setStatus\?\./);
  assert.match(source, /ctx\?\.ui\?\.setWidget\?\./);
});

test("workflow summary preserves warning exit codes", () => {
  assert.match(source, /interface TaskResult/);
  assert.match(source, /const taskResults: TaskResult\[\] = \[\]/);
  assert.match(source, /executionCode: subagentResult\.code/);
  assert.match(source, /reviewCode: reviewProcessResult\.exitCode/);
  assert.match(source, /Completed with warnings \(subagent exit/);
});

test("planned task execution uses the subagent contract (via subprocess fallback because pi.toolManager.executeTool is not part of the public ExtensionAPI)", () => {
  // The previous design assumed `pi.toolManager.executeTool` would be exposed by
  // the pi runtime so this extension could delegate to the already-registered
  // `subagent` tool. That API never made it into pi's public ExtensionAPI
  // surface, so any invocation threw "pi.toolManager.executeTool is not
  // registered" and skipped every planned task. We now implement the same
  // subagent contract directly via a `pi --mode json -p --no-session`
  // subprocess, mirroring what `_subagent` does internally.
  //
  // Contract still upheld:
  //   * `getSubagentExecutor(pi)` returns a `SubagentToolExecutor`
  //   * Callers invoke it with the canonical params (agent / task / agentScope)
  //   * Result shape (`content` + `details.results[0]` + `isError`) is unchanged
  //   * Exit code is read via `getSubagentExitCode`
  assert.match(source, /function getSubagentExecutor\(pi: ExtensionAPI\): SubagentToolExecutor/);
  assert.match(source, /executeSubagentTool\(\n\s+"subagent",/);
  assert.match(source, /agent: "worker"/);
  assert.match(source, /agentScope: "user"/);
  assert.match(source, /function getSubagentExitCode\(result: SubagentToolResult\): number/);
  assert.match(source, /return result\.isError \? 1 : 0/);
  assert.match(source, /const resultCode = getSubagentExitCode\(result\)/);

  // Subprocess fallback must be present and must use pi's documented JSON
  // event-stream interface. These were previously forbidden because the design
  // tried to call the registered `subagent` tool directly; that path is now
  // proven impossible against the current pi public API.
  assert.match(source, /function getPiInvocation\(/);
  assert.match(source, /"--mode", "json"/);
  assert.match(source, /"--no-session"/);
  assert.match(source, /args\.push\("--thinking", agent\.thinking\)/);
  assert.match(source, /"--append-system-prompt"/);
  assert.match(source, /runPiAgentSubprocess\(/);
  assert.match(source, /event\?\.type === "message_end"/);

  // And the broken assumption (a runtime throw against the missing API) must be gone.
  assert.doesNotMatch(source, /throw new Error\([^)]*toolManager\.executeTool is not registered/);
  // The type annotation is allowed to stay because the executor now uses
  // `pi.toolManager.executeTool` opportunistically (if a future pi exposes it
  // or a test harness injects it) and falls back to a `pi --mode json`
  // subprocess otherwise. What must NOT come back is the unconditional throw.
  assert.match(source, /if \(toolManager\?\.executeTool\) \{/);
  assert.match(source, /return toolManager\.executeTool\.bind\(toolManager\);/);
});

test("baseline maps required execution paths to code locations", () => {
  assert.match(baseline, /Code-Tied Execution Path Map/);
  for (const requiredTerm of [
    "Triggers",
    "Subagent Creation / Dispatch",
    "Task Execution and Stream Collection",
    "Review and Result Collection",
    "Retries",
    "Cancellation and Errors",
  ]) {
    assert.match(baseline, new RegExp(requiredTerm.replaceAll("/", "\\/")));
  }
  assert.doesNotMatch(baseline, /currently unhandled/);
});

test("optimization criteria cover requested measurable outcomes", () => {
  for (const requiredTerm of [
    "fewer redundant",
    "clearer status reporting",
    "lower latency",
    "safer retries",
    "better failure recovery",
    "easier configuration",
  ]) {
    assert.match(criteria.toLowerCase(), new RegExp(requiredTerm));
  }

  assert.match(criteria, /maxPlanRetries`:\s*Default 3/);
  assert.match(criteria, /maxTaskExecutionRetries`:\s*Default 2/);
  assert.match(criteria, /SIGTERM[\s\S]*500ms[\s\S]*SIGKILL/);
  assert.match(criteria, /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), "cc-review-"\)\)/);
});

test("README type-check guidance uses compiler diagnostics terminology", () => {
  const readme = fs.readFileSync("README.md", "utf8");
  assert.match(readme, /zero TypeScript diagnostics/);
  assert.doesNotMatch(readme, /zero errors and zero warnings/);
  assert.doesNotMatch(readme, /SPawn/);
});

test("rename happy path: active extension metadata and docs use CC Review identity", () => {
  assert.match(source, /registerCommand\("cc-review"/);
  assert.match(source, /description: "Run CC Review to plan, execute via Pi subagents, and review either per task or once after all tasks\./);
  assert.match(source, /name: "cc_review"/);
  assert.match(source, /label: "CC Review"/);
  assert.match(source, /description: "Run CC Review: plan a goal, execute tasks in dependency-safe after-all batches or per-task order, then review\/fix either per task or once after all tasks\./);
  assert.match(source, /description: "The overarching goal for CC Review to accomplish using Codex planning and Pi subagents"/);
  assert.match(source, /customType: "cc-review-summary"/);
  assert.match(source, /"cc-review-widget"/);
  assert.match(source, /"cc-review-status"/);
  assert.match(source, /## 🏆 CC Review Orchestrator Report/);
  assert.match(source, /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), "cc-review-"\)\)/);
  assert.match(fs.readFileSync("README.md", "utf8"), /# CC Review Orchestrator/);
});

test("rename error path: old plugin identity is absent from active source and user-facing docs", () => {
  const activeText = [
    source,
    fs.readFileSync("README.md", "utf8"),
    baseline,
    criteria,
  ].join("\n");
  const oldIdentityPattern = new RegExp([
    ["Codex", "Workflow"].join("-"),
    ["Codex", "Workflow"].join(" "),
    ["codex", "workflow"].join("-"),
    ["codex", "workflow"].join("_"),
  ].join("|"));
  assert.doesNotMatch(activeText, oldIdentityPattern);
});

test("review provider configuration is typed, validated, and defaults to Codex", () => {
  assert.match(source, /type ReviewProvider = "codex" \| "claude"/);
  assert.match(source, /type ReviewProviderSource = "reviewProvider" \| "CC_REVIEW_PROVIDER"/);
  assert.match(source, /interface ReviewProviderConfig/);
  assert.match(source, /interface ReviewBackendFactory/);
  assert.match(source, /mode: "subprocess"/);
  assert.match(source, /const SUPPORTED_REVIEW_PROVIDERS: readonly ReviewProvider\[\] = \["codex", "claude"\]/);
  assert.match(source, /const REVIEW_BACKEND_FACTORIES: Record<ReviewProvider, ReviewBackendFactory>/);
  assert.match(source, /credentialEnvKeys: \["CODEX_API_KEY", "OPENAI_API_KEY"\]/);
  assert.match(source, /credentialEnvKeys: \["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"\]/);
  // Credentials are not preflighted; auth is delegated to the codex/claude CLIs.
  assert.doesNotMatch(source, /requireSelectedBackendCredentials/);
  assert.doesNotMatch(source, /Missing .* reviewer credentials/);
  assert.match(source, /reviewProvider:\s*\{\n\s+type: "string",\n\s+description: "Optional review backend/);
  assert.doesNotMatch(source, /reviewProvider:\s*\{\n\s+type: "string",\n\s+enum: \["codex", "claude"\]/);
  assert.match(source, /interface CcReviewExecuteParams \{\n\s+goal: string;\n\s+reviewProvider\?: string;\n\s+logLevel\?: string;\n\s+logSources\?: string;/);
  assert.match(source, /interface RunCcReviewWorkflowOptions \{\n\s+reviewProvider\?: string;\n\s+logLevel\?: string;\n\s+logSources\?: string;/);
  assert.match(source, /function normalizeReviewProvider\(rawProvider: string, providerSource: ReviewProviderSource\): ReviewProvider/);
  assert.match(source, /function initializeSelectedReviewBackend\(provider: ReviewProvider, env: NodeJS\.ProcessEnv = process\.env\): ReviewProviderConfig/);
  assert.match(source, /return REVIEW_BACKEND_FACTORIES\[provider\]\.initialize\(env\)/);
  assert.match(source, /function resolveReviewProviderConfig\(explicitProvider\?: string, env: NodeJS\.ProcessEnv = process\.env\): ReviewProviderConfig/);
  assert.match(source, /const providerSource(?:: ReviewProviderSource)? = explicitProvider !== undefined \? "reviewProvider" : "CC_REVIEW_PROVIDER"/);
  assert.match(source, /const rawProvider = explicitProvider !== undefined \? explicitProvider : env\.CC_REVIEW_PROVIDER/);
  assert.match(source, /const normalizedProvider = rawProvider === undefined \? "codex" : normalizeReviewProvider\(rawProvider, providerSource\)/);
  assert.match(source, /return initializeSelectedReviewBackend\(normalizedProvider, env\)/);
  assert.match(source, /rawProvider\.trim\(\)\.toLowerCase\(\)/);
  assert.match(source, /Invalid \$\{providerSource\} value/);
  assert.match(source, /Supported review providers: \$\{SUPPORTED_REVIEW_PROVIDERS\.join\(", "\)\}/);
  assert.match(source, /function parseCcReviewCommandArgs\(args: string\): \{ goal: string; reviewProvider\?: string; logLevel\?: string; logSources\?: string; reviewMode\?: string; reviewRepairRounds\?: number; taskTimeoutMs\?: number; (?:widgetLogLines\?: number; )?(?:checklistWindow\?: number; )?(?:concurrency\?: number; )?(?:logFile\?: string; )?error\?: string \}/);
  assert.match(source, /--\(\?:review-\)\?provider/);
  assert.match(source, /reviewProvider: params\.reviewProvider/);
  assert.match(source, /reviewProvider: parsedArgs\.reviewProvider/);
  assert.match(source, /const reviewProviderConfig = resolveReviewProviderConfig\(options\.reviewProvider\)/);
  assert.match(source, /buildArgs\(context: ReviewPromptContext\): string\[\]/);
  assert.match(source, /buildReviewPrompt\(task, intent\)/);
  assert.match(source, /reviewProviderConfig\.buildArgs\(\{ task \}\)/);
  assert.match(source, /reviewProviderConfig\.command/);
  assert.match(source, /reviewProviderConfig\.label/);
  assert.doesNotMatch(source, /reviewProviderConfig\.command,\n\s+codexReviewArgs/);
});

test("review timing supports per-task and after-all orchestration", () => {
  assert.match(source, /type ReviewMode = "per-task" \| "after-all"/);
  assert.match(source, /type ReviewModeSource = "reviewMode" \| "CC_REVIEW_MODE"/);
  assert.match(source, /export function resolveReviewMode\(/);
  assert.match(source, /return rawMode === undefined \? "after-all" : normalizeReviewMode\(rawMode, source\)/);
  assert.match(source, /reviewMode: params\.reviewMode/);
  assert.match(source, /reviewMode: parsedArgs\.reviewMode/);
  assert.match(source, /if \(reviewMode === "after-all"\) \{/);
  assert.match(source, /transitionToBatchReviewing\(\)/);
  assert.match(source, /const batchReviewTask: Task = \{/);
  // BATCH_REPAIR_LOOP label + continue are verified behaviorally by
  // cc-review-behavior.test.ts after-all review tests. The source-grep lock
  // is removed so the execution pipeline can be deduped (candidate #2).
  assert.match(source, /Queued "\$\{task\.title\}" for the final workflow review/);
});

test("command help and docs show explicit and environment Claude provider selection", () => {
  const readme = fs.readFileSync("README.md", "utf8");
  assert.match(source, /registerCommand\("cc-review"/);
  assert.match(source, /Use --provider claude or --provider codex to select the planner\+reviewer backend/);
  assert.match(source, /Pass reviewProvider as codex or claude/);
  assert.match(readme, /reviewProvider: "claude"/);
  assert.match(readme, /--provider claude/);
  assert.match(readme, /CC_REVIEW_PROVIDER=claude/);
  assert.match(readme, /Claude Code CLI/);
  assert.match(readme, /Supported review provider values are `codex` and `claude`/);
});

test("README documents CC Review installation and active plugin identity", () => {
  const readme = fs.readFileSync("README.md", "utf8");
  assert.match(readme, /installed as the \*\*CC Review\*\* plugin/);
  assert.match(readme, /\.pi\/extensions\/cc-review\.ts/);
  assert.match(readme, /Slash command: `\/cc-review <goal>`/);
  assert.match(readme, /Tool name for API\/tool calls: `cc_review`/);
  assert.match(readme, /Display label: `CC Review`/);
  assert.match(readme, /place the current `\.pi\/extensions\/cc-review\.ts` file/);
  assert.match(readme, /restart or reload Pi/);
});

test("README documents selected review setup, provider examples, and credentials", () => {
  const readme = fs.readFileSync("README.md", "utf8");
  assert.match(readme, /selects both the planner and reviewer backend/);
  assert.match(readme, /Review Timing/);
  assert.match(readme, /CC_REVIEW_PROVIDER=claude pi --mode json -p/);
  assert.match(readme, /claude -p/);
  assert.match(readme, /ensure `claude` is on `PATH`/);
  assert.match(readme, /Authentication is delegated entirely to that CLI's own login session/);
  assert.match(readme, /CODEX_API_KEY/);
  assert.match(readme, /OPENAI_API_KEY/);
  assert.match(readme, /ANTHROPIC_API_KEY/);
  assert.match(readme, /CLAUDE_API_KEY/);
  assert.match(readme, /CODEX_MODEL/);
  assert.match(readme, /CLAUDE_MODEL/);
  assert.match(readme, /unselected\* provider never block the workflow|unselected provider/);
});

test("README documents provider defaults and troubleshooting", () => {
  const readme = fs.readFileSync("README.md", "utf8");
  assert.match(readme, /Omitted option and unset environment variable: defaults to `codex` review/);
  assert.match(readme, /Empty, whitespace-only, or any other unsupported explicit\/environment value: fails fast with a clear invalid provider error/);
  assert.match(readme, /Missing CLI/);
  assert.match(readme, /Auth failures from the CLI/);
  assert.match(readme, /CC Review does not preflight credentials/);
  assert.match(readme, /empty, whitespace-only, and unsupported names fail with an invalid provider error such as `Invalid reviewProvider` or `Invalid CC_REVIEW_PROVIDER`/);
  assert.match(readme, /explicit `reviewProvider` or `--provider` values take precedence over `CC_REVIEW_PROVIDER`/);
  assert.match(readme, /provider selection applies to both planning and review/);
  assert.doesNotMatch(readme, /Unset or empty: defaults/);
});

test("README manual verification checklist covers install, default, Claude, marketplace, old-name search, and standard commands", () => {
  const readme = fs.readFileSync("README.md", "utf8");
  assert.match(readme, /### 2\.6\. Manual Verification Checklist/);
  for (const requiredTerm of [
    "Install/load smoke test",
    "copy `.pi/extensions/cc-review.ts` into a clean Pi workspace",
    "Command and tool discovery",
    "/cc-review <goal>",
    "`cc_review` with label `CC Review`",
    "Default review path",
    "`CC_REVIEW_PROVIDER` unset",
    "Claude review path",
    "`CC_REVIEW_PROVIDER=claude`",
    "mocked/test Claude credentials",
    "Marketplace/display metadata",
    "Old-name repository search",
    "Automated regression commands",
    "node tests/cc-review-static.test.mjs",
    "node --experimental-strip-types tests/cc-review-behavior.test.ts",
    "tsc --noEmit",
  ]) {
    assert.match(readme, new RegExp(requiredTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(readme, /Do not commit real credentials/);
  assert.match(readme, /rg -n "codex\[-_ \]workflow\|Codex\[- \]Workflow" \./);
  assert.match(readme, /historical migration notes\/tests/);
});

test("Claude review subprocess integration uses workspace-capable Claude Code", () => {
  assert.match(source, /command: "claude"/);
  assert.match(source, /function buildClaudeReviewArgs\([\s\S]*?intent: "inspect" \| "repair" = "repair"[\s\S]*?\): string\[\]/);
  assert.match(source, /"--dangerously-skip-permissions"/);
  assert.match(source, /"--no-session-persistence"/);
  assert.match(source, /"-p"/);
  assert.match(source, /CLAUDE_MODEL/);
  assert.match(source, /buildReviewPrompt\(task, intent\)/);
  assert.match(source, /runReviewerProcess\(\n\s+reviewProviderConfig\.label,\n\s+reviewProviderConfig\.command,\n\s+reviewArgs/);
  // P0-3: claude planner+reviewer stream NDJSON for live observability.
  assert.match(source, /"--output-format", "stream-json"/);
  assert.match(source, /"--include-partial-messages"/);
  assert.match(source, /"--verbose"/);
  // P0-3: codex planner+reviewer stream JSONL for live observability.
  assert.match(source, /"--json"/);
  assert.doesNotMatch(source, /runClaudeReviewClient/);
  assert.doesNotMatch(source, /\/v1\/messages/);
  assert.doesNotMatch(source, /globalThis\.fetch/);
});

test("review plugin inspection handoff documents current CC Review names and historical old-name context", () => {
  const note = fs.readFileSync("docs/review-plugin-entrypoints.md", "utf8");

  for (const requiredTerm of [
    "Current review execution entry points",
    "reviewProviderConfig.buildArgs",
    "resolveReviewProviderConfig",
    "Provider/model assumptions",
    "Current plugin naming surfaces",
    "Historical old-name inventory retained intentionally",
    "Existing tests and missing coverage",
  ]) {
    assert.match(note, new RegExp(requiredTerm.replaceAll("(", "\\(").replaceAll(")", "\\)").replaceAll("\"", "\\\"")));
  }

  for (const currentName of [
    "cc-review",
    "cc_review",
    "CC Review",
    "cc-review-widget",
    "cc-review-status",
    "cc-review-summary",
  ]) {
    assert.match(note, new RegExp(currentName));
  }

  assert.match(note, /old names are retained in this document only as historical notes/);
  assert.match(note, /No compatibility aliases were kept/);
  assert.match(note, /Claude review argument selection is present/);
  assert.match(note, /<cwd>\/\.pi\/agents/);
  assert.match(note, /~\/\.pi\/agent\/agents/);
  assert.match(note, /CC_REVIEW_PROVIDER/);
  assert.match(note, /No package\.json/);
  assert.match(note, /No CI configuration/);
  assert.match(note, /provider selection tests/);
});

test("provider selection flow implementation note documents current control path and explicit option", () => {
  const note = fs.readFileSync("docs/review-plugin-entrypoints.md", "utf8");

  for (const requiredTerm of [
    "Current provider selection control path",
    "the explicit provider option is now implemented in runtime behavior",
    "`CcReviewParams` accepts required `goal` plus optional `reviewProvider`",
    "`pi.registerTool(...).execute(...)` forwards `params.goal` and `params.reviewProvider`",
    "`pi.registerCommand(\"cc-review\", ...)` parses optional `--provider <value>`, `--provider=<value>`, `--review-provider <value>`, or `--review-provider=<value>` flags",
    "Existing invocations without the option still work unchanged",
    "`resolveReviewProviderConfig(explicitProvider, env = process.env)` is the sole review-provider defaulting and validation point",
    "uses an explicit `reviewProvider`/slash flag value first",
    "otherwise reads `env.CC_REVIEW_PROVIDER`",
    "returns Codex when neither source is set",
    "normalizes configured values with `trim().toLowerCase()`",
    "throws `Invalid reviewProvider` or `Invalid CC_REVIEW_PROVIDER` for empty, whitespace-only, or unsupported values",
    "`buildClaudeReviewArgs(task, env = process.env)` separately reads `CLAUDE_MODEL`",
    "There is no package manifest, extension manifest, project config, or settings file",
    "`applyAgentModelOverride(...)` reads `~/.pi/agent/settings.json`",
    "these affect task execution subagents, not planner/reviewer provider selection",
    "`runCcReviewWorkflow(...)` calls `resolveReviewProviderConfig(options.reviewProvider)` once at workflow start",
    "invalid explicit/environment provider values fail before planner or reviewer subprocesses are spawned",
    "Planning uses the normalized provider",
    "Codex writes schema-constrained output",
    "Claude returns JSON on stdout",
    "`REVIEW_BACKEND_FACTORIES` and `reviewProviderConfig.buildArgs({ task })`",
    "Review uses `.pi/extensions/cc-review.ts` `REVIEW_BACKEND_FACTORIES`",
    "in `after-all` mode it runs once",
    "`runProcess(reviewProviderConfig.label, reviewProviderConfig.command, reviewArgs, ...)`",
    "provider and review-timing insertion points are implemented",
    "handler parses provider, log-level, and `--review-mode` flags",
    "forwards `reviewProvider`, `logLevel`, and `reviewMode`",
    "accepts an explicit provider value before falling back to `CC_REVIEW_PROVIDER`",
    "sole review-provider defaulting and validation point",
  ]) {
    assert.match(note, new RegExp(requiredTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(source, /const rawProvider = explicitProvider !== undefined \? explicitProvider : env\.CC_REVIEW_PROVIDER/);
  assert.match(source, /return initializeSelectedReviewBackend\(normalizedProvider, env\)/);
  assert.match(source, /return REVIEW_BACKEND_FACTORIES\[provider\]\.initialize\(env\)/);
  assert.match(source, /`Invalid \$\{providerSource\} value/);
  assert.match(source, /const reviewProviderConfig = resolveReviewProviderConfig\(options\.reviewProvider\)/);
});

test("baseline documents the current subagent execution contract", () => {
  assert.match(baseline, /Standard `subagent` tool/);
  assert.match(baseline, /pi\.toolManager\.executeTool\("subagent"/);
  assert.match(baseline, /getSubagentExecutor\(pi\)/);
  assert.match(baseline, /agent: "worker"/);
  assert.match(baseline, /agentScope: "user"/);
  assert.match(baseline, /"acceptanceCriteria": \{ "type": "string" \}/);
  assert.match(baseline, /"required": \["title", "description", "acceptanceCriteria"\]/);
  assert.match(baseline, /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), "cc-review-"\)\)/);
});

test("baseline and criteria document configured review provider instead of Codex-only review", () => {
  assert.match(baseline, /Per-task \*\*review\/code patching\*\* \(Phase 2B\) uses the configured reviewer selected by `CC_REVIEW_PROVIDER`/);
  assert.match(baseline, /Spawns configured reviewer \(`codex exec` or `claude`\)/);
  assert.match(baseline, /Planner and configured-reviewer subprocesses are tracked as detached process groups/);
  assert.doesNotMatch(baseline, /per-task \*\*review\/code patching\*\* \(Phase 2B\)\. This is an internal provider choice/);
  assert.doesNotMatch(baseline, /Spawns: `codex exec` instructing code review/);

  assert.match(criteria, /planner\/configured-reviewer subprocess stdout\/stderr streams/);
  assert.match(criteria, /no configured reviewer subprocess is called/);
  assert.match(criteria, /`codex exec` for planning and `codex exec` or `claude -p` for review/);
  assert.doesNotMatch(criteria, /no `codex exec` review is called/);
});

test("baseline no longer claims current planned tasks use raw pi subprocesses", () => {
  assert.doesNotMatch(baseline, /currently spawns a plain `pi` executor/);
  assert.doesNotMatch(baseline, /Planned subtasks are dispatched as raw/);
  assert.doesNotMatch(baseline, /cc-review` builds `\["--mode", "json", "-p", "--no-session"/);
  assert.doesNotMatch(baseline, /manually spawns generic raw `pi` subprocesses/);
  assert.doesNotMatch(baseline, /merely logs a warning and \*\*unconditionally continues\*\*/);
  assert.doesNotMatch(baseline, /Creating temp files directly in `os\.tmpdir\(\)` with a basic `Math\.random\(\)`/);
});

test("optimization criteria define verifiable audits without false-positive shortcuts", () => {
  assert.match(criteria, /A narrow `grep -E 'spawn\\\("pi"'/);
  assert.match(criteria, /misses indirect invocations such as `spawn\(piInvocation\.command, piInvocation\.args, \.\.\.\)`/);
  assert.match(criteria, /`ctx\.hasUI` check alone is not sufficient/);
  assert.match(criteria, /at least 50% lower than Task 1 initialization time/);
  assert.match(criteria, /0 net files attributable to that run/);
});

test("normalized log entry contract is explicit", () => {
  assert.match(source, /type CcReviewLogSeverity = "debug" \| "info" \| "warning" \| "error"/);
  assert.match(source, /export interface CcReviewLogEntry \{[\s\S]*id: string;[\s\S]*timestamp: string;[\s\S]*severity: CcReviewLogSeverity;[\s\S]*source: string;[\s\S]*pluginId: string;[\s\S]*message: string;[\s\S]*details\?: unknown;[\s\S]*sequence: number;[\s\S]*\}/);
  assert.match(source, /type CcReviewLogInput = string \| CcReviewStructuredLogInput/);
  assert.match(source, /const DEFAULT_LOG_SOURCE = "cc-review"/);
  assert.match(source, /const DEFAULT_LOG_PLUGIN_ID = "cc-review"/);
  assert.match(source, /const SUPPORTED_LOG_SEVERITIES: readonly CcReviewLogSeverity\[\] = \["debug", "info", "warning", "error"\]/);
  assert.match(source, /function normalizeLogSeverity\(rawSeverity: unknown\): CcReviewLogSeverity/);
  assert.match(source, /export function normalizeCcReviewLogEntry\(\n\s+input: CcReviewLogInput,/);
  assert.match(source, /const timestamp = normalizeOptionalText\(/);
  assert.match(source, /const source = normalizeOptionalText\(structuredInput\.source, options\.defaultSource \?\? DEFAULT_LOG_SOURCE\)/);
  assert.match(source, /const pluginId = normalizeOptionalText\(structuredInput\.pluginId, options\.defaultPluginId \?\? DEFAULT_LOG_PLUGIN_ID\)/);
  assert.match(source, /const id = suppliedId \|\| `cc-review-log-\$\{sequence\}-\$\{stableLogHash\(\[timestamp, severity, source, pluginId, message\]\)\}`/);
});

test("display log path uses normalized log entries", () => {
  // Internal state representation (liveLogs, logSequence, the log() closure
  // body, and the widget's filterCcReviewLogEntries call shape) is verified
  // behaviorally by cc-review-behavior.test.ts: it runs the full workflow,
  // captures widget snapshots + onUpdate deltas, and asserts log entries
  // render with correct severity/source/timestamp. The former source-grep
  // locks on closure bodies are intentionally removed so the state machine
  // can be deepened (candidate #1) without breaking this suite.
  assert.match(source, /const liveLogs: CcReviewLogEntry\[\]/);
  assert.match(source, /normalizeCcReviewLogEntry\(/);
  assert.match(source, /renderCcReviewLogEntry\(entry/);
  assert.match(source, /filterCcReviewLogEntries\(/);
  assert.doesNotMatch(source, /const liveLogs: string\[\] = \[\]/);
  assert.doesNotMatch(source, /liveLogs\.push\(cleaned\)/);
});

test("display log path renders severity-aware normalized log entries", () => {
  assert.match(source, /const LOG_SEVERITY_RENDER_META: Record<CcReviewLogSeverity, \{ icon: string; label: string \}> = \{/);
  for (const requiredSeverity of ["debug", "info", "warning", "error"]) {
    assert.match(source, new RegExp(`${requiredSeverity}: \\{ icon: ".+", label: "(?:DEBUG|INFO|WARN|ERROR)" \\}`));
  }
  assert.match(source, /function formatCcReviewLogTimestamp\(timestamp: string\): string/);
  assert.match(source, /return `\$\{isoTimestamp\.slice\(0, 10\)\} \$\{isoTimestamp\.slice\(11, 19\)\}Z`/);
  assert.match(source, /function wrapLogMessage\(message: string, maxWidth: number\): string\[\]/);
  assert.match(source, /export function renderCcReviewLogEntry\(\n\s+entry: CcReviewLogEntry,/);
  assert.match(source, /const prefix = `\$\{severityMeta\.icon\} \$\{severityMeta\.label\.padEnd\(5\)\} \$\{contextParts\.join\(" "\)\}: `/);
  // continuationPrefix now uses visible column width (prefixVisibleWidth) rather
  // than raw JS string length, so CJK/wide characters are counted correctly.
  assert.match(source, /const continuationPrefix = " "\.repeat\(prefixVisibleWidth\)/);
  assert.match(source, /function renderCcReviewLogEntries\(entries: readonly CcReviewLogEntry\[\], options: CcReviewLogRenderOptions = \{\}\): string\[\]/);
  assert.doesNotMatch(source, /registerMessageRenderer\("cc-review-log"/);
});

test("severity rollup helper exists and is wired into the widget", () => {
  // Helper is exported as a pure function reusing the existing severity contract.
  assert.match(source, /export function summarizeLogSeverities\(\s*\n?\s*entries: readonly CcReviewLogEntry\[\] \| null \| undefined,/);
  // Reuses the existing supported-severities allowlist instead of redefining it.
  assert.match(source, /SUPPORTED_LOG_SEVERITIES\.includes\(entry\.severity as CcReviewLogSeverity\)/);
  // Width safety via truncateForWidget on both the empty-input and populated paths.
  assert.match(source, /return truncateForWidget\("\\u03a3 no logs", maxWidth\)/);
  assert.match(source, /return truncateForWidget\(body, maxWidth\)/);
  // Severity rollup is merged into the phase line via formatPhaseSeverityLine.
  // The wiring is verified behaviorally by cc-review-behavior.test.ts widget
  // rendering tests. Source-grep lock on the specific widget call-site removed
  // so widget state shape can change with the state machine (candidate #1).
  assert.match(source, /export function formatPhaseSeverityLine\(/);
  assert.match(source, /formatPhaseSeverityLine\(/);
  assert.match(source, /truncateWidgetLine\(/);
});

test("subprocess stream lines are formatted before logging", () => {
  assert.match(source, /export function formatSubprocessStreamLine\(/);
  assert.match(source, /export function createSubprocessStreamLogger\(/);
  assert.match(source, /plannerStdoutLogger\.write\(chunk\)/);
  assert.match(source, /plannerStderrLogger\.write\(data\)/);
  assert.match(source, /stdoutLogger\.write\(data\)/);
  assert.match(source, /stderrLogger\.write\(data\)/);
  assert.match(source, /plannerStdoutLogger\.flush\(\)/);
  assert.match(source, /stdoutLogger\.flush\(\)/);
});

test("subprocess stream severity inference is exported and wired into planner/reviewer handlers", () => {
  assert.match(source, /export function inferSubprocessStreamSeverity\(/);
  // Severity resolution uses adapter hints with heuristic fallback.
  // The wiring is verified behaviorally by cc-review-behavior.test.ts
  // createSubprocessStreamLogger tests. Source-grep on exact formatting
  // removed so the adapter layer can carry severity hints (#5).
  assert.match(source, /inferSubprocessStreamSeverity\(/);
});

test("widget full-log line is width-truncated", () => {
  assert.match(source, /export function truncatePersistedLogPathForWidget\(/);
  assert.match(source, /truncatePersistedLogPathForWidget\(/);
  // The Full log line rendering is verified behaviorally by
  // cc-review-behavior.test.ts widget truncation tests. Source-grep lock on
  // the specific theme.fg call nesting removed so widget internals can
  // change with the state machine (candidate #1).
});

test("widget UI helpers export colored lines, adaptive width, and status progress", () => {
  assert.match(source, /export function buildCcReviewWidgetLines\(/);
  assert.match(source, /export function buildCcReviewStatusText\(/);
  assert.match(source, /export function truncateWidgetLine\(/);
  assert.match(source, /export function formatCcReviewSummaryHeadline\(/);
  assert.match(source, /export function countCcReviewTaskOutcomesFromSummary\(/);
  assert.match(source, /ctx\.ui\.setWidget\("cc-review-widget"/);
  assert.match(source, /buildCcReviewStatusText\(/);
  // Widget render callback wiring is verified behaviorally by
  // cc-review-behavior.test.ts which captures widget snapshots at various
  // widths. Source-grep lock on the render callback shape removed so widget
  // state shape can change with the state machine (candidate #1).
  assert.match(source, /buildCcReviewWidgetLines\(/);
});

test("preview helper is wired into the widget goal and task title path", () => {
  // Helper is exported as a pure, character-bounded preview.
  assert.match(source, /export function previewWidgetText\(\s*\n?\s*value: string \| null \| undefined,\s*\n?\s*maxLength: number = WIDGET_PREVIEW_MAX_LENGTH_DEFAULT/);
  // Collapses any run of whitespace/newlines/tabs into a single space.
  assert.match(source, /\.replace\(\/\\s\+\/g, " "\)\.trim\(\)/);
  // Single-char ellipsis on overflow (mirrors truncateForWidget).
  assert.match(source, /return collapsed\.slice\(0, cap - 1\) \+ "\\u2026"/);
  // Exposes a default cap as a named constant so callers can reason about it.
  assert.match(source, /export const WIDGET_PREVIEW_MAX_LENGTH_DEFAULT = 80/);

  // Widget goal line and task title path use previewWidgetText. The wiring
  // is verified behaviorally by cc-review-behavior.test.ts preview/truncation
  // tests. Source-grep locks on the specific call-site args removed so widget
  // state shape can change with the state machine (candidate #1).
  assert.match(source, /previewWidgetText\(.*goal/);
  assert.match(source, /previewWidgetText\(.*title/);

  // Full goal must remain available in the persisted summary markdown.
  assert.match(source, /summaryMarkdown \+= `\*\*Goal:\*\* \$\{goal\}\\n\\n`/);
});

test("filter helper is exported and wired into the widget live-log slice", () => {
  // Defined severity-rank ordering: debug < info < warning < error.
  assert.match(
    source,
    /const LOG_SEVERITY_RANK: Record<CcReviewLogSeverity, number> = \{\s*\n\s*debug: 0,\s*\n\s*info: 1,\s*\n\s*warning: 2,\s*\n\s*error: 3,\s*\n\s*\};/
  );
  // Public options shape with optional min severity + source allow-list.
  assert.match(
    source,
    /export interface FilterCcReviewLogEntriesOptions \{[\s\S]*?minSeverity\?: CcReviewLogSeverity;[\s\S]*?sources\?: readonly string\[\];[\s\S]*?\}/
  );
  // Pure helper signature, defaults to pass-through when no options are given.
  assert.match(
    source,
    /export function filterCcReviewLogEntries\(\s*\n\s*entries: readonly CcReviewLogEntry\[\] \| null \| undefined,\s*\n\s*options: FilterCcReviewLogEntriesOptions \| undefined = \{\}\s*\n?\s*\): CcReviewLogEntry\[\]/
  );
  // Helper is invoked in the widget live-log path. The specific call-site
  // formatting is verified behaviorally by cc-review-behavior.test.ts widget
  // rendering tests. Source-grep lock removed so widget state shape can
  // change with the state machine deepening (candidate #1).
  assert.match(source, /filterCcReviewLogEntries\(/);
  assert.match(source, /filteredLiveLogs/);
  assert.match(source, /\.slice\(-tailLength\)/);
});

test("log-level and log-sources resolvers are exported with the documented signature and wired through workflow + parsers", () => {
  // Resolver export with the documented signature.
  assert.match(
    source,
    /export interface ResolveCcReviewLogLevelOptions \{[\s\S]*?flag\?: string;[\s\S]*?env\?: NodeJS\.ProcessEnv;[\s\S]*?\}/
  );
  assert.match(
    source,
    /export interface ResolveCcReviewLogLevelResult \{[\s\S]*?level: CcReviewLogSeverity;[\s\S]*?source: "flag" \| "env" \| "default";[\s\S]*?invalidInput\?: \{ source: "flag" \| "env"; raw: string \};[\s\S]*?\}/
  );
  assert.match(
    source,
    /export function resolveCcReviewLogLevel\(\s*\n\s*options: ResolveCcReviewLogLevelOptions = \{\}\s*\n\s*\): ResolveCcReviewLogLevelResult/
  );
  // Reads CC_REVIEW_LOG_LEVEL exactly once, from the supplied env (default process.env).
  assert.match(source, /env\.CC_REVIEW_LOG_LEVEL/);
  // Aliases warn -> warning and fatal -> error are accepted.
  assert.match(source, /trimmed === "warn"\) return "warning"/);
  assert.match(source, /trimmed === "fatal"\) return "error"/);

  // Log sources resolver export with the documented signature.
  assert.match(
    source,
    /export interface ResolveCcReviewLogSourcesOptions \{[\s\S]*?flag\?: string;[\s\S]*?env\?: NodeJS\.ProcessEnv;[\s\S]*?\}/
  );
  assert.match(
    source,
    /export interface ResolveCcReviewLogSourcesResult \{[\s\S]*?sources: string\[\] \| undefined;[\s\S]*?source: "flag" \| "env" \| "default";[\s\S]*?invalidInput\?: \{ source: "flag" \| "env"; raw: string \};[\s\S]*?\}/
  );
  assert.match(
    source,
    /export function resolveCcReviewLogSources\(\s*\n\s*options: ResolveCcReviewLogSourcesOptions = \{\}\s*\n\s*\): ResolveCcReviewLogSourcesResult/
  );
  // Reads CC_REVIEW_LOG_SOURCES exactly once, from the supplied env (default process.env).
  assert.match(source, /env\.CC_REVIEW_LOG_SOURCES/);

  // Workflow resolves the level once at startup and reuses it downstream.
  // The call-site formatting is verified behaviorally by cc-review-behavior.test.ts
  // which calls resolveCcReviewLogLevel directly and tests flag>env>default.
  // Source-grep lock on call-site formatting removed so config can be
  // table-driven (candidate #4).
  assert.match(source, /resolveCcReviewLogLevel\(/);
  assert.match(source, /resolvedLogLevel/);
  // Workflow resolves the sources once at startup and reuses it downstream.
  assert.match(source, /resolveCcReviewLogSources\(/);
  assert.match(source, /resolvedLogSources/);
  // Invalid input emits exactly one warning log entry, NOT a throw.
  assert.match(
    source,
    /if \(logLevelResolution\.invalidInput\) \{[\s\S]*?log\(\{[\s\S]*?severity: "warning",[\s\S]*?\}\);[\s\S]*?\}/
  );
  // Invalid logSources input emits exactly one warning log entry, NOT a throw.
  assert.match(
    source,
    /if \(logSourcesResolution\.invalidInput\) \{[\s\S]*?log\(\{[\s\S]*?severity: "warning",[\s\S]*?\}\);[\s\S]*?\}/
  );

  // Slash command parser strips --log-level <value> and --log-level=<value>.
  assert.match(source, /const hasLogLevelFlag = \/\(\?:\^\|\\s\)--log-level\(\?:=\|\\s\|\$\)\//);
  assert.match(source, /token\.match\(\/\^--log-level=\(\.\*\)\$\/\)/);
  assert.match(source, /if \(token === "--log-level"\)/);

  // Slash command parser strips --log-sources <value> and --log-sources=<value>.
  assert.match(source, /const hasLogSourcesFlag = \/\(\?:\^\|\\s\)--log-sources\(\?:=\|\\s\|\$\)\//);
  assert.match(source, /token\.match\(\/\^--log-sources=\(\.\*\)\$\/\)/);
  assert.match(source, /if \(token === "--log-sources"\)/);

  // Tool schema and propagation paths expose logLevel and logSources.
  assert.match(source, /logLevel:\s*\{\s*\n\s+type: "string",\s*\n\s+description: "Optional minimum log severity/);
  assert.match(source, /logSources:\s*\{\s*\n\s+type: "string",\s*\n\s+description: "Optional comma-separated list of compact-surface log sources/);
  assert.match(
    source,
    /interface CcReviewExecuteParams \{\n\s+goal: string;\n\s+reviewProvider\?: string;\n\s+logLevel\?: string;\n\s+logSources\?: string;\n\s+reviewMode\?: string;\n\s+reviewRepairRounds\?: number;\n\s+taskTimeoutMs\?: number;\n(?:\s+widgetLogLines\?: number;\n)?(?:\s+checklistWindow\?: number;\n)?(?:\s+concurrency\?: number;\n)?(?:\s+concurrencyLimit\?: number;\n)?(?:\s+logFile\?: string;\n)?\}/
  );
  assert.match(
    source,
    /interface RunCcReviewWorkflowOptions \{[\s\S]*?reviewProvider\?: string;[\s\S]*?logLevel\?: string;[\s\S]*?logSources\?: string;[\s\S]*?reviewMode\?: string;[\s\S]*?validationCommands\?:/
  );
  assert.match(source, /logLevel: params\.logLevel/);
  assert.match(source, /logLevel: parsedArgs\.logLevel/);
  assert.match(source, /logSources: params\.logSources/);
  assert.match(source, /logSources: parsedArgs\.logSources/);
  assert.match(source, /--concurrency <n> or --concurrency-limit <n>/);
  assert.match(source, /concurrency: parsedArgs\.concurrency/);

  assert.match(
    source,
    /const passesLogSources = resolvedLogSources === undefined \|\| resolvedLogSources\.includes\(entry\.source\);/
  );
  // Persisted writes happen BEFORE the onUpdate filter gate so workflow-logs.jsonl
  // is unfiltered. This ordering invariant is verified behaviorally by
  // cc-review-behavior.test.ts which runs the workflow and checks that the
  // persisted log file contains all entries while onUpdate deltas are filtered.
  // Source-grep lock on the specific persist→gate code layout removed so the
  // log path can be restructured with the state machine (candidate #1).
  assert.match(source, /appendPersistedLogEntry\(/);
  assert.match(source, /passesLogLevel/);
  assert.match(source, /passesLogSources/);
  assert.match(source, /renderCcReviewLogEntry\(entry/);
});

test("workflow steps are instrumented with lightweight structured logging and trace events", () => {
  assert.match(source, /function emitTrace\(/);
  assert.match(source, /emitTrace\(ctx, "workflow_start"/);
  assert.match(source, /emitTrace\(ctx, "subagent_assignment",/);
  assert.match(source, /emitTrace\(ctx, "tool_execution_start"/);
  assert.match(source, /emitTrace\(ctx, "tool_execution_end"/);
  assert.match(source, /emitTrace\(ctx, "retry",/);
  assert.match(source, /emitTrace\(ctx, "completion"/);
  assert.match(source, /emitTrace\(ctx, "failure"/);
});

test("trace payloads stay minimal and avoid sensitive task content", () => {
  const traceCalls = [...source.matchAll(/emitTrace\([\s\S]*?\n\s*\}\);/g)].map((match) => match[0]).join("\n");
  assert.doesNotMatch(traceCalls, /goalPreview/);
  assert.doesNotMatch(source, /emitTrace\([^)]*taskTitle/);
  assert.match(source, /goalLength: goal\.length/);
  assert.match(source, /taskIndex: i/);
});

test("subprocess executions emit structured start and end trace events without arguments", () => {
  assert.match(source, /source: "subprocess"/);
  assert.match(source, /emitTrace\(traceCtx, "tool_execution_start", \{ label, command, source: "subprocess" \}\)/);
  assert.match(source, /exitCode: resolvedCode \?\? \(resolvedSignal \? 1 : 0\)/);
  assert.match(source, /phase: timedOut \? "subprocess_timeout" : "subprocess_exit"/);
  assert.doesNotMatch(source, /emitTrace\([^)]*args/s);
});

test("workflow state transitions explicitly reset, activate, and complete task progress", () => {
  // The transition contract (planning → executing → reviewing → complete) is
  // verified behaviorally by cc-review-behavior.test.ts: it runs the full
  // workflow with mocked subprocesses and captures widget/status snapshots
  // showing each phase. The former source-grep locks on closure arrow-fn
  // bodies (transitionToPlanning = () => { currentTaskIndex = -1; etc.) are
  // intentionally removed so the state machine can be deepened into a
  // WorkflowState module (candidate #1) without breaking this suite.
  assert.match(source, /transitionToPlanning/);
  assert.match(source, /setPlannedTasks/);
  assert.match(source, /transitionToExecuting/);
  assert.match(source, /transitionToReviewing/);
  assert.match(source, /transitionToComplete/);
  assert.match(source, /const getTaskOrThrow = \(index: number\) => \{/);
  assert.match(source, /throw new Error\(`Invalid workflow task index \$\{index\}`\)/);
});

test("subagent task definition and schema incorporate acceptance criteria", () => {
  assert.match(source, /export interface Task \{\n\s+title: string;\n\s+description: string;\n\s+acceptanceCriteria: string;\n\s+\/\*\* 1-based task numbers this task depends on\. Missing means preserve ordered handoff semantics\. \*\/\n\s+dependsOn\?: number\[\];\n\}/);
  assert.match(source, /acceptanceCriteria: \{ type: "string" \}/);
  assert.match(source, /dependsOn:\s*\{\n\s+type: "array",\n\s+items: \{ type: "integer", minimum: 1 \}/);
  assert.match(source, /required: \["title", "description", "acceptanceCriteria"\]/);
});

test("parent workflow context is summarized and formatted in subagent prompt", () => {
  assert.match(source, /function summarizeParentContext\(goal: string\): string/);
  // buildSubagentTaskPrompt now accepts an optional priorTaskHandoff arg so
  // generators on Task N>=2 receive a bounded handoff from earlier tasks.
  assert.match(
    source,
    /function buildSubagentTaskPrompt\(\s*task: Task,\s*parentContextSummary: string,\s*priorTaskHandoff[^)]*\): string/
  );
  assert.match(source, /const summarizedParentContext = summarizeParentContext\(goal\);/);
  // The runtime now derives a structured handoff from accumulated taskResults
  // and forwards it as the third argument when building the per-task prompt.
  assert.match(source, /priorTaskHandoffFromResults\(taskResults\)/);
  assert.match(source, /const batchPriorResults = taskResults\.filter\(/);
  assert.match(source, /priorTaskHandoffFromResults\(batchPriorResults\)/);
  assert.match(source, /buildAfterAllExecutionBatches\(tasks\)/);
  assert.match(
    source,
    /const subagentPrompt = buildSubagentTaskPrompt\(task, summarizedParentContext, priorHandoff\);/
  );
  assert.match(source, /Parent Workflow Context \(Summary\): \$\{parentContextSummary\}/);
  assert.match(source, /Acceptance Criteria:\\n\$\{task\.acceptanceCriteria\}/);
  assert.match(source, /Verify the acceptance criteria before reporting completion/);
});

test("workflow validates subagent outputs before merging", () => {
  assert.match(source, /function validateSubagentOutput\(/);
  assert.match(source, /const validation = validateSubagentOutput\(result, task\)/);
  assert.match(source, /appendUnique\(unresolvedItemsForFailedTask, validation\.unresolvedItems \|\| \[validationError\]\)/);
  assert.match(source, /unresolvedItems = unresolvedItemsForFailedTask\.length > 0 \? \[\.\.\.unresolvedItemsForFailedTask\] : undefined/);
  assert.match(source, /validationError = validation\.error || "Output validation failed"/);
});

test("workflow handles partial results and surfaces unresolved items deterministically", () => {
  assert.match(source, /function buildSummaryReport\(/);
  assert.match(source, /results\.push\(\{\n\s+title: tasks\[j\]\.title,\n\s+description: tasks\[j\]\.description,\n\s+executionCode: -1,\n\s+reviewCode: -1,\n\s+status: "skipped",\n\s+\}\)/);
  assert.match(source, /summaryMarkdown \+= `### ⚠️ Unresolved Items\\n\\n`/);
  assert.match(source, /allUnresolved\.push\(`Task Skipped: "\$\{taskResult\.title\}" - Description: \$\{taskResult\.description\}`\)/);
  assert.match(source, /allUnresolved\.push\(`Task Failed: "\$\{taskResult\.title\}" - Error: Subagent exited with code \$\{taskResult\.executionCode\}`\)/);
  assert.match(source, /allUnresolved\.push\(`Task Validation Failed: "\$\{taskResult\.title\}" - Reason: \$\{taskResult\.validationError\}`\)/);
  assert.match(source, /if \(err instanceof WorkflowError\)/);
  assert.match(source, /const summary = appendPersistedLogPathToSummary\(\s*\n?\s*buildSummaryReport\(goal, taskResults, tasks(?:,\s*\{[^}]*\})?\),/);
  assert.match(source, /throw new WorkflowError\(err\.message, summary, buildCcReviewSummaryMeta\(taskResults(?:,\s*\{[^}]*\})?\)\);/);
});

test("subagent failures are retried with structured feedback instead of thrown immediately", () => {
  assert.match(source, /let retryFeedback: string \| undefined = undefined/);
  assert.match(source, /const attemptPrompt = retryFeedback/);
  assert.match(source, /Previous attempt feedback:/);
  assert.match(source, /Resolve the previous attempt's errors or unresolved items before reporting completion/);
  assert.match(source, /result = \{\n\s+content: \[\{ type: "text", text: errorMessage \}\],\n\s+details: \{ results: \[\{ exitCode: 1, errorMessage \}\] \},\n\s+isError: true,\n\s+\}/);
  assert.doesNotMatch(source, /phase: "subagent_execution"[\s\S]{0,300}throw err/);
});

test("validation preserves concrete unresolved details from error states", () => {
  assert.match(source, /interface SubagentValidation/);
  assert.match(source, /unresolvedItems: \["No result returned from subagent"\]/);
  assert.match(source, /unresolvedItems: \[error\]/);
  assert.match(source, /error: unresolvedItems\.length > 0 \? "Subagent reported unresolved work" : undefined/);
  assert.match(source, /appendUnique\(unresolvedItemsForFailedTask, validation\.unresolvedItems \|\| \[validationError\]\)/);
});

test("planning and temporary outputs are isolated and deterministic across retries", () => {
  assert.match(source, /const tempDir = fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), "cc-review-"\)\)/);
  assert.match(source, /const schemaPath = path\.join\(tempDir, "workflow-schema\.json"\)/);
  assert.match(source, /const outputPath = path\.join\(tempDir, "workflow-output\.json"\)/);
  assert.match(source, /fs\.rmSync\(outputPath, \{ force: true \}\)/);
  assert.match(source, /fs\.rmSync\(tempDir, \{ recursive: true, force: true \}\)/);
  assert.doesNotMatch(source, /Math\.random\(\)/);
});

test("transient retry and fallback policy is implemented", () => {
  assert.match(source, /function isTransientError\(/);
  assert.match(source, /"rate limit"/);
  assert.match(source, /"too many requests"/);
  assert.match(source, /"timeout"/);
  assert.match(source, /maxTransientRetries = 3/);
  assert.match(source, /Math\.pow\(2, transientAttempt\) \* 1000/);
  assert.match(source, /Math\.pow\(2, attempt\) \* 1000/);
  assert.match(source, /Suggested Actionable Steps to Recover/);
});

test("improved cancellation and timeout behavior features are present", () => {
  // Test delay helper
  assert.match(source, /function delay\(/);
  assert.match(source, /const timer = setTimeout\(/);
  assert.match(source, /reject\(new Error\("Workflow aborted by user"\)\)/);

  // Test detached and process groups in shared runSubprocess
  assert.match(source, /export async function runSubprocess\(/);
  assert.match(source, /detached: true/);
  assert.match(source, /timeoutMs\?: number/);
  assert.match(source, /timeoutTimer = setTimeout\(/);
  assert.match(source, /sendSignalToProcessGroup\(proc, "SIGTERM"\)/);
  assert.match(source, /sendSignalToProcessGroup\(proc, "SIGKILL"\)/);

  // Test process group termination in onAbort
  assert.match(source, /process\.kill\(-proc\.pid, "SIGTERM"\)/);
  assert.match(source, /process\.kill\(-pid, "SIGKILL"\)/);

  // Test subagent task timeout (now configurable, was hardcoded 300000)
  assert.match(source, /const taskAbortController = new AbortController\(\)/);
  assert.match(source, /const subagentTimeoutMs = resolvedTaskTimeoutMs/);
  assert.match(source, /taskAbortController\.abort\(new Error\(`Subagent execution timed out/);

  // Test pending state marking consistently when cancellation happens
  assert.match(source, /status\?: TaskStatus/);
  assert.match(source, /"review_blocked"/);
  assert.match(source, /status: "cancelled"/);
  assert.match(source, /const isCancelled =[\s\S]*signal\?\.aborted/);
});

test("regression test for successful multi-step execution", () => {
  // Verifies that multi-step execution loop progresses through generated tasks.
  // The transitionToExecuting/Reviewing call sites and loop structure are
  // verified behaviorally by cc-review-behavior.test.ts multi-task workflow
  // tests. Source-grep locks removed so execution pipeline can be deduped (#2).
  assert.match(source, /for\s*\(let\s+i\s*=\s*0;\s*i\s*<\s*tasks\.length;\s*i\+\+\)/);
  assert.match(source, /recordTaskResult\(\{/);
  assert.match(source, /buildSummaryReport\(goal, taskResults, tasks(?:,\s*\{[^}]*\})?\)/);
});

test("regression test for subagent failure", () => {
  // Verifies that execution failures are detected and retries are scheduled
  assert.match(source, /const\s+maxTaskExecutionRetries\s*=\s*2/);
  assert.match(source, /for\s*\(let\s+attempt\s*=\s*1;\s*attempt\s*<=\s*maxTaskExecutionAttempts;\s*attempt\+\+\)/);
  assert.match(source, /retryFeedback\s*=/);
  assert.match(source, /resultCode\s*===\s*0/);
});

test("regression test for partial result aggregation", () => {
  // Verifies that skipped, failed, and cancelled tasks are formatted in the summary
  assert.match(source, /status:\s*"skipped"/);
  assert.match(source, /summaryMarkdown\s*\+=\s*`### ⚠️ Unresolved Items\\n\\n`/);
  assert.match(source, /In Task/);
  assert.match(source, /Suggested Actionable Steps to Recover/);
});

test("regression test for retry exhaustion", () => {
  // Verifies that limits are imposed on retries before propagating failures
  assert.match(source, /const\s+maxTaskExecutionRetries\s*=\s*2/);
  assert.match(source, /const\s+maxTaskExecutionAttempts\s*=\s*maxTaskExecutionRetries\s*\+\s*1/);
  assert.match(source, /const\s+maxPlanRetries\s*=\s*3/);
  assert.match(source, /throw\s+new\s+Error\(errorMsg\)/);
  assert.match(source, /Task execution failed unrecoverably/);
});

test("regression test for timeout/cancellation", () => {
  // Verifies that timeouts and abort signals terminate processes and update status
  assert.match(source, /timeoutTimer\s*=\s*setTimeout\(/);
  assert.match(source, /sendSignalToProcessGroup\(proc,\s*"SIGTERM"\)/);
  assert.match(source, /sendSignalToProcessGroup\(proc,\s*"SIGKILL"\)/);
  assert.match(source, /status:\s*"cancelled"/);
});

test("log surface audit documents relevant files and current flow", () => {
  for (const requiredTerm of [
    "CC Review Plugin Log Surface Audit",
    ".pi/extensions/cc-review.ts",
    "emitTrace(ctx, event, payload = {})",
    "runCcReviewWorkflow(...)",
    "log(message)",
    "runProcess(label, command, args, onStdout, onStderr, timeoutMs?)",
    "runPiAgentSubprocess(...)",
    "getSubagentExecutor(...)",
    "ctx.ui.setWidget(\"cc-review-widget\"",
    "ctx.ui.setStatus(\"cc-review-status\"",
    "onUpdate",
    "buildSummaryReport(goal, taskResults, tasks)",
    "workflow-trace.jsonl",
    "process.stderr",
    "pi.sendMessage",
    "registerMessageRenderer(\"cc-review-summary\"",
    "workflow-logs.jsonl` stores normalized",
    "No `renderCall`, `renderResult`, browser console, web panel",
    "headless",
  ]) {
    assert.match(logAudit, new RegExp(requiredTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("log surface audit documents data model and issues", () => {
  for (const requiredTerm of [
    "type",
    "event",
    "timestamp",
    "goalLength",
    "reviewProvider",
    "role",
    "agent",
    "taskIndex",
    "attempt",
    "command",
    "label",
    "source",
    "exitCode",
    "signal",
    "status",
    "tasksCount",
    "timeoutMs",
    "error",
    "stderr",
    "errorMessage",
    "TaskResult",
    "Rolling display loses context",
    "`onUpdate` is noisy and repetitive",
    "Human logs and trace logs are split",
    "Potential sensitive or overly verbose display",
    "No dedicated renderer/panel",
    "Subprocess buffering is partial",
  ]) {
    assert.match(logAudit, new RegExp(requiredTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("log surface audit documents addressed log-display gaps", () => {
  for (const requiredTerm of [
    "Addressed gaps (log-display increment)",
    "`onUpdate` is noisy and repetitive",
    "**Addressed**",
    "previewWidgetText",
    "CC_REVIEW_LOG_LEVEL",
    "cc-review-summary",
    "workflow-logs.jsonl` persists the full normalized human-readable log",
  ]) {
    assert.match(logAudit, new RegExp(requiredTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("README documents log display controls and compact widget affordances", () => {
  const readme = fs.readFileSync("README.md", "utf8");
  for (const requiredTerm of [
    "### 2.7. Log Display and Observability",
    "CC_REVIEW_LOG_LEVEL",
    "--log-level",
    "Severity rollup line",
    "Redacted goal/title previews",
    "Summary message renderer",
    "workflow-logs.jsonl",
    "never filtered",
    "warn` maps to `warning",
    "Log sources (`--log-sources` / `CC_REVIEW_LOG_SOURCES`)",
    "planner",
    "subagent",
    "reviewer",
    "cc-review",
    "The tool parameter is `logSources`",
    "Explicit values override the environment",
    "invalid values show all sources with one warning",
    "persisted logs remain unfiltered",
  ]) {
    assert.match(readme, new RegExp(requiredTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("user-facing slash-command and tool help contain detailed log-source controls documentation", () => {
  assert.match(source, /registerCommand\("cc-review"/);
  assert.match(source, /--log-sources/);
  assert.match(source, /CC_REVIEW_LOG_SOURCES/);
  assert.match(source, /planner,subagent,reviewer,cc-review/);
  assert.match(source, /Explicit values override the environment, invalid values show all sources with one warning, and persisted logs remain unfiltered/);

  assert.match(source, /registerTool\(\{/);
  assert.match(source, /logSources/);
  assert.match(source, /CC_REVIEW_LOG_SOURCES/);
  assert.match(source, /Explicit logSources override the environment, invalid values show all sources with one warning, and persisted logs remain unfiltered/);

  assert.match(source, /logSources:\s*\{\s*\n\s+type: "string",\s*\n\s+description: "Optional comma-separated list of compact-surface log sources to keep \(planner, subagent, reviewer, cc-review\)\. Omit to use CC_REVIEW_LOG_SOURCES or show all\. Explicit values override the environment, invalid values show all sources with one warning, and persisted logs remain unfiltered\."/);
});

test("cc-review-summary message renderer is registered behind capability guards", () => {
  assert.match(source, /function registerCcReviewSummaryRenderer\(pi: ExtensionAPI\)/);
  assert.match(source, /typeof pi\.registerMessageRenderer !== "function"\) return/);
  assert.match(source, /registerMessageRenderer\("cc-review-summary"/);
  assert.match(source, /classifyCcReviewSummary\(content\)/);
  assert.match(source, /expand for full report/);
  assert.match(source, /export function classifyCcReviewSummary\(summary: string\): CcReviewSummaryBadge/);
});

test("log surface audit documents existing tests and missing coverage", () => {
  for (const requiredTerm of [
    "Existing tests touching this area",
    "tests/cc-review-static.test.mjs",
    "tests/cc-review-behavior.test.ts",
    "workflow-trace.jsonl` is created",
    "Missing or weak coverage",
    "No direct assertions on the exact `cc-review-widget` line content",
    "No direct tests for `onUpdate` cadence",
    "No tests for log redaction/truncation",
    "No schema/contract test for `workflow-trace.jsonl`",
    "runtime behavior remains unchanged",
  ]) {
    assert.match(logAudit, new RegExp(requiredTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("reference summary names inspected Pi plugins and behavior notes", () => {
  for (const requiredTerm of [
    "CC Review Log Display Reference Patterns",
    "Screenshots were not captured",
    "written notes",
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/todo.ts",
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/plan-mode/index.ts",
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/message-renderer.ts",
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/truncated-tool.ts",
    "Severity styling",
    "Timestamps",
    "Grouping and progress",
    "Filtering and search",
    "Copy/export affordances",
    "Collapsed details",
    "Empty states",
    "Error states",
    "Width and verbosity control",
    "No matches found",
    "No todos yet",
  ]) {
    assert.match(referenceSummary, new RegExp(requiredTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("reference summary prioritizes adoptable CC Review log patterns", () => {
  for (const requiredTerm of [
    "Prioritized patterns to adopt for CC Review",
    "Introduce typed UI log events before rendering",
    "timestamp",
    "severity",
    "source",
    "phase",
    "taskIndex",
    "attempt",
    "Render severity/source badges",
    "Keep the default view compact, with expandable details",
    "Group logs by phase/task/attempt",
    "Persist/export the full bounded log",
    "workflow-trace.jsonl",
    "Add explicit empty, partial, warning, failed, timeout, and cancelled states",
    "Apply width-safe truncation and redaction in UI logs",
    "Add lightweight filters after the event model exists",
    "planner/reviewer/subagent streams",
    "stderr",
  ]) {
    assert.match(referenceSummary, new RegExp(requiredTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("reference summary records intentionally deferred patterns and scope guard", () => {
  for (const requiredTerm of [
    "does **not** change CC Review runtime logging behavior",
    "Patterns intentionally not adopted yet",
    "Full-screen modal log viewer",
    "Replacing the entire footer",
    "Animated global working indicators",
    "Unbounded expanded raw stdout/stderr",
    "Browser console or web panel logging",
    "Complex searchable filter console",
    "Persisting every human log line as conversation-visible session entries",
    "documentation-only scope",
  ]) {
    assert.match(referenceSummary, new RegExp(requiredTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(source, /setWidget\?\.\("cc-review-widget"/);
  assert.doesNotMatch(source, /registerMessageRenderer\("cc-review-log"/);
});

test("planner reuses shared JSON extraction helper", () => {
  assert.doesNotMatch(source, /function extractJsonObject\(/);
  // Planner now extracts assistant text from the stream first (P0-3), then
  // uses the shared JSON extraction helper on the recovered text.
  assert.match(source, /extractAssistantTextFromStream\(plannerStdoutBuffer\)/);
  assert.match(source, /extractBalancedJsonObject\(plannerText,\s*"first"\)/);
});

test("configurable task checklist window size is exported and integrated", () => {
  // Test resolver and options interfaces are exported with expected signatures
  assert.match(
    source,
    /export interface ResolveCcReviewChecklistWindowOptions \{[\s\S]*?flag\?: any;[\s\S]*?env\?: NodeJS\.ProcessEnv;[\s\S]*?\}/
  );
  assert.match(
    source,
    /export interface ResolveCcReviewChecklistWindowResult \{[\s\S]*?window: number;[\s\S]*?source: "flag" \| "env" \| "default";[\s\S]*?invalidInput\?: \{ source: "flag" \| "env"; raw: string \};[\s\S]*?\}/
  );
  assert.match(
    source,
    /export function resolveCcReviewChecklistWindow\(/
  );

  // Workflow resolves the checklist window once at startup. Call-site
  // formatting is verified behaviorally by cc-review-behavior.test.ts.
  // Source-grep lock removed so config can be table-driven (candidate #4).
  assert.match(source, /resolveCcReviewChecklistWindow\(/);

  // Default checklist window size is 8
  assert.match(source, /const WIDGET_CHECKLIST_WINDOW = 8;/);

  // computeChecklistWindow handles maxVisible and defaults to WIDGET_CHECKLIST_WINDOW
  assert.match(
    source,
    /export function computeChecklistWindow\([\s\S]*?maxVisible: number = WIDGET_CHECKLIST_WINDOW/
  );

  // buildCcReviewWidgetLines uses the resolved checklist window size
  assert.match(
    source,
    /state\.resolvedChecklistWindow \?\? WIDGET_CHECKLIST_WINDOW/
  );
});

test("collapseConsecutiveLogEntries is exported and integrated in widget path", () => {
  assert.match(
    source,
    /export function collapseConsecutiveLogEntries\(/
  );
  assert.match(
    source,
    /const collapsed = collapseConsecutiveLogEntries\(filteredLiveLogs\);/
  );
});
