# 配置与环境变量

[返回主页](../README.md) · [使用与排障](reference.md) · [开发与验证](development.md)

以下对应 **0.1.38**，以 [`src/settings.ts`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/src/settings.ts) 的 Config 为准。字段均位于 `llm-antigravity-acp` 插件配置根级，不需要额外包装一层对象。设置页提供即时（volatile）字段与模型控制；`proxyBypass` 不提供界面控制项，并发 / 二进制 / 超时等普通配置在普通配置编辑器里修改。

## 配置清单

| 字段 | 默认值 | 作用与限制 |
|---|---|---|
| `maxConcurrentSessions` | `2` | 最大独立 worker 数，整数 1–4，按需启动。不是单个官方进程的多 session 开关，也不增加账户额度。 |
| `queueTimeoutMs` | `120000` | 等待 worker 的上限（毫秒），最小 1000；队列最多 64 项，排队可取消。 |
| `agyCliPath` | 未设置 | 官方 `agy` CLI 路径，优先于 `AGY_CLI_BIN`、PATH 与平台默认位置；刷新时重新探测。 |
| `autoWarmup` | `true` | 加载插件时预热已有登录态与连接，不发送聊天 prompt，不主动弹浏览器授权；无登录态时预热报错，需手动「连接 / 登录 ACP」。设为 `false` 时改为只预读已缓存的官方 exe 到系统文件缓存。常驻一个官方进程约 170MB 内存。 |
| `binaryPath` | 未设置 | 本地官方 ACP server 入口，优先级最高；指定但不存在会报错，不静默换来源。 |
| `autoDownload` | `true` | 无本地覆盖和有效缓存时从官方域名下载。 |
| `extraArgs` | `[]` | 额外启动参数；不要传入会改变协议、工具隔离或认证边界的参数并假定仍兼容。 |
| `acpVersion` | `"1.5.2"` | 自动下载与缓存目标版本；不是 ACP wire protocol 版本。更换版本需重新验证厂商扩展与发行布局。 |
| `requestTimeoutMs` | `30000` | 普通 ACP 请求超时（毫秒），覆盖 stdin 写入与响应等待。 |
| `handshakeTimeoutMs` | `120000` | ACP `initialize` 握手上限（毫秒）。官方 PyInstaller 进程冷启动实测约 52 秒、热启动约 10 秒，旧默认 15 秒会使冷启动登录超时。 |
| `authTimeoutMs` | `300000` | 交互式 `authenticate` 等待上限（毫秒），独立于普通请求超时。 |
| `promptTimeoutMs` | `1800000` | 单个 `session/prompt` 上限（毫秒）；工具 park 不表示上游 prompt 已结束。 |
| `bridgeParkSettleMs` | `50` | 并发 MCP 工具调用聚合窗口（毫秒）；不是工具执行超时。 |
| `modelOverrides` | `{}` | 按模型 ID 的目录设置，键是 DSH 选择器里的模型 ID：`enabled`（默认 `true`）决定是否出现在选择器，`effort` 是该模型未选思考强度时的默认档位，`name` 覆盖显示名，`target` 把该 ID 映射到官方模型 ID。只作用于目录中已存在的条目，不新增自造模型。官方公告即将下线的家族在未配置时默认 `enabled: false`，在此显式设为 `true` 可重新启用。 |
| `orchestrator` | `{}` | 编排模式（`antigravity-orchestrator`）配置，整份对象字段：`enabled`（默认 `true`）、`plannerModel`（三选一：`gemini-4-neon` / `gemini-4-argon` / `claude-opus-5-5`，默认后者）、`plannerEffort`（默认 `medium`）、`executorModel`（两选一：`gemini-4-hydrogen` / `claude-sonnet-5-5`，默认前者）、`executorEffort`（默认 `medium`）、`maxPlansPerTurn`（默认 `2`，范围 1–4）、`plannerTimeoutMs`（显式设置才生效；代理侧默认 20000，ACP 侧未设置时用 120000）、`showPlan`（默认 `false`）。档位按目标模型的实际可选集合收敛（Opus / Sonnet 只有 low/medium/high，Hydrogen 另有 xhigh），非法值退回 medium 或默认模型。只有 planner 与配置的 executor 都已在当前目录可见时，`antigravity-orchestrator` 才会出现在选择器里。 |
| `proxyUrl` | 未设置 | 显式出网代理；留空继承 Host 代理环境，Host 也未配置才直连。代理模式支持 HTTP/HTTPS CONNECT；ACP 模式另支持 SOCKS5、SOCKS5H。 |
| `proxyBypass` | 未设置 | 兼容既有配置的逗号分隔排除列表，支持域名匹配，不支持 CIDR；始终合并 localhost、127.0.0.1、::1。设置页不提供此控制项。 |
| `reuseSessions` | `true` | 复用同一个 ACP 会话：同一 DSH 对话的后续回合只发送**新增消息**，不再每轮 `session/new` 并重放全部历史。历史被压缩、回退或编辑，模型/思考强度变化，工具目录变化，或 MCP 桥被其他对话接管时自动重建。关闭后回到旧的「每轮新会话 + 全量重放」。 |
| `resumeSessions` | `false` | 插件或 Host 重启后，尝试用 `session/load` 恢复上次的 ACP 会话。映射写在缓存目录的 `sessions.json`，只存会话 ID、cwd、已发送条数、输入/输出与路由 sha256 和时间戳，不存对话内容、system 提示或工具 schema。恢复失败或前缀不一致时自动回退为新轮重建。 |
| `keepProcessAfterCancel` | `false` | 用户按停止后是否保留官方进程。关闭时立即回收（下一轮冷启动）；开启后先等 `cancelGraceMs` 确认 agent 已停止，确认了就只丢弃会话、保留进程。 |
| `cancelGraceMs` | `30000` | 取消后等待 agent 确认停止的上限（毫秒）；`0` 表示不等待、立即回收进程。热启动约 10 秒，30 秒留出余量。 |
| `idleRecycleMs` | `300000` | 保留进程的最长空闲时间（毫秒），超时回收释放内存；`0` 表示不设上限。适用于聊天、预热及目录发现结束；等待工具和取消排空不算空闲。5 分钟是插件资源策略，不代表上游缓存寿命。 |
| `proxyMode` | `false` | 代理模式开关（即时生效，保存即切换，无需重载）。开启后生成改由本 bundle 的代理路由 `antigravity-proxy` 直连上游：插件自持登录态（先导入官方 CLI 登录态，缺失时 loopback OAuth），以 agy CLI 线身份请求 Cloud Code Assist；同时注销官方 ACP 路由 `antigravity-acp`。关闭恢复 ACP 模式。两模式互斥；额度药丸跟随当前模式取对应账户。图片输入需宿主附件服务在场：单图 4MP / 1MB 请求版本、整请求 12MB 内联预算，超预算按最旧优先协商 offload；附件服务缺席时报 `UNSUPPORTED_MODALITY`。 |
| `cliQuotaEnabled` | `false` | 是否允许额度取数调用本机官方 `agy` CLI（即时生效）。默认关闭：任何模式都不 spawn `agy`，套餐额度走内置直连，AI Credits 不查询。开启后 ACP 模式运行 `agy -p /usage` 与 `agy -p /credits`；代理模式套餐额度仍用代理账户，只有 AI Credits 调用 `agy -p /credits`。需要本机已安装并登录官方 CLI。 |

示例（不包含代理密码或账号材料）：

```json
{
  "maxConcurrentSessions": 2,
  "queueTimeoutMs": 120000,
  "autoWarmup": true,
  "autoDownload": true,
  "acpVersion": "1.5.2",
  "reuseSessions": true,
  "resumeSessions": false,
  "proxyUrl": "http://127.0.0.1:7890"
}
```

### 会话复用与恢复

ACP 官方 agent 在同一会话内会保留上下文（2026-10-23 真机验证：同一 `session` 连发两条 prompt，第二条能复述第一条的暗号），并且声明了 `loadSession`。因此插件默认复用会话：

- 同一 DSH 对话的**普通聊天回合**校验输入前缀与上轮实际交付输出后，只发送新增消息；system、工具策略与历史不再每轮重放。收到 `finish` 即结束消费也会提交游标。
- 注入内容按 producer 与内容去重：仅省略相同的快照/目录/指令或已见召回材料；首次出现、变化或恢复旧版本的状态仍发送。真实用户消息、notice、relay 与未知类别不去重。
- 出现以下任一情况即受控重建（`session/close` + `session/new` + 全量重放）：历史不是已发送前缀的追加（压缩检查点、回退、编辑）、模型或思考强度变化、system 或工具目录变化、MCP 桥被另一对话接管、回合异常终止。
- 标题、压缩等一次性请求不参与复用，各自独立建会话，结束后尽力关闭。内存会话与磁盘映射最多各保留 64 条，淘汰会话会关闭。
- 连接池会把同一对话粘在同一个 worker 上（换 worker 就丢了会话记录）；新对话优先使用未被占用的 worker，容量用尽才排队。
- `resumeSessions` 同时验证路由、输入前缀和上轮输出；恢复后核对/校正实际模型。恢复失败先回收连接，再完整重建，避免迟到回放混入新轮。
- 所有 worker 共用一个映射存储，串行提交且只修改本轮所属键。对话迁移到另一 worker 时保守新建会话，旧 worker 不能覆盖新游标。映射格式升级到 v2，旧格式自动失效并重建。
- 跨 Host 使用 `sessions.lock` 排他租约。另一 Host 已占用缓存时，本实例不读写恢复映射，只保留内存复用并记录警告；普通聊天不受影响。正常卸载 flush 后释放租约。若 Host 崩溃留下锁，不按时间猜测过期；确认使用此缓存的所有 Host 均已退出后，才可人工移除残留锁。

### 取消与进程保留

`session/cancel` 是通知，不代表官方 agent 的执行已经停止；因此默认仍在取消后回收进程（安全优先，代价是下一轮冷启动）。开启 `keepProcessAfterCancel` 后：

- 先给 `cancelGraceMs`（默认 30 秒，热启动约 10 秒）让 agent 回应 `cancelled`；确认了就只丢弃会话、保留进程（下一轮免冷启动）。
- 宽限内没有确认、本地超时或通信失败 → 照旧回收；本地 promise 结束不等于 agent 已停止。`cancelGraceMs=0` 表示立即回收。
- 新轮不能撤销旧回合的取消宽限；需等待确认或完成回收后才使用连接。
- 保留期间 `idleRecycleMs` 内没有新消息 → 回收，释放常驻内存。
- 保留进程不等于复用会话：被取消的会话一律作废，避免沿用可能仍在执行的 turn。

实测（2026-10-23，官方 1.4.0）：同一会话空闲 60s、120s 后仍能复述上一轮暗号，响应耗时稳定（约 3s）；`usage_update.used` 持续累计（3463 → 3628 → 3745）。官方会话空闲 TTL 未知；ACP 会话上下文、Gemini 显式缓存与模型前缀缓存不是同一个保证。默认 5 分钟仅是本插件在启动延迟与常驻资源之间选取的回收策略，可自行调整或设 0 禁用。

### 编排模式（planner → executor）

选择 `antigravity-orchestrator` 后，插件自己驱动两段式生成：planner 先产出一份计划（目标、步骤、每步验证方式、交回条件），executor 只执行不重新规划；命中交回条件（工具失败、同一工具连续失败两次、用户改向）时停下并重新规划。计划默认只注入 executor 的上下文，不占对话正文；打开「在对话中显示计划」后以文本块显示。

- **可配置组合**：planner 三选一（Gemini 4 Neon / Gemini 4 Argon / Claude Opus 5.5，默认 Opus 5.5），executor 两选一（Gemini 4 Hydrogen / Claude Sonnet 5.5，默认 Hydrogen，对齐官方 Antigravity 编排设置）。两个角色各带一个思考档位（默认都是 medium），选项随目标模型收敛：Opus / Sonnet 只有 low/medium/high，Hydrogen 另有 xhigh。
- **代理链路**：planner 与 executor 是两次独立上游请求，档位编码在 wire 模型 ID 后缀里。planner 不声明工具、不接收图片，其用量与 executor 合并成一个 `usage` 结算。
- **ACP 链路**：planner 在独立 ACP 会话里运行官方 `mode=plan`（不注册 MCP 桥，DSH 工具不会被 planner 调用），计划正文从 `agent_message_chunk` 采集；executor 回到 chat 会话切模型执行。切角色时必须显式带档位（写 `<family>-<effort>` 或分两步写 model 再写 thought_level），否则会继承上一个角色的档位。官方 `mode=plan` 只限制工作区写入，planner 仍会用内置工具执行只读命令、把计划写到官方 brain 目录，这些动作不经过 DSH 审批；planner 会话的 `cwd` 与会话工作目录一致，目录变化时重建。
- **预算与降级**：每个用户回合最多 `maxPlansPerTurn` 次规划（默认 2）。planner 超时、失败或计划解析失败不阻塞对话，直接降级为 executor 单模型执行。
- **目录条目**：`antigravity-orchestrator` 是插件合成的条目，只有 planner 与配置的 executor 都已在当前目录可见时才出现；关闭 `enabled` 后不出现，也不编排。

### 代理模式（默认关闭）

在「运行模式」中勾选并保存 `proxyMode` 后，宿主行立即撤下 `antigravity-acp`，第二组件 `antigravity-proxy-router` 就绪时注册 `antigravity-proxy`；关闭时恢复 ACP。代理组件未启用、卸载或注册失败时 ACP 仍保持停用，并在设置页解释原因。ACP 登录、预热、目录发现和二进制预读均不会运行。目录与额度按请求模式取数；未保存的开关只表示草稿。切换后需要在会话中选择新模式下的模型。

- **登录态**：代理账户独立于 ACP 登录。连接时优先只读导入 `~/.gemini/antigravity-cli/antigravity-oauth-token`，过期则先换发；失效登录态不会被报告为连接成功。没有可用登录态时返回 PKCE 授权链接，请点击完成浏览器登录（回调 `http://localhost:51121/oauth-callback`，只绑 127.0.0.1）。连接还会只读检测上游已有项目，未返回项目时显示具体原因，检测完成后才显示已连接。副本落在缓存目录 `proxy-account.json`（原子写、尽力 0600），官方文件保持只读。
- **无需安装 CLI**：点击「连接代理账户 → 打开 Google 授权页」，在运行 DSH 的同一台电脑上授权。插件自行处理回调、换码、项目检测及保存；账户需已有 Antigravity 使用权限。页面分别显示准备、等待授权和完成阶段，以及对应失败原因。
- **账户与退出**：代理模式一次只保存一个 Google 账号，重新 OAuth 登录会替换当前副本。收到浏览器回调后的 token 交换仍可取消。退出会使在途刷新失效，并等待已有保存结束后清除副本；本次插件生命周期内，自动取数保持退出状态，点击「连接代理账户」可重新连接。
- **出网代理**：OAuth、项目检测、模型目录、额度与生成使用同一解析规则：非空 `proxyUrl` 优先；留空依次读取 Host 的 `https_proxy` / `HTTPS_PROXY`、`all_proxy` / `ALL_PROXY`、`http_proxy` / `HTTP_PROXY`，都缺失才直连。`proxyBypass` 未配置时继承 `no_proxy` / `NO_PROXY`，始终合并 loopback；命中目标时直连。原生 TLS 不使用宿主全局 fetch dispatcher，因此仅启用其它插件的 fetch 代理不代表它已使用同一出口。
- **线形态**：请求头按 agy CLI 口径固定（`antigravity/cli/<version> (aidev_client; …)` User-Agent、`:streamGenerateContent` 走 chunked、其余 Content-Length），端点白名单包含生成、目录、只读项目检测、额度与 Google token 方法；调用方不能注入任意头或目的地。出网代理沿用 `proxyUrl` / `proxyBypass`，代理模式支持 HTTP(S) CONNECT，SOCKS 会明确报错。
- **模型目录**：`fetchAvailableModels` 当前账户可用项（30 秒 TTL）与插件支持的模型取交集；支持列表包含 core 审计快照、Gemini 4 Hydrogen 和 Gemini 4 Neon。上游停用项不显示；只列出已观测档位。Hydrogen 和 Neon 的 `xhigh` 可在对话选择器选用；可用时默认用 `medium`。已保存的默认档位失效时用当前目录的可用默认项；手动 `target` 映射优先，不提供档位菜单。登录、退出和手动刷新更新目录；失败只保留同账户已确认目录。用户手动隐藏的项仍保留在设置页。切回 ACP 后恢复 CLI / ACP 来源。
- **图片输入**：按当前账户目录的 `supportsImages` 字段判断，并需要宿主附件服务。同一家族只要有可用看图档位，就保留图片到请求派发；实际档位不支持时会提示切换。图片输出未接入代理模式。
- **响应限制**：代理生成流原始响应与解压后内容各限 64 MiB，单个 SSE 帧限 2 MiB。模型目录沿用插件已有的 8 MiB 普通响应预算，并最多解析 512 个条目。这些预算不随模型输出配置变化。
- **Claude 工具续聊**：中断工具批次后发新消息时，保留已有结果并标明其余结果未知。若尚未进入下一条消息且当前批次缺结果，会提示检查工具执行状态。
- **额度**：默认不调用 `agy`。代理模式优先用已保存的项目请求 `retrieveUserQuotaSummary`；`loadCodeAssist` 临时不可用时仍可查询该项目的额度，但该次不显示订阅档位。ACP 模式走内置 Cloud Code Assist 直连。只有打开 `cliQuotaEnabled` 后，套餐额度与 AI Credits 才运行官方 CLI 只读命令。模式切换、退出、重新连接和开关翻转均失效旧快照，在途旧结果不覆盖新状态。打开 CLI 取数后，AI Credits 属于官方 CLI 账户，可能与代理账户不同。
- **边界**：代理模式不 spawn 官方进程、没有 MCP 工具桥（工具仍由 DSH 自身执行面提供，与 ACP 模式相同）；429 不做多账户轮转，直接报 `RATE_LIMIT`；401/403 在未出块前换发一次重试一次——但 **403 且上游写明 `violation of Terms of Service` / `disabled in this account`** 时不再换发，直接报 `AGY_ACCOUNT_SUSPENDED` 并说明需要申诉（换发救不回被停用的账号）。
- **工具 schema 净化**：本地 `$ref` 展开；对象的 `oneOf` / `anyOf` 分支可补充字段，但不能覆盖主 Schema 的字段定义。节点有 `items` 优先识别为数组，有 `properties` 则识别为对象；数组补齐 `items`，字符串枚举忽略空串与纯空白。

设置页字段通过宿主的即时配置引用保存：模型显示开关、显示名与映射随保存更新选择器，会话与进程偏好在下一轮聊天、预热或目录发现时读取，不打断正在输出或等待工具的回合。自动预热开关在下次启用插件时读取。代理和 CLI 路径用于后续请求及新启动的官方进程；已有 ACP 进程保留原启动环境，切换其出口仍需重新加载插件。

并发、二进制（`binaryPath` / `autoDownload` / `acpVersion` / `extraArgs`）与各段超时（`requestTimeoutMs` / `handshakeTimeoutMs` / `authTimeoutMs` / `promptTimeoutMs` / `bridgeParkSettleMs` / `maxConcurrentSessions` / `queueTimeoutMs`）是**普通配置**：宿主只把即时（volatile）字段投影进设置文档，也会拒绝用 `mutate` 写这些路径。因此设置卡片不把它们做成输入框，只列出字段名作为指引；请在插件的普通配置编辑器里修改，保存后由宿主重载生效。

工具回合尚未结束时保存偏好，其有效续轮以及不兼容续轮触发的 ACP prompt 重建仍沿用原回合快照；新值可能延至后续空闲新轮生效，不通过保存设置中断当前工具执行。

需要代理时先保存再连接。非法代理不会让插件装载失败：装载期只记一条告警并继续加载，因此设置卡片仍可打开、修正并保存；真正用到代理的操作各自失败——启动 ACP 报 `AGY_INVALID_PROXY`，下载 / 换发 / 额度取数折叠成各自的可读错误。修正保存后下一次操作即读取新值，已有 ACP 进程保留原启动环境。不要把刷新网页当成 Host 已更新。

## 环境变量

环境指 **运行插件的 Host 实际继承的变量**，不是任意终端当前的变量。只检查存在性和继承情况，不在反馈或日志里贴出敏感值。

| 变量 | 用途 |
|---|---|
| `AGY_ACP_BIN` | 官方 ACP 可执行文件覆盖，优先级低于 `binaryPath`。 |
| `AGY_ACP_URL` | 自动下载 URL 覆盖，仍受 HTTPS / `dl.google.com` 与不重定向约束；不赋予其它域名下载权限。 |
| `AGY_ACP_HOME` | 官方程序与独立运行目录的用户级安装根目录覆盖；应避开 Windows Low 完整性目录。 |
| `AGY_CLI_BIN` | 官方 CLI 路径覆盖，低于显式 `agyCliPath`。 |
| `AGY_OAUTH_CLIENT_ID` / `AGY_OAUTH_CLIENT_SECRET` | OAuth client 元数据覆盖，配对使用；不是模型 API Key，也不是用户 access / refresh token。通常不需要手动设置，不应随文档或截图分享。 |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 与小写形式 | `proxyUrl` 未设置时的 Host 代理来源；实际选择与注入见 [`proxy-env.ts`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/src/runtime/proxy-env.ts)。 |
| `NO_PROXY` 与小写形式 | Host 代理绕过来源；本机 loopback 始终加入。 |
| `DSH_HOME` | 模型目录缓存所在宿主目录；**不是**默认官方程序与运行代码安装位置。 |
| `LOCALAPPDATA` / `USERPROFILE` / `XDG_CACHE_HOME` | 默认用户级安装位置的系统来源；不建议为本插件全局改写这些系统变量。 |

### 路径选择顺序

**ACP 程序：** `binaryPath` → `AGY_ACP_BIN` → 对应版本缓存 → 自动下载。手动覆盖先于自动平台映射，未知自动下载平台可使用明确指定的兼容程序。

自动下载的 zip 解压受三道上限约束：条目数 2000、单条目 1.5 GiB、解压总量 2 GiB。2026-11-22 实测官方包解压后：Windows 最大单条目约 156 MiB、macOS 约 269 MiB、Linux 主程序 `.par` 为 681–890 MiB（1.4.x 两条目合计最高约 1.06 GiB），正常下载不会触及；超过任一道即报 `AGY_ARCHIVE_TOO_LARGE` 并放弃本次安装，不留半成品。这是下载域名白名单之外的压缩炸弹纵深防御。

**CLI：** `agyCliPath` → `AGY_CLI_BIN` → PATH → 平台默认位置。显式覆盖与候选读取细节以 [`agy-cli.ts`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/src/runtime/agy-cli.ts) 为准；手动刷新会重新探测，不要求插件加载时 CLI 就已安装。

**代理：** 非空 `proxyUrl` 使用显式代理；留空按 Host 环境选择。清空字段不是“强制直连”，显式代理失败也不会静默直连。[代理行为与诊断](reference.md#出网代理)

## 设置页可以做什么

页面分为「连接 / 模型 / 额度 / 高级」。连接页只显示当前模式所需的账户与操作；额度独立手动查询；高级页按网络 / CLI、ACP 启动、连接池、超时、会话进程与诊断分组展开。模型页使用紧凑列表，支持搜索、启停筛选和筛选结果批量启用 / 隐藏；完整 ID、输入能力、显示名与官方映射在单条详情中编辑。代理模式不显示 ACP 专属控制项；代理排除列表不显示。

模型改动合并成一份 `modelOverrides` 在保存时提交；清空显示名或映射等于移除该字段，不会留下空壳配置。已经保存但当前目录没有的 ID 仍保留并标注「不在目录」，可搜索后继续修改或清除。官方公告即将下线的家族（见 `src/adapter/model-retirement.ts`）在设置页带「即将下线」徽章并默认关闭，打开开关后随 `modelOverrides` 保存显式启用；下线日期与迁移建议以官方模型菜单为准。

模型详情只读显示已知容量。代理模式读账户目录的 `maxTokens` 和 `maxOutputTokens`；同一家族有多个档位时，显示已知的共同上限，缺项时不从同族其他档位外推。ACP 的官方 `agy models` 列表只给 ID 和名称，容量等首次收到 `usage_update.size` 后显示。模型设置不会修改上游窗口；目录的输出上限不作为请求默认值。

无修改且无状态消息时不显示保存操作区；编辑后出现与其它面板同款的细常驻操作面板，提供保存、未保存计数、撤销与刷新，冲突和结果也在此显示。修改出网代理或排除列表后先保存，再连接；取消和退出不受草稿影响。

设置页打开时停在「连接」页。「额度」与对话药丸读取同一份本地快照，打开页面或切换标签不会请求 Google 或启动 CLI；点击「拉取额度」才即时请求上游。宿主启动、模式或代理账户变化、额度来源设置保存后，以及每 5 分钟独立刷新。快照按模式和账户校验，读取时超过刷新周期会标为陈旧；刷新失败保留同账户上次成功值。AI Credits 默认不查询且不显示占位区块，打开 CLI 取数后属于官方 CLI 账户，可能与代理账户不同。手动预热 / 目录刷新遇到暂时回收故障时会在本次操作内补试一次，持续失败仍拒绝复用旧进程。

不提供账户切换、删除目录条目或付费 Credits 开关：停用只是不列入选择器，已知模型的显示名、上下文容量与路由仍保留。思考强度由 DSH 会话菜单选择，不在此维护第二份独立档位配置。只读 Profile 禁止修改；外部刷新不会覆盖未保存草稿，保存失败保留输入。
