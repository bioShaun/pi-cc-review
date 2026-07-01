// ---------------------------------------------------------------------------
// Completion mutation guard (P2-1).
//
// Borrowed from pi-subagents' `completion-guard.ts`. For implementation tasks,
// a worker can return a plausible completion response without actually
// mutating files. This guard inspects the task text and the observed
// subagent events to infer whether mutation was expected but not attempted.
//
// Design:
//   * Infer whether a task expects mutation from the agent name and task text.
//   * Inspect streamed assistant/tool events for edit/write or mutating bash calls.
//   * If mutation was expected but no mutation was attempted, mark completion
//     as suspicious and feed that back through the retry loop.
//   * Review-only and research/scout-style tasks do NOT trigger the guard.
//
// CC Review adaptation: the guard works on a simplified event shape
// (`GuardedToolEvent`) rather than pi-internal `Message[]`, so it can be
// unit-tested without the pi runtime and integrated into the execution
// phase's event stream.
// ---------------------------------------------------------------------------

const REVIEW_ONLY_PATTERNS = [
  /\breview only\b/i,
  /\bsuggest fixes only\b/i,
  /\bonly return findings\b/i,
  /\breturn findings only\b/i,
];

const REVIEWER_REQUIRED_EDIT_PATTERNS = [
  /\bmust\s+(?:edit|modify|change|fix|patch|apply)\b/i,
  /\brequired\s+to\s+(?:edit|modify|change|fix|patch|apply)\b/i,
  /\bregardless\s+of\s+findings\b/i,
  /\balways\s+(?:edit|modify|change|fix|patch|apply)\b/i,
  /\bapply\s+(?:the\s+)?fix(?:es)?\s+directly\b/i,
  /\bmake\s+(?:the\s+)?code\s+changes\b/i,
];

const EXPLICIT_NO_EDIT_PATTERNS = [
  /\bdo not edit\b/i,
  /\bdon't edit\b/i,
  /\bdo not modify\b/i,
  /\bdo not change files\b/i,
];

const SCOPED_NO_EDIT_CONSTRAINT_PATTERNS = [
  /\bdo not edit files?\s+outside\b/i,
  /\bdo not edit\s+outside\b/i,
  /\bdo not edit\s+unrelated files?\b/i,
  /\bdo not change\s+unrelated files?\b/i,
  /\bdo not modify\s+unrelated files?\b/i,
];

const RESEARCH_AGENT_PATTERNS = [
  /\binvestigate\b/i,
  /\bscout\b/i,
  /\bresearch(?:er)?\b/i,
];

const WORKER_IMPLEMENTATION_PATTERNS = [
  /\b(?:implement|fix|edit|modify|patch|refactor|delete)\b/i,
  /\b(?:update|add|remove|replace|create)\b(?!\s+(?:(?:a|an|the)\s+)?(?:report|summary|findings?)(?:\b|$))/i,
  /\bapply\s+(?:the\s+)?(?:changes?|fix(?:es)?|patch)\b/i,
  /\bmake\s+(?:the\s+)?changes\b/i,
  /\bdo those fixes\b/i,
];

const GENERAL_IMPLEMENTATION_PATTERNS = [
  /\b(?:implement|fix|edit|modify|patch|refactor)\b/i,
  /\bapply\s+(?:the\s+)?(?:changes?|fix(?:es)?|patch)\b/i,
  /\bmake\s+(?:the\s+)?changes\b/i,
  /\bdo those fixes\b/i,
  /\b(?:update|add|remove|replace|delete|create)\s+(?:the\s+)?(?:file|files|code|source|implementation|test|tests|component|function|module|class|method|logic|import|imports|readme|docs?|changelog|package\.json|config|manifest|extension|prompt|command)\b/i,
];

const READ_ONLY_BUILTIN_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "fetch_content",
  "get_search_content",
]);

/** Simplified tool-event shape the guard inspects. */
export interface GuardedToolEvent {
  /** Tool name: "edit", "write", "bash", "read", etc. */
  name: string;
  /** Tool arguments (for bash, looks at `command`). */
  arguments?: Record<string, unknown>;
}

export interface CompletionMutationGuardInput {
  agent: string;
  task: string;
  /** Observed tool events from the subagent's event stream. */
  toolEvents: GuardedToolEvent[];
  /** Agent's declared tools (from frontmatter). Optional. */
  tools?: string[];
}

export interface CompletionMutationGuardResult {
  /** Whether the task text implies file mutation is expected. */
  expectedMutation: boolean;
  /** Whether the subagent attempted a mutating tool call. */
  attemptedMutation: boolean;
  /** Whether the guard triggered (expected but not attempted). */
  triggered: boolean;
  /** Human-readable explanation when triggered. */
  reason?: string;
}

function stripFrameworkInstructions(task: string): string {
  return task
    .split("\n")
    .filter((line) => !/^\s*\[(?:Write to|Read from):/i.test(line))
    .filter((line) => !/^\s*(?:Create and maintain progress at:|Update progress at:|\*\*Output:\*\*|Write your findings to(?: exactly this path)?:|This path is authoritative for this run\.|Ignore any other output filename or output path mentioned elsewhere)/i.test(line))
    .join("\n");
}

function stripScopedNoEditConstraints(task: string): string {
  let stripped = task;
  for (const pattern of SCOPED_NO_EDIT_CONSTRAINT_PATTERNS) {
    stripped = stripped.replace(pattern, " ");
  }
  return stripped;
}

function declaresOnlyReadOnlyTools(tools: string[] | undefined): boolean {
  return tools !== undefined
    && tools.length > 0
    && tools.every((tool) => READ_ONLY_BUILTIN_TOOLS.has(tool));
}

/**
 * Infer whether a task expects the worker to mutate files.
 * Borrowed from pi-subagents' `expectsImplementationMutation`.
 */
export function expectsImplementationMutation(agent: string, task: string): boolean {
  const taskText = stripFrameworkInstructions(task);
  const taskTextWithoutScopedConstraints = stripScopedNoEditConstraints(taskText);
  if (REVIEW_ONLY_PATTERNS.some((pattern) => pattern.test(taskTextWithoutScopedConstraints))) return false;
  if (EXPLICIT_NO_EDIT_PATTERNS.some((pattern) => pattern.test(taskTextWithoutScopedConstraints))) return false;

  if (RESEARCH_AGENT_PATTERNS.some((pattern) => pattern.test(agent))) return false;
  if (/\breviewer\b/i.test(agent)) return REVIEWER_REQUIRED_EDIT_PATTERNS.some((pattern) => pattern.test(taskText));

  const workerIntent = agent === "worker" && WORKER_IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(taskText));
  if (workerIntent) return true;

  return GENERAL_IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(taskText));
}

const MUTATING_BASH_PATTERNS = [
  /\b(?:rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln)\b/,
  /\b(?:cat|tee|dd)\b.*>/,
  /\btee\b/,  // tee always writes to a file
  /\b(?:sed|awk|perl)\b.*-i/,
  /\b(?:git)\s+(?:add|commit|push|pull|merge|rebase|reset|checkout|rm|mv)\b/,
  /\b(?:npm|pnpm|yarn|npx)\s+(?:install|uninstall|add|remove|run|exec)\b/,
  /\b(?:pip|python|python3)\s+(?:install|uninstall)\b/,
  /\b(?:cargo)\s+(?:add|remove|install|build|run|test)\b/,
  /\b(?:make)\b/,
  />\s*\/?/,  // redirect to file
];

/**
 * Classify whether a bash command is mutating (writes files, installs
 * packages, runs git mutations, etc.).
 */
export function isMutatingBashCommand(command: string): boolean {
  if (!command || typeof command !== "string") return false;
  return MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Inspect observed tool events for any mutating tool call.
 * Borrowed from pi-subagents' `hasMutationToolCall`, adapted to the
 * simplified `GuardedToolEvent` shape.
 */
export function hasMutationToolCall(toolEvents: GuardedToolEvent[]): boolean {
  for (const event of toolEvents) {
    if (event.name === "edit" || event.name === "write") return true;
    if (event.name === "bash" || event.name === "execute_command") {
      const args = event.arguments;
      const command = typeof args?.command === "string" ? args.command : "";
      if (command && isMutatingBashCommand(command)) return true;
    }
  }
  return false;
}

/**
 * Evaluate the completion mutation guard.
 * Returns `{ triggered: true }` when mutation was expected but not attempted.
 */
export function evaluateCompletionMutationGuard(
  input: CompletionMutationGuardInput,
): CompletionMutationGuardResult {
  const expectedMutation = declaresOnlyReadOnlyTools(input.tools)
    ? false
    : expectsImplementationMutation(input.agent, input.task);
  const attemptedMutation = hasMutationToolCall(input.toolEvents);
  const triggered = expectedMutation && !attemptedMutation;
  return {
    expectedMutation,
    attemptedMutation,
    triggered,
    reason: triggered
      ? "Task expects file mutation (implement/fix/edit) but no edit/write/mutating-bash tool call was observed. The worker may have returned a completion response without making changes."
      : undefined,
  };
}
