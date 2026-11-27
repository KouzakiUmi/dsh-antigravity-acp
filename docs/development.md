# 开发、验证与发布

[返回主页](../README.md) · [使用参考](reference.md) · [配置](configuration.md) · [更新记录](changelog.md)

## 项目结构

本包是独立的 DSH Host + Web Client bundle，不修改宿主 Core。

| 入口 / 目录 | 职责 |
|---|---|
| [`src/index.ts`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/src/index.ts) | Cordis apply / dispose、provider 注册、受管进程与可选附件服务 |
| [`src/pool/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/src/pool/) | 独立 worker 容量、排队、所有权与取消 |
| [`src/adapter/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/src/adapter/) | 模型发现、历史信封、图片、工具参数与 prompt 续轮 |
| [`src/protocol/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/src/protocol/) | ACP stdio、请求期限、版本 / 能力验证 |
| [`src/bridge/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/src/bridge/) | 私有 loopback MCP、工具目录、挂起调用与结果回填 |
| [`src/runtime/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/src/runtime/) | 官方程序、运行目录、登录材料、代理、CLI 与模型缓存 |
| [`src/quota/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/src/quota/) | 套餐 / Credits 快照、连接控制与 Typert remote |
| [`src/proxy/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/src/proxy/) | 代理模式（默认关闭）：OAuth 登录态、agy 线传输、`antigravity-proxy` 路由与模式总线；`gemini-stream.ts` 是端点无关的 Gemini 流解析共享层（代理与 AI Studio 同消费） |
| [`src/aistudio/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/src/aistudio/) | AI Studio 独立 provider（默认关闭，第三组件行）：Gemini API key 鉴权（经宿主 credentials 接缝）、`/v1beta/models` 实时发现、标准 Gemini REST payload、`aistudio` 路由与设置总线；与 ACP / 代理并存 |
| [`src/client.js`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/src/client.js) | 惰性 CommonJS 客户端、设置卡片与额度药丸；无 Node 原生导入。构建时由 [`scripts/client-bundle.mjs`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/scripts/client-bundle.mjs) 把 `@include` 的 [`src/client-i18n/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/src/client-i18n) 片段内联成单文件 |
| [`src/client-i18n/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/src/client-i18n) | 客户端界面 i18n：`core.js`（`t()` / `msg()` 与语言判定）、`en-ui.js`（界面英文字典）、`en-host.js`（Host 固定状态文本的英文字典）；键是中文原文，缺译回落中文。新增文案必须同步字典，`tests/client-i18n.test.ts` 会拦截缺项与占位符不一致 |
| [`src/settings.ts`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/src/settings.ts) | 完整 Config 与默认值 |
| [`src/vertex/`](../src/vertex/) | 标准 Vertex AI：ADC、宿主环境变量回退、发布商目录读取、按项目与区域路由、replay 校验 |
| [`model-catalog-policy.ts`](../src/adapter/model-catalog-policy.ts) | 四条路由共用的聊天型号过滤、代际默认和显示名整理，构建时注入独立客户端 |
| [`src/adapter/gemini-payload.ts`](../src/adapter/gemini-payload.ts) | AI Studio 与 Vertex AI 共用的标准 Gemini REST 请求构造 |
| [`src/colab/`](../src/colab/) | 可单独启停的 Colab Host 组件，使用 DSH 审批、受管子进程和附件服务；同包导出 `./colab` |
| [`cordis.patch.yml`](../cordis.patch.yml) | 仅插入本插件，不抢占默认模型 |
| [`tests/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/tests/) | 假 ACP / MCP、隔离 runtime、真实 React renderer 与回归测试 |

npm 包名为 `dsh-bundle-antigravity-host`，provider ID 为 `antigravity-acp` / `antigravity-proxy` / `aistudio` / `vertex-ai`，内部插件名为 `llm-antigravity-acp` / `antigravity-proxy-router` / `antigravity-aistudio-router` / `antigravity-vertex-ai-router`。工具执行权在 DSH；ACP `tool_call` 通知不直接执行本机操作。

## 依赖与契约基准

以 [`package.json`](../package.json) 与 [`package-lock.json`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/package-lock.json) 为准：

| 依赖 / 协议 | 当前基准 | 核验边界 |
|---|---|---|
| DSH `dsh-llm` / `dsh-subprocess` / `dsh-typert-protocol` | 宿主 peer；开发基准 `0.2.2-rc.5` | 共享宿主模块；工作区同版运行类型检查和测试 |
| `dsh-attachment` | 宿主 peer；开发基准 `0.2.2-rc.5` | 提供代理图片尺寸计算；附件服务仍按功能注入 |
| `dsh-credentials` | 宿主 peer；开发基准 `0.2.2-rc.5` | 提供 AI Studio 凭据引用校验；密钥由宿主凭据服务管理 |
| Cordis | 开发依赖 `4.1.0` | 生命周期与注入契约 |
| ACP SDK / wire protocol | SDK `1.4.0` / wire **v1** | 两者不是同一版本；v2 / RFD 草案不能替代 v1 |
| 默认官方 ACP server | `1.5.2` | 与 SDK 分别设置；1.5.2 仅离线核对全平台发行布局与解压体积，协议行为与厂商 `_meta.antigravity` 扩展的实测基准仍为 1.4.0，不自动适用于任意上游版本 |
| MCP SDK | `1.32.1` | loopback 工具桥与结果内容 |
| `@cortexkit/antigravity-auth-core` | `3.0.14`（生产依赖） | 代理模式的 agy 线头 / 分帧、OAuth 常量、请求变换与模型注册表；与 dsh-tool-antigravity 0.5.2 同版本同口径 |
| undici | `8.12.3` | 本包直接依赖，HTTP / SOCKS 代理；SOCKS5 可能输出实验性 API 警告 |
| React / test renderer | `18.3.1` | Client 使用宿主 React；renderer 是测试开发依赖，不是生产私带的 UI 运行时 |

五个 `dsh-*` peer 使用 `>=0.2.2-rc.5 <0.2.3-0`，Cordis 使用 `~4.1.0`。npm 校验实际解析到的 peer；DSH 用 Core 自身的版本校验 `dsh-*` 范围。`<0.2.3-0` 排除下一补丁的预发布版。类型与测试所用的 DSH 包也固定为同一基准，锁文件测试会检查间接依赖，桌面探针会检查编译产物使用宿主模块。更新锁文件后用 Linux 目标的 `npm ci --dry-run --ignore-scripts` 复检可选平台依赖。

## 构建与本地打包

需要 Node.js `>=22.19`。先检查依赖和脚本，在开发工作副本准备依赖：

```console
npm ci --ignore-scripts
npm run check
npm pack --dry-run
npm pack
```

`check` 顺序执行 `typecheck`、`test`、`build`：构建由 TypeScript 输出 `dist/`，再通过 [`scripts/copy-client.mjs`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/scripts/copy-client.mjs) 内联客户端 i18n 片段并输出 `dist/client.js`。`dist/` 不提交到 Git，但发布包必须包含它。

**本包没有自动构建的 prepare / prepack / install hook**，所以裸 `npm pack` 或 `npm publish` 不会替你构建。打包前必须先运行构建 / 完整检查。发布清单包含 `dist/`、patch、README、`docs/`、LICENSE；源码、测试、预览与本地审查记录不属于安装包。

检查 tarball 的包名 / 版本、导出入口、客户端、patch 和文档后，再通过目标 DSH 插件管理入口安装。工作区构建、包内容检查、Profile 安装、启用与真实调用分别验证。

主包构建已包含 Colab 的 `dist/colab/index.js`。可从 Git Bash 验证本机 Desktop 组件；脚本使用临时目录，不加载桌面 Profile、不读取账号或发送生成请求：

```sh
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" scripts/check-desktop-compat.cjs
```

## 本次验证矩阵

0.1.35 本地检查日期：**2026-11-03**；0.1.36（额度取数解耦、设置页紧凑布局与隔离修复）复检日期：**2026-11-04**（Asia/Hong_Kong）；0.1.37（AI Credits 未开启时隐藏、删除代理积分说明、保存栏面板化样式）复检日期：**2026-11-04**（Asia/Hong_Kong）；0.1.38（无档位模型的元数据、模式总线回切、设置卡片只编辑即时字段、会话选模按会话判定、一次性请求不再占死 worker、账户刷新与资源回收修复）复检日期：**2026-11-12**（Asia/Hong_Kong）；开发契约基准升到 Core `0.2.2-rc.1` / Cordis `4.1.0` 与转发型请求 `purpose` 放宽的适配复检日期：**2026-11-13**（Asia/Hong_Kong）；peer 范围补 `0.2.2` prerelease 界标、契约基准升到 `0.2.2-rc.3` 与 `LlmError` 自定义码改走 `fromFailure` 的适配复检日期：**2026-11-16**（Asia/Hong_Kong）；0.1.46（客户端 i18n、`cloakSensitiveWords` 移除、Host 字典补齐与会话容量修复）复检日期：**2026-11-20**（Asia/Hong_Kong）；0.1.47（Linux 解压守卫阈值修复、默认 ACP server 升 1.5.2）复检日期：**2026-11-22**（Asia/Hong_Kong）；0.1.48（posix 辅助程序执行位、`session/new` 失败诊断）复检日期：**2026-11-22**（Asia/Hong_Kong）；0.1.50（编排模式 planner → executor、设置页编排分组、目录合成条目；PR #15 合并、executor 两选一 Hydrogen / Sonnet 5.5）复检日期：**2026-11-25**（Asia/Hong_Kong）；0.1.51（退役模型默认隐藏、额度池合并适配、药丸排序与弹层定位修复）复检日期：**2026-11-26**（Asia/Hong_Kong）；0.1.52（#23 macOS 钥匙串登录态兜底、强制文件凭据后端、首个 `session/new` 握手档超时；药丸弹层回归 absolute 锚定；含 #17 / #18 / #14 / #16 修复）复检日期：**2026-11-26**（Asia/Hong_Kong）；0.1.53（设置页移出已过下线日的家族、不在目录的已知家族显示内置名、已配置 ID 按当前链路过滤）复检日期：**2026-11-26**（Asia/Hong_Kong）。

| 验证项 | 状态与范围 |
|---|---|
| TypeScript | `npm run typecheck` 通过 |
| UI 键盘和窄屏 | Windows 全量回归覆盖页签方向键、筛选后焦点转移、设置读取超时与草稿保留、额度弹层的 Escape 和定位。使用 Chrome 在 320px 浅色、375px 暗色设置页及 320px 的长文案额度夹具检查横向溢出；使用离线模拟数据，没有访问运行中的 DSH Web。 |
| 0.1.55 核心依赖与隔离回归 | Core `0.2.2-rc.5`：全量回归覆盖模式切换的排队、启动与实际派发边界、额度往返、代理账户绑定、AI Studio / Vertex 配置变化和 Colab 产物。Desktop 2.0.24-next 的实际解析表提供五个 DSH peer，隔离探针使用宿主模块装载全部 Host 入口。未改动本机 Profile。 |
| 0.1.54：AI Studio 本地用量 / Vertex AI / Colab | `npm run check`：68 个测试文件，1129 项通过、1 项跳过。覆盖凭据切换时的用量、掩码与目录隔离，HTTP/SSE 429、Vertex 流式工具回填，以及 Colab 固定 argv、审批、Notebook 副本和退出边界。Desktop 2.0.24-next / Core 0.2.2-rc.5 的隔离组件探针校验了默认关闭声明、Colab 工具注册及卸载不影响已有模型路由。真实项目、Colab 账号、Notebook 远程执行与桌面 GUI 尚未验收。 |
| macOS 钥匙串登录态（#23） | 2026-11-26 Windows / 系统 Node：57 个文件 / 975 项通过、1 项跳过。`tests/cli-login.test.ts` 锁定 `go-keyring-base64:` 解码（含原样 JSON 与坏值降级）、`expiry_date` 毫秒→ISO、`security find-generic-password` 只读 argv 与非 0 退出 / spawn 抛错降级；`tests/credentials.test.ts` 覆盖文件优先 → 钥匙串 → 旧版 `oauth_creds.json` 候选链、既有凭据可用时不读钥匙串、吊销后改用钥匙串、三源换发失败顺序与全缺席降级文案；`tests/agent-link.test.ts` 锁定 `AGY_ACP_FORCE_FILE_STORAGE=1` 注入（父环境覆盖无效）与首个 `session/new` 36 秒冷启动在握手档下成功、后续会话回普通档、显式 `timeoutMs` 优先；`tests/quota.test.ts` / `tests/snapshot-store.test.ts` 覆盖额度取数与快照身份的钥匙串兜底同序。全部为注入依赖的合成测试：真实 macOS 钥匙串读取、`AGY_ACP_FORCE_FILE_STORAGE` 对官方二进制的实际效果与 macOS 冷启动整链均未实机验证 |
| 隔离回归 | 2026-11-22 使用系统 Node 24：48 个文件 / 865 项通过（契约基准 Core `0.2.2-rc.3` / Cordis `4.1.0`），包含旧宿主错误回退、目录停用项与档位、Schema 字段优先、已保存项目额度回退、会话表 LRU 容量与 429 限流文案，以及解压守卫常量对官方分发包实测体积的下限回归 |
| 辅助程序执行位与会话诊断（0.1.48） | 2026-11-22 Windows / 系统 Node 24：48 个文件 / 870 项通过、1 项跳过。注入 chmod 覆盖主程序与 `localharness_external` 同时补位、辅助程序缺失或为目录时跳过、windows 不改权限；`session/new` 拒绝时附加诊断且错误码、JSON-RPC 细节与 cause 保留，空诊断、诊断回调抛错与主动取消不附加。真实权限位整链测试（下载 → 解压 → 两个入口带执行位、旧 0644 缓存命中后修复）只在 POSIX 运行，本机跳过，未在 macOS / Linux 实机执行 |
| 编排模式（代理链路） | 2026-11-25 系统 Node 24：`tests/orchestrator/orchestrator-core.test.ts` 覆盖设置规范化（含 executor 两值枚举与非法值回落）、计划解析与稳定渲染、`shouldPlan` 六分支、证据截断与状态 LRU；`tests/proxy/orchestrator-proxy.test.ts` 覆盖目录合成与依赖缺失报错、两阶段隔离、`showPlan` 块索引偏移与 replay 块、预算上限、失败降级、usage 合并与中止，并分别断言 executor 走 Hydrogen（默认/非法回落）与 Sonnet 5.5（显式配置，wire 带档位后缀）。均为合成依赖，不触真实上游与账户 |
| 编排模式（ACP 链路） | 2026-11-25 同上：`tests/adapter/orchestrator-acp.test.ts` 10 项，覆盖目录合成、关闭直通、`new → set model → set mode → prompt` 顺序与空 `mcpServers`、辅助通知忽略、两阶段 usage 合并且 `usage_update` 不计费、`session/cancel` 只发目标 ID 与迟到通知屏蔽、120s 超时降级、正常 park / 规划失败 / 计划改变三组续轮断言，以及 executor 配置 Sonnet 5.5 时 chat 会话写入 `claude-sonnet-5-5-medium`、非法 `executorModel` 回落 Hydrogen。全部在 `FakeAcpAgent` + 真实 loopback MCP 桥下执行，未用真实官方二进制 |
| 设置页编排分组 | 真实 React 18 renderer：7 个可编辑控件的默认值与整份 `orchestrator` 提交（含 executor 在 Hydrogen / Sonnet 间切换）、`plannerTimeoutMs` 透传保留、键序无关与写回默认值的规范化比较、非法 `executorModel` 回落、代理模式可见性、外部冲突合并与撤销、`maxPlansPerTurn` 5 种非法值拒绝 |
| 真实官方二进制（编排） | 未验收：`mode=plan` 只在独立探针中确认过行为（官方 agent 仍执行内置只读命令、计划写在 brain 目录、无 `plan` 通知），尚未在真实 `agy-acp-server` 上跑完整 planner → executor 编排，也没有真实账号下的计划质量对照 |
| 构建 | `npm run build` 通过 |
| 代理响应预算 | 合成 HTTP 与 SSE 测试覆盖：多帧生成超过旧 8 MiB 后仍能完成；解码后超过 64 MiB 正确失败；非生成和非成功生成响应仍受 8 MiB 传输预算约束 |
| 代理目录预算 | 2026-11-19，同一账户真实 `fetchAvailableModels` 回包为 HTTP 200、解码后 303,104 字节、38 条；同一回包交给已安装 0.1.40 复现 `REQUEST_LIMIT`（262,144 字节），候选代码成功解析并返回 6 个可选模型。未保存原始回包、未发起生成请求。合成回归另外覆盖普通响应预算与同账户缓存回退 |
| Hydrogen / Neon 实测 | 2026-11-19，真实目录 HTTP 200，设置页使用的目录接口返回 8 个家族，两组新增模型均观测到 `low` / `medium` / `high` / `xhigh`。候选适配器分别发送 `gemini-4-hydrogen-medium`、`gemini-4-neon-xhigh` 短文本请求，均 HTTP 200 并返回 `OK` 后正常结束。未测其余档位、图片或桌面 GUI |
| 图片和上下文端到端 | 真实目录 HTTP 200，Hydrogen / Neon 八档均返回 `supportsImages: true`、`maxTokens: 1048576`、`maxOutputTokens: 262144`。用桌面 Core `0.2.2-rc.5` 和本地附件服务向 Neon `medium` 发送生成的纯蓝 PNG，上游正确识别并返回 HTTP 200；Core 收到窗口 1,048,576、输入 1,144、输出 2、思考 109、总量 1,255。设置服务输出容量和输出上限；自动回归另覆盖混合档位和无附件服务 |
| 官方 CLI 容量来源 | 本机 `agy models` 实测 23 行、每行只有两列（ID、名称）；ACP 模型容量来自会话 `usage_update.size`，`used` 与单次计费 token 分开 |
| 代理思考摘要 | 同一 Hydrogen `medium` 线模型的真实对照：两次 HTTP 200；原请求收到正文和签名但无摘要，仅添加 `includeThoughts: true` 后收到 1,135 字符摘要。Neon `medium` 经 DSH NEXT 2.0.24-next 所带 Core `0.2.2-rc.5`，真实生成输出 2,177 字符摘要及 reasoning 块，正常结束 |
| 额度快照 | 用桌面包内 Cordis 拉取真实 Google 额度，获得 3 个分组；新开隔离 Host，在上游不可调用的条件下重读同一快照，分组与时间戳一致。自动回归覆盖独立定时、手动合并、读取不等待刷新、换账户隔离与过期标记。2026-11-26 真实代理快照核实上游已合并为 2 组（Gemini Models / Claude and GPT models），客户端动态遍历无硬编码组数，旧独立 Argon 组并入 Gemini 展示 |
| 退役模型与额度药丸（0.1.51） | 系统 Node 24：`tests/model-retirement.test.ts` 锁定退役表（家族键归一、档位 ID 命中、日期与迁移字段）；`tests/model-settings.test.ts` 覆盖默认关闭与显式启用优先；client/host 两表家族与日期一致性、「即将下线」徽章与开关默认态由 `tests/client-loader.test.ts` 锁定；药丸短周期在上排序（weekly/5h 逆序夹具）与空组不再渲染均有回归。弹层定位在 0.1.52 回归为 absolute 锚定（fixed ＋ 视口钳位在宿主面板内必然遮挡，见 0.1.52 记录）：`tests/client-loader.test.ts` 锁定定位函数三类分支，`tests/client-interaction.test.ts` 以注入按钮几何的真实 React 渲染锁定 absolute 右缘锚定、左对齐翻转与上下选边。真实上游拉取与 GUI 弹层位置未实机验收 |
| 设置页移出已退役家族、内置显示名与链路过滤（0.1.53） | 2026-11-26 Windows / 系统 Node：`tests/client-interaction.test.ts` 以真实 React renderer 锁定已过下线日家族的观测行、补行与残留配置键均不显示，下线日过后按同一判定移出，残留键随草稿保存删除并在模型页注明来源，撤销放弃删除，撤销后的刷新与只读切换不重新排入，只读设置不产生待保存项，清理保存不覆盖外部更新、不删除另一链路或仅默认值的键，保存成功回读后不再标脏，退役边界按本地日历日（在 Asia/Hong_Kong、America/Los_Angeles、UTC 三个时区下运行）；已知家族显示内置名而未知 ID 保持原始 ID，ACP 模式不补带 `antigravity-` 前缀的键、代理模式不补裸 ID、合成条目两边同名，且被过滤的键随保存原样提交；`tests/client-loader.test.ts` 锁定 client 内置 `ORCHESTRATOR_MODEL_ID` / `NAME` 与 host 常量一致。退役判定按本地时间与墙钟比较，相关用例用 `vi.setSystemTime` 固定（两个 client 测试加载器把测试进程的 `Date` 传入 vm 上下文），断言不随真实日期漂移。真实宿主 GUI 中的列表与保存流程未实机验收 |
| 附属功能模块注册表 + `image-gen` 图像生成工具（未发布） | 2026-11-27 Windows / 系统 Node：全量 58 文件 / 1019 项通过、1 项跳过（`npm run check` 含 typecheck + test + build）。`tests/features-registry.test.ts` 13 项锁定规格/实现加载期双向校验（缺实现、孤儿实现、重复 id、空 compatibleModes、端点越界）、端点安全域（仅 https + Google 已知域）、动态挂载的幂等差量同步、`sync` 的 `force` 选项先卸载再重挂、模式不兼容跳过、未知 id 忽略、mount 抛错不阻断、dispose 全卸载；`tests/client-loader.test.ts` 锁定 client 内置 `FEATURES` 表的 id / defaultEnabled 与 host `FEATURE_SPECS` 一致；`tests/client-interaction.test.ts` 把 `features` 纳入复合字典字段排除（与 `modelOverrides` / `orchestrator` 同模式），设置卡只提交即时字段的断言仍通过。协议口径（端点、模型校验、`responseModalities` 请求体、`inlineData` 递归解析）与同 auth-core 3.0.14 的 `dsh-tool-antigravity` 0.5.2 对齐。全部为注入依赖的合成测试，未触真实上游与账户；真实代理账户端到端生成、宿主 GUI 中 `agy_image_generate` 工具的调用与图片块渲染、原图文件下载均未实机验收 |
| AI Studio 独立 provider + Gemini 流解析层抽取（未发布） | 2026-11-27 Windows / 系统 Node：全量 63 文件 / 1085 项通过、1 项跳过（`npm run check` 含 typecheck + test + build）。解析层抽取（`gemini-stream.ts` 共享生成器 + 块组装器工厂）以代理既有测试全绿为门槛、行为不变；`parseProxyProviderEvent` 标签参数化不破坏代理断言。AI Studio 59 项单测：`tests/aistudio-discovery.test.ts`（发现过滤 / 容量 / 去重 / 分页 / catalogId↔wireModel / 段转义 / URL 不含 key / 非聊天模态过滤 / 仅 4 系默认启用谓词）、`tests/aistudio-payload.test.ts`（标准 Gemini contents / systemInstruction / 思考 thought:true / 工具绑定 / 错误结果 / 孤立结果 PROTOCOL_DRIFT / replay 签名回填与块签名优先 / generationConfig / temperature 越界 / 工具净化 / 图片 UNSUPPORTED_MODALITY）、`tests/aistudio-adapter.test.ts`（直挂 candidates 文本 / 思考 / 工具流、多轮 thoughtSignature 经 replay 回填进请求体、usage、x-goog-api-key 头鉴权且 URL 不含 key、HTTP 401/429/400 上下文超限映射、流内 error→finish error、缺 key AUTH 不发请求、凭据接缝解析拒绝→可读 LlmError 不泄漏原始 rejection、空响应 EMPTY_RESPONSE、目录缓存 TTL/force/失败保留、resolveModel 容量与文本模态、target 改写线模型、prepareCall 解析模型并经 stream 闭包派发（target 映射）、真实上游帧形态（CRLF 分隔 + modelVersion/responseId 额外字段 + thoughtSignature + functionCall）、多轮 tool-call+text 多块 replay 签名对齐、目录外 INVALID_MODEL、默认仅 4 系进选择器 / 非 4 显式启用后出现 / 仅改显示名不启用）、`tests/aistudio-settings-bus.test.ts`（默认引用名 / trim / 开关与引用名变化通知 / 无变化不通知 / 退订 / 透传）、`tests/aistudio-remote.test.ts`（8 项：models 目录投影与 force 透传 / 失败折叠 error 并脱敏 / setKey 经 `credentials.set` 写入引用名 trim 后只写不回显 / 写入失败脱敏 / 凭据缺席与无效引用名与空值可读 error / keyStatus describe 掩码视图绝不返回全值 / 描述符 service·namespace·method·id 对齐与 setKey 必填参数）。`tests/client-interaction.test.ts` 即时字段输入框一致性锁定纳入 `aistudioEnabled` / `aistudioCredentialRef`，`belongsToMode` 排除 `aistudio-` 键；新增 AI Studio Tab 用例（专属模型表无思考档列、显示名覆盖生效、手动 key 经 `agyAistudio.setKey` 写入、默认仅 4 系开启 + 启用置顶 + 非 4 系显式启用落盘）。`tests/quota-remote.test.ts` / `tests/client-loader.test.ts` 命名空间与描述符一致性锁定纳入 `agyAistudio`（models / setKey / keyStatus，与 `agyQuota` / `agyProxyAccount` 合并进同一 contribution）；另锁定 client 内置 `aistudioDefaultEnabled` 与 host 逐 ID 同结论。单测为注入依赖的合成测试（mock fetch / SSE）。**真实 key 探针已核实上游契约**（2026-11-27，用户自备 key，经环境代理）：① `x-goog-api-key` 头鉴权生效——`GET /v1beta/models` 与 `POST :streamGenerateContent?alt=sse` 均 200，key 不进 URL；② 发现响应字段（`name`/`displayName`/`inputTokenLimit`/`outputTokenLimit`/`supportedGenerationMethods`）与发现解析吻合，返回 50 模型 / 49 支持 generateContent；③ SSE 为裸 `{candidates,usageMetadata,modelVersion,responseId}`、**CRLF `\r\n\r\n` 分隔**（`iterateProxySse` 原生处理 `\r\n`），思考/工具部分携带 `thoughtSignature`。真实形态已锁进单测（CRLF + 额外字段 + thoughtSignature + functionCall + usage）。**真实发现**：`gemini-2.5-flash` 对新用户停用（目录列出但生成 404，上游推荐 `gemini-3.8-flash`）；`gemini-3.8-flash` 正常生成——目录含对当前 key 不可生成的模型，adapter 对此报可读 404，不做逐模型探测过滤。**工具往返 + 多轮 replay 集成核实**：用编译后的真实 `AistudioAdapter` 对真实上游跑 `get_weather` 工具触发→`functionResponse` 回填→续答两轮——Turn 1 finish `tool-calls`（`get_weather`/`{city:Paris}`，replay 含真实 `thoughtSignature`），Turn 2 finish `stop` 并正确引用回填值续答；usage 不相交计数（input/output/reasoning/total）正确。关键约束：回填的 `functionCall` part **必须**携带 `thoughtSignature`（上游强制，缺失报 400），且助手内容须用流发出的**全部块**忠实重建（与 `replayState.blocks` 同源同序），`compatibleAistudioReplayState` 按 kinds 长度+顺序对齐才取回签名——只取 tool-call 单块会因长度不匹配拒绝致签名丢失。该真实多块对齐形态已锁进单测。**全链路经真实宿主 `BlockAssembler` 核实**：把真实 adapter 流喂进宿主 `BlockAssembler`（`@deepseek-ai/dsh-llm` 导出），用其 `blocks()`/`replayState` 重建助手消息再续轮，签名正确附上。宿主正常路径 `assembled()` 保留全部块（含空 text，空块过滤仅在 `interruptedBlocks()` 中断路径），replay 信封按 `blocks.length` 对齐保留、max-tokens 时块与 replay 同步裁剪——故 adapter 发出块（`states.map`）与宿主存储内容 kinds 恒对齐，签名不丢。该全链路已锁进单测。宿主 GUI 中选择 AI Studio 模型聊天与工具回填仍待用户实机验收 |
| prompt 字节预算与裁剪可观测（#16） | 系统 Node 24：`tests/history-notices.test.ts` 锁定事件日志有界与最新在前；`tests/settings-schema.test.ts` 覆盖 `promptByteBudget` 默认值、越界拒绝与非 volatile；`tests/acp-adapter.test.ts` 在 FakeAcpAgent 下验证配置预算传入 prompt 组装、超限裁剪触发 `onHistoryNotice` 且提示块与实际字节不超预算；`tests/quota-remote.test.ts` 验证裁剪事件只随 read 附带、不写入快照存储；真实 React renderer 验证药丸警示、详情文案与 10 分钟窗口过期不提示。真实长会话 GUI 裁剪提示未实机验收 |
| 上下文容量审计回退（#17） | 系统 Node 24：`tests/model-capacity.test.ts` 锁定 Neon / Hydrogen 登记值、auth-core 快照家族值与未知家族 undefined；`tests/acp-adapter.test.ts` 验证未实测家族声明审计容量、实测优先于审计、目录行 `contextWindowSource` 随观测状态切换；`tests/settings-control.test.ts` 验证来源字段透传；真实 React renderer 验证「审计参考」标注与实测文案不混淆。宿主压缩引擎报错路径按已安装 Core `0.2.2-rc.5` 源码核对（`dsh-compaction-basic` 模型切换 / 溢出恢复对无容量路由抛错），未在真实账号 GUI 复现原始报错 |
| 代理 429 诊断（#14） | 系统 Node 24：`tests/proxy-adapter.test.ts` 覆盖 HTTP 429 配额耗尽分支附带 JSON `error.message`（脱敏、保留重置时间）、普通限流分支既有口径、流内限流事件附带上游原话并脱敏。真实账户 429 复现未执行（探针期间观测到 ACP 线配额耗尽文案 `reached your current quota`，已纳入耗尽识别） |
| 工具 / runtime | 假 ACP / MCP、乱序工具结果、池所有权、续轮变更、取消、写入阻塞和回收 |
| 工具目录预算（#18） | 真实探针（官方 1.5.2 缓存二进制 + 本机登录态，`scripts/probe-tool-budget.mjs`）：60,197 字节 / 24 工具全可见；100,197 字节丢前 4 个 12KB 描述工具（其余 20 个可见），确认丢弃层在官方 agent / 上游。系统 Node 24：`tests/tool-catalog.test.ts` 锁定预算内 / 禁用原样、最长优先裁剪、UTF-8 边界、参数单独超限尽力而为；`tests/acp-adapter.test.ts` 验证发布到 MCP 桥前裁剪、名称参数不变、告警留痕与预算内不告警。裁剪后真实长工具集 GUI 验收未执行 |
| Claude 历史工具批次 | 桌面 Core `0.2.2-rc.5` + 真实 Sonnet 5.5 `medium`：并行两个工具只回填一个后续发消息，已安装 0.1.42 上游 HTTP 400 / `PROTOCOL_DRIFT`；候选用同一历史正常完成（HTTP 200），两个结果都缺失时也正常完成；当前批次未收齐时在本地返回 `INVALID_ARGS`，不派发 |
| 图片 | 附件引用校验、图片内容映射与跨 worker 能力；代理模式 inlineData 准入、12MB 预算与 offload 协商、附件缺席降级；未调用真实视觉模型 |
| 设置交互 | React 18 renderer 覆盖全部即时字段（普通配置只在指引块列出字段名，`proxyBypass` 不提供控制项）与逐模型 `modelOverrides` 的编辑、搜索、启停筛选、保存回读、草稿、冲突、只读与 namespace 恢复；连接 / 模型 / 额度 / 高级分页后非活动页只隐藏不卸载，全部字段仍在同一份草稿里；不替代真实宿主设置服务或 GUI 验收 |
| 客户端 i18n | 字典完整性、占位符一致性与 `t()` 行为测试；en 环境实际渲染设置卡与药丸（ACP / 代理 / 正常 / 错误 / 展开）无中文残留，zh 基线正常；Host 固定文本字典覆盖经源码比对 |
| 代理模式 | 线头顺序与 chunked 字节、端点白名单、SOCKS 拒绝、OAuth 回调 state/主机校验与不消耗在途 flow、副本原子写与 CLI 导入（含仅 refresh 形态）、payload 映射与 sentinel 签名、replay 归属校验、模式总线通知幂等、路由注册/注销互斥、代理额度 401 换发一次重试；全部合成依赖，不触真实网络与账户 |
| 代理功能回归 | Google SSE 错误字段、401/403 首块前换发、工具 STOP 续轮与真实宿主消息回填、16KB 签名与映射归属、缺完成标志及 HTTP 截断、chunk 增量解码；目录排除停用项、仅发布已观测档位、调用准备的目录与设置快照、跨账户派发拒绝、附件能力及请求尺寸 |
| 代理 schema | 工具参数本地 `$ref` 展开、联合分支补字段但保留主 Schema、`items`/`properties` 优先于显式与推断类型、空数组补 `items`、忽略空白枚举值；403「violation of Terms of Service」识别为账号停用。全部为合成请求，不触真实上游 |
| 代理账户 | 过期 CLI 导入刷新、失效凭据转 OAuth、只读项目检测与缺失错误、取消抢占、真实存储加载/清除竞态、删除失败、授权终态与 URL 最小返回；已有账户刷新失败不导入其他 CLI 账户，直接重登增加代际；账户代际隔离目录、额度及在途结果；项目探测 503 时用已保存项目读取额度 |
| 无 CLI 授权闭环 | 不存在的 CLI 文件 → 实际 OAuth/PKCE → 生产监听器随机测试端口的真实 HTTP 回调 → 模拟 Google 换码/项目 → 真实临时 store → 真实适配器目录 → 重建读取；拒绝/缺码/过期/端口冲突/项目及保存失败/取消后可重试 |
| 设置页 UX | 精简首屏、无修改时隐藏保存区、当前模式账户、紧凑模型列表、搜索/筛选/批量启停与完整详情、独立高级分组；未保存计数/撤销/只读/冲突，网络草稿与取消可用性、授权链接/阶段；手动额度、模式来源校验、实际路由家族、账户切换及旧广播、共享刷新收尾 |
| 浏览器布局 | 已注册 Chrome + 既有 Playwright 1.63.0，离线真实 Client 静态夹具；320/390/1280 宽度、深浅主题及顶部/中部/底部共 36 项检查，保存栏可见且无横向溢出；静态布局不替代桌面实例验收 |
| 模式切换 | 请求代理模式即注销 ACP，缺席/注册失败/卸载均不回退；Host 控制层拒绝 ACP 登录与预热，目录按模式和账户代际隔离，额度请求校验期望模式。真实 React renderer 覆盖草稿与生效状态、代理登录/退出后更新模型、失败原因与过期链接清理 |
| 桌面注册契约 | 2026-11-20 使用 DSH NEXT 2.0.24-next / Core 0.2.2-rc.5 / Cordis 4.1.0 的实际组件隔离验证：npm 与 DSH 的 peer 判定、ACP 与代理模式双向切换、唯一 Typert Host 贡献、卸载清理、自定义错误码和 provider 失败事实。旧版无工厂分支由 Vitest 模拟覆盖；没有启动完整 Loader 或连接现有 Host |
| 代理（出网） | 合成依赖、动态变更与清空、不打断旧响应、卸载释放、失败不直连、运行期地址变坏时按 Promise 拒绝、装载期非法地址不阻断插件、本地 SOCKS 测试；不是 Google 网络可达性保证 |
| 代理环境继承 | HTTPS / ALL / HTTP 优先级、显式值覆盖及清空恢复、OAuth 与原生 TLS 接线、本地 CONNECT 首包和 NO_PROXY。无凭据 Google 探针对比直连超时与环境代理收到 401，只验证工具进程所见网络，不代表运行中 Host 的环境或账户可用性 |
| 额度取数 | 假 fetch 覆盖超时折叠、401/403 按状态码重试一次、401 后成功、非 401/403 不重试、OAuth 元数据配对；`cliQuotaEnabled` 默认关闭时即使注入 CLI 也不 spawn，打开后才走 `/usage` 与 `/credits`，关闭后旧快照失效；代理模式默认零 `agy` 调用且套餐额度仍取代理账户，打开开关后只有 Credits 走 CLI；不触真实账户 |
| 真实上游 / GUI | 本次 OAuth 使用真实本地 HTTP 与模拟 Google 响应，浏览器使用离线夹具；0.1.38 安装后的 GUI、真实 Google 授权、真实生成或图片识别尚未验收。编排模式的真实账号端到端与桌面 GUI 同样未验收 |
| 非 Windows | 有平台映射与契约测试，未实机验收 |
| 生产依赖漏洞 | `check` 不包含漏洞审计；没有单独成功审计证据就不声明通过 |

历史 CLI 真实账号记录见[额度来源](reference.md#登录态与额度来源)。那些记录不是本次重新执行，也不能代替当前 npm 包安装后的验收。

### 离线界面预览

```console
node scripts/preview-ui.mjs
```

输出 `.local-preview/quota-ui.html`、`.local-preview/proxy-ui.html`，以及有独立滚动容器的 `.local-preview/settings-ux.html` 和 `.local-preview/settings-login.html`。覆盖 ACP、代理账户、常驻保存栏、手动额度与授权等待；使用真实 Client 和**模拟数据 / hooks**生成静态 HTML，按钮不执行真实操作。状态交互由 `tests/client-interaction.test.ts` 的 React 18 renderer 覆盖，布局另由离线浏览器核验。

### 本次改动的补充验证

2026-10-30 的可靠性加固通过类型检查、**38 个文件 / 658 项测试**与构建。新增覆盖：额度 HTTP 请求超时折叠为可读错误（不留下永不结束的在途 promise）、401/403 按状态码而非错误文案触发一次换发重试、OAuth 元数据多份时按出现顺序配对、非法代理不再阻断插件装载（告警留痕且设置页仍可修正，启动时转成 `AGY_INVALID_PROXY`）、运行期代理地址变坏时按 Promise 契约拒绝、恢复启动失败归还磁盘 claim、中止错误码统一为 `AGY_ABORTED`、MCP 桥 Bearer 头改常数时间比较、zip 条目数与解压大小上限（含中央目录谎报大小时被拒）、单条畸形 JSON-RPC 帧只丢弃留痕而不再判死链路、带 id 的畸形响应立即拒绝而不是等满超时、留痕回调自身抛错不关链路、额度超时不足 1 秒报毫秒且主动中止与超时分开、非正数超时配置回落默认预算。

这些仍是隔离回归：没有实例化完整 DSH settings / Loader 服务，不能当作真实宿主端到端验收。真实 Desktop GUI、官方账号与非 Windows 实机仍未重新验收；zip 上限与畸形帧容错也没有用真实官方包或真实对端造过异常输入。

### 0.1.28 验证记录

2026-10-25 的源码工作副本执行 `npm run check`：TypeScript 检查、**36 个文件 / 617 项测试**与构建通过。新增覆盖手动预热的有界回收恢复、空模型配置保留目录、worker 元数据与档位合并、实际 worker 图片能力准备、额度信封与独立缓存竞态、Argon 共享额度、客户端失败保留快照，以及设置页分组与草稿行为。

同时使用本机 Chrome 无头截图检查 `.local-preview/quota-ui.html` 的浅色 / 深色及 750px 窄屏静态预览；预览数字全部为虚构，不访问真实账户或 DSH 页面。未执行发布、Profile 安装、Host 重启或真实 Desktop GUI / 官方账号验收。

## 维护与发布到 npm

现有工作流为 [Publish package](https://github.com/KouzakiUmi/dsh-antigravity-acp/actions/workflows/publish.yml)，定义见 [publish.yml](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/.github/workflows/publish.yml)。它仅由 **workflow_dispatch 手动触发**：推送 `main` 或创建 tag 本身不会发布。

流程：

1. 核对版本、锁文件、变更范围、文档与测试；确保目标版本未发布。
2. 提交并推送到目标分支，确认远端 SHA 与已验证内容一致。
3. 手动在与包版本同名的 `v<version>` 标签运行工作流。任务在 GitHub-hosted Ubuntu / Node 24 校验标签与版本一致，执行 `npm ci --ignore-scripts`、`npm run check`，并通过 `npm pack --dry-run --ignore-scripts --json | node scripts/check-npm-pack.mjs` 校验打包清单，再 `npm publish --provenance --access public`。
4. 观察这一次运行的 SHA、检查结果与 publish 步骤。失败时先判断是否已经产生远端副作用，不盲目重跑同一版本。
5. 在 registry 核对版本、dist-tag、tarball、仓库来源和 provenance；仅 workflow 返回成功还不足以宣称用户已装上该版本。

只读核对示例：

```console
npm view dsh-bundle-antigravity-host version dist-tags --json
npm view dsh-bundle-antigravity-host@0.1.24 version gitHead dist --json
```

发布使用 npm trusted publishing 的 GitHub Actions OIDC，工作流声明 `id-token: write`。npm 上必须已有与仓库 / 工作流匹配的 trusted publisher 授权。GitHub Release 单独创建并指向同一个版本提交；工作流不安装或更新本机 Profile。

## 文档来源与已知覆盖缺口

- [DSH 插件安装](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish#install-into-a-profile)与 [Desktop README](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)：公共 CLI 与桌面管理所有权；本次通过 Context7 检索，对照项目声明。公开主线不是已安装旧版本的保证。
- [ACP v1 初始化](https://agentclientprotocol.com/protocol/v1/initialization)与 [会话建立](https://agentclientprotocol.com/protocol/v1/session-setup)：本次 Context7 查询混入 RFD 草案，不能当成 v1 已核验；使用官方明确标注 v1 的页面与本地 SDK 类型作补充证据。
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)：本次 Context7 的 npm CLI 资料与官方页面交叉核对。`npm trust` 配置命令的版本门槛不同于既有工作流发布，不混淆这两者。
- 官方 `agy` CLI 的部分本地 JSON 报告没有完整公共文档，历史真实回包与本机实现只作标注的补充证据，不冒称完整官方 SDK 契约。

文档查证、静态检查、隔离测试、打包核查、真实调用和部署验收各自独立，不能互相代替。
