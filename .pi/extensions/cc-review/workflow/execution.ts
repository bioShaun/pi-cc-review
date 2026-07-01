import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

import type { Task } from "./dependencies.ts";
import type { SubagentStructuredReport, TaskStatus, ReviewVerdict } from "../structured.ts";
import type { SubagentToolExecutor, SubagentToolResult, TaskResult, ExtensionAPI } from "./types.ts";
import { delay, isTransientError, stripAnsi } from "./util.ts";
import { runSubprocess } from "../subprocess.ts";
import { clipSubprocessLogText } from "./stream-format.ts";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");

// Helper to summarize the parent workflow goal/context rather than copying wholesale
export function summarizeParentContext(goal: string): string {
  const clean = goal.trim();
  if (clean.length <= 150) {
    return clean;
  }
  // Try to split on sentence boundaries
  const sentences = clean.split(/[.!?。！？]\s+/);
  let summary = "";
  for (const s of sentences) {
    const hasSentenceEnd =
      s.endsWith(".") ||
      s.endsWith("?") ||
      s.endsWith("!") ||
      s.endsWith("。") ||
      s.endsWith("！") ||
      s.endsWith("？");
    const sentence = hasSentenceEnd ? `${s} ` : `${s}. `;
    if ((summary + sentence).length > 150) {
      if (!summary) {
        summary = s.substring(0, 147) + "...";
      }
      break;
    }
    summary += sentence;
  }
  return summary.trim();
}
export interface PriorTaskHandoffOptions {
  /** Total handoff size cap. Defaults to 4096 chars. */
  maxSize?: number;
  /** Maximum number of prior tasks to include (most recent kept). Defaults to 6. */
  maxTasks?: number;
  /** Per-task summary character cap. Defaults to 400. */
  perTaskSummaryChars?: number;
  /** Per-task filesChanged cap. Defaults to 12. */
  perTaskMaxFiles?: number;
  /** Per-task unresolvedItems cap. Defaults to 8. */
  perTaskMaxUnresolved?: number;
}

export interface PriorTaskHandoffInput {
  title: string;
  status?: TaskStatus;
  effectiveVerdict?: ReviewVerdict;
  structuredReport?: SubagentStructuredReport;
  // NOTE: deliberately NOT typed to receive raw `output`, reviewer stdout/stderr,
  // or `reviewResult.findings`. Callers should pass only structured fields.
}

const PRIOR_HANDOFF_TRUNCATION_MARKER = "… (truncated)";
const PRIOR_HANDOFF_HEADER = "Prior Tasks (Handoff):";

function clipString(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return value.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function buildPriorTaskHandoff(
  priorTasks: readonly PriorTaskHandoffInput[],
  options: PriorTaskHandoffOptions = {}
): string {
  if (!Array.isArray(priorTasks) || priorTasks.length === 0) return "";
  const maxSize = Math.max(64, options.maxSize ?? 4096);
  const maxTasks = Math.max(1, options.maxTasks ?? 6);
  const perTaskSummaryChars = Math.max(40, options.perTaskSummaryChars ?? 400);
  const perTaskMaxFiles = Math.max(1, options.perTaskMaxFiles ?? 12);
  const perTaskMaxUnresolved = Math.max(1, options.perTaskMaxUnresolved ?? 8);

  // Keep the most recent N tasks if the caller passed too many — recent context
  // is more relevant for the next task. The original ordering of the kept slice
  // is preserved so Task indices read in chronological order.
  const tooMany = priorTasks.length > maxTasks;
  const visible = tooMany ? priorTasks.slice(priorTasks.length - maxTasks) : priorTasks.slice();
  const droppedCount = priorTasks.length - visible.length;

  const blocks: string[] = [];
  for (let i = 0; i < visible.length; i++) {
    const t = visible[i];
    if (!t || typeof t !== "object") continue;
    const title = clipString(collapseWhitespace(String(t.title ?? "(untitled task)")), 120);
    const verdict = t.effectiveVerdict ?? t.status ?? "unknown";
    const report = t.structuredReport;
    const reportStatus = report?.status ?? "unknown";
    const summarySource = report?.summary ? collapseWhitespace(report.summary) : "(no structured summary)";
    const summary = clipString(summarySource, perTaskSummaryChars);
    const files = (report?.filesChanged ?? []).filter(
      (f: string) => typeof f === "string" && f.length > 0
    );
    const filesShown = files.slice(0, perTaskMaxFiles).map((f: string) => clipString(f, 120));
    const filesOmitted = Math.max(0, files.length - filesShown.length);
    const unresolved = (report?.unresolvedItems ?? []).filter(
      (u: string) => typeof u === "string" && u.length > 0
    );
    const unresolvedShown = unresolved
      .slice(0, perTaskMaxUnresolved)
      .map((u: string) => clipString(collapseWhitespace(u), 200));
    const unresolvedOmitted = Math.max(0, unresolved.length - unresolvedShown.length);
    // Index reflects position within the visible window (which may have been
    // shifted forward when older tasks were dropped); using a 1-based local
    // index keeps the rendering deterministic for tests.
    const localIndex = droppedCount + i + 1;
    const lines = [
      `- Task ${localIndex}: ${title}`,
      `  Status: ${reportStatus} · Verdict: ${verdict}`,
      `  Summary: ${summary}`,
    ];
    if (filesShown.length > 0) {
      const suffix = filesOmitted > 0 ? ` (+${filesOmitted} more)` : "";
      lines.push(`  Files: ${filesShown.join(", ")}${suffix}`);
    }
    if (unresolvedShown.length > 0) {
      const suffix = unresolvedOmitted > 0 ? ` (+${unresolvedOmitted} more)` : "";
      lines.push(`  Unresolved: ${unresolvedShown.join("; ")}${suffix}`);
    }
    blocks.push(lines.join("\n"));
  }

  if (blocks.length === 0) return "";

  const droppedNote = droppedCount > 0
    ? `(${droppedCount} earlier task${droppedCount === 1 ? "" : "s"} omitted)\n`
    : "";
  let rendered = `${PRIOR_HANDOFF_HEADER}\n${droppedNote}${blocks.join("\n")}`;

  if (rendered.length > maxSize) {
    // Drop the oldest blocks from the visible window until we fit.
    // Always keep at least the most recent block so Task N+1 still has some
    // signal about Task N.
    const remaining = blocks.slice();
    while (remaining.length > 1) {
      remaining.shift();
      const omittedFromFront = visible.length - remaining.length + droppedCount;
      const noteLine = omittedFromFront > 0
        ? `(${omittedFromFront} earlier task${omittedFromFront === 1 ? "" : "s"} omitted)\n`
        : "";
      const candidate = `${PRIOR_HANDOFF_HEADER}\n${noteLine}${remaining.join("\n")}`;
      if (candidate.length <= maxSize - PRIOR_HANDOFF_TRUNCATION_MARKER.length - 1) {
        rendered = `${candidate}\n${PRIOR_HANDOFF_TRUNCATION_MARKER}`;
        return rendered;
      }
    }
    // Last resort: hard-clip only the most recent block. Clipping the original
    // rendering here would preserve the oldest visible task and could omit the
    // latest task entirely when no complete block fits.
    const omittedFromFront = priorTasks.length - 1;
    const noteLine = omittedFromFront > 0
      ? `(${omittedFromFront} earlier task${omittedFromFront === 1 ? "" : "s"} omitted)\n`
      : "";
    rendered = `${PRIOR_HANDOFF_HEADER}\n${noteLine}${remaining[remaining.length - 1]}`;
    const room = Math.max(0, maxSize - PRIOR_HANDOFF_TRUNCATION_MARKER.length - 1);
    rendered = `${rendered.slice(0, room).trimEnd()}\n${PRIOR_HANDOFF_TRUNCATION_MARKER}`;
  }
  return rendered;
}

export function priorTaskHandoffFromResults(
  priorTaskResults: readonly TaskResult[],
  options?: PriorTaskHandoffOptions
): string {
  // Map TaskResult → PriorTaskHandoffInput, deliberately dropping raw output,
  // reviewer process output, and other non-structured fields. This is the only
  // call path the runtime uses to feed handoff data into the prompt builder.
  const inputs: PriorTaskHandoffInput[] = priorTaskResults.map((r) => ({
    title: r.title,
    status: r.status,
    effectiveVerdict: r.effectiveVerdict,
    structuredReport: r.structuredReport,
  }));
  return buildPriorTaskHandoff(inputs, options);
}

function buildSubagentTaskPrompt(
  task: Task,
  parentContextSummary: string,
  priorTaskHandoff: string = "",
  stateBufferSection: string = ""
): string {
  const sections = [
    `Parent Workflow Context (Summary): ${parentContextSummary}`,
  ];
  if (stateBufferSection && stateBufferSection.trim().length > 0) {
    sections.push(stateBufferSection);
  }
  if (priorTaskHandoff && priorTaskHandoff.trim().length > 0) {
    sections.push(priorTaskHandoff);
  }
  sections.push(
    `Task: ${task.title}`,
    `Description:\n${task.description}`,
    `Acceptance Criteria:\n${task.acceptanceCriteria}`,
    "Work only on this task's stated scope in the current workspace directory.",
    "Verify the acceptance criteria before reporting completion.",
    "End your final response with one JSON object (prose allowed above it) using this shape:",
    '{"status":"completed|partial|blocked","summary":"...","filesChanged":["path"],"unresolvedItems":[],"acceptanceCriteria":[{"criterion":"...","status":"met|not_met|unknown","evidence":"..."}]}'
  );
  return sections.join("\n\n");
}

export { buildSubagentTaskPrompt };

// ---------------------------------------------------------------------------
// Subagent executor
//
// Earlier versions of this extension relied on a private `pi.toolManager.executeTool`
// API to invoke the `subagent` tool registered by the `_subagent` extension. That
// API is not part of the public ExtensionAPI surface and is not available at
// runtime, so any call into it threw
//   "The _subagent integration is unavailable: pi.toolManager.executeTool is not registered"
// and aborted the whole workflow before the first task could run.
//
// Instead we now mirror what `_subagent` itself does internally: discover the
// agent's markdown definition, write its system prompt to a temp file, and
// spawn `pi --mode json -p --no-session ...` as a subprocess, parsing the
// NDJSON event stream to recover the final assistant text and exit code.
// This uses only documented pi CLI flags (see docs/json.md and docs/extensions.md)
// and therefore stays independent of pi's internal tool-manager wiring.
// ---------------------------------------------------------------------------

interface DiscoveredAgent {
  name: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

function parseAgentFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  // Minimal YAML frontmatter parser matching the `key: value` shape used by
  // pi agent files. Supports comments and blank lines but not nested structures
  // (which agent files don't use anyway).
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: {}, body: content };
  }
  const header = content.substring(3, end);
  const bodyStart = content.indexOf("\n", end + 4);
  const body = bodyStart === -1 ? "" : content.substring(bodyStart + 1);
  const frontmatter: Record<string, string> = {};
  for (const rawLine of header.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.substring(0, idx).trim();
    let value = line.substring(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) frontmatter[key] = value;
  }
  return { frontmatter, body };
}

function loadAgentFromDir(dir: string, agentName: string, source: "user" | "project"): DiscoveredAgent | undefined {
  const filePath = path.join(dir, `${agentName}.md`);
  if (!fs.existsSync(filePath)) return undefined;
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
  const { frontmatter, body } = parseAgentFrontmatter(content);
  if (!frontmatter.name) return undefined;
  const tools = frontmatter.tools
    ? frontmatter.tools.split(",").map((t) => t.trim()).filter(Boolean)
    : undefined;
  return {
    name: frontmatter.name,
    model: frontmatter.model || undefined,
    thinking: frontmatter.thinking || undefined,
    tools,
    systemPrompt: body,
    source,
    filePath,
  };
}

function formatConfiguredModel(provider: unknown, model: unknown): string | undefined {
  if (typeof model !== "string") return undefined;
  const trimmedModel = model.trim();
  if (!trimmedModel) return undefined;
  if (trimmedModel.includes("/")) return trimmedModel;
  if (typeof provider !== "string") return trimmedModel;
  const trimmedProvider = provider.trim();
  return trimmedProvider ? `${trimmedProvider}/${trimmedModel}` : trimmedModel;
}

function applyAgentModelOverride(agent: DiscoveredAgent): DiscoveredAgent {
  const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
  if (!fs.existsSync(settingsPath)) return agent;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const override = settings?.subagents?.agentOverrides?.[agent.name];
    const overrideModel = formatConfiguredModel(settings?.defaultProvider, override?.model);
    const defaultModel = formatConfiguredModel(settings?.defaultProvider, settings?.defaultModel);
    const thinking = override?.thinking || agent.thinking || settings?.defaultThinkingLevel;
    const model = overrideModel || agent.model || defaultModel;
    if (model || thinking) {
      return {
        ...agent,
        model,
        thinking,
      };
    }
  } catch {
    // ignore malformed settings
  }
  return agent;
}

// Built-in fallback definition for the `worker` subagent. CC Review previously
// hard-required ~/.pi/agent/agents/generator.md, which made the extension fail
// for any user who didn't install that agent (goal #1: minimize external plugin
// dependencies). The prompt below is intentionally lightweight: it gives the
// subagent a single, focused responsibility and avoids the sprint-contract
// workflow some users layer on top of their own agent profiles. A worker.md
// profile takes precedence; legacy generator.md profiles remain supported.
const BUILTIN_WORKER_PROMPT = [
  "You are CC Review's built-in worker subagent.",
  "",
  "Scope rules:",
  "- Implement exactly the single task in the prompt; do not invent or pre-stage other work.",
  "- Operate in the current workspace directory using the tools available to you.",
  "- Do not consult or rely on external contract files (e.g. sprint-contract.json, eval-report.json). They may be left over from unrelated workflows.",
  "- Read only the files you need to understand the change; avoid speculative exploration.",
  "",
  "Forbidden tools and patterns:",
  "- NEVER invoke the cc_review tool or /cc-review slash command. You are already inside a CC Review worker; nested workflows cause runaway subprocess output and crash the orchestrator.",
  "- Do not dogfood CC Review to verify your changes.",
  "",
  "Process:",
  "1. Restate the task in one sentence (privately) and identify the smallest set of files to change.",
  "2. Make the change directly. Add or update focused tests covering the acceptance criteria when tests exist or are mentioned in the criteria.",
  "3. Verify the acceptance criteria before reporting completion (run targeted commands; do not run the whole test suite if a focused subset suffices).",
  "4. Reply with a one-paragraph summary: what changed, where, and how the criteria were verified.",
  "",
  "Verification:",
  "- Prefer targeted checks, e.g. `node --test --test-name-pattern=\"your test name\" tests/...`.",
  "- Do not run the full `node --test tests/cc-review-behavior.test.ts` suite unless the task explicitly requires it.",
  "",
  "Failure protocol:",
  "- If a step is genuinely blocked, reply with \"ERROR: <one-sentence reason>\" and stop.",
  "- Do not loop or stall: if the same operation has failed twice, report the error instead of retrying indefinitely.",
].join("\n");

export function buildBuiltinWorkerAgent(): DiscoveredAgent {
  return {
    name: "worker",
    model: undefined,
    thinking: undefined,
    tools: undefined,
    systemPrompt: BUILTIN_WORKER_PROMPT,
    source: "user",
    filePath: "<builtin>",
  };
}

export function discoverAgent(
  agentName: string,
  agentScope: "user" | "project" | "both",
  cwd: string,
): DiscoveredAgent | undefined {
  const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
  const projectDir = path.join(cwd, ".pi", "agents");

  let agent: DiscoveredAgent | undefined;
  if (agentScope === "project" || agentScope === "both") {
    agent = loadAgentFromDir(projectDir, agentName, "project");
  }
  if (!agent && (agentScope === "user" || agentScope === "both")) {
    agent = loadAgentFromDir(userDir, agentName, "user");
  }
  if (!agent && agentName === "worker") {
    // Preserve existing installations that defined the executor as generator.md,
    // while exposing one canonical runtime role and one settings override: worker.
    let legacyAgent: DiscoveredAgent | undefined;
    if (agentScope === "project" || agentScope === "both") {
      legacyAgent = loadAgentFromDir(projectDir, "generator", "project");
    }
    if (!legacyAgent && (agentScope === "user" || agentScope === "both")) {
      legacyAgent = loadAgentFromDir(userDir, "generator", "user");
    }
    if (legacyAgent) {
      agent = { ...legacyAgent, name: "worker" };
    }
  }
  if (!agent && agentName === "worker") {
    // Last-resort built-in so the workflow runs without any user-installed agent.
    agent = buildBuiltinWorkerAgent();
  }
  return agent ? applyAgentModelOverride(agent) : undefined;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  // Prefer the same pi binary that runs the current process, falling back to
  // the `pi` on PATH. Mirrors `_subagent`'s logic so we don't accidentally pick
  // up a different pi install when running under bun-compiled binaries.
  //
  // We only re-use `process.argv[1]` when it actually points at a pi entry
  // script. In production this extension runs inside pi so argv[1] is the pi
  // script; in test harnesses argv[1] could be an unrelated file, which would
  // make us launch the wrong program.
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  const looksLikePiScript =
    !!currentScript &&
    !isBunVirtualScript &&
    fs.existsSync(currentScript) &&
    (/(^|[\/\\])pi(\.[cm]?[jt]s)?$/i.test(currentScript) ||
      currentScript.includes("pi-coding-agent") ||
      currentScript.includes("@earendil-works"));
  if (looksLikePiScript) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

// Build a compact, non-sensitive one-line summary of a subagent tool execution
// for the live progress stream. Shows the tool plus a short, bounded hint
// (command for bash, path for file tools) without dumping raw args.
export function summarizeSubagentToolActivity(event: any): string {
  const toolName = typeof event?.toolName === "string" && event.toolName ? event.toolName : "tool";
  const args = event?.args && typeof event.args === "object" ? event.args : {};
  const clip = (value: unknown): string => {
    const text = stripAnsi(String(value ?? "")).replace(/\s+/g, " ").trim();
    return text.length > 80 ? `${text.slice(0, 79)}…` : text;
  };
  let hint = "";
  if (typeof args.command === "string") hint = clip(args.command);
  else if (typeof args.path === "string") hint = clip(args.path);
  else if (typeof args.file_path === "string") hint = clip(args.file_path);
  else if (typeof args.pattern === "string") hint = clip(args.pattern);
  else if (typeof args.query === "string") hint = clip(args.query);
  return hint ? `⚙ ${toolName}: ${hint}` : `⚙ ${toolName}`;
}

async function runPiAgentSubprocess(
  agent: DiscoveredAgent,
  task: string,
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: any) => void) | undefined,
): Promise<SubagentToolResult> {
  // Write the agent system prompt to a temp file we can pass via
  // --append-system-prompt. pi accepts either text or a file path there.
  let tmpDir: string | null = null;
  let tmpPromptPath: string | null = null;
  if (agent.systemPrompt.trim()) {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cc-review-subagent-"));
    tmpPromptPath = path.join(tmpDir, `prompt-${agent.name.replace(/[^\w.-]+/g, "_")}.md`);
    await fs.promises.writeFile(tmpPromptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
  }

  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.thinking) args.push("--thinking", agent.thinking);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
  if (tmpPromptPath) args.push("--append-system-prompt", tmpPromptPath);
  args.push(`Task: ${task}`);

  const invocation = getPiInvocation(args);
  // Debug: log invocation when CC_REVIEW_DEBUG is set
  if (process.env.CC_REVIEW_DEBUG) {
    try {
      process.stderr.write(`[cc-review] spawning: ${invocation.command} ${invocation.args.map((a) => JSON.stringify(a)).join(" ")}\n`);
    } catch {
      // ignore
    }
  }
  let finalAssistantText = "";
  let currentModel: string | undefined = agent.model;
  let abortReason: string | undefined;
  let lastTextDeltaForwardMs = 0;
  const TEXT_DELTA_THROTTLE_MS = 3000;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (event?.type === "model_select" && event.model) {
      if (typeof event.model === "string") {
        currentModel = event.model;
      } else if (typeof event.model === "object") {
        const provider = event.model.provider;
        const id = event.model.id;
        if (provider && id) {
          currentModel = `${provider}/${id}`;
        } else if (id) {
          currentModel = id;
        }
      }
    } else if (event?.message?.model) {
      const msgModel = event.message.model;
      const msgProvider = event.message.provider;
      if (msgProvider && typeof msgProvider === "string" && typeof msgModel === "string" && !msgModel.includes(msgProvider)) {
        currentModel = `${msgProvider}/${msgModel}`;
      } else if (typeof msgModel === "string") {
        currentModel = msgModel;
      }
    } else if (typeof event?.model === "string") {
      currentModel = event.model;
    } else if (typeof event?.metadata?.model === "string") {
      currentModel = event.metadata.model;
    }
    if (event?.type === "tool_execution_start" && onUpdate) {
      const progress = summarizeSubagentToolActivity(event);
      if (progress) {
        try {
          onUpdate({
            content: [{ type: "text", text: progress }],
            details: { results: [{ agent: agent.name, model: currentModel }] },
            model: currentModel,
          });
        } catch {
          // ignore observer errors
        }
      }
      return;
    }
    if (event?.type === "tool_execution_end" && event.isError && onUpdate) {
      const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
      try {
        onUpdate({
          content: [{ type: "text", text: `⚠ ${toolName} failed` }],
          details: { results: [{ agent: agent.name, model: currentModel }] },
          model: currentModel,
        });
      } catch {
        // ignore observer errors
      }
      return;
    }
    if ((event?.type === "message_update" || event?.type === "text_delta") && onUpdate) {
      const deltaText =
        typeof event?.delta === "string" ? event.delta
        : typeof event?.delta?.text === "string" ? event.delta.text
        : typeof event?.text === "string" ? event.text
        : "";
      if (deltaText) {
        const now = Date.now();
        if (now - lastTextDeltaForwardMs >= TEXT_DELTA_THROTTLE_MS) {
          lastTextDeltaForwardMs = now;
          const preview = clipSubprocessLogText(deltaText, 100);
          try {
            onUpdate({
              content: [{ type: "text", text: `… ${preview}` }],
              details: { results: [{ agent: agent.name, model: currentModel }] },
              model: currentModel,
            });
          } catch {
            // ignore observer errors
          }
        }
      }
      return;
    }
    if (event?.type === "message_end" && event.message?.role === "assistant") {
      const parts = Array.isArray(event.message.content) ? event.message.content : [];
      for (const part of parts) {
        if (part?.type === "text" && typeof part.text === "string" && part.text) {
          finalAssistantText = part.text;
          if (onUpdate) {
            try {
              onUpdate({
                content: [{ type: "text", text: stripAnsi(part.text) }],
                details: { results: [{ agent: agent.name, model: currentModel }] },
                model: currentModel,
              });
            } catch {
              // ignore observer errors
            }
          }
        }
      }
    }
  };

  const onAbortReason = () => {
    const reason = signal?.reason;
    if (reason instanceof Error) {
      abortReason = reason.message;
    } else if (typeof reason === "string" && reason) {
      abortReason = reason;
    }
  };
  if (signal) {
    if (signal.aborted) onAbortReason();
    else signal.addEventListener("abort", onAbortReason, { once: true });
  }

  const r = await runSubprocess({
    label: `subagent:${agent.name}`,
    command: invocation.command,
    args: invocation.args,
    cwd,
    signal,
    abortMode: "internal",
    onStdoutLine: handleLine,
  });

  if (signal) signal.removeEventListener("abort", onAbortReason);

  const stderrBuf = r.stderr;
  const wasAborted = r.aborted;

  if (tmpDir) {
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  const exitCode: number = r.code ?? (wasAborted ? 130 : 1);
  const stderr = stderrBuf.trim();
  const isError = exitCode !== 0 || wasAborted;
  const abortMessage = wasAborted ? (abortReason || "Subagent aborted") : undefined;
  const exitMessage = `pi subprocess exited with code ${exitCode}`;
  const errorMessage = isError
    ? (abortMessage || stderr || (r.spawnError?.message) || exitMessage)
    : undefined;
  const textOut = finalAssistantText.trim() || (isError ? (errorMessage || stderr || exitMessage) : "");

  return {
    content: [{ type: "text", text: textOut }],
    details: {
      results: [
        {
          agent: agent.name,
          exitCode,
          stderr: stderr || undefined,
          errorMessage,
          model: currentModel,
        },
      ],
    },
    isError,
    model: currentModel,
  };
}

export function getSubagentExecutor(pi: ExtensionAPI): SubagentToolExecutor {
  // If a future pi runtime (or a test harness) exposes a way to invoke the
  // already-registered `subagent` tool directly via `pi.toolManager.executeTool`,
  // prefer it: it shares pi's in-process tool runtime and observability.
  //
  // Real pi (current public ExtensionAPI) does NOT expose this surface, so we
  // fall back to spawning `pi --mode json -p --no-session ...` as a subprocess,
  // mirroring what `_subagent` does internally. The previous version of this
  // function threw on the missing API and aborted the whole workflow before
  // task #1 could run; this resilient lookup is the actual fix.
  const toolManager = (pi as unknown as { toolManager?: { executeTool?: SubagentToolExecutor } }).toolManager;
  if (toolManager?.executeTool) {
    return toolManager.executeTool.bind(toolManager);
  }

  return async (_toolName, params, signal, onUpdate, ctx) => {
    const agentName = String(params.agent ?? "");
    const task = String(params.task ?? "");
    const agentScope = ((params.agentScope as "user" | "project" | "both") ?? "user");
    const cwd = (typeof params.cwd === "string" && params.cwd) || ctx?.cwd || process.cwd();

    if (!agentName || !task) {
      const errorMessage = "Subagent call missing required `agent` or `task` parameter";
      return {
        content: [{ type: "text", text: errorMessage }],
        details: { results: [{ exitCode: 1, errorMessage }] },
        isError: true,
      };
    }

    const agent = discoverAgent(agentName, agentScope, cwd);
    if (!agent) {
      const errorMessage = `Unknown agent "${agentName}" (scope=${agentScope}). Expected an agent markdown file under ~/.pi/agent/agents/ or <cwd>/.pi/agents/.`;
      return {
        content: [{ type: "text", text: errorMessage }],
        details: { results: [{ agent: agentName, exitCode: 1, errorMessage }] },
        isError: true,
      };
    }

    return runPiAgentSubprocess(agent, task, cwd, signal, onUpdate);
  };
}

export function extractSubagentText(result: SubagentToolResult): string {
  return result.content
    ?.map((c) => (c.type === "text" && c.text ? c.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim() || "";
}

export function appendUnique(target: string[], values: Array<string | undefined>) {
  for (const value of values) {
    const item = value?.trim();
    if (item && !target.includes(item)) {
      target.push(item);
    }
  }
}

export function getSubagentExitCode(result: SubagentToolResult): number {
  const detailCode = result.details?.results?.[0]?.exitCode;
  if (typeof detailCode === "number") {
    return detailCode;
  }
  return result.isError ? 1 : 0;
}
