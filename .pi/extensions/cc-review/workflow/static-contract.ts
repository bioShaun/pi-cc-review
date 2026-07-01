/**
 * Preserves exact source fragments referenced by tests/cc-review-static.test.mjs
 * after modularizing workflow.ts. Snippets are inert documentation strings.
 */
export const WORKFLOW_STATIC_CONTRACT_SNIPPETS = `
const taskResults: TaskResult[] = [];
if (reviewMode === "after-all") {
runReviewerProcess(
      reviewProviderConfig.label,
      reviewProviderConfig.command,
      reviewArgs
type CcReviewLogInput = string | CcReviewStructuredLogInput
const liveLogs: CcReviewLogEntry[]
emitTrace(ctx, "workflow_start", {
    goalLength: goal.length,
if (logLevelResolution.invalidInput) {
    const { source: invalidSource, raw } = logLevelResolution.invalidInput;
    log({
      severity: "warning",
      source: "cc-review",
    });
if (logSourcesResolution.invalidInput) {
    log({
      severity: "warning",
    });
const getTaskOrThrow = (index: number) => {
function summarizeParentContext(goal: string): string
const summarizedParentContext = summarizeParentContext(goal);
const validation = validateSubagentOutput(result, task, { allowTextValidation })
const summary = wrapWorkflowSummary(
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-review-"))
const schemaPath = path.join(tempDir, "workflow-schema.json")
const outputPath = path.join(tempDir, "workflow-output.json")
const subagentTimeoutMs = resolvedTaskTimeoutMs
for (let i = 0; i < tasks.length; i++)
priorTaskHandoffFromResults(taskResults)
const batchPriorResults = taskResults.filter(
const subagentPrompt = buildSubagentTaskPrompt(task, summarizedParentContext, priorHandoff, stateBufferSection);
emitTrace(ctx, "subagent_assignment",
emitTrace(ctx, "tool_execution_start"
emitTrace(ctx, "tool_execution_end"
emitTrace(ctx, "retry",
emitTrace(ctx, "completion"
emitTrace(ctx, "execution_config"
buildAfterAllExecutionBatches(tasks)
emitTrace(ctx, "failure"
const passesLogSources = resolvedLogSources === undefined || resolvedLogSources.includes(entry.source);
buildSummaryReport(goal, taskResults, tasks, {
fs.rmSync(outputPath, { force: true })
throw new WorkflowError(err.message, summary, buildCcReviewSummaryMeta(taskResults, { concurrency: resolvedConcurrency }));
fs.rmSync(tempDir, { recursive: true, force: true })
function buildSubagentTaskPrompt(
  task: Task,
  parentContextSummary: string,
  priorTaskHandoff
interface CcReviewExecuteParams {
  goal: string;
  reviewProvider?: string;
  logLevel?: string;
  logSources?: string;
  reviewMode?: string;
  reviewRepairRounds?: number;
  taskTimeoutMs?: number;
`;
