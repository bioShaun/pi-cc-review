import {
  parseSubagentStructuredReport,
  validateStructuredSubagentReport,
  type SchemaParseStatus,
} from "../structured.ts";
import type { Task } from "./dependencies.ts";
import type { SubagentToolResult, SubagentValidation } from "./types.ts";

function extractSubagentText(result: SubagentToolResult): string {
  const parts = result.content ?? [];
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .trim();
}

function validateSubagentOutputTextHeuristics(textContent: string, structuredStatus: SchemaParseStatus): SubagentValidation {
  const unresolvedItems: string[] = [];
  const lines = textContent.split("\n");
  for (const line of lines) {
    const lowerLine = line.toLowerCase();
    if (lowerLine.includes("todo:") || lowerLine.includes("fixme:") || lowerLine.includes("unresolved:") || lowerLine.includes("pending:")) {
      unresolvedItems.push(line.trim());
    } else if (
      /^\s*(could not|failed to|unable to)\b/i.test(line) &&
      !lowerLine.includes("no issues found") &&
      !lowerLine.includes("zero")
    ) {
      unresolvedItems.push(line.trim());
    }
  }

  return {
    valid: unresolvedItems.length === 0,
    error: unresolvedItems.length > 0 ? "Subagent reported unresolved work" : undefined,
    unresolvedItems: unresolvedItems.length > 0 ? unresolvedItems : undefined,
    schemaParseStatus: structuredStatus === "absent" ? "fallback_text" : structuredStatus,
  };
}

export interface ValidateSubagentOutputOptions {
  /** When false (default), missing/invalid trailing JSON is validation_failed. */
  allowTextValidation?: boolean;
}

export function validateSubagentOutput(
  result: SubagentToolResult,
  task: Task,
  options: ValidateSubagentOutputOptions = {}
): SubagentValidation {
  const allowTextValidation = options.allowTextValidation === true;

  if (!result) {
    return {
      valid: false,
      error: "No result returned from subagent",
      unresolvedItems: ["No result returned from subagent"],
      schemaParseStatus: "absent",
    };
  }
  const subagentResultDetail = result.details?.results?.[0];
  const textContent = extractSubagentText(result);

  if (result.isError) {
    const error = subagentResultDetail?.errorMessage || subagentResultDetail?.stderr || textContent || "Subagent flagged an execution error (isError: true)";
    return {
      valid: false,
      error,
      unresolvedItems: [error],
      schemaParseStatus: "absent",
    };
  }

  if (subagentResultDetail && typeof subagentResultDetail.exitCode === "number" && subagentResultDetail.exitCode !== 0) {
    const error = subagentResultDetail.errorMessage || subagentResultDetail?.stderr || `Subagent process exited with non-zero code ${subagentResultDetail.exitCode}`;
    return {
      valid: false,
      error,
      unresolvedItems: [error],
      schemaParseStatus: "absent",
    };
  }

  if (!textContent) {
    return {
      valid: false,
      error: "Subagent returned empty or missing text content",
      unresolvedItems: ["Subagent returned empty or missing text content"],
      schemaParseStatus: "absent",
    };
  }

  const structured = parseSubagentStructuredReport(textContent);
  if (structured.status === "parsed" && structured.report) {
    const structuredValidation = validateStructuredSubagentReport(structured.report);
    return {
      ...structuredValidation,
      structuredReport: structured.report,
      schemaParseStatus: structured.status,
    };
  }
  if (structured.status === "invalid_schema") {
    return {
      valid: false,
      error: "Subagent structured report failed schema validation",
      unresolvedItems: ["Invalid structured subagent JSON schema"],
      schemaParseStatus: structured.status,
    };
  }

  if (!allowTextValidation) {
    const parseError =
      structured.status === "absent"
        ? "Subagent response missing valid trailing JSON structured report"
        : `Subagent structured report parse failed (${structured.status})`;
    return {
      valid: false,
      error: parseError,
      unresolvedItems: [parseError],
      schemaParseStatus: structured.status,
    };
  }

  return validateSubagentOutputTextHeuristics(textContent, structured.status);
}

export function summarizeValidationParseFailures(taskResults: Array<{ title: string; schemaParseStatus?: SchemaParseStatus; validationError?: string }>): string[] {
  const lines: string[] = [];
  for (let i = 0; i < taskResults.length; i++) {
    const tr = taskResults[i];
    if (tr.schemaParseStatus === "fallback_text" || tr.schemaParseStatus === "absent" || tr.schemaParseStatus === "invalid_schema") {
      if (tr.validationError) {
        lines.push(`Task ${i + 1} (${tr.title}): ${tr.validationError} [parse: ${tr.schemaParseStatus}]`);
      }
    }
  }
  return lines;
}
