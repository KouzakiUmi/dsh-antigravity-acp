# 项目说明（AGENTS.md）

本文件是 `dsh-antigravity-acp` 的项目级入口：说明项目目的、需求与验收标准、设计取舍、实现边界与维护约定。详细契约见 [`README.md`](README.md) 与 [`docs/`](docs/)。

## 项目目的

把 Google 官方 Antigravity 接入 DeepSeek Harness，两条互斥的生成链路：

1. **ACP 模式（默认）**：模型生成走官方 ACP（stdio, ACP v1），工具执行仍由 DSH 校验、审批与执行。
2. **代理模式（默认关闭，`proxyMode`）**：插件自持 OAuth 登录态，以 agy CLI 线身份直连 Cloud Code Assist（`antigravity-proxy` 路由），不 spawn 官方进程；开启时 ACP 路由注销，关闭时恢复。

本包是 Host + Web Client bundle，含两行组件（`llm-antigravity-acp` 与 `antigravity-proxy-router`），不修改 DSH Core，也不把官方 CLI 包装成聊天接口。

npm 包名 `dsh-bundle-antigravity-host`、provider ID `antigravity-acp` / `antigravity-proxy`、内部插件名 `llm-antigravity-acp` / `antigravity-proxy-router` 不混用。

## 需求与验收标准

已确认的产品要求：

1. **对话可用**：在 DSH 里选择 `Antigravity (ACP)` 的模型即可生成，工具调用经私有 loopback MCP 桥回到 DSH 执行，结果回填同一个 ACP prompt。
2. **连接与目录**：设置页能预热连接、连接 / 登录并读取模型目录，两者都不发送聊天 prompt。
3. **模型列表由设置页管理**：用户按模型控制是否出现在 DSH 模型选择器、默认思考档位、显示名与官方模型 ID 映射。
4. **不再维护「默认模型」**：DSH 自带模型选择器负责选模，插件侧不保存第二份「新对话优先模型」。
5. **代理模式默认关闭、可切换**：`proxyMode` 保存即生效；OAuth 先导入官方 CLI 登录态、缺失再 loopback 登录；额度监控复用既有药丸与快照结构，按当前模式取对应账户。
6. **无需 CLI 的代理登录与常驻保存**：代理模式无 CLI 时可直接浏览器 OAuth；设置页保存操作随滚动常驻顶部，展示未保存计数和冲突。设置页可手动拉取当前模式额度；对话药丸采用 subusage 风格的紧凑余量条和简短状态，取数仍由本插件负责。
7. **代理模式不回退 ACP**：只要保存了 `proxyMode`，ACP 路由、登录、预热、目录发现与二进制预读均停用；代理组件缺席或未就绪时显示可读状态，不自动拉起官方进程。对话药丸保留原尺寸且只保留一个额度入口，ACP 预热集中在设置页；展开详情采用分组、窗口并排的紧凑布局。

验收以「目标符合性 + 关键使用流程 + 实际运行证据」共同判断，不以测试通过替代真实账号与 GUI 验收。

## 关键设计取舍

- **模型目录只观测，不自造**：ACP 模式目录来自会话 `configOptions` 与官方 CLI 只读清单；代理模式由 [`model-catalog.ts`](src/proxy/model-catalog.ts) 将支持的模型与当前账户的可用项取交集，排除上游停用项。审计快照之外的 Hydrogen 和 Neon 只按已观测档位派发，不借用其他家族的容量和能力。用户设置（`modelOverrides`）只作用于已存在的条目。唯一例外是受约束的合成条目 `antigravity-orchestrator`：只有配置的 planner 与 executor 都已在当前目录可见时才出现，它是插件编排入口而不是观测到的上游模型，条件不满足时不出现在选择器里。
- **编排由插件自己驱动**：`antigravity-orchestrator` 的 planner 与 executor 选择、计划解析、交回判定都在插件内（[`src/orchestrator/`](src/orchestrator/)），两模式行为一致。代理链路是两次独立上游请求（planner 用独立会话存储，不写 `ContinuationState`）；ACP 链路是独立 planner 会话 + 同会话切模型执行。官方 `gemini-pro-orchestrator-*` 条目保持原样，透传给官方 agent 自己编排。
- **停用 ≠ 删除**：停用只是不列入选择器，已知模型的显示名、上下文容量与路由仍保留，重新启用不会退回裸 ID。
- **退役模型默认关闭但可显式启用**：官方公告即将下线的家族集中登记在 [`model-retirement.ts`](src/adapter/model-retirement.ts)（单一规则源），未显式配置时默认不进选择器，ACP 与代理两链路同口径；目录观测、家族折叠与路由不删除，设置页保留条目与「即将下线」徽章，`modelOverrides` 显式 `enabled: true` 优先于默认关闭。client 内置同份表用于徽章，两侧一致性由测试锁定。
- **映射优先于家族路由**：`target` 原样写入 `session/set_config_option`，由官方 agent 判定是否接受；未登记 ID 不被静默改写。没有映射时才走「显式选择 → 该模型默认档位 → 官方默认档位」。
- **默认档位必须存在**：配置的档位若未被官方声明，退回官方默认档位，不指向不存在的选项。
- **整份 map 作为一个字段**：`modelOverrides` 参与草稿脏值与冲突判断，规范化后比较，避免键序或写回默认值被误判为未保存修改；提交时只发改动过的顶层字段。
- **会话复用**：同一 DSH 对话的后续回合只发送新增消息，历史不是已发送前缀的追加、路由或工具目录变化时受控重建。
- **代理请求即停用 ACP**：`proxyMode` 是生成模式的唯一事实源，代理行就绪状态只决定代理路由是否可用，不参与 ACP 回退。代理行缺席、卸载或注册失败时 ACP 仍保持注销，设置页说明代理不可用的原因；Host 控制层同时拒绝 ACP 登录与预热。目录、额度与运行状态统一消费请求模式。草稿只影响待保存设置。
- **目录与额度跟随账户和模式**：设置页通过代理行提供的目录服务读取代理模型，保留隐藏项供重新启用；选择器应用模型设置，准备与派发使用同一份设置快照。手动刷新绕过缓存，失败只可复用同账户已观测目录。账户代际和实际模式共同隔离目录及额度；登录、退出触发刷新，旧在途结果不能写回。
- **登录取消覆盖 token 交换**：OAuth 回调被消费后仍保留当前流程的取消信号；账户保存与清除串行完成。退出使旧刷新失效，本次插件生命周期内保持退出状态，直到用户再次显式连接。
- **连接成功包含只读项目检测**：CLI 导入先校验或刷新 access token，再通过 `loadCodeAssist` 解析已有 Cloud Code Assist 项目；缺项目时给出可读错误，流程与参考插件的只读探测一致。失效登录态可进入 OAuth；状态快照只返回脱敏阶段与账户代际，授权链接仅在显式登录结果中返回。
- **ACP 凭据导入链只读、惰性（issue #23）**：`ensureAcpCredentials` 的官方登录态候选链是「CLI 登录文件 → macOS 钥匙串（`gemini/antigravity`，`go-keyring-base64:` 解码，仅 darwin、经 `ctx.subprocess` 跑 `security`）→ 旧版 `~/.gemini/oauth_creds.json`」，实现在 [`cli-login.ts`](src/runtime/cli-login.ts)；既有凭据可用时不碰任何 CLI 来源，换发失败按链依次重试。额度取数（[`quota.ts`](src/runtime/quota.ts)）与快照身份（`cliQuotaIdentity`）用同序兜底，CLI 文件与钥匙串一律只读、绝不写回。官方 server 启动环境固定注入 `AGY_ACP_FORCE_FILE_STORAGE=1`（[`agent-link.ts`](src/protocol/agent-link.ts) `officialAgentEnv`）：官方 1.5.2 在 macOS 会把钥匙串当 primary 凭据后端而无视 `acp_token.json`，强制文件后端与插件凭据准备自洽。首个 `session/new` 用 `handshakeTimeoutMs` 档（官方冷启动收尾实测约 36 秒），建过会话后回 `requestTimeoutMs`，调用方显式 `timeoutMs` 始终优先。
- **代理模式统一出网**：OAuth 与原生 TLS 请求都使用 `resolveHttpsProxy`，显式 `proxyUrl` 优先，留空继承 Host 的 HTTPS / ALL / HTTP 代理环境；小写变量优先。`proxyBypass` 优先于环境排除列表，命中目标才直连。原生 TLS 不读取全局 fetch dispatcher，不能把宿主 fetch 已走代理当作其出网证据。
- **登录阶段与取消一致**：连接状态区分准备、等待浏览器、完成登录；阶段变化不增加账户代际或重复刷新目录。取消覆盖 OAuth 之前的换发和项目检测，以及回调后的换码与提交；失败原因按授权、项目检测和本地保存分别反馈，重试不受旧回调或监听关闭阻塞。
- **额度读取与拉取分离**：[`quota-remote.ts`](src/quota/quota-remote.ts) 的 `read` 只读 [`snapshot-store.ts`](src/quota/snapshot-store.ts) 中按模式和账户隔离的快照；Host 定时/事件刷新与手动 `refresh` 共享同一拉取入口。快照原子落盘，不写凭据或原始错误；无可确认身份时不恢复磁盘数据。旧在途结果不得覆盖新账户。代理额度优先使用已保存项目，401/403 仍按原流程换发。
- **伪装口径复用审计实现**：agy 线头、chunked 分帧、OAuth 常量与请求变换取自 `@cortexkit/antigravity-auth-core@3.0.14`（与 dsh-tool-antigravity 0.5.2 同版本）；本包只写有界传输与适配器胶水。与参考实现的差异显式记录：不携带 DSH 归属第二头、单账户不轮转 429、SOCKS 在代理模式报错。

## 实现边界

- 协议约束不是 OS 沙箱；ACP fs / terminal 与未知原生权限请求一律拒绝。
- 官方 agent 对超约 60KB 的 MCP 工具目录会丢弃工具（issue #18 探针实测）；插件按 `toolCatalogByteBudget`（默认 55000，0 禁用）在发布前把描述总量裁进预算，名称与参数不变，被裁描述带标记并写宿主日志（[`tool-catalog.ts`](src/adapter/tool-catalog.ts)）。
- 编排模式的 planner 阶段不经过 DSH 审批：ACP 链路在会话工作目录下运行官方 `mode=plan`，官方内置工具仍会执行只读命令，计划文件写在官方 brain 目录；代理链路的 planner 请求不声明工具。两条链路的 planner 会话都不注册 MCP 桥，DSH 工具只由 executor 轮次调用。
- `temperature` / `stop` 无 ACP v1 会话通道，记录警告并忽略；`maxTokens` 忽略；`reasoningEffort` 是家族 → 档位的路由键。
- 额度与 AI Credits 仅为参考值，不是计费依据；ACP 登录、CLI 登录与代理账户登录是三条链路。
- ACP 上下文容量实测（`usage_update.size`）优先，不把 `used` 记成单轮计费用量；未实测的已知家族用有来源的审计参考回退（[`model-capacity.ts`](src/adapter/model-capacity.ts)：auth-core 原生快照 + Neon/Hydrogen 的 2026-11-19 上游实测登记值），因为宿主压缩引擎对无容量路由在模型切换 / 溢出恢复时直接报错（issue #17）；未知家族仍省略容量，绝不填猜测值，审计值不落盘。代理容量来自账户目录的实际线模型（家族取已观测共同上限，既有模型保留审计回退）。设置页只读显示容量并区分实测 / 审计来源，目录输出上限不自动改成请求默认值。
- 代理模式接受图片输入（宿主附件服务在场时，单图 4MP / 1MB、整请求 12MB 内联预算，超预算协商 offload）；附件服务缺席时仅声明文本能力，图片请求报 `UNSUPPORTED_MODALITY`。端点白名单含 Cloud Code Assist 生成、目录、项目、额度方法与 Google token 端点；代理账户凭据不进日志与客户端响应。
- 版本与测试范围见 [README 兼容性矩阵](README.md#兼容性与验证范围)；宽 peer 范围是安装条件，不是全部 Core / 平台实机兼容证明。
- 自定义 LLM 错误统一经 [`llmError`](src/runtime/llm-error.ts) 构造：新宿主走 `fromFailure`，没有工厂方法的旧宿主走原构造函数；两条路径均保留自定义码和 provider 失败事实。
- [`transport.ts`](src/proxy/transport.ts) 区分生成流与普通响应预算；模型目录沿用普通响应预算，[`model-catalog.ts`](src/proxy/model-catalog.ts) 再限制条目数。生成单帧和额度接口的限制不随目录改动。

## 维护约定

- 字段以 [`src/settings.ts`](src/settings.ts) 的 `Config` 为唯一来源；`LIVE_SETTING_KEYS` 只管理即时字段。设置卡片只编辑即时字段与 `modelOverrides`（逐模型编辑器），并以指引块列出普通配置字段名（并发、二进制、各段超时）——宿主只把 volatile 字段投影进设置文档，也会拒绝 `mutate` 非 volatile 路径，把它们渲染成可编辑控件只会得到「值不是真值、保存整批失败」；`proxyBypass` 仅保留配置兼容性、不显示控制项（有测试锁定）。
- 编排核心只在 [`src/orchestrator/`](src/orchestrator/) 实现（计划解析、触发判定、提示词、状态存储）；代理与 ACP 适配器只做接入，不改写这些纯逻辑。`orchestrator` 作为整份对象字段参与草稿脏值与冲突判断，与 `modelOverrides` 同模式。
- 模型设置的纯逻辑集中在 [`src/adapter/model-settings.ts`](src/adapter/model-settings.ts)，适配器与客户端只消费其结论。
- 代理模式的线身份、传输、凭据、payload 与路由分别在 [`src/proxy/`](src/proxy/) 下独立模块；模式总线（`mode-bus.ts`）是互斥语义的唯一实现处。
- 客户端 [`src/client.js`](src/client.js) 不得导入 Node 原生模块；`remote.settings` / `remote.llm` 必须逐个声明注入。一个包只注册一次 Host Typert contribution、只执行一次客户端 `$mount`，合并 `agyQuota` 与 `agyProxyAccount` 描述符；宿主拒绝重复 package-face / Remote package 身份。
- 行为改动后同步更新 `docs/changelog.md`、`docs/configuration.md`、`docs/reference.md` 与 `docs/development.md` 的验证矩阵，并核对 `scripts/preview-kit.mjs` 的离线预览夹具。
- 验证入口：`npm run typecheck`、`npm test`、`npm run build`（`npm run check` 顺序执行三者）。
- 待决事项：无。
