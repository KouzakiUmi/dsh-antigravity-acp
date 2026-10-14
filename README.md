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
`promptTimeoutMs`、`bridgeParkSettleMs`。
环境变量：`AGY_ACP_BIN`（二进制覆盖）、`AGY_ACP_URL`（下载 URL 覆盖，
供未验证平台组合使用）。

本 README 仅描述代码现状，不构成任何安装或兼容性承诺。
