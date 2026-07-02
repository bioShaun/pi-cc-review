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
  attachPostExitStdioGuard,
  resolvePostExitGuardTimings,
  DEFAULT_POST_EXIT_IDLE_MS,
  DEFAULT_POST_EXIT_HARD_MS,
  type PostExitStdioGuardOptions,
  type GuardedChildProcess,
} from "./workflow/post-exit-stdio-guard.ts";

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
  restoreBatchTaskExecutions,
  resolveTasksToSkipOnResume,
  isTaskReusableOnResume,
  writeCheckpoint,
  writePlanArtifact,
} from "./workflow/checkpoint.ts";

export {
  mergeTaskResultIntoStateBuffer,
  rebuildStateBufferFromTaskResults,
} from "./workflow/session.ts";

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

export {
  getPiSpawnCommand,
  formatResolvedPiCommand,
  findPiPackageRootFromEntry,
  resolvePiPackageRoot,
  resolveWindowsPiCliScript,
  CC_REVIEW_PI_BINARY_ENV,
  PI_SUBAGENT_PI_BINARY_ENV,
  PI_CODING_AGENT_PACKAGE,
  type PiSpawnDeps,
  type PiSpawnCommand,
} from "./workflow/pi-spawn.ts";

export {
  resolveSessionContinuity,
  resolveTaskSessionFile,
  resolvePriorTaskSessionPath,
  describeSessionPath,
  CC_REVIEW_SESSION_CONTINUITY_ENV,
  CC_REVIEW_SESSION_CHAIN_ENV,
  type SessionContinuityConfig,
  type SessionContinuityOptions,
  type SessionFileResolution,
} from "./workflow/session-continuity.ts";

export {
  splitThinkingSuffix,
  parseFallbackModels,
  buildModelCandidates,
  isRetryableModelFailure,
  formatModelAttemptNote,
  summarizeAttemptedModels,
  resolveModelFallbackConfig,
  type ModelAttemptSummary,
  type ModelFallbackConfig,
  type ModelFallbackResolutionOptions,
} from "./workflow/model-fallback.ts";

export {
  resolveStructuredOutputStrict,
  resolveStructuredOutputFile,
  readStructuredOutputFile,
  CC_REVIEW_STRUCTURED_OUTPUT_STRICT_ENV,
  type StructuredOutputStrictConfig,
  type StructuredOutputFileResolution,
  type StructuredOutputFileResult,
  type StructuredOutputSource,
} from "./workflow/structured-output.ts";

export {
  expectsImplementationMutation,
  isMutatingBashCommand,
  hasMutationToolCall,
  evaluateCompletionMutationGuard,
  type GuardedToolEvent,
  type CompletionMutationGuardInput,
  type CompletionMutationGuardResult,
} from "./workflow/completion-guard.ts";

export {
  createSubagentActivityTracker,
  recordActivity,
  recordToolFailure,
  markCompleted,
  classifySubagentControlState,
  emitControlEvent,
  formatControlEventLabel,
  formatControlStateLabel,
  buildControlEventLogPayload,
  DEFAULT_CONTROL_THRESHOLDS,
  type SubagentControlState,
  type SubagentControlEvent,
  type SubagentActivityTracker,
  type SubagentControlThresholds,
} from "./workflow/subagent-control.ts";

export {
  buildUiSnapshot,
  createDefaultOverlayState,
  resolveDefaultSelectedTaskIndex,
  generateFindingId,
  toActiveForm,
  type CcReviewUiSnapshot,
  type TaskUiRecord,
  type FindingUiRecord,
  type AttemptUiRecord,
  type OverlayView,
  type OverlayState,
  type OverlayFocusedPanel,
  type SeverityFilter,
  type TaskUiStatus,
  type SnapshotBuilderInput,
} from "./workflow/ui/model.ts";

export {
  sortFindings,
  filterFindingsBySeverity,
  groupFindingsByFile,
  findAdjacentFinding,
  findAdjacentFile,
  getFindingsForFile,
  filterTasksByStatus,
  getHighestUnresolvedSeverity,
  getLatestExceptionLog,
  resolveRetainedSelection,
  resolveRetainedFile,
  countTasksByStatus,
} from "./workflow/ui/selectors.ts";

export {
  detectPiUiCapabilities,
  resolveDetailEntryPoints,
  formatFooterEntryHint,
  canRenderCustomOverlay,
  registerDetailsCommand,
  DEFAULT_PI_UI_CAPABILITIES,
  type PiUiCapabilities,
  type DetailEntryPoint,
} from "./workflow/ui/pi-adapter.ts";

export {
  renderCompactWidget,
  type CompactWidgetRenderOptions,
  type CompactWidgetRenderResult,
} from "./workflow/ui/compact-widget.ts";

export {
  buildRuntimeUiSnapshot,
  type WorkflowUiSource,
} from "./workflow/ui/runtime-snapshot.ts";

export {
  createCcReviewUiController,
  type CcReviewUiController,
  type CcReviewUiControllerContext,
} from "./workflow/ui/controller.ts";

export { stripAnsi, delay, isTransientError } from "./workflow/util.ts";

export { parseCcReviewCommandArgs } from "./workflow/register.ts";

export { WORKFLOW_STATIC_CONTRACT_SNIPPETS } from "./workflow/static-contract.ts";

export { runCcReviewWorkflow } from "./workflow/orchestrator/index.ts";

export { default } from "./workflow/register.ts";
