# 配置与环境变量

[返回主页](../README.md) · [使用与排障](reference.md) · [开发与验证](development.md)

以下对应 **0.1.30**，以 [`src/settings.ts`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/src/settings.ts) 的 Config 为准。字段均位于 `llm-antigravity-acp` 插件配置根级，不需要额外包装一层对象。设置页只展示常用项，其余可通过宿主提供的配置面编辑。

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
| `acpVersion` | `"1.4.0"` | 自动下载与缓存目标版本；不是 ACP wire protocol 版本。更换版本需重新验证厂商扩展与发行布局。 |
| `requestTimeoutMs` | `30000` | 普通 ACP 请求超时（毫秒），覆盖 stdin 写入与响应等待。 |
| `handshakeTimeoutMs` | `120000` | ACP `initialize` 握手上限（毫秒）。官方 PyInstaller 进程冷启动实测约 52 秒、热启动约 10 秒，旧默认 15 秒会使冷启动登录超时。 |
| `authTimeoutMs` | `300000` | 交互式 `authenticate` 等待上限（毫秒），独立于普通请求超时。 |
| `promptTimeoutMs` | `1800000` | 单个 `session/prompt` 上限（毫秒）；工具 park 不表示上游 prompt 已结束。 |
| `bridgeParkSettleMs` | `50` | 并发 MCP 工具调用聚合窗口（毫秒）；不是工具执行超时。 |
| `modelOverrides` | `{}` | 按模型 ID 的目录设置，键是 DSH 选择器里的模型 ID：`enabled`（默认 `true`）决定是否出现在选择器，`effort` 是该模型未选思考强度时的默认档位，`name` 覆盖显示名，`target` 把该 ID 映射到官方模型 ID。只作用于目录中已存在的条目，不新增自造模型。 |
| `proxyUrl` | 未设置 | 显式出网代理；留空继承 Host 代理环境，Host 也未配置才直连。支持 HTTP、HTTPS、SOCKS5、SOCKS5H。 |
| `proxyBypass` | 未设置 | 逗号分隔排除列表，支持域名匹配，不支持 CIDR；始终合并 localhost、127.0.0.1、::1。 |
| `reuseSessions` | `true` | 复用同一个 ACP 会话：同一 DSH 对话的后续回合只发送**新增消息**，不再每轮 `session/new` 并重放全部历史。历史被压缩、回退或编辑，模型/思考强度变化，工具目录变化，或 MCP 桥被其他对话接管时自动重建。关闭后回到旧的「每轮新会话 + 全量重放」。 |
| `resumeSessions` | `false` | 插件或 Host 重启后，尝试用 `session/load` 恢复上次的 ACP 会话。映射写在缓存目录的 `sessions.json`，只存会话 ID、cwd、已发送条数、输入/输出与路由 sha256 和时间戳，不存对话内容、system 提示或工具 schema。恢复失败或前缀不一致时自动回退为新轮重建。 |
| `keepProcessAfterCancel` | `false` | 用户按停止后是否保留官方进程。关闭时立即回收（下一轮冷启动）；开启后先等 `cancelGraceMs` 确认 agent 已停止，确认了就只丢弃会话、保留进程。 |
| `cancelGraceMs` | `30000` | 取消后等待 agent 确认停止的上限（毫秒）；`0` 表示不等待、立即回收进程。热启动约 10 秒，30 秒留出余量。 |
| `idleRecycleMs` | `300000` | 保留进程的最长空闲时间（毫秒），超时回收释放内存；`0` 表示不设上限。适用于聊天、预热及目录发现结束；等待工具和取消排空不算空闲。5 分钟是插件资源策略，不代表上游缓存寿命。 |

示例（不包含代理密码或账号材料）：

```json
{
  "maxConcurrentSessions": 2,
  "queueTimeoutMs": 120000,
  "autoWarmup": true,
  "autoDownload": true,
  "acpVersion": "1.4.0",
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

设置页字段通过宿主的即时配置引用保存：模型显示开关、显示名与映射随保存更新选择器，会话与进程偏好在下一轮聊天、预热或目录发现时读取，不打断正在输出或等待工具的回合。自动预热开关在下次启用插件时读取。代理和 CLI 路径用于后续请求及新启动的官方进程；已有 ACP 进程保留原启动环境，切换其出口仍需重新加载插件。并发、二进制等普通配置继续遵循宿主的重载流程。

工具回合尚未结束时保存偏好，其有效续轮以及不兼容续轮触发的 ACP prompt 重建仍沿用原回合快照；新值可能延至后续空闲新轮生效，不通过保存设置中断当前工具执行。

需要代理时先保存再连接。非法代理在初次装载或后续使用时抛 `ProxyConfigError`；即时保存后使用失败可直接回到设置页修正，初次装载失败则需要通过宿主通用配置面修复。不要把刷新网页当成 Host 已更新。

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

**CLI：** `agyCliPath` → `AGY_CLI_BIN` → PATH → 平台默认位置。显式覆盖与候选读取细节以 [`agy-cli.ts`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/src/runtime/agy-cli.ts) 为准；手动刷新会重新探测，不要求插件加载时 CLI 就已安装。

**代理：** 非空 `proxyUrl` 使用显式代理；留空按 Host 环境选择。清空字段不是“强制直连”，显式代理失败也不会静默直连。[代理行为与诊断](reference.md#出网代理)

## 设置页可以做什么

页面按连接、模型列表、常用偏好组织；网络 / CLI / 会话进程与生命周期诊断分别放入高级设置和连接诊断折叠区。可执行连接 / 取消、预热、目录刷新，逐模型设置显示开关、默认思考档位、显示名与官方 ID 映射，以及 CLI 路径、代理、会话复用 / 重启恢复 / 取消保留开关、取消宽限与空闲计时。并发上限可通过宿主配置面调整。

模型列表对目录中的每个模型各占一行，改动合并成一份 `modelOverrides` 在保存时提交；清空显示名或映射等于移除该字段，不会留下空壳配置。已经保存但当前目录没有的 ID 仍列在末尾并标注「不在当前目录」，可继续修改或清除。

套餐额度与 AI Credits 只在对话输入框旁的额度药丸及详情弹层展示；设置页不重复渲染，也不因此启动额度轮询。手动预热 / 目录刷新遇到暂时回收故障时会在本次操作内补试一次，持续失败仍拒绝复用旧进程。

不提供账户切换、删除目录条目或付费 Credits 开关：停用只是不列入选择器，已知模型的显示名、上下文容量与路由仍保留。思考强度由 DSH 会话菜单选择，不在此维护第二份独立档位配置。只读 Profile 禁止修改；外部刷新不会覆盖未保存草稿，保存失败保留输入。
