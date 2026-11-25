# Orchestrator（planner → executor）实现规格

状态：待实现（设计冻结，2026-11-24）。本文是实现依据：接口与字段名为契约，实现偏离须先在本文更新。

## 1. 目标

在两条互斥链路里提供同一个编排模型：选 `antigravity-orchestrator` 后，问题先由 **planner** 产出计划（目标、步骤、每步验证方式、**交回条件**），再由 **executor** 执行；executor 命中交回条件时，下一轮重新规划。ACP 链路与代理链路行为一致，只是执行后端不同。

非目标：不复刻官方 `gemini-pro-orchestrator-*` 行；官方那两个条目保持原样（用户仍可选官方编排）。本功能是插件自持编排，用来在代理模式（没有官方 agent）与 ACP 模式之间取得一致行为。

## 2. 已核实约束

1. 一次 DSH `generate` = 链路一次请求；工具由宿主执行，宿主在工具结果后再次调用 adapter。编排以「每一步」为单位，同一次用户回合内可多次交回。
2. `StreamChunk` 无 plan 通道（`@deepseek-ai/dsh-llm` 只有 block/text/reasoning/tool-call/usage/finish）。计划默认只注入上下文；可选以文本块展示（`showPlan`）。
3. 续轮指纹含 `provider/model/effort/system/tools`（`routeFingerprint`）。planner 阶段不得与 executor 共用 `ContinuationState`，代理侧 planner 请求不参与会话续轮状态。
4. 两条链路目录都来自观测；新增 `antigravity-orchestrator` 是**受约束的合成条目**：仅当其 planner 与 executor 都已被观测到才出现。此边界变更写进 AGENTS/README。
5. ACP 侧 `mode` configOption 值为 `default | accept-edits | auto | plan`；`thought_level` 为 `low | medium | high | xhigh`。当前插件只写 `model`，本功能新增写 `mode` 与档位路由。
6. ACP 的 planner 会话**不得挂 MCP 工具**：工具回调会在未结束的 `generate` 内嵌套触发，与 `mcp-bridge` 的单轮模型冲突。

## 3. 编排状态

```ts
export type OrchestratorStage = 'idle' | 'planning' | 'executing'

export interface PlanStep {
  id: string                 // 'p1'…
  title: string
  verification?: string      // 该步如何自证完成
}

export interface OrchestratorPlan {
  goal: string
  steps: readonly PlanStep[]
  handback: readonly string[] // planner 自写的「停下来问」条件
  revision: number
  createdAt: number
}

export interface OrchestratorState {
  plan?: OrchestratorPlan
  stage: OrchestratorStage
  plansThisTurn: number
  turnKey?: string           // 当前用户回合标识，用于重置 plansThisTurn
  lastError?: string
}
```

状态按 DSH 会话隔离：键 = `options.sessionId ?? 'anonymous'`，与 `session-reuse.ts` 的 `sessionId::chat` 同源但独立。会话结束（或 adapter dispose）时回收；上限 64 条，LRU 淘汰。

## 4. 模块与接口（`src/orchestrator/`，新建）

| 文件 | 导出 | 职责 |
|---|---|---|
| `types.ts` | 上面的类型 + `OrchestratorSettings` | 纯类型 |
| `plan-schema.ts` | `parsePlan(text, previous?): OrchestratorPlan \| undefined`、`renderPlanForExecutor(plan): string` | 宽松解析 `<plan>{json}</plan>`（容忍代码围栏与前后文字），渲染注入文本 |
| `triggers.ts` | `shouldPlan(input): { plan: boolean; reason: string }` | 见 §5 |
| `prompts.ts` | `PLANNER_SYSTEM_SUFFIX`、`buildPlannerMessages(goal, evidence, prior?): readonly RequestMessage[]`、`buildExecutorSystem(base, plan)` | planner 提示与 executor 注入 |
| `state.ts` | `class OrchestratorStore { get/update/resetTurn/dispose }` | 状态存储与 LRU |
| `index.ts` | 汇总导出 | — |

`OrchestratorSettings`（规范化后）：

```ts
export type OrchestratorPlannerModel = 'gemini-4-neon' | 'gemini-4-argon' | 'claude-opus-5-5'
export type OrchestratorExecutorModel = 'gemini-4-hydrogen' | 'claude-sonnet-5-5'
export const ORCHESTRATOR_EXECUTOR_MODEL: OrchestratorExecutorModel = 'gemini-4-hydrogen'

export interface OrchestratorSettings {
  enabled: boolean                     // 默认 true
  plannerModel: OrchestratorPlannerModel // 默认 'claude-opus-5-5'，仅这三个值
  executorModel: OrchestratorExecutorModel // 默认 'gemini-4-hydrogen'，仅这两个值
  maxPlansPerTurn: number              // 默认 2，范围 1–4
  plannerTimeoutMs: number             // 默认 20000（ACP 侧未显式设置时 120000）
  showPlan: boolean                    // 默认 false
}
```

`normalizeOrchestratorSettings(input: unknown): OrchestratorSettings` 与 `model-settings.ts` 同风格：非法值回落默认、不抛错。`plannerModel` 不在三值集合内回落 `claude-opus-5-5`，`executorModel` 不在两值集合内回落 `gemini-4-hydrogen`；未知字段静默忽略（旧配置不报错）。

### 3.1 组合与档位（双角色可配置 + 双角色档位）

- **planner**：`gemini-4-neon`、`gemini-4-argon`、`claude-opus-5-5` 三选一，默认 `claude-opus-5-5`。
- **executor**：`gemini-4-hydrogen`、`claude-sonnet-5-5` 两选一，默认 `gemini-4-hydrogen`（对齐官方 Antigravity 编排设置的可选项与默认值）；设置页下拉选择。
- **两个角色各带一个档位**（对齐 Devin Fusion 的 `leadEffort` / `sidekickEffort`，也对齐 agy 官方 Orchestrator 的 Planner / Executor Effort）：
  - `plannerEffort`：默认 `medium`；
  - `executorEffort`：默认 `medium`。
- **可选档位随模型变化**（实测见 §13），实现不能写死低中高：
  - ACP 侧：取当前会话 `configOptions.thought_level` 的选项；切换 model 后重新读取。
  - 代理侧：取该家族在 live 目录的档位集合（`liveGemini.variants` 或 `definitions` 的档位）。
  - 配置值不在集合内时收敛到 `medium`；`medium` 不可用时取最近档。
- **切换角色必须显式带档位**：写 `<family>-<effort>`（服务端会归一化为家族名并回写 `thought_level`），或分两步「先写 model，再写 thought_level」。只写家族名会让 executor 继承 planner 的档位（§13 实测）。
- `antigravity-orchestrator` 条目的 `reasoning` 暴露 planner 家族支持的档位，`defaultEffort` = `plannerEffort`；用户在对话里改思考强度即改 planner 生效值。

## 5. 规划触发（`shouldPlan`）

输入：`messages`、`state`、`goal`、`settings`。按序判定，先命中先返回：

| 条件 | 结果 |
|---|---|
| `settings.enabled === false` | 不规划（`disabled`） |
| `state.plansThisTurn >= settings.maxPlansPerTurn` | 不规划（`budget`） |
| 无 `state.plan` | 规划（`no-plan`） |
| 本轮出现新的真实用户消息（`role==='user'` 且 `source.kind` 为 `'user'` 或缺省，且与 `state.turnKey` 不同） | 规划（`new-goal`），并 `resetTurn` |
| 最后一条 `role==='tool'` 消息 `isError === true` | 规划（`tool-error`） |
| 最近 4 条 tool 消息里同一工具名连续 2 次 `isError` | 规划（`repeat-failure`） |
| 否则 | 不规划（`continue`） |

`turnKey` = `sessionId + ':' + (最后一条真实用户消息的指纹)`，用 `messageFingerprint` 计算。

## 6. 代理链路（`src/proxy/adapter.ts`）

新增导出常量 `ORCHESTRATOR_MODEL_ID = 'antigravity-orchestrator'`（放 `src/orchestrator/types.ts`，两链路共用）。

`stream()` 现有分支之前插入：`options.model === ORCHESTRATOR_MODEL_ID` → `streamOrchestrated(options, generation)`；其余路径不变。

`streamOrchestrated` 步骤：

1. 规范化设置（`normalizeOrchestratorSettings(settings.orchestrator)`）；`enabled === false` → 直接按 executor 常规路径执行（`model` 未在 definitions 里，需先改写成 executor 的 `antigravity-*` 家族 ID）。
2. 解析 planner / executor wire，两条路径分别处理（已实现，见 `src/proxy/model-catalog.ts` 的 `resolveProxyOrchestratorEndpoint`）：
   - `isLiveGeminiFamily(familyId)` 的模型（`gemini-4-hydrogen` / `gemini-4-neon`）**不在** auth-core `getPublicModelDefinitions()` 里，只能从 live 目录的 `models.get(familyId).liveGemini.variants.get(effort)` 取 wire，并核对 `catalog.wire` 存在；
   - 其余模型走 `resolveProxyWireModel(familyId, effort)`，并同时核对 `definitions`（非图片输出）与 live 目录。
   任一解析不出来都抛 `INVALID_MODEL`（措辞：`编排模式的 planner/executor 模型不在当前目录`）。
3. `shouldPlan`。需要规划时：
   - 用 `buildProxyGeneratePayload` 构造 planner 请求：`model = plannerWire`、`tools = []`、`system = options.system + PLANNER_SYSTEM_SUFFIX`、`messages = buildPlannerMessages(goal, evidence, priorPlan)`；证据 = 最近 6 条 tool 结果的文本摘要（每条 ≤ 1200 字符），不含图片。
   - 以 `AbortSignal`（`options.signal` 叠加 `AbortSignal.timeout(settings.plannerTimeoutMs)`）请求 `STREAM_ENDPOINT`，消费 SSE 收集文本。**不生成 StreamChunk，不写 ContinuationState。**
   - 解析计划成功 → 更新 state（`revision = prior+1`、`stage='executing'`、`plansThisTurn+1`），`showPlan === true` 时以一次性文本块 emit（`block-start` + `text-delta` + `block-end`，index 0）。
   - 失败/超时/解析失败 → `log.warn` + 不改变 state，继续执行 executor。
4. executor 阶段：把 `options` 以 `{ ...options, model: executorModelFamily }` 交给现有 `streamInGeneration`；`system` 追加 `renderPlanForExecutor(plan)`。图片与工具声明沿用 executor 的能力。
5. 用量：**只发一个 `usage` chunk，紧贴 `finish` 之前**（已实现：`streamOrchestrated` 缓冲 executor 的 usage 后与 planner 用量合并；宿主后到的 `usage` 会覆盖前一条，不会自动累加，所以不能分两次发）。逐字段累加已知量；有任一已执行阶段的精确总量未知时省略 `totalTokens`。取消终态不发 usage。
6. 取消：`options.signal` 中止时结束 planner 请求并返回 `finish: { kind: 'aborted' }`，不 emit usage。

注意：executor 阶段 `options.system` 变化会让本步续轮指纹失效并受控重建，这是预期行为；计划渲染必须**稳定**（同一 plan 的渲染结果逐字节相同）。

## 7. ACP 链路（`src/adapter/antigravity-adapter.ts`）

`stream()` 内 `#streamExclusive` 之前插入：`options.model === ORCHESTRATOR_MODEL_ID` → `#streamOrchestrated(options)`。

1. planner 会话：按会话键缓存一个独立 ACP 会话（`link.newSession({ cwd, mcpServers: [] })`），复用连接池里的 link；不注册 MCP 桥。设置 `configId='model'` 的值为 `routeTieredModelId(plannerFamily, plannerEffort, tiers)`；`configOptions` 里存在 `category === 'mode'` 时设 `'plan'`（若其选项包含 plan）。
2. planner prompt：`prompt([{ type: 'text', text: <planner 指令 + 目标 + 证据摘要> }])`，超时用 `settings.plannerTimeoutMs`（ACP 默认 **120000**，见 §13 实测）。

   **实测结论（2026-11-24，agy 1.5.15，空临时目录 + `mcpServers: []` + `mode=plan`）**：`mode=plan` 只限制了工作区写入，**不等于纯规划器**——官方 agent 仍会用自己的内置工具执行只读命令（`Get-ChildItem`、`node -v`），并把计划写成 `~/.gemini/antigravity-cli/brain/<id>/implementation_plan.md`。计划正文出现在 `agent_message_chunk` 里，**没有 `plan` sessionUpdate**。因此：
   - 计划采集以 `agent_message_chunk` 汇总文本为准，`implementation_plan.md` 只作可选辅助（路径来自 `tool_call` 标题，不可稳定依赖）。
   - 不要假设「无 MCP 工具」等于「不执行任何动作」；隔离靠 `cwd`，不靠 `mode`。planner 会话的 `cwd` 取值见 §14 决策项。
   - planner 会话会产生 `current_mode_update` / `config_option_update` / `available_commands_update` / `session_info_update` 通知，实现须忽略未知通知而不是报错。
3. executor：在**chat 会话**上 `setConfigOption(model=executor 路由值)`，恢复 mode（若之前改成 plan，则设回该会话原 mode 或 `default`），随后走现有 `#runNewRound` / `#runContinuation`，`system` 追加计划渲染。
4. 失败降级：planner 会话建立失败、超时、无文本 → `log.warn`，直接执行 executor。
5. 取消：`options.signal` 中止时 `session/cancel` planner 会话，且不污染 chat 会话状态。
6. 计划展示：`showPlan` 时与代理链路一致，emit 文本块。

风险与必须处理的边界：planner 会话的 `session/prompt` 期间宿主不会再调用 `generate`，因此不会产生工具回调；若未来给 planner 挂工具，必须先改 `mcp-bridge` 的轮次模型，不在本次范围。

## 8. 设置（`src/settings.ts`）

新增字段并加入 `LIVE_SETTING_KEYS`：

```ts
export interface OrchestratorConfig {
  enabled?: boolean
  plannerModel?: 'gemini-4-neon' | 'gemini-4-argon' | 'claude-opus-5-5'
  plannerEffort?: 'low' | 'medium' | 'high'
  executorModel?: 'gemini-4-hydrogen' | 'claude-sonnet-5-5'
  executorEffort?: 'low' | 'medium' | 'high'
  maxPlansPerTurn?: number
  plannerTimeoutMs?: number
  showPlan?: boolean
}
// AntigravityHostConfig 增加：
orchestrator?: OrchestratorConfig
```

配置层的 effort 只接受 `low` / `medium` / `high`（与卡片下拉一致）；Hydrogen 的 `xhigh` 不在配置层暴露，运行期由 `convergeOrchestratorEffort` 对照 live 目录或 `thought_level` 的实际集合处理。

`executorModel` 两值枚举、默认 `gemini-4-hydrogen`；规范化层对非法值回落默认模型，不抛错。

`liveHostConfig()` 增加 `orchestrator` 的 getter（volatile 读取）。Schema 用 `Schema.object(...)`，所有子字段可选、带 `volatile()` 由父字段承担；`plannerModel` 用三值枚举、默认 `claude-opus-5-5`，`executorModel` 用两值枚举、默认 `gemini-4-hydrogen`；`maxPlansPerTurn` 默认 2、范围 1–4；`plannerTimeoutMs` 默认 20000、范围 5000–300000；两个 effort 均为三值枚举（low / medium / high）、默认 `medium`，Hydrogen 的 `xhigh` 不进配置层，实际可用性由适配器按目标模型收敛（§3.1）。

## 9. 目录条目

**代理**（`src/proxy/model-catalog.ts` + adapter 目录合成）：当
- planner（三选一）与配置的 executor（两选一）的 wire 都能解析，且
- 两条 wire 都在 live 目录与 `definitions`（或 live family 变体）中

时，在目录里追加 `id: 'antigravity-orchestrator'`、`name: 'Orchestrator（插件编排）'`、`inputModalities` 取 executor 的能力、contextWindow 取两者最小值。不满足条件时该条目不出现，且选中它会得到 `INVALID_MODEL`。

**ACP**（`src/adapter/antigravity-adapter.ts` 的目录路径）：当 planner 与 executor 的家族值都出现在 `configOptions.model.options` 里时追加同一 id/名称的条目；`reasoning` 暴露 planner 家族支持的档位，`defaultEffort` 按 §3.1 的 planner 取值顺序决定。

两链路共用同一 id，用户在不同模式下看到同一名称。

**可见性语义**：门槛中的「目录可见」指上游账户目录 / ACP `configOptions` 中存在该家族，与 `modelOverrides` 的用户停用开关无关——停用只过滤普通观测条目，合成条目的出现只取决于 planner / executor 两家族的上游可用性与 `enabled` 开关。

## 10. 前端（`src/client.js` + `src/client-i18n/`）

设置卡片新增「编排（Orchestrator）」分组，字段：

| key | 控件 | 说明 |
|---|---|---|
| `orchestratorEnabled` | 开关 | 关闭后不生成条目、不编排 |
| `orchestratorPlannerModel` | 下拉 | 仅 `gemini-4-neon` / `gemini-4-argon` / `claude-opus-5-5`，默认 Opus 5.5 |
| `orchestratorPlannerEffort` | 下拉 | low / medium / high，默认 medium |
| `orchestratorExecutorModel` | 下拉 | 仅 `gemini-4-hydrogen` / `claude-sonnet-5-5`，默认 Hydrogen |
| `orchestratorExecutorEffort` | 下拉 | low / medium / high，默认 medium |
| `orchestratorMaxPlans` | 数字 | 1–4 |
| `orchestratorShowPlan` | 开关 | 在对话里显示计划文本 |

即 7 个可编辑控件（启用开关、planner / executor 两个模型下拉、两个档位、规划预算、计划显示开关）。下拉选项取保守子集（low/medium/high）；xhigh 等模型特有档位由宿主按 §3.1 收敛，不在卡片暴露。

契约约束：一张卡片只提交改动过的顶层字段；`orchestrator` 作为一个**整份对象字段**参与脏值与冲突判断（与 `modelOverrides` 同模式：`canonicalOrchestrator` / `sameOrchestrator`）。新增中文原文文案须同时补 `src/client-i18n/en-ui.js`。

## 11. 分片与写入归属

| 分片 | 负责人 | 可写文件 |
|---|---|---|
| A 核心编排层 + 代理链路 | 实现 worker（Hydrogen） | `src/orchestrator/**`、`src/settings.ts`、`src/proxy/adapter.ts`、`src/proxy/model-catalog.ts`、`tests/orchestrator/**`、`tests/proxy/orchestrator*.test.ts` |
| B ACP 链路 | 同一 worker 续办（A 完成后） | `src/adapter/antigravity-adapter.ts`、`src/adapter/model-catalog.ts`、`tests/adapter/orchestrator*.test.ts` |
| C 设置页前端 | 前端 worker（Neon） | `src/client.js`、`src/client-i18n/en-ui.js`、`tests/client-*.test.ts` |
| D 集成与文档 | 主代理 | `docs/**`、`AGENTS.md`、`README.md`、`docs/changelog.md`、`src/index.ts`、`src/proxy/mode-bus.ts`、`tests/client-interaction.test.ts`（整份对象字段的既有断言） |

## 15. 实现状态

| 分片 | 状态 | 证据 |
|---|---|---|
| A 核心编排层 + 代理链路 | 已完成自测 | `src/orchestrator/**`、`src/proxy/adapter.ts`、`src/proxy/model-catalog.ts`、`src/settings.ts`；`tests/orchestrator/**`、`tests/proxy/orchestrator-proxy.test.ts` 通过；typecheck / build 通过 |
| C 设置页前端 | 已完成自测 | `src/client.js` 编排分组（7 控件）、`src/client-i18n/en-ui.js` 16 条文案、`tests/client-*.test.ts` 新增 10 条 |
| D 集成（`orchestrator` 透传到代理行） | 已完成 | `src/index.ts` 的 `modeBus.modelSettings()` 与 `src/proxy/mode-bus.ts` 类型；`LIVE_SETTING_KEYS` 增加后 `tests/client-interaction.test.ts` 的整份对象断言已同步 |
| B ACP 链路 | 待实现 | 规格 §7 的实测约束与 §14 的 `cwd` 决策已就绪 |

A 与 C 可并行（文件不重叠）；B 在 A 的 `src/orchestrator/index.ts` 产出后开始。

## 12. 验收

必须全部满足：

1. `npm run typecheck`、`npm test`、`npm run build` 通过。
2. 单元：`shouldPlan` 六个分支；`parsePlan` 正常/带围栏/损坏 JSON；`normalizeOrchestratorSettings` 非法值；代理 planner 失败降级；预算上限；ACP planner 超时降级（假 agent）。
3. 目录：两链路都只在依赖模型可见时出现 `antigravity-orchestrator`；不出现时不报错、不影响其它条目。
4. 续轮：executor 阶段 system 稳定后 continuation 正常复用；plan 更新的那一轮允许一次受控重建，且日志可见。
5. 手工验收（真机）：代理模式下简单任务不产生 planner 请求；含失败任务触发一次重规划；`maxPlansPerTurn` 生效；`showPlan` 开关行为正确。
6. 文档：`docs/changelog.md` 加条目；`docs/configuration.md` 记录新字段；`AGENTS.md` 与 README 更新「目录不自造」的边界表述。

## 13. 已实测

1. **ACP `mode=plan`（2026-11-24，agy 1.5.15，空临时目录 + `mcpServers: []`）**：设置成功（`current_mode_update`），停止原因 `end_turn`，全程 57s。agent 仍执行内置只读命令并写 brain 目录的 `implementation_plan.md`；没有 `plan` sessionUpdate，计划正文在 `agent_message_chunk`。→ 已回写 §7 的采集方式与超时默认值。
2. ACP planner 会话的计划质量（用本仓库小任务对照）：B 分片实现时验证。
3. 代理线对 `gemini-pro-orchestrator-g1-pro` 的响应形态（仅影响官方条目如何标注，不阻塞本实现）。
4. **思考档位的判定（2026-11-24，agy 1.5.15，ACP `session/new` + `set_config_option`，未发 prompt）**：
   - 模型选择器返回的是**家族名**（`gemini-4-hydrogen`），档位由独立的 `thought_level` 表示（默认 `high`）。
   - 写入带后缀的 model（`gemini-4-hydrogen-medium`）时，服务端**拆开归一化**：`model` 回写为 `gemini-4-hydrogen`，`thought_level` 同步变为 `medium`。即后缀是档位的权威来源，两者是同一事实的两种表示。
   - 只写家族名**不会**改 `thought_level`：会话沿用上一个角色的档位。
   - 可选档位**随模型变化**：`claude-opus-5-5` 为 low/medium/high，`gemini-4-hydrogen` 为 low/medium/high/xhigh。
   - 选中官方 `gemini-pro-orchestrator-g1-pro` 后 `thought_level` 选项**消失**，写入返回 `-32602 Thinking level "xhigh" is not offered for model "Orchestrator (Argon)"`——官方编排的档位在 CLI 设置的 `"orchestrator"` 键里，不走 ACP。
   - 代理侧对应实现：`src/proxy/payload.ts` 对 `gemini-4-(hydrogen|neon)-<level>` 只带 `thinkingConfig.includeThoughts`，档位完全由 wire model 后缀决定；其余家族才用 `thinkingLevel` / `thinkingBudget`。

## 14. 已决策：planner 会话的 `cwd` = 工作区目录

实测表明官方 agent 在 `mode=plan` 下仍会运行自己的只读命令。用户决策（2026-11-24）：**planner 会话使用工作区目录**，换取接近官方的计划质量（planner 能读真实代码）。

由此明确三条实现要求：

1. planner 会话的只读命令与 brain 目录下的 `implementation_plan.md` 不经过 DSH 审批与审计；这是本模式的已知取舍，须在设置页文案与 `docs/configuration.md` 里如实说明一句（不写免责声明，只写事实）。
2. planner 会话仍然 `mcpServers: []`：DSH 侧工具不得被 planner 调用，避免在未结束的 `generate` 内嵌套触发 MCP 桥。
3. planner 会话缓存按 `cwd` 失效：会话工作目录变化时必须新建，不得复用旧目录的计划会话。


