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
| [`src/proxy/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/src/proxy/) | 代理模式（默认关闭）：OAuth 登录态、agy 线传输、`antigravity-proxy` 路由与模式总线 |
| [`src/client.js`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/src/client.js) | 惰性 CommonJS 客户端、设置卡片与额度药丸；无 Node 原生导入。构建时由 [`scripts/client-bundle.mjs`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/scripts/client-bundle.mjs) 把 `@include` 的 [`src/client-i18n/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/src/client-i18n) 片段内联成单文件 |
| [`src/client-i18n/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/src/client-i18n) | 客户端界面 i18n：`core.js`（`t()` / `msg()` 与语言判定）、`en-ui.js`（界面英文字典）、`en-host.js`（Host 固定状态文本的英文字典）；键是中文原文，缺译回落中文。新增文案必须同步字典，`tests/client-i18n.test.ts` 会拦截缺项与占位符不一致 |
| [`src/settings.ts`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/src/settings.ts) | 完整 Config 与默认值 |
| [`cordis.patch.yml`](../cordis.patch.yml) | 仅插入本插件，不抢占默认模型 |
| [`tests/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/tests/) | 假 ACP / MCP、隔离 runtime、真实 React renderer 与回归测试 |

npm 包名为 `dsh-bundle-antigravity-host`，provider ID 为 `antigravity-acp`，内部插件名为 `llm-antigravity-acp`，三者不混用。工具执行权仍在 DSH；ACP `tool_call` 通知不是本机执行指令。

## 依赖与契约基准

以 [`package.json`](../package.json) 与 [`package-lock.json`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/package-lock.json) 为准：

| 依赖 / 协议 | 当前基准 | 核验边界 |
|---|---|---|
| DSH `dsh-llm` / `dsh-subprocess` / `dsh-typert-protocol` | 开发依赖 `0.2.2-rc.3` | 本地类型、调用链与测试；不是全部 peer 范围实机认证 |
| 可选 `dsh-attachment` | 开发依赖 `0.2.2-rc.3` | Host 服务在场时读取图片，缺少时文本降级 |
| Cordis | 开发依赖 `4.1.0` | 生命周期与注入契约 |
| ACP SDK / wire protocol | SDK `1.4.0` / wire **v1** | 两者不是同一版本；v2 / RFD 草案不能替代 v1 |
| 默认官方 ACP server | `1.4.0` | 与 SDK 分别设置；厂商 `_meta.antigravity` 扩展不自动适用于任意上游版本 |
| MCP SDK | `1.32.1` | loopback 工具桥与结果内容 |
| `@cortexkit/antigravity-auth-core` | `3.0.14`（生产依赖） | 代理模式的 agy 线头 / 分帧、OAuth 常量、请求变换与模型注册表；与 dsh-tool-antigravity 0.5.2 同版本同口径 |
| undici | `8.12.3` | 本包直接依赖，HTTP / SOCKS 代理；SOCKS5 可能输出实验性 API 警告 |
| React / test renderer | `18.3.1` | Client 使用宿主 React；renderer 是测试开发依赖，不是生产私带的 UI 运行时 |

三个 `dsh-*` peer 当前均声明 `>=0.2.0-rc.1 <0.2.1-0 || >=0.2.1-0 <0.3.0-0 || >=0.2.2-0 <0.3.0-0`，Cordis peer 为 `>=4.0.4 <5`。末段是 semver prerelease 语义的必需补写：`-0` 界标只放行同版本组的 prerelease，不外推到更高 patch（`>=0.2.1-0` 拒绝 `0.2.2-rc.x`）；实测整体放宽为 `>=0.2.0-0 <0.3.0-0` 同样拒绝 `0.2.2-rc.3`。宽范围只表达 npm 安装准入，不能推导全部版本通过运行验证，也不替代 DSH loader 自身的装载条件。CLI、Desktop 壳与实际 Core 的版本应分别核对。

## 构建与本地打包

需要 Node.js `>=22.19`。先检查依赖和脚本，在开发工作副本准备依赖：

```console
npm ci --ignore-scripts
npm run check
npm pack --dry-run
npm pack
```

`check` 顺序执行 `typecheck`、`test`、`build`：构建由 TypeScript 输出 `dist/`，再通过 [`scripts/copy-client.mjs`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/scripts/copy-client.mjs) 复制客户端文件。`dist/` 不提交到 Git，但发布包必须包含它。

**本包没有自动构建的 prepare / prepack / install hook**，所以裸 `npm pack` 或 `npm publish` 不会替你构建。打包前必须先运行构建 / 完整检查。发布清单包含 `dist/`、patch、README、`docs/`、LICENSE；源码、测试、预览与本地审查记录不属于安装包。

检查 tarball 的包名 / 版本、导出入口、客户端、patch 和文档后，再通过目标 DSH 插件管理入口安装。工作区构建、包内容检查、Profile 安装、启用与真实调用分别验证。

在 Desktop 会话中构建后，可从 Git Bash 用以下命令验证本机分发归档。脚本使用临时缓存和安装根，不加载桌面 Profile，不读取账户或发送生成请求：

```sh
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" scripts/check-desktop-compat.cjs
```

## 本次验证矩阵

0.1.35 本地检查日期：**2026-11-03**；0.1.36（额度取数解耦、设置页紧凑布局与隔离修复）复检日期：**2026-11-04**（Asia/Hong_Kong）；0.1.37（AI Credits 未开启时隐藏、删除代理积分说明、保存栏面板化样式）复检日期：**2026-11-04**（Asia/Hong_Kong）；0.1.38（无档位模型的元数据、模式总线回切、设置卡片只编辑即时字段、会话选模按会话判定、一次性请求不再占死 worker、账户刷新与资源回收修复）复检日期：**2026-11-12**（Asia/Hong_Kong）；开发契约基准升到 Core `0.2.2-rc.1` / Cordis `4.1.0` 与转发型请求 `purpose` 放宽的适配复检日期：**2026-11-13**（Asia/Hong_Kong）；peer 范围补 `0.2.2` prerelease 界标、契约基准升到 `0.2.2-rc.3` 与 `LlmError` 自定义码改走 `fromFailure` 的适配复检日期：**2026-11-16**（Asia/Hong_Kong）。

| 验证项 | 状态与范围 |
|---|---|
| TypeScript | `npm run typecheck` 通过 |
| 隔离回归 | 2026-11-19 使用系统 Node 24：48 个文件 / 849 项通过（契约基准 Core `0.2.2-rc.3` / Cordis `4.1.0`），包含旧宿主错误回退、目录停用项与档位、Schema 字段优先和已保存项目额度回退 |
| 构建 | `npm run build` 通过 |
| 代理响应预算 | 合成 HTTP 与 SSE 测试覆盖：多帧生成超过旧 8 MiB 后仍能完成；解码后超过 64 MiB 正确失败；非生成和非成功生成响应仍受 8 MiB 传输预算约束 |
| 代理目录预算 | 2026-11-19，同一账户真实 `fetchAvailableModels` 回包为 HTTP 200、解码后 303,104 字节、38 条；同一回包交给已安装 0.1.40 复现 `REQUEST_LIMIT`（262,144 字节），候选代码成功解析并返回 6 个可选模型。未保存原始回包、未发起生成请求。合成回归另外覆盖普通响应预算与同账户缓存回退 |
| Hydrogen / Neon 实测 | 2026-11-19，真实目录 HTTP 200，设置页使用的目录接口返回 8 个家族，两组新增模型均观测到 `low` / `medium` / `high` / `xhigh`。候选适配器分别发送 `gemini-4-hydrogen-medium`、`gemini-4-neon-xhigh` 短文本请求，均 HTTP 200 并返回 `OK` 后正常结束。未测其余档位、图片或桌面 GUI |
| 图片和上下文端到端 | 真实目录 HTTP 200，Hydrogen / Neon 八档均返回 `supportsImages: true`、`maxTokens: 1048576`、`maxOutputTokens: 262144`。用桌面 Core `0.2.2-rc.5` 和本地附件服务向 Neon `medium` 发送生成的纯蓝 PNG，上游正确识别并返回 HTTP 200；Core 收到窗口 1,048,576、输入 1,144、输出 2、思考 109、总量 1,255。设置服务输出容量和输出上限；自动回归另覆盖混合档位和无附件服务 |
| 官方 CLI 容量来源 | 本机 `agy models` 实测 23 行、每行只有两列（ID、名称）；ACP 模型容量来自会话 `usage_update.size`，`used` 与单次计费 token 分开 |
| 代理思考摘要 | 同一 Hydrogen `medium` 线模型的真实对照：两次 HTTP 200；原请求收到正文和签名但无摘要，仅添加 `includeThoughts: true` 后收到 1,135 字符摘要。Neon `medium` 经 DSH NEXT 2.0.24-next 所带 Core `0.2.2-rc.5`，真实生成输出 2,177 字符摘要及 reasoning 块，正常结束 |
| 额度快照 | 用桌面包内 Cordis 拉取真实 Google 额度，获得 3 个分组；新开隔离 Host，在上游不可调用的条件下重读同一快照，分组与时间戳一致。自动回归覆盖独立定时、手动合并、读取不等待刷新、换账户隔离与过期标记 |
| 工具 / runtime | 假 ACP / MCP、乱序工具结果、池所有权、续轮变更、取消、写入阻塞和回收 |
| Claude 历史工具批次 | 桌面 Core `0.2.2-rc.5` + 真实 Sonnet 5.5 `medium`：并行两个工具只回填一个后续发消息，已安装 0.1.42 上游 HTTP 400 / `PROTOCOL_DRIFT`；候选用同一历史正常完成（HTTP 200），两个结果都缺失时也正常完成；当前批次未收齐时在本地返回 `INVALID_ARGS`，不派发 |
| 图片 | 附件引用校验、图片内容映射与跨 worker 能力；代理模式 inlineData 准入、12MB 预算与 offload 协商、附件缺席降级；未调用真实视觉模型 |
| 设置交互 | React 18 renderer 覆盖全部即时字段（普通配置只在指引块列出字段名，`proxyBypass` 不提供控制项）与逐模型 `modelOverrides` 的编辑、搜索、启停筛选、保存回读、草稿、冲突、只读与 namespace 恢复；连接 / 模型 / 额度 / 高级分页后非活动页只隐藏不卸载，全部字段仍在同一份草稿里；不替代真实宿主设置服务或 GUI 验收 |
| 代理模式 | 线头顺序与 chunked 字节、端点白名单、SOCKS 拒绝、OAuth 回调 state/主机校验与不消耗在途 flow、副本原子写与 CLI 导入（含仅 refresh 形态）、payload 映射与 sentinel 签名、replay 归属校验、模式总线通知幂等、路由注册/注销互斥、代理额度 401 换发一次重试；全部合成依赖，不触真实网络与账户 |
| 代理功能回归 | Google SSE 错误字段、401/403 首块前换发、工具 STOP 续轮与真实宿主消息回填、16KB 签名与映射归属、缺完成标志及 HTTP 截断、chunk 增量解码；目录排除停用项、仅发布已观测档位、调用准备的目录与设置快照、跨账户派发拒绝、附件能力及请求尺寸 |
| 代理 schema | 工具参数本地 `$ref` 展开、联合分支补字段但保留主 Schema、`items`/`properties` 优先于显式与推断类型、空数组补 `items`、忽略空白枚举值；403「violation of Terms of Service」识别为账号停用。全部为合成请求，不触真实上游 |
| 代理账户 | 过期 CLI 导入刷新、失效凭据转 OAuth、只读项目检测与缺失错误、取消抢占、真实存储加载/清除竞态、删除失败、授权终态与 URL 最小返回；已有账户刷新失败不导入其他 CLI 账户，直接重登增加代际；账户代际隔离目录、额度及在途结果；项目探测 503 时用已保存项目读取额度 |
| 无 CLI 授权闭环 | 不存在的 CLI 文件 → 实际 OAuth/PKCE → 生产监听器随机测试端口的真实 HTTP 回调 → 模拟 Google 换码/项目 → 真实临时 store → 真实适配器目录 → 重建读取；拒绝/缺码/过期/端口冲突/项目及保存失败/取消后可重试 |
| 设置页 UX | 精简首屏、无修改时隐藏保存区、当前模式账户、紧凑模型列表、搜索/筛选/批量启停与完整详情、独立高级分组；未保存计数/撤销/只读/冲突，网络草稿与取消可用性、授权链接/阶段；手动额度、模式来源校验、实际路由家族、账户切换及旧广播、共享刷新收尾 |
| 浏览器布局 | 已注册 Chrome + 既有 Playwright 1.63.0，离线真实 Client 静态夹具；320/390/1280 宽度、深浅主题及顶部/中部/底部共 36 项检查，保存栏可见且无横向溢出；静态布局不替代桌面实例验收 |
| 模式切换 | 请求代理模式即注销 ACP，缺席/注册失败/卸载均不回退；Host 控制层拒绝 ACP 登录与预热，目录按模式和账户代际隔离，额度请求校验期望模式。真实 React renderer 覆盖草稿与生效状态、代理登录/退出后更新模型、失败原因与过期链接清理 |
| 桌面注册契约 | 2026-11-19 使用 DSH NEXT 2.0.23-next / Core 0.2.2-rc.3 / Cordis 4.1.0 的实际组件隔离验证：npm 与 DSH 的 peer 判定、ACP 与代理模式双向切换、唯一 Typert Host 贡献、卸载清理、自定义错误码和 provider 失败事实。旧版无工厂分支由 Vitest 模拟覆盖；没有启动完整 Loader 或连接现有 Host |
| 代理（出网） | 合成依赖、动态变更与清空、不打断旧响应、卸载释放、失败不直连、运行期地址变坏时按 Promise 拒绝、装载期非法地址不阻断插件、本地 SOCKS 测试；不是 Google 网络可达性保证 |
| 代理环境继承 | HTTPS / ALL / HTTP 优先级、显式值覆盖及清空恢复、OAuth 与原生 TLS 接线、本地 CONNECT 首包和 NO_PROXY。无凭据 Google 探针对比直连超时与环境代理收到 401，只验证工具进程所见网络，不代表运行中 Host 的环境或账户可用性 |
| 额度取数 | 假 fetch 覆盖超时折叠、401/403 按状态码重试一次、401 后成功、非 401/403 不重试、OAuth 元数据配对；`cliQuotaEnabled` 默认关闭时即使注入 CLI 也不 spawn，打开后才走 `/usage` 与 `/credits`，关闭后旧快照失效；代理模式默认零 `agy` 调用且套餐额度仍取代理账户，打开开关后只有 Credits 走 CLI；不触真实账户 |
| 真实上游 / GUI | 本次 OAuth 使用真实本地 HTTP 与模拟 Google 响应，浏览器使用离线夹具；0.1.38 安装后的 GUI、真实 Google 授权、真实生成或图片识别尚未验收 |
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
3. 手动在对应 ref 运行工作流。现有任务使用 GitHub-hosted Ubuntu、Node 24，执行 `npm ci --ignore-scripts`、`npm run check`，再 `npm publish --provenance --access public`。
4. 观察这一次运行的 SHA、检查结果与 publish 步骤。失败时先判断是否已经产生远端副作用，不盲目重跑同一版本。
5. 在 registry 核对版本、dist-tag、tarball、仓库来源和 provenance；仅 workflow 返回成功还不足以宣称用户已装上该版本。

只读核对示例：

```console
npm view dsh-bundle-antigravity-host version dist-tags --json
npm view dsh-bundle-antigravity-host@0.1.24 version gitHead dist --json
```

发布使用 npm trusted publishing 的 GitHub Actions OIDC，工作流声明 `id-token: write`，不应为本流程保存长期 npm 写入 token。npm 上必须已有与仓库 / 工作流匹配的 trusted publisher 授权；本地 `npm whoami` 不能验证 CI 的 OIDC 权限。当前流程不创建 GitHub Release，也不安装 / 升级任何本机 Profile。

## 文档来源与已知覆盖缺口

- [DSH 插件安装](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish#install-into-a-profile)与 [Desktop README](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)：公共 CLI 与桌面管理所有权；本次通过 Context7 检索，对照项目声明。公开主线不是已安装旧版本的保证。
- [ACP v1 初始化](https://agentclientprotocol.com/protocol/v1/initialization)与 [会话建立](https://agentclientprotocol.com/protocol/v1/session-setup)：本次 Context7 查询混入 RFD 草案，不能当成 v1 已核验；使用官方明确标注 v1 的页面与本地 SDK 类型作补充证据。
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)：本次 Context7 的 npm CLI 资料与官方页面交叉核对。`npm trust` 配置命令的版本门槛不同于既有工作流发布，不混淆这两者。
- 官方 `agy` CLI 的部分本地 JSON 报告没有完整公共文档，历史真实回包与本机实现只作标注的补充证据，不冒称完整官方 SDK 契约。

文档查证、静态检查、隔离测试、打包核查、真实调用和部署验收各自独立，不能互相代替。
