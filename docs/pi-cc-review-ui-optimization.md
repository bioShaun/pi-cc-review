# pi-cc-review UI 优化参考方案

## 结论

`pi-cc-review` 当前的问题并不是“完全没有 UI”，而是已经具备任务状态、阶段状态、严重级别汇总、实时日志、窄终端适配和 CJK 宽度处理等基础能力，但信息主要堆叠在一个静态 Widget 中，缺少：

- 清晰的信息层级
- 可交互的任务选择
- 审查结果下钻
- Findings 按文件和严重级别浏览
- Widget 与详情 Overlay 的分层
- 更稳定的快捷键与焦点体系

因此，最推荐的方向不是单纯增加颜色、边框或 Emoji，而是改造成：

```text
Compact Widget
    ↓ Enter
Task / Review Detail Overlay
```

---

## 推荐参考仓库

### 1. tintinweb/pi-subagents

这是与 `pi-cc-review` 插件形态最接近、最值得直接借鉴的仓库。

重点关注：

- `src/ui/fleet-list.ts`
- `src/ui/conversation-viewer.ts`
- `src/ui/agent-widget.ts`

值得借鉴的设计：

- 编辑器附近仅保留紧凑的 Agent/任务列表
- 使用方向键选择任务
- Enter 打开宽度约 90% 的详情 Overlay
- Overlay 中查看实时会话和完整执行过程
- 支持停止或 steer Agent
- 列表右侧对齐显示耗时和 Token
- Widget 仅注册一次，后续通过 `requestRender()` 刷新
- 当前选择项具有明确焦点标识
- 已完成 Agent 会短暂保留，避免 UI 突然跳动

最适合移植到 `pi-cc-review` 的结构：

```text
常驻 Widget
  ├─ 当前阶段
  ├─ 当前任务
  ├─ Findings 汇总
  └─ 快捷键提示

Enter
  ↓

详情 Overlay
  ├─ Planner 输出
  ├─ Worker 执行过程
  ├─ Reviewer Findings
  ├─ Validation 结果
  ├─ Retry 历史
  └─ 完整日志
```

仓库：

- https://github.com/tintinweb/pi-subagents

---

### 2. tintinweb/pi-tasks

这个仓库适合参考任务列表的视觉表达和动态状态。

重点关注：

- `src/ui/task-widget.ts`

值得借鉴的设计：

- 当前任务使用动态 Spinner
- 完成任务变暗并加删除线
- Pending、Running、Completed 使用稳定图形语言
- 当前任务显示耗时和 Token
- 支持 blocker、agent ID 和 activeForm
- 长任务列表使用 `… and N more`
- Widget 状态变化与动画更新逻辑相对完整

建议引入 `activeForm` 思路。

例如：

```text
静态任务标题：
Review implementation

执行中显示：
Reviewing implementation…
```

这比始终显示相同标题更有“正在运行”的感觉。

仓库：

- https://github.com/tintinweb/pi-tasks

---

### 3. earendil-works/pi

官方仓库应作为 Pi UI API、组件生命周期和兼容性的基线。

重点关注：

- `packages/coding-agent/examples/extensions/todo.ts`
- `packages/coding-agent/examples/extensions/truncated-tool.ts`
- `packages/coding-agent/docs/extensions.md`
- `packages/coding-agent/docs/tui.md`

#### todo.ts

适合学习：

- `ctx.ui.custom()` 构建完整自定义界面
- `render()`、`handleInput()`、`invalidate()` 的组件结构
- 渲染结果缓存
- collapsed 与 expanded 两种显示模式
- Escape / Ctrl+C 关闭界面
- Session 状态重建

#### truncated-tool.ts

适合学习：

- 默认只显示摘要
- 展开后显示部分详情
- 完整内容保存到文件
- `renderCall()` 和 `renderResult()` 分离
- Partial、Expanded、Truncated 状态处理
- 控制 UI 输出长度，避免淹没上下文

对 `pi-cc-review` 的启发：

- 主 Widget 只展示摘要
- 完整日志和完整审查结果放到 Overlay 或文件
- Tool Call 和 Tool Result 使用不同渲染逻辑
- 对长输出明确标记 truncated，并提供完整文件路径

仓库：

- https://github.com/earendil-works/pi

---

### 4. Neville-Loh/gh-review

这是非常适合参考的终端代码审查 UX。

重点借鉴：

- File List / Diff / Description 三面板
- Unified 与 Side-by-side Diff
- 下一个或上一个文件
- 下一个或上一个 Hunk
- 下一个或上一个 Comment Thread
- 行级评论
- 多行选择
- Suggest Change
- Expand Context
- Resolve / Unresolve Thread
- Approve / Request Changes

仓库的核心价值不是 Pi 插件实现，而是“如何让 Review Findings 可浏览”。

`pi-cc-review` 当前 Findings 不应长期停留在：

```text
Findings: 1 critical · 2 warning · 5 info
```

更适合改为：

```text
Files
├─ src/parser.ts       2
├─ src/config.ts       1
└─ test/parser.test.ts 3
```

选择文件后展示：

```text
BLOCKER  src/parser.ts:142

Null value is passed without validation.

Evidence
Suggested fix
Reviewer
Validation status
```

仓库：

- https://github.com/Neville-Loh/gh-review

---

### 5. dlvhdr/gh-dash

适合参考整体信息层级、焦点管理、面板切换和快捷键 Footer。

值得借鉴：

- 面板层级设计
- 焦点状态
- 快捷键提示
- Responsive 布局
- 列表浏览到深度 Review 的工作流
- 左侧列表、右侧详情的结构
- 在窄终端中按优先级隐藏非关键信息

推荐将 `pi-cc-review` 设计为：

```text
Widget：运行监控和快速定位
Overlay：任务与 Findings 浏览
Markdown Result：最终可持久化报告
```

仓库：

- https://github.com/dlvhdr/gh-dash

---

### 6. DragonYH/pi-ui

这个仓库适合在整体交互架构完成后，用于视觉润色。

可参考：

- 自定义状态栏
- Boxed Editor
- 自适应 Working Indicator
- 根据持续时间变化的运行状态
- 窄屏时优先隐藏非关键内容
- 更统一的间距、边框和状态色

它更适合解决“看起来更精致”，但不应替代前面的交互架构设计。

仓库：

- https://github.com/DragonYH/pi-ui

---

## 推荐组合

| 需求 | 推荐参考仓库 |
|---|---|
| Pi UI API 和兼容性 | `earendil-works/pi` |
| Widget + Overlay 架构 | `tintinweb/pi-subagents` |
| Task 状态展示 | `tintinweb/pi-tasks` |
| Review Findings 浏览 | `Neville-Loh/gh-review` |
| 面板和快捷键体系 | `dlvhdr/gh-dash` |
| 最终视觉润色 | `DragonYH/pi-ui` |

---

## 推荐的常驻 Widget

主 Widget 不建议默认展示大量 Live Logs，可以压缩为：

```text
● CC Review  2/5 · Reviewing · 03:12

  ✔ 1  Plan implementation
  ✳ 2  Review parser changes…    sonnet · 1m21s
  ○ 3  Add validation tests

  Findings  1 blocker · 2 warnings · 5 info
  ↓ select · Enter details · L logs · Esc cancel
```

### 设计原则

- 第一行只显示整体状态
- 中间只保留少量任务
- 当前任务突出显示
- 完成任务弱化
- Findings 只显示摘要
- 不在主 Widget 中持续刷大量日志
- 最后一行始终保留快捷键提示

---

## 推荐的详情 Overlay

按 Enter 后打开详情 Overlay：

```text
┌ Tasks / Files ─────────┬ Review Details ──────────────────────┐
│ ✔ 1 Plan               │ BLOCKER                              │
│ ▸ 2 Parser review      │ src/parser.ts:142                    │
│ ○ 3 Tests              │                                      │
│                        │ Missing null validation before parse │
│ Findings               │                                      │
│ ● parser.ts          2 │ Evidence                             │
│ ○ config.ts          1 │ Suggested fix                        │
│ ○ parser.test.ts     3 │ Validation result                    │
├────────────────────────┴──────────────────────────────────────┤
│ ↑↓ select · Tab panel · Enter expand · L logs · Esc close    │
└───────────────────────────────────────────────────────────────┘
```

### 左侧面板

可以在以下视图间切换：

- Tasks
- Files
- Findings
- Reviewers
- Attempts

### 右侧面板

显示当前选中项的完整详情：

- Task 描述
- Planner 原始输出
- Worker 修改摘要
- Reviewer Finding
- 文件路径和行号
- Evidence
- Suggested Fix
- Validation Result
- Retry 原因
- 对应模型
- 耗时和 Token

---

## 建议的信息架构

### 第一层：Status Bar

仅展示最关键状态：

```text
CC Review · Reviewing · Task 2/5 · 1 blocker
```

### 第二层：Compact Widget

展示：

- 当前任务
- 前后少量任务
- Findings 汇总
- 最后一个 Warning / Error
- 快捷键提示

### 第三层：Overlay

展示：

- 全部任务
- 全部 Findings
- 日志
- Reviewer 输出
- Validation 结果
- Retry 历史

### 第四层：持久化文件

保存：

- 完整日志
- 完整 Markdown Review
- JSON Findings
- 执行元数据
- 每次 Reviewer 原始输出

---

## 快捷键建议

| 快捷键 | 功能 |
|---|---|
| `↓` / `↑` | 进入列表或切换任务 |
| `Enter` | 打开详情 |
| `Tab` | 切换面板 |
| `j` / `k` | 上下移动 |
| `n` / `N` | 下一个 / 上一个 Finding |
| `]` / `[` | 下一个 / 上一个文件 |
| `L` | 打开日志 |
| `F` | 切换 Findings 视图 |
| `R` | 查看 Reviewer 输出 |
| `V` | 查看 Validation |
| `Esc` | 返回或关闭 |
| `Ctrl+C` | 取消 Workflow |
| `?` | 打开帮助 |

---

## 状态图标建议

| 状态 | 图标 |
|---|---|
| Pending | `○` |
| Running | 动态 Spinner |
| Completed | `✔` |
| Completed with warnings | `⚠` |
| Failed | `✘` |
| Validation failed | `✖` |
| Review blocked | `⛔` |
| Skipped | `↪` |
| Cancelled | `⊘` |

建议减少 Emoji 使用，优先选择单列宽度、终端兼容性更稳定的符号。

---

## 色彩建议

颜色只表达语义，不用于装饰。

| 语义 | 颜色 |
|---|---|
| 当前活动项 | accent |
| 成功 | success |
| Warning | warning |
| Blocker / Error | error |
| 次要信息 | muted |
| 已完成历史 | dim |
| 普通文本 | text |

避免：

- 每一行都使用不同颜色
- 大量彩色边框
- 同一状态使用多个图标和颜色重复表达
- 在日志中为普通 info 使用过强颜色

---

## Responsive 策略

### 宽度小于 50 列

仅显示：

- 当前阶段
- 当前任务
- Findings 数量
- 最新 Error / Warning

隐藏：

- 模型名称
- 完整 Goal
- 日志来源
- 完整路径
- 多任务列表

### 宽度 50–90 列

显示：

- 3–5 个任务
- Findings 汇总
- 当前模型
- 当前耗时
- 最新 1–2 条日志

### 宽度大于 90 列

显示：

- 更多任务
- 模型与耗时
- Findings 分类
- 文件摘要
- 更多快捷键提示

---

## 最优先实施顺序

### Phase 1：Widget 与 Overlay 分层

参考 `pi-subagents`：

- 增加可选择的 Widget
- 增加方向键导航
- Enter 打开详情 Overlay
- 主 Widget 与详情界面分离

这是收益最大的一步。

### Phase 2：压缩主 Widget

- 移除默认 5 行 Live Logs
- 只保留最新 Warning / Error
- Findings 只保留汇总
- 完整日志移入 Overlay

### Phase 3：任务行重构

参考 `pi-tasks`：

- 动态 Spinner
- activeForm
- 完成任务删除线
- 耗时
- Token
- Agent / Model 信息
- 隐藏任务数量提示

### Phase 4：Findings 浏览器

参考 `gh-review`：

- 按文件分组
- 按严重级别过滤
- Next / Previous Finding
- 展示文件和行号
- Evidence
- Suggested Fix
- Validation Status

### Phase 5：统一视觉系统

- 统一状态图标
- 统一色彩语义
- 统一间距
- 统一边框
- 增加帮助 Overlay
- 完善窄终端适配

---

## 最终建议

最推荐的实现组合是：

```text
pi-subagents
    负责 Widget、焦点、Overlay 和实时刷新架构

pi-tasks
    负责任务列表、Spinner、耗时和 Token 展示

gh-review
    负责 Findings、文件、行号和审查详情浏览体验

earendil-works/pi
    负责 API、生命周期、渲染组件和兼容性基线

gh-dash
    负责面板层级、快捷键 Footer 和整体信息密度

pi-ui
    负责最终视觉润色
```

不要优先把时间花在颜色、Emoji 和边框上。

优先完成：

```text
静态信息堆叠
    ↓
可选择的 Compact Widget
    ↓
可下钻的 Review Overlay
    ↓
按文件和严重级别浏览 Findings
```

这一结构调整会比任何单纯视觉美化带来更明显的体验提升。
