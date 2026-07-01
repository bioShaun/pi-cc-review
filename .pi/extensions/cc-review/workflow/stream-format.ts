import type { CcReviewLogSeverity } from "../config.ts";
import type { SubprocessProvider } from "./types.ts";
import { stripAnsi } from "./util.ts";

export function inferSubprocessStreamSeverity(
  line: string,
  stream: "stdout" | "stderr" = "stderr"
): CcReviewLogSeverity {
  const normalized = stripAnsi(line).trim().toLowerCase();
  if (!normalized) return "info";

  if (
    /\b(fatal|panic|segfault|uncaught exception)\b/.test(normalized) ||
    /\berror:\s/.test(normalized) ||
    /^error\b/.test(normalized) ||
    /\b(exit(?:ed)? with code|exit code) [1-9]\d*/.test(normalized)
  ) {
    return "error";
  }

  if (/\bfailed\b/.test(normalized) && !/\bsucceeded\b/.test(normalized)) {
    return "error";
  }

  if (/\b(warn(?:ing)?|retrying|timed?\s*out|transient|rate[-\s]+limit(?:ed)?)\b/.test(normalized)) {
    return "warning";
  }

  return "info";
}

export function clipSubprocessLogText(text: string, maxLength = 120): string {
  const cleaned = stripAnsi(text).replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  if (maxLength <= 1) return cleaned.slice(0, maxLength);
  return `${cleaned.slice(0, maxLength - 1)}…`;
}

function looksLikeJsonFragment(line: string): boolean {
  if (/^[\{\}\[\]],?\s*$/.test(line)) return true;
  if (/^"[^"]+"\s*:/.test(line)) return true;
  if (/^"(tasks|title|description|verdict|findings|summary|acceptanceCriteria|postFixValidation)"/.test(line)) {
    return true;
  }
  return false;
}

function structuredTextPreview(value: unknown, maxLength = 100): string {
  return typeof value === "string" ? clipSubprocessLogText(value, maxLength) : "";
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const args = input as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "pattern", "query", "url"]) {
    const preview = structuredTextPreview(args[key], 80);
    if (preview) return preview;
  }
  return "";
}

type AdapterSeverityHint = CcReviewLogSeverity | undefined;

type StreamSummarizerOutcome =
  | { readonly kind: "terminal"; readonly summary: string | null; readonly severity?: AdapterSeverityHint }
  | { readonly kind: "redispatch"; readonly rawLine: string };

interface StreamSummarizerContext {
  readonly provider: SubprocessProvider | undefined;
  readonly rawLine: string;
}

interface StreamSummarizer {
  readonly provider: SubprocessProvider;
  summarize(payload: unknown, context: StreamSummarizerContext): StreamSummarizerOutcome | null;
}

const MAX_REDISPATCH_DEPTH = 2;

interface RichStreamSummary {
  readonly message: string;
  readonly severity?: AdapterSeverityHint;
}

function resolveNestedAssistantText(
  rawText: string | undefined,
  provider: SubprocessProvider | undefined
): { readonly summary: string | null } {
  if (typeof rawText !== "string") return { summary: null };
  const trimmed = rawText.trim();
  if (!trimmed) return { summary: null };
  const nested = formatSubprocessStreamLineRich(rawText, provider);
  if (nested !== null && nested.message !== trimmed) {
    return { summary: nested.message };
  }
  if (nested === null && /^[\[{]/.test(trimmed)) {
    return { summary: null };
  }
  return { summary: `Assistant: ${structuredTextPreview(rawText, 120)}` };
}

function codexItemSummary(eventType: string, item: Record<string, unknown>, provider: SubprocessProvider | undefined): string | null {
  const itemType = typeof item.type === "string" ? item.type : "item";
  const isStarted = eventType === "item.started";
  const isCompleted = eventType === "item.completed";
  const status = typeof item.status === "string" ? item.status : "";

  if (itemType === "reasoning") {
    const text = structuredTextPreview(item.text, 110);
    return text ? `Thinking: ${text}` : null;
  }

  if (itemType === "agent_message") {
    if (typeof item.text !== "string" || !item.text.trim()) return null;
    return resolveNestedAssistantText(item.text, provider).summary;
  }

  if (itemType === "command_execution") {
    const command = structuredTextPreview(item.command, 90) || "command";
    if (isStarted || status === "in_progress") return `Running command: ${command}`;
    const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
    if (exitCode !== undefined && exitCode !== 0) return `Command failed (exit ${exitCode}): ${command}`;
    return `Command completed: ${command}`;
  }

  if (itemType === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths = changes
      .map((change) =>
        change && typeof change === "object"
          ? structuredTextPreview((change as Record<string, unknown>).path, 50)
          : ""
      )
      .filter(Boolean);
    const preview = paths.slice(0, 3).join(", ");
    const suffix = paths.length > 3 ? ` (+${paths.length - 3} more)` : "";
    if (isStarted) return preview ? `Applying changes: ${preview}${suffix}` : "Applying file changes";
    return preview ? `Updated ${paths.length} file${paths.length === 1 ? "" : "s"}: ${preview}${suffix}` : "File changes applied";
  }

  if (itemType === "mcp_tool_call") {
    const tool =
      structuredTextPreview(item.tool, 60) ||
      structuredTextPreview(item.name, 60) ||
      "tool";
    const hint = summarizeToolInput(item.arguments ?? item.input);
    const action = isCompleted ? "Tool completed" : "Using tool";
    return hint ? `${action}: ${tool} — ${hint}` : `${action}: ${tool}`;
  }

  if (itemType === "web_search") {
    const query = structuredTextPreview(item.query, 90);
    return query ? `Searching the web: ${query}` : "Searching the web";
  }

  if (itemType === "todo_list") {
    const items = Array.isArray(item.items) ? item.items : [];
    const completed = items.filter(
      (todo) => todo && typeof todo === "object" && (todo as Record<string, unknown>).completed === true
    ).length;
    return `Plan updated: ${completed}/${items.length} completed`;
  }

  return null;
}

const codexSummarizer: StreamSummarizer = {
  provider: "codex",
  summarize(payload, context) {
    if (!payload || typeof payload !== "object") return null;
    const obj = payload as Record<string, unknown>;
    if (typeof obj.type !== "string") return null;

    if (obj.type === "thread.started" || obj.type === "turn.started") {
      return { kind: "terminal", summary: null };
    }
    if (obj.type === "turn.completed") {
      return { kind: "terminal", summary: "Codex turn completed" };
    }
    if (obj.type === "turn.failed") {
      const error =
        structuredTextPreview((obj.error as Record<string, unknown> | undefined)?.message, 100) ||
        structuredTextPreview(obj.message, 100);
      return { kind: "terminal", summary: error ? `Codex turn failed: ${error}` : "Codex turn failed", severity: "error" };
    }
    if (
      (obj.type === "item.started" || obj.type === "item.updated" || obj.type === "item.completed") &&
      obj.item &&
      typeof obj.item === "object"
    ) {
      const item = obj.item as Record<string, unknown>;
      const itemType = typeof item.type === "string" ? item.type : "item";
      const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
      const severity: AdapterSeverityHint =
        itemType === "command_execution" && exitCode !== undefined && exitCode !== 0 ? "error" : undefined;
      const summary = codexItemSummary(obj.type, item, context.provider);
      return { kind: "terminal", summary, severity };
    }
    if (obj.type === "item.started" || obj.type === "item.updated" || obj.type === "item.completed") {
      return { kind: "terminal", summary: null };
    }

    return null;
  },
};

const claudeSummarizer: StreamSummarizer = {
  provider: "claude",
  summarize(payload, _context) {
    if (!payload || typeof payload !== "object") return null;
    const obj = payload as Record<string, unknown>;
    if (typeof obj.type !== "string") return null;

    if (obj.type === "system" || obj.type === "user") {
      return { kind: "terminal", summary: null };
    }
    if (obj.type === "stream_event") {
      const event = obj.event && typeof obj.event === "object" ? obj.event as Record<string, unknown> : undefined;
      const delta = event?.delta && typeof event.delta === "object" ? event.delta as Record<string, unknown> : undefined;
      if (event?.type === "content_block_delta" && delta?.type === "text_delta") {
        const text = structuredTextPreview(delta.text, 100);
        return { kind: "terminal", summary: text || null };
      }
      return { kind: "terminal", summary: null };
    }
    if (obj.type === "assistant") {
      const message = obj.message && typeof obj.message === "object"
        ? obj.message as Record<string, unknown>
        : undefined;
      const content = Array.isArray(message?.content) ? message.content : [];
      const summaries: string[] = [];
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const contentPart = part as Record<string, unknown>;
        if (contentPart.type === "tool_use") {
          const name = structuredTextPreview(contentPart.name, 60) || "tool";
          const hint = summarizeToolInput(contentPart.input);
          summaries.push(hint ? `Using tool: ${name} — ${hint}` : `Using tool: ${name}`);
        } else if (contentPart.type === "text") {
          if (typeof contentPart.text !== "string" || !contentPart.text.trim()) continue;
          const resolved = resolveNestedAssistantText(contentPart.text, "claude");
          if (resolved.summary !== null) summaries.push(resolved.summary);
        }
      }
      return { kind: "terminal", summary: summaries.length > 0 ? summaries.slice(0, 2).join(" · ") : null };
    }
    if (obj.type === "result") {
      const failed = obj.is_error === true || obj.subtype === "error";
      const durationMs = typeof obj.duration_ms === "number" ? obj.duration_ms : undefined;
      const turns = typeof obj.num_turns === "number" ? obj.num_turns : undefined;
      const details = [
        durationMs !== undefined ? `${Math.max(0, durationMs / 1000).toFixed(1)}s` : "",
        turns !== undefined ? `${turns} turn${turns === 1 ? "" : "s"}` : "",
      ].filter(Boolean).join(", ");
      const resultText = structuredTextPreview(obj.result, 100);
      if (failed) return { kind: "terminal", summary: resultText ? `Claude failed: ${resultText}` : "Claude run failed", severity: "error" };
      return { kind: "terminal", summary: `Claude run completed${details ? ` (${details})` : ""}` };
    }
    if (obj.type === "tool_progress") {
      const tool = structuredTextPreview(obj.tool_name ?? obj.name, 60) || "tool";
      return { kind: "terminal", summary: `${tool} is still running` };
    }
    if (obj.type === "rate_limit_event") {
      return { kind: "terminal", summary: "Rate limited; waiting to retry", severity: "warning" };
    }
    if (obj.type === "tool_call" || obj.type === "tool_use" || obj.type === "tool_execution_start") {
      const name =
        typeof obj.name === "string"
          ? obj.name
          : typeof obj.tool === "string"
            ? obj.tool
            : typeof obj.toolName === "string"
              ? obj.toolName
              : "tool";
      return { kind: "terminal", summary: `⚙ ${name}` };
    }
    if (obj.type === "message" || obj.type === "message_end") {
      return { kind: "terminal", summary: null };
    }

    return null;
  },
};

const STREAM_SUMMARIZERS: readonly StreamSummarizer[] = [codexSummarizer, claudeSummarizer];

function selectSummarizers(provider: SubprocessProvider | undefined): readonly StreamSummarizer[] {
  if (provider === undefined) return STREAM_SUMMARIZERS;
  return STREAM_SUMMARIZERS.filter((adapter) => adapter.provider === provider);
}

function summarizeStructuredSubprocessPayload(
  payload: unknown,
  provider: SubprocessProvider | undefined,
  depth: number
): StreamSummarizerOutcome | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;

  if (obj.type === "workflow_trace" || obj.type === "cc_review_log_rotation") {
    return { kind: "terminal", summary: null };
  }

  if (Array.isArray(obj.tasks)) {
    const titles = obj.tasks
      .map((task) =>
        task && typeof task === "object" && typeof (task as { title?: unknown }).title === "string"
          ? (task as { title: string }).title
          : ""
      )
      .filter(Boolean);
    const preview = titles.slice(0, 3).join("; ");
    const suffix = titles.length > 3 ? ` (+${titles.length - 3} more)` : "";
    return { kind: "terminal", summary: `Planned ${titles.length} task${titles.length === 1 ? "" : "s"}: ${preview}${suffix}` };
  }

  if (typeof obj.verdict === "string") {
    const summary = typeof obj.summary === "string" ? clipSubprocessLogText(obj.summary, 80) : "";
    const findings = Array.isArray(obj.findings) ? obj.findings : [];
    const unfixed = findings.filter(
      (finding) =>
        finding &&
        typeof finding === "object" &&
        (finding as { status?: unknown }).status === "unfixed"
    ).length;
    const parts = [`Review: ${obj.verdict}`];
    if (summary) parts.push(summary);
    if (findings.length > 0) {
      parts.push(`${findings.length} finding${findings.length === 1 ? "" : "s"} (${unfixed} unfixed)`);
    }
    return { kind: "terminal", summary: parts.join(" — ") };
  }

  const context: StreamSummarizerContext = { provider, rawLine: "" };
  for (const adapter of selectSummarizers(provider)) {
    const outcome = adapter.summarize(obj, context);
    if (outcome !== null) return outcome;
  }

  if (typeof obj.command === "string") {
    return { kind: "terminal", summary: `exec ${clipSubprocessLogText(obj.command, 80)}` };
  }

  const error = structuredTextPreview(obj.error ?? obj.message, 110);
  return error
    ? { kind: "terminal", summary: `Provider message: ${error}` }
    : { kind: "terminal", summary: null };
}

export function formatSubprocessStreamLineRich(
  rawLine: string,
  provider: SubprocessProvider | undefined,
  depth = 0
): RichStreamSummary | null {
  const line = stripAnsi(rawLine).trim();
  if (!line) return null;

  if (line.includes('"type":"workflow_trace"') || line.includes('"type": "workflow_trace"')) {
    return null;
  }

  if (line.startsWith("{") || line.startsWith("[")) {
    try {
      const parsed = JSON.parse(line);
      const outcome = summarizeStructuredSubprocessPayload(parsed, provider, depth);
      if (outcome === null) return null;
      if (outcome.kind === "terminal") {
        if (outcome.summary === null) return null;
        return { message: outcome.summary, severity: outcome.severity };
      }
      if (depth >= MAX_REDISPATCH_DEPTH) {
        const fallback = resolveNestedAssistantText(outcome.rawLine, provider);
        return fallback.summary === null ? null : { message: fallback.summary };
      }
      return formatSubprocessStreamLineRich(outcome.rawLine, provider, depth + 1);
    } catch {
      return null;
    }
  }

  if (looksLikeJsonFragment(line)) return null;

  return { message: line };
}

export function formatSubprocessStreamLine(rawLine: string): string | null {
  const rich = formatSubprocessStreamLineRich(rawLine, undefined);
  return rich === null ? null : rich.message;
}

function extractCodexItemText(event: Record<string, unknown>): string {
  if (event.type !== "item.completed" || !event.item || typeof event.item !== "object") return "";
  const item = event.item as Record<string, unknown>;
  return item.type === "agent_message" && typeof item.text === "string" ? item.text : "";
}

// Extract the final assistant text from a claude `--output-format stream-json`
// NDJSON stream (see P0-3). When the output contains recognizable stream-json
// events (assistant message content or a final `result` event), the
// accumulated text is returned. When the output is plain text (e.g. from a
// test mock that does not emit stream-json), the original text is returned
// unchanged so callers keep working in both modes.
export function extractAssistantTextFromStream(stdout: string): string {
  if (!stdout) return stdout;
  const lines = stdout.split("\n");
  let hasStreamEvents = false;
  let finalText = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Only attempt JSON parsing on lines that look like JSON objects.
    if (!trimmed.startsWith("{")) continue;
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    // Claude stream-json: assistant message with content parts.
    if (event?.type === "assistant" && Array.isArray(event?.message?.content)) {
      hasStreamEvents = true;
      for (const part of event.message.content) {
        if (part?.type === "text" && typeof part.text === "string") {
          finalText += part.text;
        }
      }
    }
    // Claude stream-json with --include-partial-messages: text deltas arrive as
    // stream_event payloads before the terminal assistant/result event.
    if (event?.type === "stream_event" && event?.event?.type === "content_block_delta") {
      const delta = event.event.delta;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        hasStreamEvents = true;
        finalText += delta.text;
      }
    }
    // Claude stream-json: final result event overrides accumulated text.
    if (event?.type === "result" && typeof event?.result === "string") {
      hasStreamEvents = true;
      finalText = event.result;
    }
    // Codex --json: message events with text content (best-effort; shape varies
    // across versions, so we only match the common {type:"message",content:...}).
    if (event?.type === "message" && typeof event?.content === "string") {
      hasStreamEvents = true;
      finalText += event.content;
    }
    const codexItemText = extractCodexItemText(event);
    if (codexItemText) {
      hasStreamEvents = true;
      finalText += codexItemText;
    }
  }
  return hasStreamEvents && finalText ? finalText : stdout;
}
