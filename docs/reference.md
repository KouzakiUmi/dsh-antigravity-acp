# 使用与技术参考

[返回主页](../README.md) · [配置](configuration.md) · [更新记录](changelog.md) · [开发与验证](development.md)

本文对应 `dsh-bundle-antigravity-host` **0.1.24**。安装或连接成功不等于真实模型生成、图片识别或所有平台已验收。

## 安装与更新

### npm 包

```console
# 公共 CLI 的 Web profile 示例
dsh plugin --profile web add dsh-bundle-antigravity-host

# 需要固定版本时
dsh plugin --profile web add dsh-bundle-antigravity-host@0.1.24
```

更新时通过目标插件管理器选择本包的目标版本，或使用目标 CLI 支持的单包更新方式；先核对该入口的 `plugin --help`。不要用不限定包名的批量更新命令替代一次单插件更新。

### 本地产物

在源码仓库完成构建并打包后，也可安装本地 tarball：

```console
dsh plugin --profile web add ./dsh-bundle-antigravity-host-0.1.24.tgz
```

文件名以实际打包结果为准；构建与打包步骤见[开发说明](development.md#构建与本地打包)。本仓库现有发布工作流发布到 npm，**不生成 GitHub Release tarball**，因此没有可用的 `releases/latest/download/...` 安装入口。

### Desktop 与启用

- `web` 只是文档示例，不代表实际安装目标。
- **DSH NEXT Desktop 使用随包 DSH Desktop CLI 管理其已初始化的 `desktop` Profile**；独立 npm 公共 CLI 不能代替它。按目标版本要求完全退出 Desktop，执行单包操作，再重开。应用内插件管理页也是可选入口。
- 安装与启用分开。按部署方式重载或重启，让 Host 和 Client 一起生效；仅刷新网页不保证后台已更新。
- 不在受管 Profile 中裸跑 npm / pnpm，不手工编辑其 manifest、锁文件或 bundle 清单。
- 安装后核对包版本、bundle 启用、provider 注册和设置页，再测试连接、生成与工具调用；目录存在或 CLI 返回成功不足以证明运行生效。

官方参考：[插件发布与安装](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish#install-into-a-profile)、[Desktop CLI 与安装所有权](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)。公开主线文档不是每个旧版安装入口的兼容证明。

## 第一次连接

打开 **设置 → Antigravity ACP**。需要代理时先填写并保存，再连接。

| 操作 | 做什么 | 不做什么 |
|---|---|---|
| 立即预热 | 准备已有登录态，启动官方进程并完成 ACP 握手，保留连接 | 不创建会话、不发送 prompt、无登录态时不主动弹浏览器 |
| 连接 / 登录 ACP | 必要时进行官方授权，建立关闭全部工具的发现会话，读取模型目录并保留连接 | 不发送聊天 prompt，不抢占当前聊天或工具回合 |
| 一键拉取模型 | 优先查询官方 CLI；没有 CLI 时使用已有 ACP 登录态进行有界目录发现 | 不暗中触发交互登录，不自动替换当前会话的已选模型 |

连接支持取消。启动时自动预热默认关闭；开启后只准备连接，不预先运行一次模型生成。设置页区分连接已预热、目录 / 账户已验证与进程已停止，不能用上一次成功状态代表当前仍存活。

生命周期面板每两秒读取内存状态，页面隐藏时暂停，离开后停止轮询。显示启动、凭据准备、握手、建会话、选模型、首块、首个工具及续轮耗时，以及活动、排队、保留工具回合和并发容量。

## 模型目录与请求项

模型目录来自会话 `configOptions`、`config_option_update` 与官方 CLI 的只读 `agy models`。`initialize` 本身不是无需登录即可获取完整模型目录的接口。没有缓存时目录可以为空，应先显式连接或刷新。

- 观测目录写入 `$DSH_HOME/cache/antigravity-acp/catalog.json`，只含模型信息，不含凭据；CLI 目录使用同目录的 `cli-models.json`。版本不符或损坏的缓存不作为有效目录。
- `preferredModel` 可以从目录选择或手填。目录外 ID 标为用户配置、未验证；不会自动替换当前会话的选择。
- 旧 `server-default` 路由仍兼容：映射到 `preferredModel`，留空沿用上游默认；不再新增占位选择项。
- 官方将思考档位编码进 ID 时，选择器折叠为模型家族；DSH 思考强度低 / 中 / 高路由至 `-low` / `-medium` / `-high`。缺档取最近档位，未指定通常使用 `medium`；显式钉住档位 ID 时尊重该 ID。`gpt-oss-120b` 家族不列入选择器。
- 上下文容量不填猜测值。收到官方 `usage_update.size` 后才记录到模型上下文并缓存；首次观测前未知。
- 模型、容量与图片能力在 worker 间同步；不因增加 worker 就虚构新模型权益。

| 请求项 | 行为 |
|---|---|
| `reasoningEffort` | 官方档位路由键，不是采样参数 |
| `maxTokens` | 忽略；宿主标题等内建流程也会携带此项，输出限制由官方 agent 决定 |
| `temperature` / `stop` | 返回 `UNSUPPORTED_OPTION`，不假装满足无法兑现的要求 |

## 并发与工具续轮

默认最多 2 个按需启动的 worker，可配置 1–4；每个 worker 独立拥有官方进程、连接、MCP 桥和 prompt 状态。等待队列最多 64 项，默认 120 秒超时；排队可取消，主对话优先于排队中的 `session-title`。已经运行的请求不会仅因优先级被抢占。

同一会话、同一用途的重叠请求串行；保留的工具回合仍归原 worker。同会话同步压缩可回到该 worker 并受控重建，不等待自己的工具结果。原工具结果拥有优先回填路径，不会仅因无关队列已满而被拒绝。

工具链路：

1. 插件通过宿主 `ctx.subprocess` 以 stdio 启动官方 ACP server。
2. 会话使用厂商扩展 `_meta.antigravity.enabledTools: []` 关闭内置工具，使用 `eagerMcpServers: ["dsh-tools"]` 提供当前 DSH 工具 schema。此扩展的默认适配基准是官方 server 1.4.0，不保证任意版本同样实现。
3. 私有 MCP 桥仅绑定 `127.0.0.1`，每个新回合轮换 token 与授权代次，重新核对工具仍在当前目录中。
4. ACP 权限提示只对已识别私有桥请求选择 `allow_once`，不会自身产生 DSH 调用；真正的 `tools/call` 到桥后才挂起，并以 `tool-call` 交给 DSH。
5. DSH 负责校验、审批、执行；工具结果按调用 ID 匹配，携带 `isError` 回填同一 ACP prompt。支持乱序结果与后续批次。

桥可按 schema 修正常见、无歧义的参数别名，如 `path` / `AbsolutePath` → `file_path`、`CommandLine` → `command`。不覆盖已有字段，不猜多目标映射，不换算超时单位，不编造缺失说明。缺必填键时返回 `AGY_BRIDGE_INVALID_ARGUMENTS` 与正确签名，不进入 DSH；字段类型与取值仍由 DSH 校验。

续轮会校验模型、思考强度、system、工具 schema、历史前缀与上轮实际输出。变更后取消旧 prompt，按新历史重建。`finish(tool-calls)` 只封住当前 DSH 输出，不代表官方 prompt 已结束；封口后到达的内容留给续轮。

普通新用户回合仍创建 ACP session 并重放完整 DSH 历史，不提供跨进程会话恢复，也不把文本历史信封等同于模型 API 的原生角色消息。上游 `end_turn` 没有可见文本或工具调用时返回 `AGY_EMPTY_RESPONSE`，仅思考或进度通知不算成功。

ACP fs / terminal 与未知原生权限请求始终拒绝。单次拒绝允许模型改用 DSH 工具；同回合反复索要超过 3 次会 fail-closed 终止。协议能力与权限拒绝**不是操作系统沙箱**，不证明官方二进制只能执行被协议观察到的操作。

## 图片输入

需要宿主附件服务与上游 `promptCapabilities.image` 同时可用。插件在调用准备阶段发现能力，避免提前按 text-only 投影丢掉图片。

- 当前 / 历史消息与工具返回图片均通过附件引用读取，校验附件 ID、媒体类型、字节数及非空内容，再转换为 ACP / MCP 图片内容。
- 支持 PNG、JPEG、WebP、GIF；不自行下载远程图片 URL，不任意读取用户文件来替代附件服务。
- 附件服务不存在时保留文本能力，不声明图片输入；意外收到不能处理的图片返回 `AGY_IMAGE_UNAVAILABLE`，引用与数据不一致返回 `AGY_INVALID_IMAGE`。
- 已被宿主 offload 的图片会明确说明本次未发送像素；不保证可以重建已卸载内容。
- 不支持的文件引用应先由 DSH 投影为可读文本；不声称支持音频、视频或图片生成。

协议依据：[ACP v1 初始化与能力协商](https://agentclientprotocol.com/protocol/v1/initialization)、[会话建立](https://agentclientprotocol.com/protocol/v1/session-setup)。SDK 版本 1.4.0 与 wire protocol v1 分开看待；v2 / RFD 草案不作为当前实现契约。

## 登录态与额度来源

### ACP 认证

优先复用本机已有 ACP 凭据。需要导入时，只读 `~/.gemini/antigravity-cli/antigravity-oauth-token`，换发后写入官方 ACP 使用的 `~/.gemini/antigravity-acp/acp_token.json`，并在 `settings.json` 缺少认证方式时合并 `auth.type = oauth-personal`。保留既有设置与用户指定的其它认证方式，不覆盖无法解析的设置文件。

这意味着插件**可能读写本机认证材料**，不是“完全不碰凭据”。CLI 源文件不由插件改写；有可用登录态时跳过浏览器授权。没有可用登录态且本次允许交互时才退回官方 OAuth。预热与非交互目录刷新不会暗中弹登录页。CLI 登录不会由 ACP 登录反向补齐。

凭据文件使用临时文件与重命名写入，POSIX 请求 `0600`；Windows 依赖目录 ACL，不宣称文件加密或仅靠 mode 就完成隔离。OAuth client 元数据来自显式环境变量或本机官方分发物，这是兼容性取数路径，不保证官方内部格式永远稳定。

### 额度药丸与 AI Credits

只在选中 `antigravity-acp` 时显示。药丸位于模型选择器左侧，随模型匹配 Gemini、Claude/GPT、Gemini 4 Argon 额度组；未知型号与旧 `server-default` 不借用其它模型数字。

展开固定展示三个组；缺数据标为未提供，显示每窗剩余百分比、重置时间、当前模型、缓存状态与刷新。支持深浅主题、Escape 与外部点击关闭。

| 数据 | 优先来源 | 回退 / 限制 |
|---|---|---|
| 套餐额度 | `agy -p /usage --output-format json` 的 `command.data.groups[].buckets[]` | 无 CLI 时尝试 Cloud Code Assist HTTP；产品授权不匹配可能返回 403 |
| AI Credits | `agy -p /credits --output-format json` 的 `command.data.remaining_credits`，可选 `plan_name` | 无 CLI 不提供，不从套餐额度推算 |
| 模型目录 | 会话观测与 `agy models` | 手动强制刷新无 CLI 时尝试非交互 ACP 发现 |

CLI 额度 / 余额命令各有 45 秒超时，并发刷新合并、有效缓存不重复取数。额度与 Credits 独立缓存、独立标记更新时间与错误；查询失败可保留旧值但明确标缓存，上游明确无账户信息时移除旧值。Credits 只接受成功本地报告与非负安全整数；真实零显示 0，缺字段不变成零。不请求购买、不自动开启 `useG1Credits`。

HTTP 额度回退只读 CLI 登录材料，换发 access token 仅留内存，不写回 CLI 文件。所有 CLI 进程经宿主受管通道启动。日志与错误对 OAuth URL、Bearer、代理密码和结构化 token 脱敏，不回显正文或工具参数值。

**历史实测，不是 0.1.24 GUI 验收：** 2026-10-16 本机 CLI `/usage` 返回三个组的 weekly / 5h 窗口；同账户 HTTP 回退曾返回产品授权 403。2026-10-22 既有 CLI `/credits` 记录为成功、零模型回合 / 零用量。当前任务未重跑这些在线调用；不能保证所有旧 CLI 支持相同 JSON 形态。

官方参考：[安装与认证](https://antigravity.google/docs/cli/install.md)、[无头模式](https://antigravity.google/docs/cli/headless.md)、[AI Credits](https://antigravity.google/docs/cli/commands/credits.md)。本地 JSON 契约与官方 TUI 说明的覆盖范围不同。

## 运行目录与下载安全

默认官方 server **1.4.0**，不随 registry 自动升级。自动下载限定 HTTPS / `dl.google.com`，拒绝任何重定向，按流写入临时文件；解压检查绝对路径、`..`、盘符、反斜杠与逃逸路径。成功后提交缓存，失败清理本次暂存。官方未提供校验和，不能据此宣称签名 / 校验和验证通过。

二进制默认**不放在 DSH home**：

- Windows：`%LOCALAPPDATA%\dsh-antigravity-host\<版本>\`；缺少该变量时按用户目录回退。
- macOS / Linux：`$XDG_CACHE_HOME/dsh-antigravity-host/<版本>/`，其次 `~/.cache/dsh-antigravity-host/<版本>/`。

Windows 的 Low 完整性目录可能导致官方进程不能保存用户级凭据，也可能降低运行代码目录的信任级别。插件启动前只读探测二进制与运行目录，识别到 Low 标签返回 `AGY_BINARY_LOW_INTEGRITY`；探测失败本身不等于安全校验成功，也不会自动修 ACL。

onefile 临时展开使用用户级根目录内独立的 `runtime/instance-*`，不使用 DSH Low 临时目录。每个目录带插件所有权记录；只清理自身拥有且可确认进程退出的运行目录，不按 mtime 删除活跃 DLL。历史 `_MEI*` 与未知所有权目录保留，由用户停止相关进程后人工检查。宿主被强杀或崩溃、未留下明确子进程退出记录的 `active` 目录也不会自动清理；这可能持续占用磁盘，当前不提供崩溃残留的自动回收保证。

自动平台映射参考[官方 registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json)：Windows `.exe`、POSIX `.par`、macOS 目录 `macos`、ARM64 发布后缀 `arm64`、Linux 默认参数 `--uid=`。这些是发行布局与测试契约，不代表所有平台实机验证；手动本地二进制覆盖先于自动平台映射。

## 出网代理

`proxyUrl` 支持 `http` / `https` / `socks5` / `socks5h`，缺 scheme 按 HTTP，不支持 SOCKS4。留空继承宿主代理，宿主未配置才直连；清空此项不等于强制关闭宿主代理。

- 显式代理先验证，再进行下载、OAuth 或启动；非法地址抛出 `ProxyConfigError`，不回显输入材料。当前验证发生在插件装载期，配置错误可能使本插件无法加载，需通过宿主通用配置面修正，不应依赖本插件自己的设置卡片恢复。当前实现不保证返回旧文档所写的 `AGY_INVALID_PROXY` 错误码。
- 官方进程通过环境注入大小写两套代理键，因为宿主受管子进程会清理父环境。
- `proxyBypass` 与 `localhost` / `127.0.0.1` / `::1` 合并，loopback 始终排除，保证 MCP 桥和 OAuth 回调不绕出本机。
- 插件自身下载、OAuth 与 HTTP 额度请求使用直接依赖 `undici`；显式代理不可用就报错，不静默退回直连。SOCKS5 域名经代理解析。
- 改动后按部署方式重载 Host / 重启 Desktop，确保新进程读到配置；不把页面刷新当作代理已更新。
- 卸载关闭本插件持有的连接池，不影响其它插件的网络资源。

## 设置页实现边界

设置读取 / 修改使用宿主 `remote.settings.describe()` / `mutate()`，provider 状态使用 `remote.llm.listProviders()`。模型、账户连接与额度通过本包贡献的 `remote.agyQuota` 提供；不调用不存在的 `remote.llm.listModels`。

客户端先挂载贡献型 remote。`remote.settings` / `remote.llm` 是宿主已有服务，必须声明依赖；本包的 `remote.agyQuota` 需等挂载后出现，不能预先作为硬依赖阻止自身挂载。

设置草稿与远端快照分离，只提交已修改字段，支持清空。外部更新产生冲突时提示并可恢复远端值；保存失败保留草稿。加载、只读与保存期间禁用相应编辑，不提供账户切换、模型删除 / 禁用或付费开关。

## 排障

| 现象 / 错误码 | 可能原因 | 检查与处理 |
|---|---|---|
| `AGY_BINARY_LOW_INTEGRITY` | 二进制或运行目录带 Windows Low 标签 | 将 `binaryPath` / `AGY_ACP_HOME` 指向合适的用户级目录；不要自动改 ACL 或删除旧缓存。先停止相关进程，再人工检查遗留目录。 |
| `AGY_BINARY_MISSING` | 无本地覆盖 / 有效缓存且关闭自动下载 | 开启 `autoDownload` 或指定可用 `binaryPath`。 |
| 已有解压目录却缺少有效可执行文件，下载后仍重命名失败 | 同版本缓存损坏，当前不会自动删除并覆盖该目录 | 先确认相关进程已停止，再人工核对该版本缓存；也可使用明确指定的有效 `binaryPath`。不要在官方进程活跃时清理它。 |
| `AGY_AUTH_TIMEOUT` | 需要浏览器授权但未在期限内完成，或上游认证失败 | 检查官方登录状态、浏览器和代理；日志不要附完整 OAuth URL。 |
| 连接已预热但目录为空 | 握手不等于已建会话 | 点击「连接 / 登录 ACP」或使用已登录 CLI 拉取目录；检查具体错误而不是反复发送聊天。 |
| 代理配置导致插件无法加载 / `ProxyConfigError`，或连接 Google 失败 | 代理格式、出口或宿主环境继承问题 | 装载失败时通过宿主通用配置面修正代理；不要只等待插件卡片。核对目标 Host 实际继承的环境，保存后重载 Host；当前不保证旧 `AGY_INVALID_PROXY` 码。 |
| `AGY_QUEUE_TIMEOUT` / `AGY_QUEUE_FULL` | worker 忙或保留工具回合，队列超时 / 已满 | 完成或取消旧工具审批；查看排队状态，按资源与账户限制调整并发。 |
| `AGY_INCOMPATIBLE_PROTOCOL` / `AGY_UNSUPPORTED_CAPABILITY` | 协议版本或 MCP 等能力不满足 | 使用兼容 ACP v1 的官方 server；不只修改版本号就假定厂商扩展兼容。 |
| `AGY_IMAGE_UNAVAILABLE` / `AGY_INVALID_IMAGE` | 附件服务 / image capability 不在场，或附件引用不一致 | 重新连接检查能力与附件；不要将文字描述误当已发送图片像素。 |
| `AGY_BRIDGE_INVALID_ARGUMENTS` | 参数别名修正后仍缺必填键 | 按错误中签名补齐；模糊别名不由桥猜测。 |
| `AGY_EMPTY_RESPONSE` | 上游结束时没有可见文本或工具调用 | 查看结束原因与连接诊断；不把仅思考、进度或空白当成功。 |
| 额度 / Credits 不完整 | CLI 未登录、旧版本缺字段、HTTP 产品授权不足或网络失败 | 分别查看额度与 Credits 状态，检查 `agyCliPath`；ACP 登录不等于 CLI 登录。 |
| 药丸完全消失 | 未选择本 provider，或 Client / remote 未装载 | 先确认选中 `antigravity-acp`、Host 与 Client 同版本；开发时核对 `$mount` 与依赖，避免让贡献型 remote 等待自身。 |
| 运行目录积累 | 被强杀后残留或所有权 / 退出状态未知 | 未知目录不会按时间自动删除；停止相关进程后人工核对，不在进程仍活跃时批量清理。 |

失败或取消会撤销桥授权并回收该受管进程；无法确认退出时拒绝开启新回合。provider 不声明可安全重试错误码，避免宿主整步重放导致重复认证、生成或工具调用。定位后由用户决定是否重试，不将错误掩盖为成功。
