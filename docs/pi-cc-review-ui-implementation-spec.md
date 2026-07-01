# pi-cc-review UI 优化实施 Spec

Status: Proposed  
Date: 2026-07-01  
Source: `docs/pi-cc-review-ui-optimization.md`  
Target: `.pi/extensions/cc-review/`

## 1. 目标

将当前以静态信息堆叠为主的 CC Review Widget 改造成两层 UI：

```text
Compact Widget（持续监控）
    ↓ 打开详情
Review Detail Overlay（任务、Findings、日志和尝试记录）
```

完成后，用户应能在不浏览原始 JSON 或完整日志文件的情况下：

1. 在 Compact Widget 中快速判断工作流状态、当前任务和阻塞情况。
2. 打开详情界面并在任务、文件、Finding、日志、Reviewer、Validation 和重试记录之间导航。
3. 按文件和严重级别定位 Finding，查看证据、建议修复和验证状态。
4. 在 40、80、120 列终端中获得稳定、无越界的显示。
5. 关闭 Overlay 后回到原工作流，不影响后台执行、取消和最终报告。

## 2. 非目标

- 不在本次改造中实现 diff 编辑、行级评论、Approve 或 Request Changes。
- 不替换现有 workflow orchestration、review verdict 或 artifact 格式。
- 不删除最终 Markdown 报告、JSON task artifact 或持久化 JSONL 日志。
- 不为缺失的 Token、耗时或 Evidence 数据生成推测值。
- 不让常驻 Widget 抢占编辑器的方向键、Enter 或普通字符输入。
- 不把视觉润色置于交互架构和可测试状态模型之前。

## 3. 当前基线与缺口

### 3.1 已有能力

- `workflow/ui.ts`
  - 状态色、任务图标、CJK/ANSI 可见宽度处理。
  - 任务窗口、Findings rollup、日志过滤、日志持久化路径。
  - 40/80/120 列回归测试。
- `workflow/orchestrator/runtime.ts`
  - 工作流阶段、任务状态、模型、Findings、日志和 retry 状态。
  - `refreshWorkflowUi()` 同步更新 Widget 与 Status Bar。
- `structured.ts`
  - 结构化 `ReviewFinding`、`ReviewResult` 和 task artifact。
- `workflow/register.ts`
  - Findings 和最终 Summary 的消息渲染器。

### 3.2 主要缺口

- Widget 每次刷新均通过 `setWidget()` 重新注册，没有持久控制器、选择状态和焦点状态。
- Widget 默认显示日志尾部，信息密度高，任务与 Findings 无法下钻。
- `CcReviewWidgetState` 只有 Findings 汇总，没有传入完整 Findings。
- 任务缺少 UI 专用的开始时间、结束时间、active form 和 attempt 历史。
- 当前插件没有 Overlay 状态机、输入映射和焦点恢复逻辑。
- 工作流 `finally` 会直接清除 Widget 和 Status Bar，详情界面需要安全关闭并释放订阅。
- 当前 `ExtensionAPI` 本地类型未声明交互式 UI/shortcut 能力，需要兼容适配层。

## 4. 产品决策

### 4.1 信息层级

| 层级 | 用途 | 内容 |
|---|---|---|
| Status Bar | 一眼判断全局状态 | 阶段、任务进度、最高未解决严重级别 |
| Compact Widget | 持续监控 | 当前任务窗口、Findings 汇总、最新 Warning/Error、操作提示 |
| Detail Overlay | 浏览与诊断 | Tasks、Files、Findings、Logs、Reviewer、Validation、Attempts |
| 持久化文件 | 完整审计 | JSONL 日志、task artifact、最终 Markdown、原始 reviewer 输出 |

### 4.2 交互入口

常驻 Widget 默认不获取焦点。详情入口按以下优先级提供：

1. Pi 运行时支持可聚焦 Widget 时：Widget 获焦后 `Enter` 打开详情。
2. Pi 运行时支持 extension shortcut 时：注册一个不冲突的详情快捷键，并在 Footer 展示实际按键。
3. 所有运行时必须提供 `/cc-review-details` 命令作为可发现的兼容入口。

禁止在未获得 Widget/Overlay 焦点时拦截全局 `↑`、`↓`、`j`、`k`、`Enter`。

### 4.3 数据真实性

- 耗时只从记录的 `startedAt`/`completedAt` 计算。
- Token 只在运行时返回可靠 usage 数据时显示；否则整段省略，不显示 `0` 或 `unknown`。
- Evidence 和 Suggested Fix 在 schema 尚未提供独立字段时，显示为“不提供”，不得从 `message` 猜测。
- 文件路径必须来自 `ReviewFinding.file`，行号必须来自 `ReviewFinding.line`。

## 5. 目标体验

### 5.1 Compact Widget

80 列及以上：

```text
● CC Review  2/5 · Reviewing · 03:12

  ✔ 1  Plan implementation
  ▸ 2  Reviewing parser changes…             sonnet · 1m21s
  ○ 3  Add validation tests

  Findings  1 P1 · 2 P2 · 5 P3
  ⚠ Latest  Validation command failed
  Enter details · L logs · ? help
```

小于 50 列：

```text
● Reviewing · 2/5
▸ Parser changes…
Findings 1 P1 · 7 others
⚠ Validation failed
```

规则：

- Header 始终存在。
- 默认最多显示 3–5 个任务；小于 50 列只显示当前任务。
- 默认不展示 info/debug 日志。
- 只展示最新一条 Warning 或 Error，且 Error 优先。
- 已完成任务弱化；是否使用删除线由 TUI 能力决定，不能影响可读性。
- Spinner 仅在 Running 状态动画；Headless 测试使用固定帧。
- Footer 只显示当前运行时实际可用的操作。

### 5.2 Detail Overlay

大于等于 90 列时采用双面板：

```text
┌ Tasks / Files ─────────┬ Review Details ──────────────────────┐
│ ✔ 1 Plan               │ P1 · unfixed                         │
│ ▸ 2 Parser review      │ src/parser.ts:142                    │
│ ○ 3 Tests              │ Missing null validation before parse │
│                        │                                      │
│ Findings               │ Evidence / Suggested fix             │
│ ▸ parser.ts          2 │ Validation status                    │
│   config.ts          1 │ Reviewer · Model · Attempt           │
├────────────────────────┴──────────────────────────────────────┤
│ ↑↓ select · Tab panel · Enter expand · L logs · Esc close    │
└───────────────────────────────────────────────────────────────┘
```

小于 90 列时采用单面板堆栈：

- 先显示列表。
- `Enter` 进入选中项详情。
- `Esc` 从详情返回列表；再次 `Esc` 关闭 Overlay。
- Header 显示当前位置，例如 `Files > src/parser.ts > Finding 2/3`。

### 5.3 Overlay 视图

MVP 必须包含：

| 视图 | 列表内容 | 详情内容 |
|---|---|---|
| Tasks | 全部任务及状态 | 描述、acceptance criteria、模型、耗时、结果摘要 |
| Files | 按路径分组及 Finding 数 | 该文件 Findings 列表 |
| Findings | 按优先级排序 | priority、status、confidence、path:line、message |
| Logs | 过滤后的日志列表 | 时间、source、severity、完整 message、details |
| Attempts | task/review retry 列表 | attempt、原因、起止时间、结果 |

第二阶段增加：

| 视图 | 详情内容 |
|---|---|
| Reviewer | verdict、summary、原始输出位置、block reason |
| Validation | 执行命令、exit code、timeout、stdout/stderr 摘要、artifact 路径 |

如果当前 run 尚无对应数据，显示明确空状态，不隐藏整个 Overlay。

## 6. UI 数据模型

UI 不直接读取和修改 `WorkflowRuntime`。Runtime 每次变化时生成不可变快照：

```ts
type CcReviewUiSnapshot = {
  runId: string;
  goal: string;
  displayState: CcReviewDisplayState;
  phase: string;
  startedAt: string;
  completedAt?: string;
  currentTaskIndex: number;
  tasks: TaskUiRecord[];
  findings: FindingUiRecord[];
  logs: readonly CcReviewLogEntry[];
  attempts: AttemptUiRecord[];
  findingsRollup: CcReviewFindingsRollup;
  persistedLogPath: string;
  artifactRunDir: string;
};

type TaskUiRecord = {
  index: number;
  title: string;
  activeForm?: string;
  description: string;
  acceptanceCriteria?: string;
  status: TaskStatus | "running" | "pending";
  configuredModel?: string;
  effectiveModel?: string;
  startedAt?: string;
  completedAt?: string;
  tokenUsage?: { input?: number; output?: number; total?: number };
  resultSummary?: string;
  artifactPath?: string;
};

type FindingUiRecord = ReviewFinding & {
  id: string;
  taskIndex?: number;
  reviewer?: string;
  validationStatus?: "passed" | "failed" | "not_run";
  artifactPath?: string;
};

type AttemptUiRecord = {
  id: string;
  kind: "worker" | "reviewer" | "validation";
  taskIndex?: number;
  attempt: number;
  maxAttempts: number;
  startedAt?: string;
  completedAt?: string;
  reason?: string;
  outcome?: string;
};
```

约束：

- Snapshot 对渲染器只读。
- `FindingUiRecord.id` 使用 run id、task index、file、line、priority 和序号稳定生成。
- 并发任务不能只依赖单个 `currentTaskIndex`；每个任务的显式 status 是唯一事实来源。
- `activeForm` 是可选计划字段；缺失时使用 `toActiveForm(title)` 的保守转换，不能改变原始 task title。
- 日志内存上限保持有界；Overlay 的完整历史从 JSONL 分页读取，不把整文件常驻内存。

## 7. UI 控制器与状态机

新增一个 run 级 `CcReviewUiController`，只注册一次：

```ts
interface CcReviewUiController {
  mount(initial: CcReviewUiSnapshot): void;
  update(next: CcReviewUiSnapshot): void;
  openOverlay(initialView?: OverlayView): void;
  closeOverlay(): void;
  dispose(): void;
}
```

内部交互状态：

```ts
type OverlayView =
  | "tasks"
  | "files"
  | "findings"
  | "logs"
  | "attempts"
  | "reviewer"
  | "validation";

type OverlayState = {
  isOpen: boolean;
  view: OverlayView;
  focusedPanel: "navigation" | "content";
  selectedTaskIndex: number;
  selectedFile?: string;
  selectedFindingId?: string;
  selectedLogId?: string;
  selectedAttemptId?: string;
  severityFilter: "all" | "P0" | "P1" | "P2" | "P3";
  logSeverityFilter: CcReviewLogSeverity;
  logSources?: string[];
  scrollOffset: number;
};
```

状态规则：

- Snapshot 更新时尽量按稳定 id 保留选择。
- 选中项消失时，选择相邻项；列表为空时进入空状态。
- 打开 Overlay 时默认选中当前 running task；无 running task 时选中第一个未完成任务；全部完成时选中第一个 blocker，否则选中最后一个任务。
- Workflow 结束时 Overlay 保持可浏览，直到结果消息已发出；随后关闭 Overlay、移除 Widget，并释放 timer/监听器。
- `dispose()` 必须幂等，且在 workflow `finally` 中调用。

## 8. 输入与焦点

Overlay 获焦后使用以下按键：

| 按键 | 行为 |
|---|---|
| `↑` / `k` | 上一项 |
| `↓` / `j` | 下一项 |
| `Tab` / `Shift+Tab` | 下一个/上一个面板 |
| `Enter` | 打开选中项或展开详情 |
| `n` / `N` | 下一个/上一个 Finding |
| `]` / `[` | 下一个/上一个文件 |
| `L` | Logs 视图 |
| `F` | Files/Findings 视图 |
| `R` | Reviewer 视图 |
| `V` | Validation 视图 |
| `1`–`4` | 切换 P0–P3 filter；`0` 清除 |
| `?` | Help Overlay |
| `Esc` | 返回上层；位于根列表时关闭 |
| `Ctrl+C` | 请求取消 workflow，必须二次确认 |

要求：

- 所有输入只在 Overlay 或明确聚焦的 Widget 中处理。
- `Ctrl+C` 不得直接杀进程；调用现有 AbortController/取消路径。
- 关闭 Overlay 后恢复之前的编辑器焦点。
- Help 中只列出当前视图有效的按键。

## 9. Responsive 规则

| 宽度 | Compact Widget | Detail Overlay |
|---|---|---|
| `< 50` | 当前任务、阶段、Finding 总数、最新异常 | 单面板；隐藏模型、Token、source |
| `50–89` | 3 个任务、模型或耗时、Finding 汇总 | 单面板；详情按区块纵向排列 |
| `>= 90` | 5 个任务、模型、耗时、分类汇总 | 双面板，左 30–36%，右侧剩余宽度 |

通用要求：

- 所有行在 ANSI 和 CJK 字符下均不得超过渲染宽度。
- 路径优先保留 basename 和行号；完整路径在详情中换行显示。
- 高度不足时优先保留 Header、当前选择、最高优先级 Finding 和 Footer。
- 不依赖 Emoji 的终端宽度；状态图标使用项目现有单列宽度符号集合。

## 10. 视觉语义

| 语义 | Theme token |
|---|---|
| 当前活动/焦点 | `accent` |
| 成功 | `success` |
| Warning、P2 | `warning` |
| Error、P0、P1、block | `error` |
| 次要元数据 | `muted` |
| 已完成历史 | `dim` |
| 普通正文 | `text` |

颜色不能作为唯一状态信号；图标和文字标签必须同时可辨识。

状态图标统一为：

| 状态 | 图标 |
|---|---|
| Pending | `○` |
| Running | Spinner，测试固定为 `▸` |
| Completed | `✔` |
| Completed with warnings | `⚠` |
| Failed | `✘` |
| Validation failed | `✖` |
| Review blocked | `⛔` |
| Skipped | `↪` |
| Cancelled | `⊘` |

## 11. 模块设计

将 UI 拆分为纯状态/渲染层与 Pi 适配层：

```text
.pi/extensions/cc-review/workflow/ui/
├── model.ts              # Snapshot 和 OverlayState
├── selectors.ts          # 分组、排序、过滤、默认选择
├── compact-widget.ts     # Compact Widget 纯渲染
├── overlay.ts            # Overlay 控制器和状态转换
├── overlay-render.ts     # Responsive 页面渲染
├── input.ts              # 按键映射
├── log-reader.ts         # JSONL 分页读取
├── pi-adapter.ts         # setWidget/custom/shortcut 能力适配
└── width.ts              # 现有 ANSI/CJK 宽度工具
```

迁移规则：

- 保留 `workflow/ui.ts` 作为临时 re-export，避免一次性修改所有 import 和测试。
- 纯 selector/renderer 不 import Pi runtime，Node test 可直接执行。
- `pi-adapter.ts` 是唯一允许访问 `ctx.ui` 和 Pi TUI constructor 的模块。
- Orchestrator 只调用 `controller.update(snapshot)`，不持有 Overlay 内部状态。

## 12. 实施阶段

### Phase 0：运行时能力确认和适配层

任务：

1. 确认目标 Pi 版本的 `ctx.ui.custom()`、interactive component、shortcut、focus 和 `requestRender()` 签名。
2. 扩展本地 `ExtensionAPI`/UI 类型，移除新增代码中的 `any`。
3. 实现 capability detection 和 `/cc-review-details` fallback。
4. 为 headless test 增加 mock focus、input、custom overlay 和 render invalidation。

验收：

- 不支持 shortcut 或 focusable Widget 的运行时仍可通过命令打开详情。
- 能力缺失只降级入口，不导致 workflow 失败。
- Widget 注册次数在单次 run 中为 1，dispose 时清理 1 次。

### Phase 1：Compact Widget 重构

任务：

1. 引入 `CcReviewUiSnapshot` 和 `CcReviewUiController`。
2. 将 Widget 改为 Header、任务窗口、Finding 汇总、最新异常和 Footer。
3. 移除默认 info/debug 日志尾部；`L` 或详情命令打开 Logs。
4. 加入 Spinner timer，只有 running 时启动；Overlay 关闭或 run 结束时停止。
5. Status Bar 增加最高未解决 Finding 严重级别。

验收：

- 默认 Widget 不再显示连续 Live Logs。
- Error/Warning 存在时最多显示最新一条，Error 优先。
- 40/80/120 列均无越界。
- Snapshot 更新不重复注册 Widget。
- 当前已有 UI 测试经更新后全部通过。

### Phase 2：Overlay MVP

任务：

1. 实现 Overlay state machine、双/单面板渲染和焦点恢复。
2. 实现 Tasks、Files、Findings、Logs、Attempts 五个视图。
3. 实现选择、滚动、Tab、Enter、Esc、`n/N`、`[/]`、`L/F/?`。
4. 完整日志通过 JSONL reader 分页加载，并处理文件不存在、截断和新增行。
5. Workflow 更新时按稳定 id 保留选择。

验收：

- 可从当前任务导航到其 Finding，再导航到同文件下一 Finding。
- 新日志或 Finding 到达时不重置用户当前选择和滚动位置。
- 小于 90 列使用单面板导航，大于等于 90 列使用双面板。
- Overlay 关闭后编辑器继续正常接收输入。
- 日志文件超过 10 MB 时打开 Overlay 不进行全文件同步读取。

### Phase 3：Reviewer、Validation 和 Attempt 数据补全

任务：

1. Runtime 记录 task、reviewer、validation attempt 的起止时间和原因。
2. 从 task artifact 映射 reviewer verdict、validation command 和结果。
3. 实现 Reviewer 与 Validation 详情视图。
4. 为 `Task` 增加可选 `activeForm` 计划字段；兼容旧 plan。
5. 接入真实 usage 数据（仅在 Pi/subagent 返回该字段时）。

验收：

- Retry 可看到 attempt 序号、原因和最终 outcome。
- Validation 失败可定位命令、exit code 和 artifact。
- 老版本 plan/artifact 无新增字段时 UI 正常降级。
- UI 中不出现伪造的 Token、Evidence 或 Suggested Fix。

### Phase 4：视觉和可用性收尾

任务：

1. 统一图标、间距、边框、色彩和空状态。
2. 增加 Help Overlay 和动态 Footer。
3. 增加高频更新节流，默认每 50–100 ms 合并一次 render request。
4. 完成低色彩、无色彩和窄终端检查。

验收：

- 日志高频输出时不会为每个 chunk 重建组件。
- 无颜色输出仍可区分状态和优先级。
- Help 与实际按键行为一致。

## 13. 测试计划

### 13.1 纯单元测试

新增或扩展 `tests/cc-review-ui.test.ts`：

- Snapshot 从 runtime state 的确定性映射。
- 并发 running task 的显式状态。
- Finding 按 P0→P3、file、line 的稳定排序。
- 文件分组、severity filter、next/previous Finding。
- 选中项在 snapshot 更新后的保留和 fallback。
- 40/49/50/80/89/90/120 列渲染。
- ANSI、CJK、超长路径、超长无空格文本。
- 空任务、空 Findings、空日志、artifact 缺失。
- Spinner timer 的启动、复用和清理。

### 13.2 控制器测试

扩展 `tests/mock-tui.ts`：

- Widget 只 mount 一次。
- update 触发 invalidate/requestRender，不重新 mount。
- Overlay open/close 与焦点恢复。
- `Esc` 层级返回。
- Workflow dispose 时关闭 Overlay、timer 和 file reader。
- 不支持高级 UI API 时命令 fallback 生效。

### 13.3 行为测试

扩展 `tests/cc-review-behavior.test.ts`：

- per-task 和 after-all 模式均向 UI 提供完整 Findings。
- retry/repair round 生成 attempt 记录。
- cancellation 从 Overlay 走现有 abort 路径。
- workflow 成功、失败、超时和取消均正确释放 UI。

### 13.4 质量门

每个 Phase 合并前执行：

```bash
npm run typecheck
node tests/cc-review-static.test.mjs
node --experimental-strip-types tests/cc-review-structured.test.ts
node --experimental-strip-types tests/cc-review-ui.test.ts
node --experimental-strip-types tests/cc-review-behavior.test.ts
```

## 14. 向后兼容与发布

- 保留现有 `buildCcReviewWidgetLines`、宽度工具和相关 export，直至调用方迁移完成。
- 新 UI 默认启用前提供 `CC_REVIEW_UI_V2=1` 灰度开关。
- `CC_REVIEW_UI_V2=0` 使用现有 Widget；持久化日志和 artifacts 不受影响。
- 新 UI 至少覆盖成功、warning、review blocked、failed、timeout、cancelled 六类真实 run 后再移除开关。
- 不修改现有 artifact schema 时，Overlay 仅做映射读取；需要新增持久字段时升级 schemaVersion 并提供旧版 reader。

## 15. 风险与处理

| 风险 | 处理 |
|---|---|
| Pi 版本间 UI API 不一致 | capability adapter + command fallback |
| 常驻 Widget 抢占编辑器按键 | 默认不聚焦，只在 Overlay 内处理输入 |
| 高频日志导致闪烁或 CPU 升高 | 单次注册、render 合并、Spinner 单 timer |
| 并发任务使 currentTaskIndex 不准确 | 以每任务显式 status 为准 |
| 完整日志过大 | JSONL 分页读取，不一次性载入 |
| Finding 更新导致选择跳动 | 稳定 id 保留选择 |
| 终端 Unicode 宽度不一致 | 复用现有可见宽度工具，避免 Emoji |
| 旧 artifact 缺少新字段 | 可选字段和明确空状态 |

## 16. Definition of Done

以下条件全部满足后，本 UI 优化可视为完成：

- Compact Widget 与 Detail Overlay 已分层。
- Widget 只注册一次，更新通过 controller invalidate/requestRender 完成。
- Tasks、Files、Findings、Logs、Attempts、Reviewer、Validation 均可浏览。
- Findings 可按文件和严重级别导航。
- 默认 Widget 不再持续展示 info/debug 日志。
- 所有快捷键仅在正确焦点范围内生效，并有命令 fallback。
- 40、80、120 列及 CJK 场景无越界。
- 成功、失败、warning、block、timeout、cancelled 均释放 UI 资源。
- 全部质量门通过。
- README 补充详情入口、快捷键、降级行为和截图/文本示例。

## 17. 建议拆分的提交

1. `refactor(ui): add snapshot model and pi capability adapter`
2. `feat(ui): replace live-log widget with compact review widget`
3. `feat(ui): add task findings and file detail overlay`
4. `feat(ui): add paged logs and attempt navigation`
5. `feat(ui): expose reviewer and validation details`
6. `test(ui): cover focus responsive rendering and lifecycle`
7. `docs(ui): document review overlay and shortcuts`
