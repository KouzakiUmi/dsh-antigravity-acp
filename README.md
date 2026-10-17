# dsh-bundle-antigravity-host

DeepSeek Harness (DSH) host bundle：把 Google 官方 Antigravity ACP server
（`agy-acp-server`，Gemini 背后的 agent）作为 LLM provider 接入 DSH。

工作方式：

- 插件通过宿主注入的 `ctx.subprocess` 服务以 stdio 启动官方 ACP server，
  并以 Agent Client Protocol v1（JSON-RPC over newline-delimited JSON）通信。
- 本包通过 `src/index.ts` 向 `ctx.llm` 注册 provider `antigravity-acp`
  的 `LlmAdapter`。
- 工具执行留在 DSH 侧：进程内私有 `127.0.0.1` loopback MCP 桥把当前
  DSH 工具 schema 交给官方 agent；`tools/call` 被 park 后以 DSH
  `tool-call` 结束本轮，下一轮带着 tool result 续同一 ACP prompt。
- 登录态由本包**导入**：读本机官方 CLI 已登录的
  `~/.gemini/antigravity-cli/antigravity-oauth-token`（只读），换发一颗
  access token 后落成官方 server 认的 `~/.gemini/antigravity-acp/acp_token.json`，
  并补写 `settings.json` 的 `auth.type = oauth-personal`。因此**不会拉起浏览器
  登录页**，也不再发 `authenticate` 请求（该请求在没有交互式浏览器时会一直挂着）。
  只有导入不到任何登录态时才回退到官方浏览器授权流程。

安全边界（自动下载路径）：

- 仅允许 `https://dl.google.com`，拒绝任何 HTTP 重定向；
- zip 解压前逐条目校验路径（拒绝绝对路径、`..` 穿越、盘符/反斜杠异常路径）；
- 官方未提供校验和，因此不伪造任何签名/校验和声明；
- 下载先落临时文件，成功后原子重命名，失败清理残留。

配置项：`binaryPath`（手动指定，优先级最高）、`autoDownload`（默认开启）、
`extraArgs`、`acpVersion`、`requestTimeoutMs`、`authTimeoutMs`、
`promptTimeoutMs`、`bridgeParkSettleMs`、`preferredModel`、`proxyUrl`、
`proxyBypass`。
环境变量：`AGY_ACP_BIN`（二进制覆盖）、`AGY_ACP_URL`（下载 URL 覆盖，
供未验证平台组合使用）、`AGY_ACP_HOME`（可执行文件安装根目录覆盖）。

## 二进制装在哪里（重要）

自动下载的官方 server **不放在 DSH home 下**，默认装到用户级应用数据目录：

- Windows：`%LOCALAPPDATA%\dsh-antigravity-host\<版本>\`
- macOS / Linux：`$XDG_CACHE_HOME/dsh-antigravity-host/<版本>/`，其次 `~/.cache/...`

原因不是洁癖，而是**功能必需**：DSH 会把 `$DSH_HOME`（默认 `~/.dsh`）整棵树标为
**Low 强制完整性**（`icacls` 可见 `Mandatory Label\Low Mandatory Level`），而 Windows
在创建进程时**会采用映像文件的强制完整性标签**。装在 `~/.dsh` 下的 exe 因此只能以
LOW 运行，受 MIC「禁止向上写」约束，写不进中等完整性的 `~/.gemini/antigravity-acp/`：
官方 server 保存凭据用的 `tempfile.NamedTemporaryFile` 会在 `PermissionError` 上
无限重试，`session/new` 永不返回——表现为「Gemini 一直不回话」且没有任何报错。

插件在启动前会**只读**跑一次 `icacls` 探测该标签；一旦命中就直接报
`AGY_BINARY_LOW_INTEGRITY` 并给出修法，而不是把卡死留给用户（探测本身失败不会阻断
启动）。手动指定 `binaryPath` 时请同样避开带该标签的目录。

## 出网代理

官方 `agy_acp_server` 自己连 Google（OAuth 与 Cloud Code Assist），而宿主
`subprocess` 会 scrub 父进程环境，所以代理只能由本包显式注入子进程：

- `proxyUrl`：如 `http://127.0.0.1:7890`；缺 scheme 按 `http` 处理，
  支持 `http`/`https`/`socks5`/`socks5h`/`socks4`。留空即直连。
- `proxyBypass`：逗号分隔的排除列表，用户条目会与本机地址合并。
- 注入 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 与对应小写键，
  Windows 上运行的 Python 栈读大写，小写键覆盖 POSIX 风格读取者。
- `localhost`、`127.0.0.1`、`::1` 始终排除：私有 MCP 桥与 OAuth 回调都在
  loopback，走了代理工具回合会直接卡死。
- 地址非法时在 spawn 之前报 `AGY_INVALID_PROXY`，不会先启动再失败。
- 代理只在子进程启动时读取，改配置后需完全重启 Desktop（或让官方进程退出）。

## 模型目录

ACP v1 没有「不建会话、不认证」就能读到模型目录的方法：`InitializeResponse`
只带 `protocolVersion` / `agentCapabilities` / `authMethods` / `agentInfo`，
`configOptions` 只出现在会话响应与 `config_option_update` 里。因此：

- 未观测到真实目录时，本包广告一条占位模型 `server-default`，让模型选择器能
  列出本 provider；选中它不会调用 `session/set_config_option`，而是映射到
  配置项 `preferredModel`（留空则用官方会话默认模型）。
- 占位项**始终保留在列表首位**，即使真实目录已经出现 —— 用户往往在登录前就选了
  `server-default`，把它挤掉会造成「当前模型不在列表里」。
- 观测到的目录会写入 `$DSH_HOME/cache/antigravity-acp/catalog.json`（只含
  id/name/description/contextWindow，不含任何凭据），重启后用它兜住选择器；ACP server 版本变化
  或文件损坏即失效，回落为占位项。
- **家族折叠 + 思考强度路由**（2026-10-16 用户指示）：官方把思考强度编码进
  模型 id（`claude-opus-5-5-{low,medium,high}`），但模型选择**只出家族一行**
  （`claude-opus-5-5`「Claude Opus 5.5」），强度由 DSH 的思考强度菜单（低/中/高）
  决定，路由到对应档位模型（选「高」→ `claude-opus-5-5-high`；未选走默认档位
  `medium`，与官方默认 `Gemini 3.8 Flash (Medium)` 一致）。家族来源是会话观测
  目录与官方 CLI 只读 `agy models` 清单（2026-10-16 授权「不 wrap agy CLI」
  **仅限只读取数用途**，缓存 `cli-models.json`）折叠去重；`gpt-oss-120b` 整族
  排除（临近下架，用户指示不进选择器）。配置里显式钉住档位 id（如
  `gemini-3.8-flash-high`）且未选强度时，尊重钉住的档位。
- **上下文容量**：官方目录不报告 context window，本包不填猜测值；首个回合收到
  官方 `usage_update.size`（协议定义即 total context window size）后，把实测值
  写进 `resolveModel().context` 并随目录落盘，压缩引擎由此可量化上下文，不再
  每步报 `no context capacity`。首轮回话之前仍是未知。

### 请求项映射

ACP v1 没有采样参数通道，以下请求项的处理是明确的：

| 请求项 | 行为 |
| --- | --- |
| `reasoningEffort` | **路由键**（不是不支持项）：低/中/高 → 家族的 `-low`/`-medium`/`-high` 档位模型；家族缺该档位时取最接近档位。 |
| `maxTokens` | **静默忽略**（输出上限由官方 agent 自己的会话配置决定）。宿主的会话标题等内建流程固定携带它，硬拒绝会让这些功能永久失败。 |
| `temperature` / `stop` | 抛 `UNSUPPORTED_OPTION`：用户显式要求的效果无法兑现，不假装接受。 |

## 稳定性与诊断

- `ensureAcpRuntime` 是 single-flight：并发首轮只 spawn 一条官方进程、只做一次
  `authenticate`，不会留下 dispose 杀不到的孤儿进程，也不会重复弹登录。
- 官方 stderr 含**完整 OAuth 授权 URL**（`state`、`code_challenge` 等）。本包在把
  stderr 写进 `LlmError` 之前统一脱敏：URL userinfo 与敏感 query 参数一律打码，
  非凭据上下文保留以便诊断。
- 认证等待超时时不再回显授权 URL，而是提示「官方进程已打开 Google 登录页，
  请在浏览器里完成授权」。认证超时使用独立错误码 `AGY_AUTH_TIMEOUT`，与普通
  请求超时区分。
- 本 provider **不声明任何可重试失败码**。宿主若消费重试策略会在失败步骤上整步
  重放 `stream()`：握手失败会重复 spawn，认证超时会重复弹登录，`session/prompt`
  超时会新建会话并重放全部历史（可能造成重复内容与重复工具调用）。三类都不可
  安全重放，因此宁可一次不重试。

## 设置卡片

卡片走宿主真实存在的通道：`remote.settings.describe()` 读取、`remote.settings.mutate()`
写入（改 `preferredModel` / `proxyUrl` / `proxyBypass`），`remote.llm.listProviders()`
确认路由是否注册。宿主**没有** `remote.llm.listModels`，所以模型目录不在卡片里展示。

客户端插件的 `inject` 必须逐个声明用到的 remote 命名空间
（`remote`、`remote.settings`、`remote.llm`）：宿主把每个命名空间做成独立服务，
漏声明时连读属性都会抛 `cannot get property "remote.<ns>" without inject`，
击穿 `settings.section` 卡片。卡片对属性读取异常一律降级为卡内可读错误，
不再让异常穿出组件。

## 额度监控（模型选择器旁用量药丸）

选中 `antigravity-acp` 的模型时，输入区模型选择器**左侧**出现用量药丸
（`conversation.input.right` 槽，宿主 InputBar 把它渲染在模型选择器之前；
实现手法参考 dsh-subusage 的同位置药丸）。点开可见各组额度窗的剩余百分比、
重置倒计时与订阅档位；读取失败会显示可读原因，不把未知当充足。

取数链路（Host 侧 `remote.agyQuota.read`）：

1. **首选官方 CLI 的只读额度查询**：`agy -p /usage --output-format json`（slash
   命令由 CLI 本地处理，实测 `num_turns: 0`、`total_tokens: 0`，无模型回合），
   结果取 `command.data.groups[].buckets[]`（`window`/`remaining_fraction`/
   `reset_time`）。CLI 路径可用 `AGY_CLI_BIN` 覆盖，缺省按
   `%LOCALAPPDATA%\agy\bin\agy.exe` 等默认位置探测。
2. 无官方 CLI 时退回 Cloud Code Assist HTTP 线（读 `antigravity-oauth-token`
   → 过期时内存内换发 → `loadCodeAssist` → `retrieveUserQuotaSummary`）。

边界（2026-10-16 经用户明确授权）：

- 「不 wrap agy CLI」放宽为**仅限只读取数用途**：只跑 `/usage` 与 `models` 两个
  只读命令，不发对话、不写文件；子进程一律经 DSH 的 `ctx.subprocess`。
- 「bundle 不读 OAuth 凭据」放宽为额度取数只读：登录态**只读不写**，换发出的
  access token 只在内存里用，绝不改官方登录文件；
- token 材料不进快照、不进错误文本、不进日志（错误统一过 `redactSensitiveText`，
  含 `Bearer <token>` 打码）；
- 取数失败折叠成 `status: 'error'` 的可读快照，不把异常抛穿到界面。

实测状态（2026-10-16，本机账户，真实跑通）：官方 CLI 额度查询解析出 3 组额度窗
（Gemini Models / Claude and GPT models / Gemini 4 Argon，weekly 与 5h 窗、
剩余百分比与重置时间齐全）。Cloud Code Assist HTTP 线是 **Gemini Code Assist
（企业授权产品）**：本账户 `retrieveUserQuotaSummary` 403「no valid license of
this product (#3501)」，仅作备用。原生 gRPC 接口
`google.gca.aicode.v1main.JetskiRemoteAgentProxyService/GetUserQuotaSummary`
已定位（宿主 `aicode.googleapis.com:443`）但服务端路由未接通，记录备查。

## 宿主（DSH Core）兼容性声明

宿主在**安装/启用时**会校验插件 manifest 里的 DSH 版本要求，不通过就拒绝安装
（`ManagementFailure(incompatible-version)`，诊断文本以 `dsh: installation rejected:`
开头）。规则（读自宿主 `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`）：

- 若声明了 `engines.dsh`，**该范围单独决定**，`peerDependencies` 一律忽略；
- 否则逐个校验 `peerDependencies` 中名为 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-`
  开头的项，其余包（含 `@deepseek-ai/cordis`）**不参与**该判定；
- 比较对象是**运行时版本**，取 `@deepseek-ai/dsh-app-boot` 自身 `package.json` 的
  `version`（即实际加载的 Core 版本，不是壳版本、也不是任何全局 CLI 版本），
  且按 `includePrerelease: true` 参与范围匹配。

本包当前声明（0.1.11）：

| peer | 范围 | 说明 |
|---|---|---|
| `@deepseek-ai/dsh-llm` | `>=0.2.0-rc.1 <0.2.1-0 \|\| >=0.2.1-0 <0.3.0-0` | 参与宿主校验 |
| `@deepseek-ai/dsh-subprocess` | 同上 | 参与宿主校验 |
| `@deepseek-ai/dsh-typert-protocol` | 同上 | 参与宿主校验 |
| `@deepseek-ai/cordis` | `~4.0.4 \|\| 4.0.5-alpha.1 \|\| 4.0.5-alpha.2` | 宿主不校验，仅供 pnpm peer 解析 |

0.1.10 及更早版本把三个 `dsh-*` peer 写成了逐版本枚举（止于 `0.2.1-alpha.3`），
在宿主升到 `0.2.1-alpha.4` 后判定为不兼容；0.1.11 换成上面这条宽范围
（与社区插件 `dsh-subusage` 0.13.4 一致），对 `0.2.1-alpha.x`、`0.2.2` 均为真，
对 `0.3.0-0` 及以后为假。

若宿主将来越过该范围：可以更新本包的范围，或在插件管理器 / `dsh plugin allow-version`
里为**精确的 name@version + 精确运行时版本**授予豁免（豁免记录在 profile 的
`compatibility.json`）。豁免是显式接受风险，不是默认恢复步骤。

契约面（非声明面）的核对状态：以宿主 0.2.1-alpha.4 的实际产物逐项对比过——
`dsh-subprocess` 与 `cordis` 的类型声明逐字节相同；`dsh-llm` 只有新增可选成员
（`imageRequestTarget`、`defaultBaseURL` 等，基类提供默认实现）；`dsh-typert-protocol`
新增 `resources`/`principal` 等可选访问控制面，`register(contribution)` 签名未变，
本包用的 contribution 形态（`{package, face, schemas, model, invocations}`）与同宿主上
可用的 `dsh-subusage` 0.13.4 完全一致；客户端依赖的 `conversation.input.right` /
`conversation.input.model` slot、`__ModuleLoader__`、`listProviders` 在新壳中均存在。
开发依赖已对齐宿主版本并精确锁定（`dsh-llm` / `dsh-subprocess` / `dsh-typert-protocol`
= `0.2.1-alpha.4`，`cordis` = `4.0.5-alpha.2`），`npm run check`（255 测试 / 17 文件 +
类型检查 + 构建）在该版本类型上全绿。**未做**：真机安装 0.1.11 后的 GUI 验收
（对话与额度药丸）。

## 安装参考

通用 CLI 示例（`web` 只是文档用的 profile 名，不是本机 Desktop）：

```sh
dsh plugin --profile web add ./dsh-bundle-antigravity-host-0.1.11.tgz
```

本机 Desktop 壳独占 `desktop` profile，公共 `dsh` 不能对它执行 `plugin add`。
请在 DSH NEXT 的插件管理器里添加本地包，路径示例：

`D:\dsh-antigravity-acp\.local-install\dsh-bundle-antigravity-host-0.1.11.tgz`

装好后需要完全退出并重开 Desktop。只要本机官方 CLI 已登录过，
`oauth-personal` 登录态会自动导入，**不会**弹浏览器登录页。模型路由名为
`antigravity-acp`。

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 首次对话后 Gemini 完全不回话、也没有报错 | 二进制落在 Low 强制完整性目录，官方进程被降权后卡在凭据保存 | 插件现在会直接报 `AGY_BINARY_LOW_INTEGRITY`；删掉 DSH home 下的旧 `cache/antigravity-acp/*/extract-*` 即可，新版本默认装到 `%LOCALAPPDATA%` |
| 启动即失败 `AGY_BINARY_MISSING` | 未配置 `binaryPath`、无缓存且 `autoDownload=false` | 打开 `autoDownload` 或指定 `binaryPath` |
| 认证环节等到超时 | 导入不到任何本机登录态，退回官方浏览器授权 | 先用官方 CLI 登录一次，或在插件配置里填 `proxyUrl` 后重试 |
| 官方进程连不上 Google | 宿主 scrub 了父环境，代理需显式注入 | 填 `proxyUrl`（留空时会自动转发宿主自身的 `*_PROXY`） |
| 磁盘被 `_MEI*` 目录吃掉几十 GB | onefile 解压目录在进程被强杀后不会自清理 | 装载插件时会自动清理超过 1 小时的陈旧目录 |
| 选某个具体型号后「没有反应」，默认项（首次对话登录）正常 | 该型号去索要原生 `fs`/`terminal` 能力（不同模型对工具的使用风格不同），回合被护栏终止 | 0.1.17 起改为「**拒绝但继续**」：原生请求与权限询问一律照旧**拒绝**（不授予任何本地能力），但不再当场终止回合，模型会改用桥过去的 DSH 工具；只有同一回合反复索要超过 3 次（明确坚持绕开工具桥）才按 fail-closed 终止 |
| 药丸空着 / 药丸消失 | 贡献型 remote 的客户端挂载与依赖声明 | 插件必须在客户端 `ctx.remote.$mount(...)` 一次（0.1.15 起）；**不要**把 `remote.<ns>` 写进 `inject`（注册回调会永远等待 → 元素消失）|

本 README 仅描述代码与产物现状，不构成已安装或兼容性承诺。
