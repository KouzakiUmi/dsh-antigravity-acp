# 更新记录

[返回主页](../README.md) · [使用参考](reference.md) · [配置](configuration.md) · [开发与验证](development.md)

记录源码与发布内容，不将本地构建、npm 发布和本机升级混为同一状态。日期采用 Asia/Hong_Kong。更早历史见 [Git 提交记录](https://github.com/KouzakiUmi/dsh-antigravity-acp/commits/main/)。

## 0.1.24 · 2026-10-22

### 日常使用

- **有界并发池**：默认最多 2 个按需启动的独立 worker，可设 1–4；同会话工具结果回原 worker。等待队列最多 64 项，默认 120 秒，支持取消；主对话优先于排队中的后台标题。
- **先登录再取模型**：「连接 / 登录 ACP」建立不发送 prompt 的发现会话，验证连接并读取目录。无 CLI 时也可从已有 ACP 登录态刷新；目录、上下文容量与图片能力跨 worker 同步。
- **原生图片输入**：通过宿主附件服务发送当前 / 历史消息与工具结果中的图片，协商上游能力，校验引用、媒体类型与字节数。支持 PNG、JPEG、WebP、GIF；已卸载图片明确说明没有像素。
- **可观测连接**：区分预热、登录、建会话、生成、等待工具与停止；设置页显示队列与分阶段耗时，药丸可直接预热。
- **更可靠的设置草稿**：远端更新保留 dirty 字段，仅提交修改项，显示冲突，遵守只读状态并防重复保存。

### 工具与可靠性

- 续轮检查模型、思考强度、system、工具 schema、完整历史与上轮输出；不兼容时取消旧 prompt 并按新历史重建。
- MCP 参数按 schema 修正常见无歧义别名；缺必填字段返回 `AGY_BRIDGE_INVALID_ARGUMENTS` 与签名，不进入 DSH。类型与取值仍由 DSH 最终校验。
- stdin 写入与响应等待共享 deadline / abort；阻塞写入、缺管道、构造失败与握手失败进入统一回收路径。
- 验证 ACP v1 版本与所需 MCP / image 能力；未声明能力不当作支持。
- 取消与失败撤销桥授权；通过宿主受管进程终止并等待退出，不能确认退出时不允许新进程覆盖跟踪状态。

### 运行与网络加固

- 下载流写临时文件，限制来源与重定向，校验 ZIP 路径与布局；保留手动二进制优先级。
- 补齐 macOS / ARM64 / POSIX `.par` 与 Linux 参数的官方发行布局映射；默认 server 仍为 **1.4.0**，不自动追最新。
- onefile 运行代码迁至用户级独立 `runtime/instance-*`，记录所有权，只清理确认已退出的本插件目录；未知历史目录不按 mtime 删除。
- 直接声明 `undici` 依赖，统一下载、OAuth 与 HTTP 额度代理；显式代理失败不静默直连，关闭插件持有的连接池。
- 补齐结构化 token、无 scheme 代理材料和错误日志的脱敏；CLI 路径支持显式配置、PATH 与重新探测。

### 文档

- 主页采用快速开始、功能亮点、能力边界与验证矩阵分层，详细契约移至 `docs/`。
- 补齐完整配置、环境变量、安装 / 更新区别、登录材料读写范围、排障与维护发布流程。
- 明确 npm 发布不代表本机安装；不提供不存在的 GitHub Release 下载入口，不把示意或隔离测试当成真实 GUI 证据。

### 验证与剩余限制

本次本地 `npm run check` 通过：**33 个测试文件、515 项测试、TypeScript 类型检查与构建**。覆盖假 ACP / MCP、真实 React 18 renderer 交互、池与续轮、图片映射、阻塞写入、安全回收和本地 SOCKS 代理测试。React renderer 不是浏览器像素验收；假上游不证明真实 Google 服务兼容。

已知维护缺口：非法代理当前在插件装载期抛 `ProxyConfigError`，可能需要通过宿主通用配置面修复；宿主崩溃、没有明确子进程退出记录的运行目录不会自动回收；已有解压目录损坏且缺少有效可执行文件时不保证自动自愈。这些限制见[排障](reference.md#排障)。

尚未完成 **0.1.24 安装后的 Desktop GUI、真实上游生成、真实图片识别、非 Windows 实机验证**。未在本次执行真实登录 / 额度 / Credits 调用，未将历史记录升级为当前版验收。生产依赖漏洞审计不由上述检查覆盖。

普通新用户回合仍创建 ACP session 并重放完整历史；不提供跨进程会话恢复，不承诺 API 式角色层级、采样控制或延迟。`maxTokens` 仍忽略，`temperature` / `stop` 仍拒绝。ACP 原生工具保护仍是协议与生命周期约束，**不是 OS 沙箱**。

### 升级注意

- 更新后按部署方式重载 Host 与 Client；Desktop 按目标版本要求退出 / 重开。只刷新页面不足以升级后台。
- 默认双 worker 比单进程可能占用更多内存；资源受限时设置 `maxConcurrentSessions: 1`。池容量不提升上游账号额度。
- 无目录时先连接 / 登录，不再依赖“首次对话登录”占位项；旧 `server-default` 路由保留兼容。
- CLI 额度与 ACP 连接认证分别检查；ACP 登录不替 CLI 登录。已有缓存不代表上游持续可用。
- 不为迁移批量删除旧 `_MEI*` 或修改 ACL；先确认所属进程已停，再人工处理未知历史目录。

## 0.1.23 · 2026-10-22

- 版本由 [`1d81265`](https://github.com/KouzakiUmi/dsh-antigravity-acp/commit/1d81265) 发布准备提交确定。
- 前置 [`d4c6e91`](https://github.com/KouzakiUmi/dsh-antigravity-acp/commit/d4c6e91) 补充 npm provenance 所需仓库声明，前置 [`8b81df5`](https://github.com/KouzakiUmi/dsh-antigravity-acp/commit/8b81df5) 修复跨平台发布 CI。
- 保留既有 GitHub Actions 手动发布到 npm 的流程；后续功能加固归入 0.1.24，不追溯写入旧 npm 版本。
