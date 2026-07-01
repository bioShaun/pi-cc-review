import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const WORKFLOW_ARTIFACT_DIR = "cc-review-artifacts";

export type SubagentStatus = "completed" | "partial" | "blocked";
export type CriterionStatus = "met" | "not_met" | "unknown";
export type ReviewVerdict = "ship" | "ship_with_warnings" | "block";
export type FindingStatus = "fixed" | "unfixed" | "not_applicable";
export type FindingPriority = "P0" | "P1" | "P2" | "P3";
export type SchemaParseStatus = "parsed" | "invalid_schema" | "fallback_text" | "absent";
export type ReviewParseStatus =
  | "parsed"
  | "invalid_schema"
  | "fallback_exit_code"
  | "fallback_synthetic"
  | "absent";
export type BlockReason =
  | "explicit_block"
  | "unfixed_high_severity"
  | "ambiguous_high_severity"
  | "post_review_validation_failed";

export type TaskStatus =
  | "completed"
  | "completed_with_warnings"
  | "failed"
  | "validation_failed"
  | "review_blocked"
  | "skipped"
  | "cancelled";

export interface AcceptanceCriterionResult {
  criterion: string;
  status: CriterionStatus;
  evidence?: string;
}

export interface SubagentStructuredReport {
  status: SubagentStatus;
  summary: string;
  filesChanged?: string[];
  unresolvedItems?: string[];
  acceptanceCriteria?: AcceptanceCriterionResult[];
}

export interface ReviewFinding {
  priority: FindingPriority;
  confidence: number;
  file?: string;
  message: string;
  status: FindingStatus;
  line?: number;
}

export interface PostFixValidation {
  status: "passed" | "failed";
  evidence?: string;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  postFixValidation?: PostFixValidation;
}

export interface VerificationCommand {
  command: string;
  args: string[];
  timeoutMs?: number;
}

export interface VerificationCommandResult {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  startedAt: string;
  completedAt: string;
}

export interface ProcessCapture {
  exitCode: number;
  stdout: string;
  stderr: string;
  combinedOutput: string;
}

export interface TaskArtifactTask {
  title: string;
  description: string;
  acceptanceCriteria: string;
}

export interface TaskArtifact {
  schemaVersion: 1;
  runId: string;
  taskIndex: number;
  task: TaskArtifactTask;
  execution: {
    exitCode: number;
    status: string;
    rawOutput: string;
    structuredReport: SubagentStructuredReport | null;
    schemaParseStatus: SchemaParseStatus;
    model?: string;
  };
  review: {
    provider: string;
    reviewerExitCode: number;
    stdout: string;
    stderr: string;
    combinedOutput: string;
    reviewParseStatus: ReviewParseStatus;
    reportedVerdict: ReviewVerdict | null;
    effectiveVerdict: ReviewVerdict | null;
    blockReason: BlockReason | null;
    fallbackApplied: boolean;
    result: ReviewResult | null;
  };
  validation: {
    valid: boolean;
    error: string | null;
    unresolvedItems: string[];
  };
  postReviewValidation: {
    required: boolean;
    workspaceChanged: boolean;
    passed: boolean;
    error: string | null;
    commands: VerificationCommandResult[];
  };
  workflow: {
    haltedOnReview: boolean;
    haltedOnExecution: boolean;
  };
  timestamps: {
    startedAt: string;
    completedAt: string;
  };
}

export interface CcReviewFindingsPayload {
  kind: "task" | "rollup";
  partial?: boolean;
  taskIndex?: number;
  taskTitle?: string;
  reportedVerdict: ReviewVerdict | null;
  effectiveVerdict: ReviewVerdict;
  blockReason?: BlockReason;
  summary: string;
  findings: ReviewFinding[];
  artifactPath: string;
  counts: { p0: number; p1: number; p2: number; p3: number; unfixed: number };
}

export interface CcReviewSummaryMeta {
  taskOutcomes: {
    review_blocked: number;
    failed: number;
    warning: number;
    completed: number;
    cancelled: number;
  };
  topBlockers: ReviewFinding[];
}

export interface CcReviewFindingsRollup {
  tasksReviewed: number;
  ship: number;
  shipWithWarnings: number;
  blocked: number;
  unfixedP0: number;
  unfixedP1: number;
  unfixedP2P3: number;
}

export function emptyFindingsRollup(): CcReviewFindingsRollup {
  return {
    tasksReviewed: 0,
    ship: 0,
    shipWithWarnings: 0,
    blocked: 0,
    unfixedP0: 0,
    unfixedP1: 0,
    unfixedP2P3: 0,
  };
}

export function generateWorkflowRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "000Z");
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${stamp}-${suffix}`;
}

export function getArtifactRunDir(cwd: string, runId: string): string {
  return path.join(cwd, WORKFLOW_ARTIFACT_DIR, runId);
}

export function formatTaskArtifactFileName(taskIndex: number): string {
  return `task-${String(taskIndex + 1).padStart(3, "0")}.json`;
}

export function writeTaskArtifact(cwd: string, runId: string, artifact: TaskArtifact): string {
  const runDir = getArtifactRunDir(cwd, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const fileName = formatTaskArtifactFileName(artifact.taskIndex);
  const finalPath = path.join(runDir, fileName);
  const tmpPath = `${finalPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(artifact, null, 2), "utf8");
  fs.renameSync(tmpPath, finalPath);
  return finalPath;
}

const WORKSPACE_SNAPSHOT_EXCLUDES = new Set([
  WORKFLOW_ARTIFACT_DIR,
  ".cc-review",
  "workflow-logs.jsonl",
  "workflow-trace.jsonl",
  "node_modules",
  ".git",
]);

function shouldExcludeSnapshotPath(relativePath: string): boolean {
  const parts = relativePath.split(path.sep);
  if (parts.some((part) => WORKSPACE_SNAPSHOT_EXCLUDES.has(part))) return true;
  if (relativePath.endsWith(".tmp")) return true;
  return false;
}

export type WorkspaceSnapshot = Map<string, { mtimeMs: number; size: number }>;

export function snapshotWorkspace(cwd: string): WorkspaceSnapshot {
  const snapshot: WorkspaceSnapshot = new Map();
  const stack = [""];
  while (stack.length > 0) {
    const relativeDir = stack.pop()!;
    const absoluteDir = relativeDir ? path.join(cwd, relativeDir) : cwd;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      if (shouldExcludeSnapshotPath(relativePath)) continue;
      const absolutePath = path.join(cwd, relativePath);
      if (entry.isDirectory()) {
        stack.push(relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(absolutePath);
        snapshot.set(relativePath, { mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        // ignore unreadable files
      }
    }
  }
  return snapshot;
}

export function workspaceSnapshotChanged(before: WorkspaceSnapshot, after: WorkspaceSnapshot): boolean {
  if (before.size !== after.size) return true;
  for (const [filePath, beforeMeta] of before) {
    const afterMeta = after.get(filePath);
    if (!afterMeta) return true;
    if (afterMeta.mtimeMs !== beforeMeta.mtimeMs || afterMeta.size !== beforeMeta.size) return true;
  }
  for (const filePath of after.keys()) {
    if (!before.has(filePath)) return true;
  }
  return false;
}

export function extractBalancedJsonObject(raw: string, position: "first" | "last" = "first"): string | undefined {
  if (!raw) return undefined;
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/gi);
  const candidates: string[] = [];
  if (fenceMatch) {
    for (const fence of fenceMatch) {
      const inner = fence.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
      candidates.push(inner);
    }
  }
  candidates.push(raw);

  const found: string[] = [];
  for (const candidate of candidates) {
    let searchFrom = 0;
    while (searchFrom < candidate.length) {
      const start = candidate.indexOf("{", searchFrom);
      if (start === -1) break;
      let depth = 0;
      let inString = false;
      let escape = false;
      let end = -1;
      for (let i = start; i < candidate.length; i++) {
        const ch = candidate[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (inString && ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) break;
      found.push(candidate.substring(start, end + 1));
      if (position === "first") {
        return found[0];
      }
      searchFrom = end + 1;
    }
  }
  if (found.length === 0) return undefined;
  return position === "last" ? found[found.length - 1] : found[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length === value.length ? items : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseCriterionStatus(value: unknown): CriterionStatus | undefined {
  return value === "met" || value === "not_met" || value === "unknown" ? value : undefined;
}

export function parseSubagentStructuredReport(
  text: string
): { report: SubagentStructuredReport | null; status: SchemaParseStatus } {
  const jsonText = extractBalancedJsonObject(text, "last");
  if (!jsonText) return { report: null, status: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { report: null, status: "fallback_text" };
  }
  if (!isRecord(parsed)) return { report: null, status: "invalid_schema" };
  const status = parsed.status;
  const summary = asString(parsed.summary);
  if (
    (status !== "completed" && status !== "partial" && status !== "blocked") ||
    !summary
  ) {
    return { report: null, status: "invalid_schema" };
  }
  const report: SubagentStructuredReport = { status, summary };
  const filesChanged = asStringArray(parsed.filesChanged);
  if (filesChanged) report.filesChanged = filesChanged;
  const unresolvedItems = asStringArray(parsed.unresolvedItems);
  if (unresolvedItems) report.unresolvedItems = unresolvedItems;
  if (Array.isArray(parsed.acceptanceCriteria)) {
    const criteria: AcceptanceCriterionResult[] = [];
    for (const item of parsed.acceptanceCriteria) {
      if (!isRecord(item)) return { report: null, status: "invalid_schema" };
      const criterion = asString(item.criterion);
      const criterionStatus = parseCriterionStatus(item.status);
      if (!criterion || !criterionStatus) return { report: null, status: "invalid_schema" };
      criteria.push({
        criterion,
        status: criterionStatus,
        evidence: asString(item.evidence),
      });
    }
    report.acceptanceCriteria = criteria;
  }
  return { report, status: "parsed" };
}

export function validateStructuredSubagentReport(report: SubagentStructuredReport): {
  valid: boolean;
  error?: string;
  unresolvedItems?: string[];
} {
  const unresolvedItems: string[] = [...(report.unresolvedItems ?? [])];
  if (report.status === "partial" || report.status === "blocked") {
    unresolvedItems.push(`Subagent reported status: ${report.status}`);
  }
  for (const criterion of report.acceptanceCriteria ?? []) {
    if (criterion.status === "not_met" || criterion.status === "unknown") {
      unresolvedItems.push(`Acceptance criterion ${criterion.status}: "${criterion.criterion}"`);
    }
  }
  return {
    valid: unresolvedItems.length === 0 && report.status === "completed",
    error: unresolvedItems.length > 0 ? "Subagent structured report indicates unresolved work" : undefined,
    unresolvedItems: unresolvedItems.length > 0 ? unresolvedItems : undefined,
  };
}

const FINDING_PRIORITIES: FindingPriority[] = ["P0", "P1", "P2", "P3"];
const FINDING_STATUSES: FindingStatus[] = ["fixed", "unfixed", "not_applicable"];

function parseFindingPriority(value: unknown): FindingPriority | undefined {
  return FINDING_PRIORITIES.includes(value as FindingPriority) ? (value as FindingPriority) : undefined;
}

function parseFindingStatus(value: unknown): FindingStatus | undefined {
  return FINDING_STATUSES.includes(value as FindingStatus) ? (value as FindingStatus) : undefined;
}

function normalizeHighSeverityFinding(finding: ReviewFinding): {
  finding: ReviewFinding;
  ambiguous: boolean;
} {
  if (finding.priority !== "P0" && finding.priority !== "P1") {
    return { finding, ambiguous: false };
  }
  if (!parseFindingStatus(finding.status)) {
    return { finding: { ...finding, status: "unfixed" }, ambiguous: true };
  }
  return { finding, ambiguous: false };
}

export function parseReviewResult(
  text: string
): {
  result: ReviewResult | null;
  status: ReviewParseStatus;
  ambiguousHighSeverity: boolean;
} {
  const jsonText = extractBalancedJsonObject(text, "last");
  if (!jsonText) return { result: null, status: "absent", ambiguousHighSeverity: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { result: null, status: "fallback_exit_code", ambiguousHighSeverity: false };
  }
  if (!isRecord(parsed)) {
    return { result: null, status: "invalid_schema", ambiguousHighSeverity: false };
  }
  const verdict = parsed.verdict;
  const summary = asString(parsed.summary);
  if (
    (verdict !== "ship" && verdict !== "ship_with_warnings" && verdict !== "block") ||
    !summary ||
    !Array.isArray(parsed.findings)
  ) {
    return { result: null, status: "invalid_schema", ambiguousHighSeverity: false };
  }
  const findings: ReviewFinding[] = [];
  let ambiguousHighSeverity = false;
  for (const item of parsed.findings) {
    if (!isRecord(item)) return { result: null, status: "invalid_schema", ambiguousHighSeverity: false };
    const priority = parseFindingPriority(item.priority);
    const confidence = asNumber(item.confidence);
    const message = asString(item.message);
    const explicitStatus = parseFindingStatus(item.status);
    if (!priority || confidence === undefined || !message) {
      return { result: null, status: "invalid_schema", ambiguousHighSeverity: false };
    }
    if (confidence < 0 || confidence > 1) {
      return { result: null, status: "invalid_schema", ambiguousHighSeverity: false };
    }
    if ((priority === "P0" || priority === "P1") && !explicitStatus) {
      ambiguousHighSeverity = true;
    }
    const baseFinding: ReviewFinding = {
      priority,
      confidence,
      message,
      status: explicitStatus ?? "unfixed",
      file: asString(item.file),
      line: asNumber(item.line),
    };
    findings.push(baseFinding);
  }
  const result: ReviewResult = { verdict, summary, findings: sortReviewFindings(findings) };
  if (isRecord(parsed.postFixValidation)) {
    const pfStatus = parsed.postFixValidation.status;
    if (pfStatus === "passed" || pfStatus === "failed") {
      result.postFixValidation = {
        status: pfStatus,
        evidence: asString(parsed.postFixValidation.evidence),
      };
    }
  }
  return {
    result,
    status: ambiguousHighSeverity ? "invalid_schema" : "parsed",
    ambiguousHighSeverity,
  };
}

export function sortReviewFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const priorityRank: Record<FindingPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return [...findings].sort((a, b) => {
    const byPriority = priorityRank[a.priority] - priorityRank[b.priority];
    if (byPriority !== 0) return byPriority;
    return b.confidence - a.confidence;
  });
}

export function countFindingSeverities(findings: ReviewFinding[]): CcReviewFindingsPayload["counts"] {
  const counts = { p0: 0, p1: 0, p2: 0, p3: 0, unfixed: 0 };
  for (const finding of findings) {
    if (finding.priority === "P0") counts.p0 += 1;
    if (finding.priority === "P1") counts.p1 += 1;
    if (finding.priority === "P2") counts.p2 += 1;
    if (finding.priority === "P3") counts.p3 += 1;
    if (finding.status === "unfixed") counts.unfixed += 1;
  }
  return counts;
}

export function deriveEffectiveVerdict(input: {
  reportedVerdict: ReviewVerdict | null;
  findings: ReviewFinding[];
  reviewerExitCode: number;
  reviewParseStatus: ReviewParseStatus;
  ambiguousHighSeverity: boolean;
  postReviewValidationFailed: boolean;
}): {
  effectiveVerdict: ReviewVerdict;
  blockReason?: BlockReason;
  fallbackApplied: boolean;
} {
  const normalizedFindings = input.findings.map((finding) => normalizeHighSeverityFinding(finding).finding);
  const unfixedHigh = normalizedFindings.filter(
    (finding) =>
      (finding.priority === "P0" || finding.priority === "P1") && finding.status === "unfixed"
  );
  if (unfixedHigh.length > 0) {
    return {
      effectiveVerdict: "block",
      blockReason: input.ambiguousHighSeverity ? "ambiguous_high_severity" : "unfixed_high_severity",
      fallbackApplied: false,
    };
  }
  if (input.postReviewValidationFailed) {
    return {
      effectiveVerdict: "block",
      blockReason: "post_review_validation_failed",
      fallbackApplied: false,
    };
  }
  if (input.reportedVerdict === "block") {
    return { effectiveVerdict: "block", blockReason: "explicit_block", fallbackApplied: false };
  }
  if (input.reviewParseStatus === "invalid_schema") {
    return { effectiveVerdict: "ship_with_warnings", fallbackApplied: true };
  }
  if (input.reviewParseStatus !== "parsed" && input.reviewerExitCode !== 0) {
    return { effectiveVerdict: "ship_with_warnings", fallbackApplied: true };
  }
  const unfixedLow = normalizedFindings.filter(
    (finding) =>
      (finding.priority === "P2" || finding.priority === "P3") && finding.status === "unfixed"
  );
  if (unfixedLow.length > 0) {
    return { effectiveVerdict: "ship_with_warnings", fallbackApplied: false };
  }
  if (input.reportedVerdict) {
    return { effectiveVerdict: input.reportedVerdict, fallbackApplied: false };
  }
  return {
    effectiveVerdict: input.reviewerExitCode === 0 ? "ship" : "ship_with_warnings",
    fallbackApplied: input.reviewParseStatus !== "parsed",
  };
}

export function mapEffectiveVerdictToTaskStatus(effectiveVerdict: ReviewVerdict): TaskStatus {
  if (effectiveVerdict === "block") return "review_blocked";
  if (effectiveVerdict === "ship_with_warnings") return "completed_with_warnings";
  return "completed";
}

export interface VerificationPlan {
  commands: VerificationCommand[];
}

export function loadVerificationPlan(
  cwd: string,
  explicitCommands?: VerificationCommand[] | null
): { plan: VerificationPlan | null; error?: string } {
  if (explicitCommands !== undefined && explicitCommands !== null) {
    const validation = validateVerificationPlan({ commands: explicitCommands });
    return validation.error ? { plan: null, error: validation.error } : { plan: validation.plan! };
  }
  const configPath = path.join(cwd, ".cc-review-validation.json");
  if (!fs.existsSync(configPath)) return { plan: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return { plan: null, error: "Invalid .cc-review-validation.json: malformed JSON" };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.commands)) {
    return { plan: null, error: "Invalid .cc-review-validation.json: expected { commands: [] }" };
  }
  const unknownKeys = Object.keys(parsed).filter((key) => key !== "commands");
  if (unknownKeys.length > 0) {
    return { plan: null, error: `Invalid .cc-review-validation.json: unknown fields: ${unknownKeys.join(", ")}` };
  }
  const validation = validateVerificationPlan({ commands: parsed.commands as VerificationCommand[] });
  return validation.error ? { plan: null, error: validation.error } : { plan: validation.plan! };
}

function validateVerificationPlan(plan: VerificationPlan): { plan?: VerificationPlan; error?: string } {
  if (!Array.isArray(plan.commands) || plan.commands.length === 0) {
    return { error: "Verification plan must include at least one command" };
  }
  const commands: VerificationCommand[] = [];
  for (const item of plan.commands) {
    if (!isRecord(item)) return { error: "Verification command must be an object" };
    const command = asString(item.command);
    if (!command) return { error: "Verification command requires a command string" };
    if (!Array.isArray(item.args) || item.args.some((arg) => typeof arg !== "string")) {
      return { error: "Verification command args must be a string array" };
    }
    const timeoutMs = item.timeoutMs === undefined ? undefined : asNumber(item.timeoutMs);
    if (item.timeoutMs !== undefined && (timeoutMs === undefined || timeoutMs <= 0)) {
      return { error: "Verification command timeoutMs must be a positive number" };
    }
    commands.push({ command, args: [...item.args], timeoutMs });
  }
  return { plan: { commands } };
}

export type RunVerificationCommand = (
  command: VerificationCommand
) => Promise<VerificationCommandResult>;

export function reviewRequiresPostFixValidation(
  reviewResult: ReviewResult | null,
  workspaceChanged: boolean
): boolean {
  if (workspaceChanged) return true;
  return !!reviewResult?.findings.some((finding) => finding.status === "fixed");
}

export async function runPostReviewValidation(input: {
  reviewResult: ReviewResult | null;
  workspaceChanged: boolean;
  verificationPlan: VerificationPlan | null;
  runCommand: RunVerificationCommand;
  rerunSubagentValidationPassed: boolean;
}): Promise<{
  required: boolean;
  workspaceChanged: boolean;
  passed: boolean;
  error: string | null;
  commands: VerificationCommandResult[];
}> {
  const required = reviewRequiresPostFixValidation(input.reviewResult, input.workspaceChanged);
  if (!required) {
    return {
      required: false,
      workspaceChanged: input.workspaceChanged,
      passed: input.rerunSubagentValidationPassed,
      error: input.rerunSubagentValidationPassed ? null : "Subagent report consistency check failed",
      commands: [],
    };
  }
  if (!input.rerunSubagentValidationPassed) {
    return {
      required: true,
      workspaceChanged: input.workspaceChanged,
      passed: false,
      error: "Subagent report consistency check failed after review",
      commands: [],
    };
  }
  if (input.reviewResult?.postFixValidation?.status === "failed") {
    return {
      required: true,
      workspaceChanged: input.workspaceChanged,
      passed: false,
      error: "Reviewer postFixValidation reported failed",
      commands: [],
    };
  }
  if (!input.verificationPlan) {
    return {
      required: true,
      workspaceChanged: input.workspaceChanged,
      passed: false,
      error: "Reviewer changed workspace files but no verification plan is configured",
      commands: [],
    };
  }
  const commands: VerificationCommandResult[] = [];
  for (const command of input.verificationPlan.commands) {
    const result = await input.runCommand(command);
    commands.push(result);
    if (result.timedOut || result.exitCode !== 0) {
      return {
        required: true,
        workspaceChanged: input.workspaceChanged,
        passed: false,
        error: `Verification command failed: ${command.command} ${command.args.join(" ")}`,
        commands,
      };
    }
  }
  return {
    required: true,
    workspaceChanged: input.workspaceChanged,
    passed: true,
    error: null,
    commands,
  };
}

export function updateFindingsRollup(
  rollup: CcReviewFindingsRollup,
  effectiveVerdict: ReviewVerdict,
  findings: ReviewFinding[]
): CcReviewFindingsRollup {
  const next = { ...rollup, tasksReviewed: rollup.tasksReviewed + 1 };
  if (effectiveVerdict === "ship") next.ship += 1;
  else if (effectiveVerdict === "ship_with_warnings") next.shipWithWarnings += 1;
  else next.blocked += 1;
  for (const finding of findings) {
    if (finding.priority === "P0" && finding.status === "unfixed") next.unfixedP0 += 1;
    if (finding.priority === "P1" && finding.status === "unfixed") next.unfixedP1 += 1;
    if ((finding.priority === "P2" || finding.priority === "P3") && finding.status === "unfixed") {
      next.unfixedP2P3 += 1;
    }
  }
  return next;
}

export function formatFindingsRollupLine(rollup: CcReviewFindingsRollup): string {
  return `Review: ${rollup.ship}✓ · ${rollup.shipWithWarnings}⚠ · P0:${rollup.unfixedP0} P1:${rollup.unfixedP1}`;
}

export function buildFindingsPayload(input: {
  kind: "task" | "rollup";
  partial?: boolean;
  taskIndex?: number;
  taskTitle?: string;
  reportedVerdict: ReviewVerdict | null;
  effectiveVerdict: ReviewVerdict;
  blockReason?: BlockReason;
  summary: string;
  findings: ReviewFinding[];
  artifactPath: string;
}): CcReviewFindingsPayload {
  return {
    kind: input.kind,
    partial: input.partial,
    taskIndex: input.taskIndex,
    taskTitle: input.taskTitle,
    reportedVerdict: input.reportedVerdict,
    effectiveVerdict: input.effectiveVerdict,
    blockReason: input.blockReason,
    summary: input.summary,
    findings: sortReviewFindings(input.findings),
    artifactPath: input.artifactPath,
    counts: countFindingSeverities(input.findings),
  };
}

export function mergeRollupFindings(taskFindings: ReviewFinding[][]): ReviewFinding[] {
  return sortReviewFindings(taskFindings.flat());
}

export function buildSummaryMeta(
  taskResults: Array<{ status?: TaskStatus; reviewResult?: ReviewResult | null }>,
  options?: { concurrency?: number }
): CcReviewSummaryMeta {
  const taskOutcomes = { review_blocked: 0, failed: 0, warning: 0, completed: 0, cancelled: 0 };
  const blockers: ReviewFinding[] = [];
  for (const result of taskResults) {
    if (result.status === "review_blocked") taskOutcomes.review_blocked += 1;
    else if (result.status === "failed" || result.status === "validation_failed") {
      taskOutcomes.failed += 1;
    } else if (result.status === "cancelled") {
      taskOutcomes.cancelled += 1;
    } else if (result.status === "completed_with_warnings" || result.status === "skipped") {
      taskOutcomes.warning += 1;
    } else if (result.status === "completed") {
      taskOutcomes.completed += 1;
    }
    for (const finding of result.reviewResult?.findings ?? []) {
      if ((finding.priority === "P0" || finding.priority === "P1") && finding.status === "unfixed") {
        blockers.push(finding);
      }
    }
  }
  return {
    taskOutcomes,
    topBlockers: sortReviewFindings(blockers).slice(0, 3),
    ...(options?.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
  };
}

export function isExecutionGateHaltError(message: string): boolean {
  return /task execution failed unrecoverably|validation failed unrecoverably/i.test(message);
}

export function isReviewGateHaltError(message: string): boolean {
  return /blocked by reviewer/i.test(message);
}
