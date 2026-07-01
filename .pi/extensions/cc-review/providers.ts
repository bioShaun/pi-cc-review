import type { Task } from "./workflow/dependencies.ts";

export type ReviewProvider = "codex" | "claude";
type ReviewProviderSource = "reviewProvider" | "CC_REVIEW_PROVIDER";
export type ReviewMode = "per-task" | "after-all";
type ReviewModeSource = "reviewMode" | "CC_REVIEW_MODE";

interface ReviewPromptContext {
  task: Task;
  intent?: "inspect" | "repair";
}

export interface ReviewProviderConfig {
  provider: ReviewProvider;
  mode: "subprocess";
  command: string;
  label: string;
  warningName: string;
  credentialEnvKeys: readonly string[];
  modelEnvKey?: string;
  buildArgs(context: ReviewPromptContext): string[];
}

interface ReviewBackendFactory {
  provider: ReviewProvider;
  credentialEnvKeys: readonly string[];
  modelEnvKey?: string;
  initialize(env?: NodeJS.ProcessEnv): ReviewProviderConfig;
}

const SUPPORTED_REVIEW_PROVIDERS: readonly ReviewProvider[] = ["codex", "claude"];

function buildReviewPrompt(task: Task, intent: "inspect" | "repair" = "repair"): string {
  const intentInstructions = intent === "inspect"
    ? [
        "This is an inspection-only review phase.",
        "Do not modify workspace files or attempt repairs.",
        "Report every actionable issue with status unfixed so the orchestrator can start a separate repair phase.",
        "Do not include postFixValidation.",
      ]
    : [
        "This is a repair phase.",
        "Fix the supplied review findings directly in-place in the workspace files and verify your fixes.",
        "Include postFixValidation with status passed or failed and brief evidence when fixes are applied.",
      ];
  return [
    `Review the changes in the workspace for task: '${task.title}'.`,
    `Task description: '${task.description}'.`,
    "Identify bugs, compile/syntax errors, incomplete features, or logical flaws.",
    ...intentInstructions,
    "End your final response with one JSON object (prose allowed above it) using this shape:",
    '{"verdict":"ship|ship_with_warnings|block","summary":"...","findings":[{"priority":"P0|P1|P2|P3","confidence":0.0,"file":"optional/path","line":1,"message":"...","status":"fixed|unfixed|not_applicable"}],"postFixValidation":{"status":"passed|failed","evidence":"..."}}',
    "postFixValidation is required when any finding has status fixed.",
  ].join(" ");
}

const REVIEW_BACKEND_FACTORIES: Record<ReviewProvider, ReviewBackendFactory> = {
  codex: {
    provider: "codex",
    credentialEnvKeys: ["CODEX_API_KEY", "OPENAI_API_KEY"],
    modelEnvKey: "CODEX_MODEL",
    initialize: (env: NodeJS.ProcessEnv = process.env) => {
      // Auth is handled by the codex CLI itself (login session or env). No preflight gate.
      const credentialEnvKeys = ["CODEX_API_KEY", "OPENAI_API_KEY"] as const;
      return {
        provider: "codex",
        mode: "subprocess",
        command: "codex",
        label: "Codex reviewer",
        warningName: "codex review",
        credentialEnvKeys,
        modelEnvKey: "CODEX_MODEL",
        buildArgs: ({ task, intent }) => buildCodexReviewArgs(task, env, intent),
      };
    },
  },
  claude: {
    provider: "claude",
    credentialEnvKeys: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
    modelEnvKey: "CLAUDE_MODEL",
    initialize: (env: NodeJS.ProcessEnv = process.env) => {
      // Auth is handled by the claude CLI itself (Claude Code login or env). No preflight gate.
      const credentialEnvKeys = ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"] as const;
      return {
        provider: "claude",
        mode: "subprocess",
        command: "claude",
        label: "Claude reviewer",
        warningName: "claude review",
        credentialEnvKeys,
        modelEnvKey: "CLAUDE_MODEL",
        buildArgs: ({ task, intent }) => buildClaudeReviewArgs(task, env, intent),
      };
    },
  },
};

export function readTrimmedEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function buildCodexReviewArgs(
  task: Task,
  env: NodeJS.ProcessEnv = process.env,
  intent: "inspect" | "repair" = "repair"
): string[] {
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    // Stream JSONL events to stdout for live observability (P0-3). Without
    // this, codex buffers all output and the user sees nothing for the entire
    // review duration. The final text is recovered from the stream via
    // extractAssistantTextFromStream.
    "--json",
  ];
  const model = readTrimmedEnv(env, "CC_REVIEW_REVIEWER_MODEL") ?? readTrimmedEnv(env, "CODEX_MODEL");
  if (model) {
    args.push("--model", model);
  }
  args.push(buildReviewPrompt(task, intent));
  return args;
}

function buildClaudeReviewArgs(
  task: Task,
  env: NodeJS.ProcessEnv = process.env,
  intent: "inspect" | "repair" = "repair"
): string[] {
  const args = [
    "-p",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    // Stream NDJSON events to stdout for live observability (P0-3). Without
    // this, `claude -p` buffers all output and flushes only at the end, so
    // the user sees nothing for the entire review duration. The final text is
    // recovered from the stream via extractAssistantTextFromStream.
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
  ];
  const model = readTrimmedEnv(env, "CC_REVIEW_REVIEWER_MODEL") ?? readTrimmedEnv(env, "CLAUDE_MODEL");
  if (model) {
    args.push("--model", model);
  }
  args.push(buildReviewPrompt(task, intent));
  return args;
}

export function resolvePlannerModelEnv(env: NodeJS.ProcessEnv = process.env, provider: ReviewProvider = "codex"): string | undefined {
  const roleModel = readTrimmedEnv(env, "CC_REVIEW_PLANNER_MODEL");
  if (roleModel) return roleModel;
  return provider === "claude" ? readTrimmedEnv(env, "CLAUDE_MODEL") : readTrimmedEnv(env, "CODEX_MODEL");
}

export function resolveReviewerModelEnv(env: NodeJS.ProcessEnv = process.env, provider: ReviewProvider = "codex"): string | undefined {
  const roleModel = readTrimmedEnv(env, "CC_REVIEW_REVIEWER_MODEL");
  if (roleModel) return roleModel;
  return provider === "claude" ? readTrimmedEnv(env, "CLAUDE_MODEL") : readTrimmedEnv(env, "CODEX_MODEL");
}

function normalizeReviewProvider(rawProvider: string, providerSource: ReviewProviderSource): ReviewProvider {
  const normalizedProvider = rawProvider.trim().toLowerCase();
  if (SUPPORTED_REVIEW_PROVIDERS.includes(normalizedProvider as ReviewProvider)) {
    return normalizedProvider as ReviewProvider;
  }

  throw new Error(
    `Invalid ${providerSource} value "${rawProvider}". Supported review providers: ${SUPPORTED_REVIEW_PROVIDERS.join(", ")}.`
  );
}

function initializeSelectedReviewBackend(provider: ReviewProvider, env: NodeJS.ProcessEnv = process.env): ReviewProviderConfig {
  return REVIEW_BACKEND_FACTORIES[provider].initialize(env);
}

export function resolveReviewProviderConfig(explicitProvider?: string, env: NodeJS.ProcessEnv = process.env): ReviewProviderConfig {
  const providerSource: ReviewProviderSource = explicitProvider !== undefined ? "reviewProvider" : "CC_REVIEW_PROVIDER";
  const rawProvider = explicitProvider !== undefined ? explicitProvider : env.CC_REVIEW_PROVIDER;
  const normalizedProvider = rawProvider === undefined ? "codex" : normalizeReviewProvider(rawProvider, providerSource);
  return initializeSelectedReviewBackend(normalizedProvider, env);
}

function normalizeReviewMode(rawMode: string, source: ReviewModeSource): ReviewMode {
  const normalized = rawMode.trim().toLowerCase();
  if (normalized === "per-task" || normalized === "after-all") {
    return normalized;
  }
  throw new Error(
    `Invalid ${source} value "${rawMode}". Supported review modes: per-task, after-all.`
  );
}

export function resolveReviewMode(
  explicitMode?: string,
  env: NodeJS.ProcessEnv = process.env
): ReviewMode {
  const source: ReviewModeSource = explicitMode !== undefined ? "reviewMode" : "CC_REVIEW_MODE";
  const rawMode = explicitMode !== undefined ? explicitMode : env.CC_REVIEW_MODE;
  return rawMode === undefined ? "after-all" : normalizeReviewMode(rawMode, source);
}
