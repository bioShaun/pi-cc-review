export {
  buildAfterAllExecutionBatches,
  runWithConcurrencyLimit,
  type AfterAllExecutionBatchItem,
  type Task,
} from "./workflow/dependencies.ts";

export {
  buildFindingsPayload,
  deriveEffectiveVerdict,
  emptyFindingsRollup,
  extractBalancedJsonObject,
  formatTaskArtifactFileName,
  generateWorkflowRunId,
  isExecutionGateHaltError,
  loadVerificationPlan,
  mapEffectiveVerdictToTaskStatus,
  parseReviewResult,
  parseSubagentStructuredReport,
  sortReviewFindings,
  snapshotWorkspace,
  validateStructuredSubagentReport,
  workspaceSnapshotChanged,
  writeTaskArtifact,
  WORKFLOW_ARTIFACT_DIR,
} from "./structured.ts";

export * from "./subprocess.ts";

export {
  appendPersistedLogEntry,
  appendArtifactDirToSummary,
  appendPersistedLogPathToSummary,
  resolveCcReviewLogPath,
  resolveCcReviewTracePath,
  shouldUseWorkspaceRootLogs,
  createSubprocessStreamLogger,
  type PersistedLogState,
  type ResolveCcReviewLogPathOptions,
  type SubprocessStreamLogger,
} from "./workflow/logging.ts";

export {
  formatResumeInstructions,
  loadCheckpoint,
  listResumableRunIds,
  resolveTasksToSkipOnResume,
  writeCheckpoint,
  writePlanArtifact,
} from "./workflow/checkpoint.ts";

export { runPreflight, shouldSkipPreflight, formatPreflightReport } from "./workflow/preflight.ts";
export { validateSubagentOutput, summarizeValidationParseFailures } from "./workflow/validation.ts";

export * from "./config.ts";
export * from "./providers.ts";

export type {
  CcReviewLogEntry,
  CcReviewLogInput,
  CcReviewLogStructuredInput,
  CcReviewWorkflowResult,
  ExtensionAPI,
  SubprocessProvider,
} from "./workflow/types.ts";

export {
  inferSubprocessStreamSeverity,
  formatSubprocessStreamLine,
  extractAssistantTextFromStream,
} from "./workflow/stream-format.ts";

export {
  normalizeCcReviewLogEntry,
  collapseConsecutiveLogEntries,
  renderCcReviewLogEntry,
  filterCcReviewLogEntries,
  summarizeLogSeverities,
  truncatePersistedLogPathForWidget,
  truncateForWidget,
  WIDGET_PREVIEW_MAX_LENGTH_DEFAULT,
  previewWidgetText,
  computeChecklistWindow,
  type CcReviewDisplayState,
  type CcReviewWidgetTheme,
  measureVisibleWidth,
  truncateWidgetLine,
  type TaskModelState,
  type CcReviewWidgetState,
  type TaskVisuals,
  getTaskVisuals,
  type BuildCcReviewWidgetLinesOptions,
  formatPhaseSeverityLine,
  buildCcReviewWidgetLines,
  type CcReviewStatusState,
  getStatusColorForDisplayState,
  buildCcReviewStatusText,
} from "./workflow/ui.ts";

export {
  type CcReviewTaskOutcomeCounts,
  countCcReviewTaskOutcomesFromSummary,
  formatCcReviewSummaryHeadline,
  type CcReviewSummaryBadge,
  classifyCcReviewSummary,
  buildCcReviewSummaryMeta,
} from "./workflow/summary.ts";

export { buildRepairFeedback } from "./workflow/review.ts";

export {
  buildPriorTaskHandoff,
  priorTaskHandoffFromResults,
  buildSubagentTaskPrompt,
  buildBuiltinWorkerAgent,
  discoverAgent,
  summarizeSubagentToolActivity,
  getSubagentExecutor,
  getSubagentExitCode,
  type PriorTaskHandoffOptions,
  type PriorTaskHandoffInput,
} from "./workflow/execution.ts";

export { stripAnsi, delay, isTransientError } from "./workflow/util.ts";

export { parseCcReviewCommandArgs } from "./workflow/register.ts";

export { WORKFLOW_STATIC_CONTRACT_SNIPPETS } from "./workflow/static-contract.ts";

export { runCcReviewWorkflow } from "./workflow/orchestrator/index.ts";

export { default } from "./workflow/register.ts";
