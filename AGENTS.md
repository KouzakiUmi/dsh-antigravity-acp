# 项目说明（AGENTS.md）

本文件是 `dsh-antigravity-acp` 的项目级入口：说明项目目的、需求与验收标准、设计取舍、实现边界与维护约定。详细契约见 [`README.md`](README.md) 与 [`docs/`](docs/)。

## 项目目的

把 Google 官方 Antigravity ACP agent 接入 DeepSeek Harness：模型生成走官方 ACP（stdio, ACP v1），工具执行仍由 DSH 校验、审批与执行。本包是 Host + Web Client bundle，不修改 DSH Core，也不把官方 CLI 包装成聊天接口。

npm 包名 `dsh-bundle-antigravity-host`、provider ID `antigravity-acp`、内部插件名 `llm-antigravity-acp` 三者不混用。

## 需求与验收标准

已确认的产品要求：

1. **对话可用**：在 DSH 里选择 `Antigravity (ACP)` 的模型即可生成，工具调用经私有 loopback MCP 桥回到 DSH 执行，结果回填同一个 ACP prompt。
2. **连接与目录**：设置页能预热连接、连接 / 登录并读取模型目录，两者都不发送聊天 prompt。
3. **模型列表由设置页管理**：用户按模型控制是否出现在 DSH 模型选择器、默认思考档位、显示名与官方模型 ID 映射。
4. **不再维护「默认模型」**：DSH 自带模型选择器负责选模，插件侧不保存第二份「新对话优先模型」。

验收以「目标符合性 + 关键使用流程 + 实际运行证据」共同判断，不以测试通过替代真实账号与 GUI 验收。

## 关键设计取舍

- **模型目录只观测，不自造**：目录来自 ACP 会话 `configOptions` 与官方 CLI 只读清单；用户设置（`modelOverrides`）只作用于已存在的条目。
- **停用 ≠ 删除**：停用只是不列入选择器，已知模型的显示名、上下文容量与路由仍保留，重新启用不会退回裸 ID。
- **映射优先于家族路由**：`target` 原样写入 `session/set_config_option`，由官方 agent 判定是否接受；未登记 ID 不被静默改写。没有映射时才走「显式选择 → 该模型默认档位 → 官方默认档位」。
- **默认档位必须存在**：配置的档位若未被官方声明，退回官方默认档位，不指向不存在的选项。
- **整份 map 作为一个字段**：`modelOverrides` 参与草稿脏值与冲突判断，规范化后比较，避免键序或写回默认值被误判为未保存修改；提交时只发改动过的顶层字段。
- **会话复用**：同一 DSH 对话的后续回合只发送新增消息，历史不是已发送前缀的追加、路由或工具目录变化时受控重建。

## 实现边界

- 协议约束不是 OS 沙箱；ACP fs / terminal 与未知原生权限请求一律拒绝。
- `temperature` / `stop` 无 ACP v1 会话通道，记录警告并忽略；`maxTokens` 忽略；`reasoningEffort` 是家族 → 档位的路由键。
- 额度与 AI Credits 仅为参考值，不是计费依据；ACP 登录与 CLI 登录是两条链路。
- 上下文容量只在实测到 `usage_update.size` 后才声明，不填猜测值。
- 版本与测试范围见 [README 兼容性矩阵](README.md#兼容性与验证范围)；宽 peer 范围是安装条件，不是全部 Core / 平台实机兼容证明。

## 维护约定

- 字段以 [`src/settings.ts`](src/settings.ts) 的 `Config` 为唯一来源；`LIVE_SETTING_KEYS` 与设置卡片渲染的字段必须一致（有测试锁定）。
- 模型设置的纯逻辑集中在 [`src/adapter/model-settings.ts`](src/adapter/model-settings.ts)，适配器与客户端只消费其结论。
- 客户端 [`src/client.js`](src/client.js) 不得导入 Node 原生模块；`remote.settings` / `remote.llm` 必须逐个声明注入。
- 行为改动后同步更新 `docs/changelog.md`、`docs/configuration.md`、`docs/reference.md` 与 `docs/development.md` 的验证矩阵，并核对 `scripts/preview-kit.mjs` 的离线预览夹具。
- 验证入口：`npm run typecheck`、`npm test`、`npm run build`（`npm run check` 顺序执行三者）。
- 待决事项：无。
