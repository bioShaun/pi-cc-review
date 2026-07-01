import * as path from "node:path";

import type { CcReviewLogSeverity } from "../config.ts";
import type { CcReviewFindingsRollup, TaskStatus } from "../structured.ts";
import { emptyFindingsRollup, formatFindingsRollupLine } from "../structured.ts";
import {
  type CcReviewLogEntry,
  type CcReviewLogInput,
  type CcReviewLogStructuredInput,
} from "./types.ts";
import { inferSubprocessStreamSeverity } from "./stream-format.ts";
import { shouldShowUnknownTaskModel } from "./summary.ts";
import { stripAnsi } from "./util.ts";

interface CcReviewLogNormalizationOptions {
  sequence?: number;
  now?: () => Date;
  defaultSource?: string;
  defaultPluginId?: string;
}

const DEFAULT_LOG_SOURCE = "cc-review";
const DEFAULT_LOG_PLUGIN_ID = "cc-review";
const SUPPORTED_LOG_SEVERITIES: readonly CcReviewLogSeverity[] = ["debug", "info", "warning", "error"];
export { SUPPORTED_LOG_SEVERITIES };
const DEFAULT_LOG_MESSAGE_WRAP_WIDTH = 96;

const LOG_SEVERITY_RENDER_META: Record<CcReviewLogSeverity, { icon: string; label: string }> = {
  debug: { icon: "🔎", label: "DEBUG" },
  info: { icon: "ℹ", label: "INFO" },
  warning: { icon: "⚠", label: "WARN" },
  error: { icon: "✖", label: "ERROR" },
};

interface CcReviewLogRenderOptions {
  maxMessageWidth?: number;
  /** When set, caps each rendered line (prefix + message) to this visible budget. */
  maxLineWidth?: number;
  includeTimestamp?: boolean;
  includeSource?: boolean;
}

function normalizeLogSeverity(rawSeverity: unknown): CcReviewLogSeverity {
  if (typeof rawSeverity !== "string") return "info";
  const severity = rawSeverity.trim().toLowerCase();
  if (severity === "warn") return "warning";
  if (severity === "fatal") return "error";
  return SUPPORTED_LOG_SEVERITIES.includes(severity as CcReviewLogSeverity)
    ? (severity as CcReviewLogSeverity)
    : "info";
}

function stableLogHash(parts: readonly string[]): string {
  let hash = 2166136261;
  const input = parts.join("\u001f");
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeOptionalText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = stripAnsi(value).trim();
  return trimmed || fallback;
}
function isStderrChannelLabel(label: string): boolean {
  const normalizedLabel = label.trim().toLowerCase();
  return normalizedLabel.endsWith(" error") || normalizedLabel.endsWith(" failure");
}

function inferLegacyLogSeverity(label: string, message = ""): CcReviewLogSeverity {
  const normalizedLabel = label.trim().toLowerCase();
  if (normalizedLabel.includes("debug")) return "debug";
  if (isStderrChannelLabel(label)) {
    return inferSubprocessStreamSeverity(message, "stderr");
  }
  if (
    normalizedLabel.includes("failure") ||
    normalizedLabel.includes("failed") ||
    normalizedLabel.includes("halted")
  ) {
    return "error";
  }
  if (normalizedLabel.includes("error")) {
    return "error";
  }
  if (
    normalizedLabel.includes("warn") ||
    normalizedLabel.includes("timeout") ||
    normalizedLabel.includes("transient") ||
    normalizedLabel.includes("retry")
  ) {
    return "warning";
  }
  return "info";
}

function inferLegacyLogSource(label: string): string {
  const normalizedLabel = label.trim().toLowerCase();
  if (normalizedLabel.includes("planner")) return "planner";
  if (normalizedLabel.includes("reviewer") || normalizedLabel.includes("review")) return "reviewer";
  if (normalizedLabel.includes("subagent")) return "subagent";
  return DEFAULT_LOG_SOURCE;
}

function parseLegacyLogInput(input: string): CcReviewLogStructuredInput {
  const cleaned = stripAnsi(input).trim();
  const prefixedLogMatch = cleaned.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (!prefixedLogMatch) {
    return { message: cleaned };
  }

  const label = prefixedLogMatch[1].trim();
  const message = prefixedLogMatch[2].trim();
  return {
    severity: inferLegacyLogSeverity(label, message),
    source: inferLegacyLogSource(label),
    message: message || cleaned,
  };
}

export function normalizeCcReviewLogEntry(
  input: CcReviewLogInput,
  options: CcReviewLogNormalizationOptions = {}
): CcReviewLogEntry {
  const structuredInput: CcReviewLogStructuredInput = typeof input === "string" ? parseLegacyLogInput(input) : input;
  const sequence = Number.isSafeInteger(options.sequence)
    ? Number(options.sequence)
    : Number.isSafeInteger(structuredInput.sequence)
      ? Number(structuredInput.sequence)
      : 0;
  const timestamp = normalizeOptionalText(
    structuredInput.timestamp,
    (options.now ?? (() => new Date()))().toISOString()
  );
  const severity = normalizeLogSeverity(structuredInput.severity);
  const source = normalizeOptionalText(structuredInput.source, options.defaultSource ?? DEFAULT_LOG_SOURCE);
  const pluginId = normalizeOptionalText(structuredInput.pluginId, options.defaultPluginId ?? DEFAULT_LOG_PLUGIN_ID);
  const message = typeof structuredInput.message === "string" ? stripAnsi(structuredInput.message).trim() : "";
  const suppliedId = typeof structuredInput.id === "string" ? structuredInput.id.trim() : "";
  const id = suppliedId || `cc-review-log-${sequence}-${stableLogHash([timestamp, severity, source, pluginId, message])}`;

  const entry: CcReviewLogEntry = {
    id,
    timestamp,
    severity,
    source,
    pluginId,
    message,
    sequence,
  };
  if (structuredInput.details !== undefined) {
    entry.details = structuredInput.details;
  }
  return entry;
}

function formatCcReviewLogTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "unknown-time";
  }
  const isoTimestamp = date.toISOString();
  return `${isoTimestamp.slice(0, 10)} ${isoTimestamp.slice(11, 19)}Z`;
}

function normalizeRenderableLogMessage(message: string): string {
  const cleaned = stripAnsi(message).replace(/\s+/g, " ").trim();
  return cleaned || "(empty message)";
}

export function collapseConsecutiveLogEntries(
  entries: readonly CcReviewLogEntry[]
): CcReviewLogEntry[] {
  if (entries.length === 0) return [];
  const collapsed: CcReviewLogEntry[] = [];
  let currentGroup: CcReviewLogEntry[] = [entries[0]];

  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i];
    const prev = currentGroup[currentGroup.length - 1];
    const normPrev = normalizeRenderableLogMessage(prev.message);
    const normCurr = normalizeRenderableLogMessage(entry.message);

    if (normPrev === normCurr) {
      currentGroup.push(entry);
    } else {
      collapsed.push(mergeLogGroup(currentGroup));
      currentGroup = [entry];
    }
  }

  if (currentGroup.length > 0) {
    collapsed.push(mergeLogGroup(currentGroup));
  }

  return collapsed;
}

function mergeLogGroup(group: CcReviewLogEntry[]): CcReviewLogEntry {
  if (group.length === 1) return group[0];
  const lastEntry = group[group.length - 1];
  return {
    ...lastEntry,
    message: `${lastEntry.message} (x${group.length})`,
  };
}

function wrapLogMessage(message: string, maxWidth: number): string[] {
  const width = Math.max(16, Math.floor(maxWidth));
  const words = message.split(/\s+/).filter(Boolean);
  const wrappedLines: string[] = [];
  let currentLine = "";

  const flushCurrentLine = () => {
    if (currentLine) {
      wrappedLines.push(currentLine);
      currentLine = "";
    }
  };

  for (const word of words) {
    if (word.length > width) {
      flushCurrentLine();
      let remaining = word;
      while (remaining.length > width) {
        wrappedLines.push(remaining.slice(0, width));
        remaining = remaining.slice(width);
      }
      currentLine = remaining;
      continue;
    }

    if (!currentLine) {
      currentLine = word;
    } else if (currentLine.length + 1 + word.length <= width) {
      currentLine += ` ${word}`;
    } else {
      flushCurrentLine();
      currentLine = word;
    }
  }

  flushCurrentLine();
  return wrappedLines.length > 0 ? wrappedLines : ["(empty message)"];
}

export function renderCcReviewLogEntry(
  entry: CcReviewLogEntry,
  options: CcReviewLogRenderOptions = {}
): string[] {
  const severityMeta = LOG_SEVERITY_RENDER_META[entry.severity] ?? LOG_SEVERITY_RENDER_META.info;
  const source = normalizeOptionalText(entry.source, entry.pluginId || DEFAULT_LOG_SOURCE);
  const contextParts = [
    options.includeTimestamp === false ? "" : formatCcReviewLogTimestamp(entry.timestamp),
    options.includeSource === false ? "" : `[${source}]`,
  ].filter(Boolean);
  const prefix = `${severityMeta.icon} ${severityMeta.label.padEnd(5)} ${contextParts.join(" ")}: `;
  // Use visible column width (ANSI-aware, CJK-aware) rather than JS string
  // length so that wide characters in the icon or source label are counted
  // correctly.  This prevents the message portion from overflowing the terminal.
  const prefixVisibleWidth = measureVisibleWidth(prefix);
  const messageWrapWidth =
    options.maxLineWidth !== undefined
      ? Math.max(8, options.maxLineWidth - prefixVisibleWidth)
      : (options.maxMessageWidth ?? DEFAULT_LOG_MESSAGE_WRAP_WIDTH);
  const messageLines = wrapLogMessage(normalizeRenderableLogMessage(entry.message), messageWrapWidth);
  const continuationPrefix = " ".repeat(prefixVisibleWidth);

  return messageLines.map((line, index) => (index === 0 ? `${prefix}${line}` : `${continuationPrefix}${line}`));
}

// Defined severity ordering used by `filterCcReviewLogEntries`. Lower rank is
// less severe. Mirrors LOG_SEVERITY_ROLLUP_ORDER's intent but encodes a numeric
// threshold so callers can express "warning or worse" as a single comparison.
export const LOG_SEVERITY_RANK: Record<CcReviewLogSeverity, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
};

export interface FilterCcReviewLogEntriesOptions {
  /** Drop entries below this severity rank (`debug<info<warning<error`). */
  minSeverity?: CcReviewLogSeverity;
  /** Keep only entries whose `source` exactly matches an item in the allow-list. */
  sources?: readonly string[];
}

// Pure helper: return a new array of entries that satisfy an optional minimum
// severity and/or an optional source allow-list. Defaults to pass-through when
// no options (or an empty `{}` / `undefined`) are supplied, so widget callers
// can wire it in safely before any user-facing controls exist (reference
// pattern #8 in docs/log-display-reference-patterns.md). An empty allow-list
// (`sources: []`) intentionally yields an empty result, matching the "no
// sources enabled" toggle semantics. Unknown severities on input entries are
// treated as `info`, mirroring the existing summarizeLogSeverities convention.
export function filterCcReviewLogEntries(
  entries: readonly CcReviewLogEntry[] | null | undefined,
  options: FilterCcReviewLogEntriesOptions | undefined = {}
): CcReviewLogEntry[] {
  if (!entries || entries.length === 0) return [];
  const opts: FilterCcReviewLogEntriesOptions = options ?? {};
  const minRank =
    opts.minSeverity !== undefined && LOG_SEVERITY_RANK[opts.minSeverity] !== undefined
      ? LOG_SEVERITY_RANK[opts.minSeverity]
      : undefined;
  const allowedSources = opts.sources;
  const sourceSet = Array.isArray(allowedSources) ? new Set(allowedSources) : undefined;
  // Fast-path: no filters configured → pass-through copy.
  if (minRank === undefined && sourceSet === undefined) {
    return entries.slice();
  }
  const result: CcReviewLogEntry[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (minRank !== undefined) {
      const entrySeverity = SUPPORTED_LOG_SEVERITIES.includes(entry.severity as CcReviewLogSeverity)
        ? (entry.severity as CcReviewLogSeverity)
        : "info";
      if (LOG_SEVERITY_RANK[entrySeverity] < minRank) continue;
    }
    if (sourceSet !== undefined && !sourceSet.has(entry.source)) {
      continue;
    }
    result.push(entry);
  }
  return result;
}

// ---------------------------------------------------------------------------
// resolveSubagentTaskTimeoutMs: pure resolver for the per-attempt subagent
// execution timeout. Previously this was hardcoded to 300000ms (5 min), which
// killed real coding subagent runs mid-flight (exitCode 143 / SIGTERM) and was
// the single most frequent failure in the trace (see P0-1).
//
// Precedence: explicit `flag` (tool param / slash flag `--task-timeout`)
//           > `env.CC_REVIEW_TASK_TIMEOUT_MS`
//           > default 1800000 (30 min).
//
// A value of 0 means "no timeout" — the timer is not installed at all. Invalid
// input (negative, NaN, non-numeric) falls back to the default so a typo never
// disables the safety net silently.
// Display order for the severity rollup line: error first (most actionable),
// then warning, then info/debug. Mirrors the visual priority of
// LOG_SEVERITY_RENDER_META without re-encoding icons.
const LOG_SEVERITY_ROLLUP_ORDER: readonly CcReviewLogSeverity[] = ["error", "warning", "info", "debug"];

// Singular/plural pairs for the rollup line. "info" and "debug" are treated as
// mass nouns in TUI rollups (e.g. `5 info`), matching the prompt's example.
const LOG_SEVERITY_ROLLUP_LABELS: Record<CcReviewLogSeverity, { singular: string; plural: string }> = {
  error: { singular: "error", plural: "errors" },
  warning: { singular: "warning", plural: "warnings" },
  info: { singular: "info", plural: "info" },
  debug: { singular: "debug", plural: "debug" },
};

export interface SummarizeLogSeveritiesOptions {
  maxWidth?: number;
}

// Pure helper: counts entries by severity across the bounded liveLogs buffer
// and returns a single compact, width-bounded rollup line for the widget.
// - Mixed severities  → `Σ 1 error · 2 warnings · 5 info` (zero counts omitted)
// - Only info/debug   → `Σ no issues` (optionally suffixed with counts)
// - Empty input       → `Σ no logs`
// The output is always passed through `truncateForWidget` so a misconfigured
// caller cannot blow past the compact widget width.
export function summarizeLogSeverities(
  entries: readonly CcReviewLogEntry[] | null | undefined,
  options: SummarizeLogSeveritiesOptions = {}
): string {
  const maxWidth = options.maxWidth ?? WIDGET_MAX_WIDTH_DEFAULT;
  if (!entries || entries.length === 0) {
    return truncateForWidget("\u03a3 no logs", maxWidth);
  }

  const counts: Record<CcReviewLogSeverity, number> = { debug: 0, info: 0, warning: 0, error: 0 };
  for (const entry of entries) {
    const severity = entry && SUPPORTED_LOG_SEVERITIES.includes(entry.severity as CcReviewLogSeverity)
      ? (entry.severity as CcReviewLogSeverity)
      : "info";
    counts[severity] += 1;
  }

  const segments: string[] = [];
  for (const severity of LOG_SEVERITY_ROLLUP_ORDER) {
    const count = counts[severity];
    if (count <= 0) continue;
    const labels = LOG_SEVERITY_ROLLUP_LABELS[severity];
    segments.push(`${count} ${count === 1 ? labels.singular : labels.plural}`);
  }

  const hasIssue = counts.error > 0 || counts.warning > 0;
  let body: string;
  if (!hasIssue) {
    // Neutral 'no issues' style line when only info/debug entries are present.
    body = segments.length > 0 ? `\u03a3 no issues \u00b7 ${segments.join(" \u00b7 ")}` : "\u03a3 no issues";
  } else {
    body = `\u03a3 ${segments.join(" \u00b7 ")}`;
  }
  return truncateForWidget(body, maxWidth);
}

// ---------------------------------------------------------------------------
// Widget display helpers (learned from pi examples: todo.ts uses truncateToWidth,
// truncated-tool.ts persists full output to a file and surfaces the path).
// We intentionally don't import @earendil-works/pi-tui here so the extension
// stays runnable in test environments without pi's TUI runtime.
// ---------------------------------------------------------------------------

export const WIDGET_MAX_WIDTH_DEFAULT = 96;
const WIDGET_CHECKLIST_WINDOW = 8;

// ANSI-naive width truncation with ellipsis. Sufficient because cc-review widget
// lines are plain text (we strip ANSI when normalizing log messages).
export function truncatePersistedLogPathForWidget(
  filePath: string,
  maxWidth: number = WIDGET_MAX_WIDTH_DEFAULT
): string {
  const width = Math.max(12, Math.floor(maxWidth));
  if (filePath.length <= width) return filePath;
  const base = path.basename(filePath);
  const ellipsis = "\u2026";
  const tailBudget = base.length + ellipsis.length;
  if (tailBudget >= width) {
    return truncateForWidget(base, width);
  }
  const headChars = width - tailBudget;
  return `${filePath.slice(0, headChars)}${ellipsis}${base}`;
}

export function truncateForWidget(value: string, maxWidth: number = WIDGET_MAX_WIDTH_DEFAULT): string {
  const width = Math.max(8, Math.floor(maxWidth));
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return value.slice(0, width - 1) + "\u2026"; // single-char ellipsis
}

// Default character cap for `previewWidgetText`. The compact widget should
// never display long raw goals/prompts verbatim (see
// docs/plugin-log-surface-audit.md gap #4); the persisted log file and the
// final markdown summary keep the full text.
export const WIDGET_PREVIEW_MAX_LENGTH_DEFAULT = 80;

// Pure helper: produce a bounded single-line preview of long user-supplied
// text (typically the workflow goal or a task title) for compact widget
// surfaces. Collapses any run of whitespace/newlines/tabs into a single
// space, trims, then caps the result to `maxLength` characters with a
// single-char ellipsis (`\u2026`). Short, already-single-line inputs are
// returned unchanged. This is intentionally character-bounded (not
// width-bounded) so the outer `truncateForWidget` still owns terminal width
// safety and the two helpers compose without surprise.
export function previewWidgetText(
  value: string | null | undefined,
  maxLength: number = WIDGET_PREVIEW_MAX_LENGTH_DEFAULT
): string {
  if (value === null || value === undefined) return "";
  const collapsed = String(value).replace(/\s+/g, " ").trim();
  const cap = Math.max(1, Math.floor(maxLength));
  if (collapsed.length <= cap) return collapsed;
  if (cap <= 1) return collapsed.slice(0, cap);
  return collapsed.slice(0, cap - 1) + "\u2026"; // single-char ellipsis
}

export interface ChecklistWindowResult {
  startIndex: number;
  endIndex: number; // exclusive
  hiddenBefore: number;
  hiddenAfter: number;
}

// Pick a sliding window of tasks centered on the current task index when the
// total count exceeds `maxVisible`, preserving the head when no execution has
// started yet. Mirrors todo.ts's bounded list with a '... N more' affordance.
export function computeChecklistWindow(
  total: number,
  currentIndex: number,
  maxVisible: number = WIDGET_CHECKLIST_WINDOW
): ChecklistWindowResult {
  const visible = Math.max(1, Math.floor(maxVisible));
  if (total <= visible) {
    return { startIndex: 0, endIndex: total, hiddenBefore: 0, hiddenAfter: 0 };
  }
  // Before tasks start, anchor to the head so users see the full upcoming plan.
  if (currentIndex < 0) {
    return { startIndex: 0, endIndex: visible, hiddenBefore: 0, hiddenAfter: total - visible };
  }
  const half = Math.floor(visible / 2);
  let start = Math.max(0, currentIndex - half);
  let end = start + visible;
  if (end > total) {
    end = total;
    start = Math.max(0, end - visible);
  }
  return {
    startIndex: start,
    endIndex: end,
    hiddenBefore: start,
    hiddenAfter: total - end,
  };
}

// Mark whether the widget should surface a warning/cancelled state distinct from
// regular execution. Derived from data we already track in runCcReviewWorkflow.
export type CcReviewDisplayState =
  | "initializing"
  | "planning"
  | "executing"
  | "reviewing"
  | "retrying"
  | "warning"
  | "failed"
  | "cancelled"
  | "timeout"
  | "complete";

// Minimal theme surface for widget coloring. Matches pi's Theme.fg contract
// without importing @earendil-works/pi-tui at module load time.
export interface CcReviewWidgetTheme {
  fg: (color: string, text: string) => string;
}

const PLAIN_WIDGET_THEME: CcReviewWidgetTheme = {
  fg: (_color, text) => text,
};

let truncateToWidthFn: ((text: string, width: number) => string) | null | undefined;
let visibleWidthFn: ((text: string) => number) | null | undefined;

function getVisibleWidth(): ((text: string) => number) | undefined {
  if (visibleWidthFn === undefined) {
    try {
      const piTui = require("@earendil-works/pi-tui");
      visibleWidthFn = typeof piTui?.visibleWidth === "function" ? piTui.visibleWidth : null;
    } catch {
      visibleWidthFn = null;
    }
  }
  return visibleWidthFn ?? undefined;
}

// ---------------------------------------------------------------------------
// Column-width primitives
// ---------------------------------------------------------------------------
// Terminal cells occupied by Unicode East-Asian Wide / Fullwidth characters.
// Sourced from Unicode EAW = W (Wide) or F (Fullwidth) classifications,
// with conservative ranges that cover CJK ideographs, Hangul, fullwidth ASCII,
// and common ideographic symbols.  This is the single source of truth used by
// all width-measuring and truncation functions below.

function charWidth(code: number): 1 | 2 {
  // Supplementary-plane characters (>U+FFFF, i.e. codepoints encoded as
  // surrogate pairs in UTF-16) are rendered 2 columns wide by virtually
  // every modern terminal.  This covers emoji, CJK Extension B–G, historic
  // scripts, and other wide symbols without needing an exhaustive range
  // table that would inevitably miss new Unicode additions.
  if (code > 0xFFFF) return 2;
  // BMP East-Asian Wide / Fullwidth ranges.
  // Hangul Jamo
  if (code >= 0x1100 && code <= 0x115F) return 2;
  if (code === 0x2329 || code === 0x232A) return 2;
  // CJK Radicals, Kangxi, Ideographic Desc, CJK Symbols…
  if (code >= 0x2E80 && code <= 0x3247 && code !== 0x303F) return 2;
  // Enclosed CJK, CJK Compat Forms, CJK Ext A
  if (code >= 0x3250 && code <= 0x4DBF) return 2;
  // CJK Unified Ideographs, Yi
  if (code >= 0x4E00 && code <= 0xA4C6) return 2;
  // Hangul Jamo Extended-A
  if (code >= 0xA960 && code <= 0xA97C) return 2;
  // Hangul Syllables
  if (code >= 0xAC00 && code <= 0xD7A3) return 2;
  // CJK Compatibility Ideographs
  if (code >= 0xF900 && code <= 0xFAFF) return 2;
  // Vertical forms
  if (code >= 0xFE10 && code <= 0xFE19) return 2;
  // CJK Compatibility Forms
  if (code >= 0xFE30 && code <= 0xFE6B) return 2;
  // Fullwidth ASCII, Halfwidth Katakana range
  if (code >= 0xFF01 && code <= 0xFF60) return 2;
  // Fullwidth signs
  if (code >= 0xFFE0 && code <= 0xFFE6) return 2;
  return 1;
}

/** Count visible columns in a plain (ANSI-free) or ANSI-containing string. */
function countColumns(plain: string): number {
  let cols = 0;
  for (const cp of plain) {
    cols += charWidth(cp.codePointAt(0) ?? 0);
  }
  return cols;
}

/**
 * Truncate a *plain* (ANSI-free) string to at most `maxCols` visible columns,
 * appending an ellipsis when truncation occurs.  Returns the original if it
 * already fits.
 */
function truncatePlainByColumn(plain: string, maxCols: number): string {
  if (countColumns(plain) <= maxCols) return plain;
  const budget = Math.max(0, maxCols - 1); // −1 for ellipsis
  let cols = 0;
  let cut = 0;
  for (const cp of plain) {
    const w = charWidth(cp.codePointAt(0) ?? 0);
    if (cols + w > budget) break;
    cols += w;
    cut += cp.length; // handles surrogate pairs correctly
  }
  return plain.slice(0, cut) + "\u2026";
}

/**
 * Truncate a string that may contain ANSI escape codes while preserving them.
 * Uses `measureVisibleWidth` for the width check (ANSI-aware when pi-tui is
 * available) and walks the raw string code-point by code-point, accumulating
 * visible column cost only for the printable portion, so ANSI sequences are
 * carried through transparently.
 */
function truncateAnsiByColumn(text: string, maxCols: number): string {
  if (measureVisibleWidth(text) <= maxCols) return text;
  const budget = Math.max(0, maxCols - 1);
  let cols = 0;
  let cut = 0;
  let inEscape = false;
  // Walk the string as an array of code-point strings so `.length` is
  // always 1 or 2 (surrogate pair), never slicing mid-codepoint.
  const chars = Array.from(text);
  for (const ch of chars) {
    if (inEscape) {
      cut += ch.length;
      if (ch === "m") inEscape = false;
      continue;
    }
    if (ch === "\x1b") {
      inEscape = true;
      cut += ch.length;
      continue;
    }
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (cols + w > budget) break;
    cols += w;
    cut += ch.length;
  }
  return text.slice(0, cut) + "\u2026";
}

// ---------------------------------------------------------------------------
// pi-tui integration
// ---------------------------------------------------------------------------

// Measure visible (column) width of a string, ANSI-aware when pi-tui is available.
// Falls back to our CJK-aware column counter in headless / test environments.
export function measureVisibleWidth(text: string): number {
  const vw = getVisibleWidth();
  if (vw) return vw(text);
  return countColumns(stripAnsi(text));
}

// Build a visibleWidth-aware truncation function when pi-tui is available but
// does not export truncateToWidth.  The returned function is ANSI-preserving.
function buildVisibleWidthTruncate(
  vw: (text: string) => number
): (text: string, maxWidth: number) => string {
  return (text: string, maxWidth: number): string => {
    if (vw(text) <= maxWidth) return text;
    // When pi-tui's visibleWidth signals overflow but pi-tui has no native
    // truncator, fall back to our ANSI-safe column truncation using the same
    // CJK-width table as `countColumns`.  The fallback cannot guarantee
    // absolute consistency with pi-tui's width model for exotic emoji /
    // grapheme clusters, but it handles the dominant crash case (CJK-heavy
    // log lines) safely and preserves ANSI colour codes.
    return truncateAnsiByColumn(text, maxWidth);
  };
}

function getTruncateToWidth(): ((text: string, width: number) => string) | undefined {
  if (truncateToWidthFn === undefined) {
    try {
      const piTui = require("@earendil-works/pi-tui");
      if (typeof piTui?.truncateToWidth === "function") {
        truncateToWidthFn = piTui.truncateToWidth;
      } else if (typeof piTui?.visibleWidth === "function") {
        truncateToWidthFn = buildVisibleWidthTruncate(piTui.visibleWidth);
      } else {
        truncateToWidthFn = null;
      }
    } catch {
      truncateToWidthFn = null;
    }
  }
  return truncateToWidthFn ?? undefined;
}

// Width-safe truncation for widget lines.  Uses pi-tui's truncateToWidth when
// available (ANSI-aware); falls back to a CJK-aware column truncation for
// headless / test environments.  The fallback operates on ANSI-stripped text
// because headless renderers do not emit colour codes.
export function truncateWidgetLine(text: string, maxWidth: number = WIDGET_MAX_WIDTH_DEFAULT): string {
  const width = Math.max(8, Math.floor(maxWidth));
  const trunc = getTruncateToWidth();
  if (trunc) return trunc(text, width);
  // Headless / test fallback: strip ANSI and truncate by columns.
  return truncatePlainByColumn(stripAnsi(text), width);
}

export interface TaskModelState {
  configured?: string;
  effective?: string;
}

export interface CcReviewWidgetState {
  goal: string;
  tasks: readonly { title: string; status?: TaskStatus | "running"; model?: string; modelState?: TaskModelState }[];
  currentTaskIndex: number;
  displayState: CcReviewDisplayState;
  currentPhase: string;
  retryState?: { attempt: number; maxAttempts: number };
  lastTaskWarning?: string;
  liveLogs: readonly CcReviewLogEntry[];
  resolvedLogLevel: CcReviewLogSeverity;
  resolvedLogSources?: string[];
  resolvedWidgetLogLines?: number;
  resolvedChecklistWindow?: number;
  persistedLogPath: string;
  findingsRollup: CcReviewFindingsRollup;
  taskStatuses?: readonly (TaskStatus | "running" | undefined)[];
  taskModels?: readonly TaskModelState[];
}

export interface TaskVisuals {
  marker: string;
  markerColor: string;
  titleColor: string;
}

export function getTaskVisuals(status: TaskStatus | "running" | "pending"): TaskVisuals {
  switch (status) {
    case "completed":
      return {
        marker: "\u2714", // ✔
        markerColor: "success",
        titleColor: "dim",
      };
    case "completed_with_warnings":
      return {
        marker: "\u26a0", // ⚠️
        markerColor: "warning",
        titleColor: "warning",
      };
    case "failed":
      return {
        marker: "\u2718", // ✘
        markerColor: "error",
        titleColor: "error",
      };
    case "validation_failed":
      return {
        marker: "\u2716", // ✖
        markerColor: "error",
        titleColor: "error",
      };
    case "review_blocked":
      return {
        marker: "\u26d4", // ⛔
        markerColor: "error",
        titleColor: "error",
      };
    case "skipped":
      return {
        marker: "\u21aa", // ↪
        markerColor: "muted",
        titleColor: "dim",
      };
    case "cancelled":
      return {
        marker: "\u2298", // ⊘
        markerColor: "muted",
        titleColor: "dim",
      };
    case "running":
      return {
        marker: "\u25b8", // ▸
        markerColor: "accent",
        titleColor: "text",
      };
    case "pending":
    default:
      return {
        marker: "\u2610", // ☐
        markerColor: "dim",
        titleColor: "muted",
      };
  }
}

export interface BuildCcReviewWidgetLinesOptions {
  width?: number;
  theme?: CcReviewWidgetTheme;
}

function severityThemeColor(severity: CcReviewLogSeverity): string {
  if (severity === "error") return "error";
  if (severity === "warning") return "warning";
  if (severity === "info") return "muted";
  return "dim";
}

function colorizeSeverityRollup(
  entries: readonly CcReviewLogEntry[] | null | undefined,
  theme: CcReviewWidgetTheme
): string {
  if (!entries || entries.length === 0) {
    return theme.fg("dim", "\u03a3 no logs");
  }

  const counts: Record<CcReviewLogSeverity, number> = { debug: 0, info: 0, warning: 0, error: 0 };
  for (const entry of entries) {
    const severity = entry && SUPPORTED_LOG_SEVERITIES.includes(entry.severity as CcReviewLogSeverity)
      ? (entry.severity as CcReviewLogSeverity)
      : "info";
    counts[severity] += 1;
  }

  const segments: string[] = [];
  for (const severity of LOG_SEVERITY_ROLLUP_ORDER) {
    const count = counts[severity];
    if (count <= 0) continue;
    const labels = LOG_SEVERITY_ROLLUP_LABELS[severity];
    const label = `${count} ${count === 1 ? labels.singular : labels.plural}`;
    segments.push(theme.fg(severityThemeColor(severity), label));
  }

  const hasIssue = counts.error > 0 || counts.warning > 0;
  if (!hasIssue) {
    if (segments.length > 0) {
      return `${theme.fg("success", "\u03a3 no issues")} ${theme.fg("dim", "\u00b7")} ${segments.join(` ${theme.fg("dim", "\u00b7")} `)}`;
    }
    return theme.fg("success", "\u03a3 no issues");
  }
  return `${theme.fg("muted", "\u03a3")} ${segments.join(` ${theme.fg("dim", "\u00b7")} `)}`;
}

// Merge the current phase label with the live-log severity rollup on one line.
export function formatPhaseSeverityLine(
  phase: string,
  liveLogs: readonly CcReviewLogEntry[] | null | undefined,
  options: { theme?: CcReviewWidgetTheme } = {}
): string {
  const theme = options.theme ?? PLAIN_WIDGET_THEME;
  const phasePart = theme.fg("accent", `\u26a1 ${phase}`);
  const rollupPart = colorizeSeverityRollup(liveLogs, theme);
  return `${phasePart} ${theme.fg("dim", "\u00b7")} ${rollupPart}`;
}

export function buildCcReviewWidgetLines(
  state: CcReviewWidgetState,
  options: BuildCcReviewWidgetLinesOptions = {}
): string[] {
  const width = options.width ?? WIDGET_MAX_WIDTH_DEFAULT;
  const theme = options.theme ?? PLAIN_WIDGET_THEME;
  const findingsRollup = state.findingsRollup ?? emptyFindingsRollup();
  const lines: string[] = [];
  const isCompact = width < 50;

  // 1. Goal Line
  if (isCompact) {
    lines.push(
      truncateWidgetLine(
        `${theme.fg("accent", "\ud83c\udfaf")} ${theme.fg("muted", previewWidgetText(state.goal, width - 4))}`,
        width
      )
    );
  } else {
    lines.push(
      truncateWidgetLine(
        `${theme.fg("accent", "\ud83c\udfaf")} ${theme.fg("text", "Goal:")} ${theme.fg("muted", previewWidgetText(state.goal))}`,
        width
      )
    );
  }

  // 2. Decorative Divider
  if (!isCompact) {
    lines.push(truncateWidgetLine(theme.fg("borderMuted", "\u2501".repeat(Math.min(50, width))), width));
  }

  // 3. Tasks List
  if (state.tasks.length === 0) {
    const waiting =
      state.displayState === "planning"
        ? theme.fg("warning", "  \u2699 Planning tasks\u2026")
        : theme.fg("dim", "  \u23f3 Waiting for planner output\u2026");
    lines.push(truncateWidgetLine(waiting, width));
  } else {
    const checklistWindowSize = isCompact ? 1 : (state.resolvedChecklistWindow ?? WIDGET_CHECKLIST_WINDOW);
    const window = computeChecklistWindow(
      state.tasks.length,
      state.currentTaskIndex,
      checklistWindowSize
    );
    if (!isCompact && window.hiddenBefore > 0) {
      lines.push(
        truncateWidgetLine(
          theme.fg("dim", `  \u2026 ${window.hiddenBefore} earlier task${window.hiddenBefore === 1 ? "" : "s"}`),
          width
        )
      );
    }
    for (let i = window.startIndex; i < window.endIndex; i++) {
      const task = state.tasks[i];
      let status: TaskStatus | "running" | "pending";
      const explicitStatus = state.taskStatuses?.[i] ?? task.status;
      if (explicitStatus) {
        status = explicitStatus;
      } else if (i < state.currentTaskIndex) {
        status = "completed";
      } else if (i === state.currentTaskIndex) {
        status = "running";
      } else {
        status = "pending";
      }

      const visuals = getTaskVisuals(status);
      const marker = theme.fg(visuals.markerColor, visuals.marker);
      const titleColor = visuals.titleColor;

      const title = previewWidgetText(task.title, width - 16);
      const taskLabel = theme.fg("muted", `[Task ${i + 1}/${state.tasks.length}]`);
      const styledTitle = theme.fg(titleColor, title);
      let modelPart = "";
      if (status !== "pending") {
        const modelName = task.model;
        if (modelName) {
          modelPart = ` ${theme.fg("muted", `[${modelName}]`)}`;
        } else if (shouldShowUnknownTaskModel(status, task.modelState)) {
          modelPart = ` ${theme.fg("muted", `[Unknown model]`)}`;
        }
      }
      lines.push(truncateWidgetLine(`  ${marker} ${taskLabel}${modelPart} ${styledTitle}`, width));
    }
    if (!isCompact && window.hiddenAfter > 0) {
      lines.push(
        truncateWidgetLine(
          theme.fg("dim", `  \u2026 ${window.hiddenAfter} later task${window.hiddenAfter === 1 ? "" : "s"}`),
          width
        )
      );
    }
  }

  // 4. Decorative Divider
  if (!isCompact) {
    lines.push(truncateWidgetLine(theme.fg("borderMuted", "\u2501".repeat(Math.min(50, width))), width));
  }

  // 5. Phase / Severity Status (Always display)
  lines.push(truncateWidgetLine(formatPhaseSeverityLine(state.currentPhase, state.liveLogs, { theme }), width));

  // 6. Findings (Skip in compact mode)
  if (!isCompact) {
    lines.push(truncateWidgetLine(theme.fg("muted", formatFindingsRollupLine(findingsRollup)), width));
  }

  // 7. Exceptional/Error indicators (Prioritized, always kept)
  if (state.displayState === "warning" && state.lastTaskWarning) {
    lines.push(
      truncateWidgetLine(
        `${theme.fg("warning", "\u26a0 Warning:")} ${theme.fg("warning", state.lastTaskWarning)}`,
        width
      )
    );
  } else if (state.displayState === "cancelled") {
    lines.push(truncateWidgetLine(theme.fg("error", "\u26d4 Cancelled by user"), width));
  } else if (state.displayState === "timeout") {
    lines.push(truncateWidgetLine(theme.fg("error", "\u23f1 Timed out"), width));
  } else if (state.displayState === "failed") {
    lines.push(truncateWidgetLine(theme.fg("error", "\u2716 Workflow failed"), width));
  }

  // 8. Live Logs Section Header (Skip in compact mode)
  if (!isCompact) {
    if (state.resolvedLogSources !== undefined) {
      const sourcesText = state.resolvedLogSources.length > 0 ? state.resolvedLogSources.join(", ") : "none";
      lines.push(
        truncateWidgetLine(
          theme.fg("text", `\ud83d\udcdd Live Logs (sources: ${sourcesText}):`),
          width
        )
      );
    } else {
      lines.push(truncateWidgetLine(theme.fg("text", "\ud83d\udcdd Live Logs:"), width));
    }
  }

  // 9. Live Logs Tail
  if (state.liveLogs.length === 0) {
    if (!isCompact) {
      lines.push(truncateWidgetLine(theme.fg("dim", "   (No logs yet \u2014 waiting for activity)"), width));
    }
  } else {
    const filteredLiveLogs = filterCcReviewLogEntries(state.liveLogs, {
      minSeverity: state.resolvedLogLevel,
      sources: state.resolvedLogSources,
    });
    const totalCount = state.liveLogs.filter(e => e).length;
    const hiddenCount = totalCount - filteredLiveLogs.length;

    const collapsed = collapseConsecutiveLogEntries(filteredLiveLogs);
    filteredLiveLogs.length = 0;
    filteredLiveLogs.push(...collapsed);
    const defaultTailLength = isCompact ? 3 : 5;
    const tailLength = state.resolvedWidgetLogLines ?? defaultTailLength;
    const recentLogs = tailLength > 0 ? filteredLiveLogs.slice(-tailLength) : [];
    for (const entry of recentLogs) {
      // In compact mode, we omit timestamps and source tags to conserve narrow columns
      const rendered = isCompact
        ? renderCcReviewLogEntry(entry, { maxLineWidth: width - 3, includeTimestamp: false, includeSource: false })
        : renderCcReviewLogEntry(entry, { maxLineWidth: width - 3 });
      const color = severityThemeColor(entry.severity);
      for (const line of rendered) {
        // Defensively truncate the plain-text line before wrapping it in
        // ANSI codes and the 3-space indent.  renderCcReviewLogEntry uses
        // measureVisibleWidth for its wrap budget, but we guard here too in
        // case a single token (e.g. a URL or JSON blob) exceeds the budget.
        const safeLine = truncateWidgetLine(line, width - 3);
        lines.push(truncateWidgetLine(`   ${theme.fg(color, safeLine)}`, width));
      }
    }
    if (hiddenCount > 0) {
      const hintText = `${hiddenCount} log${hiddenCount === 1 ? "" : "s"} hidden`;
      const lineText = `   (${hintText})`;
      lines.push(truncateWidgetLine(theme.fg("dim", lineText), width));
    }
  }

  // 10. Persisted log path (Skip in compact mode)
  if (!isCompact) {
    lines.push(
      truncateWidgetLine(
        `${theme.fg("muted", "\ud83d\udcc4 Full log:")} ${theme.fg(
          "dim",
          truncatePersistedLogPathForWidget(state.persistedLogPath, Math.max(12, width - 14))
        )}`,
        width
      )
    );
  }
  return lines;
}

export interface CcReviewStatusState {
  tasks: readonly unknown[];
  currentTaskIndex: number;
  displayState: CcReviewDisplayState;
  retryState?: { attempt: number; maxAttempts: number };
  currentPhase?: string;
}

export function getStatusColorForDisplayState(displayState: CcReviewDisplayState): "accent" | "success" | "warning" | "error" {
  switch (displayState) {
    case "initializing":
    case "planning":
    case "executing":
    case "reviewing":
      return "accent";
    case "complete":
      return "success";
    case "retrying":
    case "warning":
      return "warning";
    case "cancelled":
    case "timeout":
    case "failed":
      return "error";
    default:
      return "accent";
  }
}

export function buildCcReviewStatusText(state: CcReviewStatusState): string {
  const total = state.tasks.length;
  let body: string;

  if (state.displayState === "complete" || (total > 0 && state.currentTaskIndex >= total)) {
    body = `Task ${total}/${total} Complete`;
  } else if (state.displayState === "planning" || state.displayState === "initializing") {
    body = total > 0 ? `Task 0/${total} Planning` : "Planning";
  } else if (total > 0 && state.currentTaskIndex >= 0) {
    body = `Task ${state.currentTaskIndex + 1}/${total}`;
    if (state.displayState === "reviewing") body += " Reviewing";
    else if (state.displayState === "executing") body += " Executing";
    else if (state.displayState === "retrying") body += " Retrying";
    else if (state.displayState === "warning") body += " Warning";
    else if (state.displayState === "failed") body += " Failed";
    else if (state.displayState === "cancelled") body += " Cancelled";
    else if (state.displayState === "timeout") body += " Timeout";
  } else {
    if (state.displayState === "cancelled") {
      body = "Cancelled";
    } else if (state.displayState === "timeout") {
      body = "Timeout";
    } else if (state.displayState === "failed") {
      body = "Failed";
    } else {
      body = state.currentPhase ?? "Running";
    }
  }

  let text = `[CC Review] ${body}`;
  if (state.retryState) {
    text += ` \u27f3${state.retryState.attempt}/${state.retryState.maxAttempts}`;
  }
  return text;
}
