import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Structured-output strict mode (P1-2).
//
// CC Review currently asks the worker to end its final response with a JSON
// object and then extracts the last balanced JSON object from the text. This
// is compatible but prose-dependent — a plausible "done" response without
// actual structured output can pass.
//
// This module adds a strict mode where the worker must write its structured
// result to a designated output file (path passed via the prompt). If the
// file is missing or invalid, the step fails clearly. The existing text-JSON
// parser remains as a compatibility fallback when strict mode is disabled.
//
// Design:
//   * Default OFF — text-JSON extraction remains the default.
//   * Gated by `CC_REVIEW_STRUCTURED_OUTPUT_STRICT=1`.
//   * When enabled, the prompt includes an instruction to write the JSON
//     result to `<artifactRunDir>/structured/task-<index>.json`.
//   * After execution, the file is read and schema-validated.
//   * The result source (`structured_output` | `text_json` | `fallback_text`)
//     is recorded in the validation result for artifact reporting.
// ---------------------------------------------------------------------------

export const CC_REVIEW_STRUCTURED_OUTPUT_STRICT_ENV = "CC_REVIEW_STRUCTURED_OUTPUT_STRICT";

export type StructuredOutputSource =
  | "structured_output" // strict mode: read from designated output file
  | "text_json"         // compatibility: extracted last balanced JSON from text
  | "fallback_text";    // no structured data, text validation only

export interface StructuredOutputStrictConfig {
  enabled: boolean;
}

export function resolveStructuredOutputStrict(
  env: NodeJS.ProcessEnv = process.env,
): StructuredOutputStrictConfig {
  const raw = env[CC_REVIEW_STRUCTURED_OUTPUT_STRICT_ENV];
  if (raw === undefined || raw === "") return { enabled: false };
  const normalized = String(raw).trim().toLowerCase();
  return { enabled: normalized === "1" || normalized === "true" || normalized === "yes" };
}

export interface StructuredOutputFileResolution {
  /** Absolute path to the designated structured output file. */
  outputPath: string;
  /** Prompt section instructing the worker to write structured output there. */
  promptInstruction: string;
}

/**
 * Resolve the structured output file path and prompt instruction for a task.
 * Returns undefined when strict mode is disabled (no file-based contract).
 */
export function resolveStructuredOutputFile(
  artifactRunDir: string,
  taskIndex: number,
  config: StructuredOutputStrictConfig,
): StructuredOutputFileResolution | undefined {
  if (!config.enabled) return undefined;
  const dir = path.join(artifactRunDir, "structured");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort; the worker will fail to write and the step will fail clearly
  }
  const outputPath = path.join(dir, `task-${taskIndex}.json`);
  const promptInstruction = [
    "Structured output (REQUIRED):",
    `Write your final structured result as a JSON object to exactly this file path: ${outputPath}`,
    "Do not wrap it in markdown code fences. Write only the JSON object to the file.",
    'The JSON shape must be: {"status":"completed|partial|blocked","summary":"...","filesChanged":["path"],"unresolvedItems":[],"acceptanceCriteria":[{"criterion":"...","status":"met|not_met|unknown","evidence":"..."}]}',
    "If you cannot complete the task, still write a JSON object with status \"blocked\" and an explanation in summary.",
  ].join("\n");
  return { outputPath, promptInstruction };
}

export interface StructuredOutputFileResult {
  /** The parsed JSON object, or undefined if the file was missing/invalid. */
  parsed: unknown;
  /** Whether the file existed and contained valid JSON. */
  found: boolean;
  /** Error message if the file was missing or invalid. */
  error?: string;
}

/**
 * Read and parse the structured output file written by the worker.
 * Returns `{ found: false }` when the file doesn't exist (strict mode failure).
 */
export function readStructuredOutputFile(outputPath: string): StructuredOutputFileResult {
  if (!fs.existsSync(outputPath)) {
    return {
      parsed: undefined,
      found: false,
      error: `Structured output file not found: ${outputPath}. The worker did not write the required structured result.`,
    };
  }
  let content: string;
  try {
    content = fs.readFileSync(outputPath, "utf-8").trim();
  } catch (err: any) {
    return {
      parsed: undefined,
      found: true,
      error: `Failed to read structured output file: ${err?.message ?? String(err)}`,
    };
  }
  if (!content) {
    return {
      parsed: undefined,
      found: true,
      error: `Structured output file is empty: ${outputPath}`,
    };
  }
  // Strip markdown code fences if the worker wrapped the JSON.
  const fenceMatch = content.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fenceMatch) {
    content = fenceMatch[1]!.trim();
  }
  try {
    return { parsed: JSON.parse(content), found: true };
  } catch (err: any) {
    return {
      parsed: undefined,
      found: true,
      error: `Structured output file contains invalid JSON: ${err?.message ?? String(err)}`,
    };
  }
}
