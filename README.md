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
供未验证平台组合使用）。

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
  id/name/description，不含任何凭据），重启后用它兜住选择器；ACP server 版本变化
  或文件损坏即失效，回落为占位项。

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

## 安装参考

通用 CLI 示例（`web` 只是文档用的 profile 名，不是本机 Desktop）：

```sh
dsh plugin --profile web add ./dsh-bundle-antigravity-host-0.1.0.tgz
```

本机 Desktop 壳独占 `desktop` profile，公共 `dsh` 不能对它执行 `plugin add`。
请在 DSH NEXT 的插件管理器里添加本地包，路径示例：

`D:\dsh-antigravity-acp\.local-install\dsh-bundle-antigravity-host-0.1.0.tgz`

装好后需要完全退出并重开 Desktop。首次对话可能由官方 `agy_acp_server` 打开浏览器做 `oauth-personal`。模型路由名为 `antigravity-acp`。

本 README 仅描述代码与产物现状，不构成已安装或兼容性承诺。
