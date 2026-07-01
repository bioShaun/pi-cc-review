import type { BlockReason, ReviewFinding, ReviewResult } from "../structured.ts";

export function buildRepairFeedback(
  reviewResult: ReviewResult | null,
  blockReason: BlockReason | undefined,
  findings: ReviewFinding[],
  postReviewValidation?: {
    error: string | null;
    commands: Array<{
      command: string;
      args: string[];
      exitCode: number;
      stderr: string;
      timedOut: boolean;
    }>;
  }
): string {
  const parts: string[] = [];
  const verdict = reviewResult?.verdict ?? "block";
  parts.push(
    verdict === "block"
      ? `Reviewer verdict: block (${blockReason ?? "explicit_block"})`
      : `Reviewer verdict: ${verdict}`
  );
  if (reviewResult?.summary) {
    parts.push(`Reviewer summary: ${reviewResult.summary}`);
  }
  const unfixed = findings.filter((f) => f.status === "unfixed");
  if (unfixed.length > 0) {
    parts.push("Unfixed findings to address:");
    for (const f of unfixed) {
      const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "workspace";
      parts.push(`- [${f.priority}] ${loc}: ${f.message}`);
    }
  }
  if (reviewResult?.postFixValidation?.status === "failed") {
    parts.push(`Post-fix validation failed: ${reviewResult.postFixValidation.evidence ?? "no evidence provided"}`);
  }
  if (postReviewValidation?.error) {
    parts.push(`Orchestrator post-review validation failed: ${postReviewValidation.error}`);
    for (const command of postReviewValidation.commands.filter(
      (result) => result.timedOut || result.exitCode !== 0
    )) {
      const invocation = [command.command, ...command.args].join(" ");
      const rawDiagnostic = command.stderr.trim();
      const diagnostic = rawDiagnostic.length > 2000
        ? `${rawDiagnostic.slice(0, 1999)}…`
        : rawDiagnostic;
      parts.push(
        `- ${invocation}: ${command.timedOut ? "timed out" : `exit code ${command.exitCode}`}` +
        (diagnostic ? `\n  ${diagnostic}` : "")
      );
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Cross-task handoff
//
// `buildPriorTaskHandoff` produces a compact, bounded "Prior Tasks (Handoff)"
// block that is injected into each subsequent task's subagent prompt so
// downstream worker runs can build on what earlier tasks delivered.
//
// Design constraints (per sprint contract):
//   * Includes ONLY structured fields: title, verdict (effectiveVerdict ?? status),
//     structuredReport.summary, filesChanged, unresolvedItems.
//   * NEVER includes raw model output (TaskResult.output), reviewer stdout/stderr,
//     log fragments, or `reviewResult.findings[*].message` (reviewer prose).
//   * Total length is hard-capped (default 4096 chars). When the natural
//     rendering exceeds the cap, the string is truncated and a stable marker
//     `… (truncated)` is appended so the worker knows context was elided.
//   * Per-task fields are also individually clipped (summary ≤ 400 chars,
//     filesChanged ≤ 12 items, unresolvedItems ≤ 8 items) to keep one large
//     task from starving later ones.
// ---------------------------------------------------------------------------
