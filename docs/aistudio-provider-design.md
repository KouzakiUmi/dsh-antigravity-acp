# AI Studio 独立 provider 设计

> 本页保留 AI Studio 首期设计及上游验证记录。0.1.54 还加入本地用量面板，并与 Vertex AI 共享标准 Gemini 请求构造；当前设置见[配置参考](configuration.md#配置清单)。实现演进见 §10，真实 API 验证见 §11。

## 1. 结论先行

AI Studio（Gemini API，`generativelanguage.googleapis.com`）应作为本 bundle 的**第三个组件行**，provider id 暂定 `aistudio`，与 `antigravity-acp`、`antigravity-proxy` 并列，注册到 DSH 模型选择器。它是一个「用户自备 API key 的独立路由」，与 agy CLI 的 OAuth 登录态完全解耦。

**为什么不放进 `src/features/`**：features 框架只暴露 `registerTool`（让当前模型调用工具），不暴露 `registerAdapter`（注册新的 provider 路由）。AI Studio 是让用户在选择器里选它作为模型来源，本质是新 adapter 路由，不是工具——所以不适合塞进 features 的工具挂载框架。它复用 features 同套「模块化、用户手动开启」的产品语义，但技术形态是独立组件行。

**为什么值得做**：DSH Core（已核对 `packages.md`）只内置 DeepSeek 账户 / API key 两个 LLM provider，**没有** Gemini API / Google AI provider——不存在重复造轮子。Google AI Pro 订阅含的 $10/月 GCP 积分在 AI Studio 手动申领后绑定到用户自己的 API key，正好通过这个 provider 消费。

## 2. 与 agy 代理线的差异（同 schema，不同鉴权与端点）

Gemini 家族的 REST schema 同源，代理适配器的**解析层可复用**：

| 维度 | agy 代理线（现有） | AI Studio（新增） |
|---|---|---|
| 端点 origin | `daily-cloudcode-pa.googleapis.com` | `generativelanguage.googleapis.com` |
| 鉴权 | OAuth Bearer（agy CLI 登录态） | API key，经 URL 查询参数 `?key=` |
| 生成 | `/v1internal:streamGenerateContent?alt=sse` | `/v1beta/models/{model}:streamGenerateContent?alt=sse` |
| 模型发现 | Cloud Code Assist 目录（账户可用项交集） | `GET /v1beta/models?key=` 或 curated allowlist |
| 线身份伪装 | agy CLI User-Agent + 固定头序（必需，否则被拒） | 标准 Google API，**不需要** agy 伪装头序，普通 fetch 即可 |
| 端点白名单 | `wire-identity.ts` 限定 cloudcode-pa | 需扩展 `generativelanguage.googleapis.com`（或用普通 fetch 不经代理传输层） |

**可复用**：`parseProxyProviderEvent`（payload.ts）、SSE 帧迭代、BlockAssembler（text/tool-call/reasoning 块组装）、`usage` / `finish` 映射、`inlineData` 图片解析——这些是纯 Gemini schema 解析，与端点 origin 和鉴权无关。

**需新建/改造**：
- 端点常量与鉴权注入（key 查询参数）。
- 模型发现：`GET /v1beta/models` 解析 `models[]` → `{name, displayName, supportedGenerationMethods, inputTokenLimit, outputTokenLimit}`。
- 请求体构造：AI Studio 不需要 agy 的 `request` 包装与 `project` 字段，body 是标准 `{contents, systemInstruction, generationConfig, tools}`——这部分与代理 payload 的**内层**一致，外层（`{model, request}` 包装）不同，需要抽出共享的内层构造。

## 3. 形态选型：第三组件行

```
bundle
├── llm-antigravity-acp        (宿主行，现有)
│   └── provide: antigravityProxyAuth / antigravityProxyMode / 附件 / tools
├── antigravity-proxy-router   (代理行，现有)
│   └── registerAdapter([antigravity-proxy])
└── antigravity-aistudio-router  (新增，独立行)
    └── registerAdapter([aistudio])
```

- `inject = ['llm']`，弱注入宿主行提供的设置面（读取 key 与开关）；宿主行缺席时本行安静不注册。
- **独立开关**：`aistudioEnabled`（volatile，默认关），与 `proxyMode` 同模式即时挂载/卸载。
- key 存储：不进设置明文，走宿主凭据服务（见 §5）。

## 4. 解析层复用与重构边界（先拆，再用）

当前 `src/proxy/adapter.ts`（1321 行）把解析逻辑绑死在代理线。为让 AI Studio 复用而不复制，需先做一次**无行为变更的抽取**：

1. `src/proxy/gemini-stream.ts`（新建）：把 `streamResponse` 里与端点无关的纯解析——SSE 迭代、`parseProxyProviderEvent`、BlockAssembler（begin/same/end block）、usage/finish 映射、错误码映射——抽成一个**端点无关的生成器**，输入 `Response` + `AdapterRequestOptions`，输出 `StreamChunk`。保留现有行为（有单元测试锁定，抽完必须全绿）。
2. `src/proxy/gemini-payload.ts`（新建）：抽出「内层 contents/systemInstruction/generationConfig/tools 构造」（当前在 payload.ts 的 `buildProxyGeneratePayload` 里），代理线在外层包 `{project, model, request}`，AI Studio 在外层包标准 body。
3. 代理 adapter 改为消费这两个共享模块；AI Studio adapter 也消费它们。

**这一步是重构**，必须以「现有测试全绿 + 行为不变」为门槛，再叠加 AI Studio 新代码。不与 AI Studio 功能混在一个 commit 里。

## 5. 凭据存储

AI Studio API key 是用户私密凭据，不能明文存进 `settings.ts`（会随设置文档同步到客户端）。两个候选：

- **方案 A（推荐）**：复用宿主的 `dsh-credentials-local`（`$DSH_HOME/.env` 凭据 provider），key 存为命名凭据引用，设置页只存引用名、不存值。这是 DSH 原生的密钥管理方式（DeepSeek API key provider 同口径）。需验证宿主凭据服务的注入面。
- **方案 B**：本插件自管一个与 `account-store.ts` 同形态的 key 存储（落盘到 profile 目录、不进设置文档、不进日志）。不依赖宿主凭据服务，但多一份存储代码。

待确认：A 的注入面是否在当前 Core 版本暴露。实现前先以只读探针核实 `ctx.credentials`（或等价服务）的契约，不可用则退回 B。

## 6. 模型发现策略

- **首选**：`GET /v1beta/models` 实时发现，过滤 `supportedGenerationMethods` 含 `generateContent` 的条目，映射到 DSH 模型目录（容量取 `inputTokenLimit`/`outputTokenLimit`）。仅靠 `generateContent` 不足以排除专用模态（TTS / 图像预览也声明它），故再按线模型名排除非聊天家族（image/imagen/tts/speech/audio/music/lyria/veo/video/embed/aqa/live/realtime）；这些模态的单独调用接口另立任务（§7）。
- **回退**：key 缺失或发现失败时，不注册任何模型（与代理行「账户缺席不注册」同语义），设置页显示可读状态。
- 不做 curated allowlist（会随上游模型更新过期），以实时发现为准。

## 7. 能力范围（分阶段，先确认首期）

| 能力 | 首期 | 后续 |
|---|---|---|
| 文本流式生成 | ✅ | |
| 工具调用（function calling）回填 | ✅（复用解析层） | |
| 多轮会话 history | ✅（复用 request-options） | |
| 思考块（reasoning）渲染 | ✅（复用解析层） | |
| 图片输入（多模态） | ⏸（复用 proxy image 投影，需接入附件读） | 二期 |
| 图像生成（responseModalities IMAGE） | ⏸（与 image-gen 工具同路径，可复用 generate.ts） | 二期 |
| 视频生成（Veo，需异步长任务） | ⏸（上游异步轮询，复杂度高） | 三期，单独评估 |
| 模型目录隐藏/显示名设置 | ✅（专属 AI Studio Tab 模型表，复用 `modelOverrides`，键带 `aistudio-` 前缀按链路过滤；启用置顶；默认仅 Gemini 4 系开启、其余默认关可显式启用） | |

首期目标：能选 AI Studio 模型、流式聊天、工具调用正常回填、key 配置即生效。图片/视频延后，避免首期过大。

## 8. 风险与未验证项

- **API 契约未实机核实**：`?key=` 鉴权、`/v1beta/models` 响应字段、`streamGenerateContent` 的 SSE 帧与 agy 线是否逐字节一致——需真实 key 跑一次只读探针（发现端点 + 一次最小生成），确认后再写解析适配。Context7 配额用尽、web_fetch 当前故障，官方文档未拉到；协议基于公开常识，需实机验证。
- **端点白名单**：若走 `createProxyTransport`（固定头序传输），`wire-identity.ts` 需扩展 `generativelanguage.googleapis.com`；若 AI Studio 不需要 agy 伪装，可直接用普通代理感知 fetch（`pluginFetch`），不经固定头序传输层——更简单，但需确认 Google API 不要求特定头序（标准 REST，应不需要）。
- **key 脱敏**：key 绝不进日志、客户端响应、错误消息；错误只报 HTTP 状态与脱敏后的上游原话（与代理线 `redactSensitiveText` 同口径）。
- **计费**：AI Studio key 走用户自己的 GCP 计费，与 agy 订阅额度无关；设置页需明确这一点（一句事实陈述，不写免责语气）。
- **凭据服务注入面**：方案 A 的可用性待核实（§5）。

## 9. 实现拆解（确认后执行）

1. 解析层抽取（`gemini-stream.ts` / `gemini-payload.ts`），现有测试全绿，行为不变——**独立提交**。
2. 凭据存储核实 + 实现（方案 A 或 B）。
3. `src/aistudio/` 新组件行：端点常量、key 鉴权、`GET /v1beta/models` 发现、adapter（消费共享解析层）、`registerAdapter([aistudio])`、开关 `aistudioEnabled` 联动。
4. 设置页：AI Studio key 配置入口（引用名，不存值）+ 独立开关；`modelOverrides` 按 `aistudio-` 前缀链路过滤。
5. 文档 + 测试：changelog / configuration / reference / development；client-loader 一致性锁定；解析层抽取的回归测试。
6. 真实 key 端到端验证（需用户提供有效 key 或授权跑一次探针）。

## 10. 实现与本稿的偏差（已落地）

1. **未抽取 `gemini-payload.ts`（§4.2）**：代理 `mapMessage` 与 agy 线身份深度交织（`compatibleProxyReplayState` 家族判定、`proxyModelFamily==='claude'` 特例、`SKIP_THOUGHT_SIGNATURE` 哨兵、`readProxyImage` offload、「代理模式」文案），抽共享内层会把这些 agy 语义带进 AI Studio。改为：只抽取端点无关的**流解析层** `src/proxy/gemini-stream.ts`（`assembleGeminiStream` 生成器 + `createGeminiBlockAssembler` 工厂 + finish/错误码映射），代理与 AI Studio 同消费；AI Studio 写**自己的**标准 Gemini REST payload 构造器 `src/aistudio/payload.ts`（保留真实 `thoughtSignature`，无 agy 哨兵 / Claude / offload），只复用纯函数 `buildProxyFunctionDeclarations`（工具 schema 净化）与 `reportsContextWindowExceeded`。`parseProxyProviderEvent` 参数化错误标签（默认「代理模式」）。
2. **鉴权用 `x-goog-api-key` 头，而非 `?key=` 查询参数（§2 / §6）**：key 绝不进 URL / 日志，直接满足 §8 脱敏要求；探针需核实头鉴权被上游接受（标准 Gemini API 支持该头）。
3. **端点白名单风险已消解（§8）**：`createLiveProxiedFetch`（`pluginFetch`）只做代理路由、**无端点白名单**；白名单只存在于代理线身份传输层 `wire-identity.ts`。AI Studio 用普通代理感知 fetch，不经固定头序传输层，无需扩展白名单。
4. **凭据方案 A 落地（§5）**：`ctx.credentials`（`@deepseek-ai/dsh-credentials` 的 `CredentialProvider`）按操作 `resolve(credentialRef(name))`；设置存引用名 `aistudioCredentialRef`（默认 `AISTUDIO_API_KEY`）。credentials 服务经 `ctx.inject(['credentials'])` 可选注入，缺席时解析返回 undefined → adapter 报 AUTH 可读态（不静默注册可用模型）。
5. **注册语义（§3 / §6）**：路由按 `aistudioEnabled` 注册（与代理行按 `proxyMode` 注册同构）；「key 缺失不注册任何模型」体现为目录空 / listModels 报 AUTH，路由仍在册以便设置页显示可读状态。AI Studio 是独立第三路由，**不进** ACP / 代理互斥模式总线，自有设置总线 `antigravityAistudioSettings`（`src/aistudio/settings-bus.ts`）。
6. **设置页模型编辑器（§7）**：`belongsToMode` 排除 `aistudio-` 键，使其不泄漏进 ACP / 代理二元编辑器；该路由的 `modelOverrides` 键由 adapter 经 `readSettings` 自行消费。**已落地专属 AI Studio Tab**（设置页第五个分页，位于「模型」与「额度」之间）：独立开关 + 引用名、手动 API key 输入（密码框，经 `agyAistudio.setKey` 写宿主 credentials，只写不回显）、专属模型表（`aistudioModelRows` 从实时目录 + `aistudio-` 覆盖键建行，复用 `ModelOverrideList` 但隐藏思考档列，因首期不映射 effort）。模型表与 ACP / 代理共用 `editOverride` / 草稿保存路径，`aistudio-` 键随整份 `modelOverrides` 保存。默认启用口径为「只开 4」：仅 Gemini 4 系默认进选择器，其余代际 / 非 Gemini 默认关闭（目录保留、可显式启用），host [`endpoints.ts`](../src/aistudio/endpoints.ts) `aistudioDefaultEnabled` 与 client 内置同口径函数由测试锁定；仅改显示名不会把默认关闭模型误启用（`normalizeModelSettings` 缺省 enabled 交给链路谓词）。模型表启用项置顶（稳定排序，镜像 Unified）。非聊天模态（音乐/TTS/图像/视频）在发现层过滤、不进文本选择器，其单独调用接口另立任务。
7. **思考档位（§7）**：首期不做 effort→thinkingConfig budget 映射（不猜测预算值）；响应里的 reasoning 块仍正常渲染。
8. **设置控制 remote（§7 扩展）**：新增 `agyAistudio` 命名空间（[`src/aistudio/remote.ts`](../src/aistudio/remote.ts)，`AgYAistudioService`），三方法 `models`（force 透传 `adapter.discoverModels`，投影设置页字段）/ `setKey`（trim 后经 `credentials.set(credentialRef(ref), value)` 写入，结果只 `{status}` 不回显值）/ `keyStatus`（`credentials.describe` 掩码视图，绝不返回全值）。描述符合并进**同一个** Host Typert contribution（[`quota-remote.ts`](../src/quota/quota-remote.ts) 的 invocations 数组）与客户端单次 `$mount`，不新增 package-face。key 全程不进设置明文 / 日志 / 客户端响应，错误经 `redactSensitiveText` 脱敏；凭据服务缺席或引用名无效时报可读 error。

## 11. 真实 key 探针核实结论（2026-11-27）

用户自备 Gemini key（经环境代理）跑契约探针，三项上游契约核实通过：

1. **`x-goog-api-key` 头鉴权生效**：`GET /v1beta/models` 与 `POST /models/{model}:streamGenerateContent?alt=sse` 均返回 200，key 不进 URL（§10.2 的头鉴权偏差被上游接受）。
2. **发现响应字段吻合**：`models[].name`（`models/…`）/`displayName`/`inputTokenLimit`/`outputTokenLimit`/`supportedGenerationMethods` 与 [`discovery.ts`](../src/aistudio/discovery.ts) 解析一致；实测返回 50 模型、49 支持 `generateContent`。
3. **SSE 帧形态**：裸 `{candidates,usageMetadata,modelVersion,responseId}`（`modelVersion`/`responseId` 为额外字段，解析器忽略），**CRLF `\r\n\r\n` 分隔**——共享层 [`iterateProxySse`](../src/proxy/transport.ts) 以 `buffer.search(/[\r\n]/)` 逐行解析并 flush 末帧，原生处理 CRLF；思考/工具部分携带 `thoughtSignature`。该真实形态已锁进单测（CRLF + 额外字段 + thoughtSignature + functionCall + usage）。
4. **工具往返 + 多轮 replay（真实 adapter 集成核实）**：用编译后的 [`AistudioAdapter`](../src/aistudio/adapter.ts) 对真实上游跑 `get_weather` 两轮——Turn 1 finish `tool-calls`（`get_weather`/`{city:Paris}`，replay 含真实 `thoughtSignature`，usage input 72 / output 16 / reasoning 42 / total 130）；Turn 2 以 `functionResponse` 回填后续答 finish `stop`，正确引用回填值（「sunny… 22°C」）。**上游强制约束**：回填的 `functionCall` part 必须携带 `thoughtSignature`，缺失报 400「Function call is missing a thought_signature」。签名经 [`replay.ts`](../src/aistudio/replay.ts) 信封块对齐取回，`compatibleAistudioReplayState` 要求 replay 块 kinds 与助手内容 kinds **长度+顺序完全一致**——助手内容须用流发出的全部块（含伴随 text 块）忠实重建，只取 tool-call 单块会因长度不匹配被拒绝、签名丢失致 400。该多块对齐形态已锁进单测。

**真实发现（模型可用性随 key 而异）**：`gemini-2.5-flash` 对**新用户**停用——目录列出它（支持 `generateContent`），但生成返回 404「This model … is no longer available to new users. Please … use models/gemini-3.8-flash」。`gemini-3.8-flash` 正常生成。结论：发现目录含对当前 key 不可生成的模型，`supportedGenerationMethods` 过滤不能捕获新用户限制；adapter 对此报可读 404 上游原话，**不做逐模型探测过滤**（代价高且 key 相关），用户改选可用模型即可。此行为与代理线「目录观测 ≠ 一定可生成」一致。

**宿主组装对齐已核实**：宿主 `BlockAssembler.assembled()`（`@deepseek-ai/dsh-llm`）正常路径保留全部块（含伴随空 text 块；空块过滤仅在 `interruptedBlocks()` 中断路径），replay 信封按 `envelope.blocks.length === all.length` 校验保留，max-tokens 截断时块与 replay **同步裁剪**（host 注释明示两者同源不会不一致）。adapter 的 replay 块由 `states.map` 生成，与发出的 block-end 数量+顺序严格一致（`assembleGeminiStream` 每个 state 恰获一个 block-end），故宿主存储内容 kinds 与 replay 恒对齐、签名不丢。该全链路（adapter 流→宿主 `BlockAssembler`→存储消息→下轮 payload→签名附上）已锁进单测。

**仍待验收**：宿主 GUI 渲染与完整装配的实机验收。上游契约（含工具往返、多轮 replay、思考块、usage）已经真实 adapter 集成核实，宿主组装对齐已经真实 `BlockAssembler` 核实；剩 GUI 选择模型聊天、思考块渲染、与 ACP / 代理并存的界面验收。
