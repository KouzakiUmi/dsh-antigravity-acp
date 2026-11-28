# Google Colab 工具

[返回主页](../README.md) · [配置清单](configuration.md#colab-工具组件) · [开发与验证](development.md)

`antigravity-colab` 是 `dsh-bundle-antigravity-host` 内的 Host 工具组件，默认关闭。它不注册模型，也不依赖 ACP / 代理模式或其他模型 provider。

## 配置与启用

1. [安装同一个 `dsh-bundle-antigravity-host` 包](reference.md#安装与更新)。在运行 DSH Host 的环境中准备已安装的 [Google Colab CLI 0.8.0](https://github.com/googlecolab/google-colab-cli/tree/v0.8.0) 和该 CLI 可用的 Google Application Default Credentials（ADC）。官方 CLI 0.8.0 的 README 列出 Linux 与 macOS；CLI 和 Host 需要使用同一个本地文件系统及进程环境。
2. 在 DSH「插件」页找到 `antigravity-colab`，在**该组件行**的普通配置编辑器中填写 `executable` 和 `session`，再启用组件。需要暂停工具时，在同一条目关闭即可；无需切换模型。`executable` 是已安装 CLI 的绝对路径，不是 shell 命令或 WSL 启动器。
3. `session` 若非空，填写一个已存在的 CLI 会话的确切名称：1–64 个 ASCII 字母、数字、下划线或连字符，首字符须是字母或数字。留空时可查询余额，但不能执行。会话和 ADC 都在插件之外准备。

该组件的普通配置示例：

```yaml
executable: /absolute/path/to/colab
session: notebook-lab
```

两项工具都使用 CLI 的非交互 `--auth=adc` 模式和默认状态路径。组件不会自动登录、分配 VM、切换会话、挂载 Drive、使用 SSH 或安装软件。CLI 可刷新现有凭据及运行时代理令牌、更新本机会话状态，并在现有 VM 中连接或启动内核。若不需要 CLI 自身的每日更新检查，可在 CLI 的 `~/.config/colab-cli/settings.json` 中设置 `enable_update_check: false`；组件不修改该设置。

## 查询 Compute Units

`colab_usage` 无参数。返回 `balanceCu`（余额）、`rateCuPerHour`（小时用量）与 `activeAssignments`（活动分配数）。缺失、无法解析或含义不明的字段为 `null`，已报告的数值零保持为零。

## 执行 Python 或 Notebook

`colab_execute` 的两种参数只能选一种：

- `code`：最多 32 KiB 的 Python 源码，经标准输入发送。
- `notebook`：从当前 DSH 会话工作区根目录起算的相对路径，指向不超过 2 MiB 的 v4 `.ipynb`。不接受绝对路径、上级路径、符号链接、junction 或硬链接。

每次执行均须通过一次性 DSH 审批。审批提示包括配置的会话名、Compute Units 消耗及 CLI 历史记录；审批渠道不可用、会话策略禁用审批、拒绝或取消时不调用 CLI。DSH 会记录工具调用和结果，Colab CLI 会记录已执行代码、输出和相关元数据。提交前移除密钥等敏感数据。代码运行在已有内核的状态中，可能改变该运行时。

Notebook 执行需要 DSH 附件服务。组件在私有临时目录中执行清除旧单元格输出的副本，原文件不会被覆盖。执行后的 Notebook 和 CLI 最后保存的 PNG/JPEG 图（如有）由支持流式写入的 DSH 附件后端返回，每件最多 8 MiB。`artifactIssue: true` 表示应有产物缺失、无效或保存失败；它与远端执行状态分开。Python 文本结果返回 stdout 尾部，截断时不返回不完整的首行。`completed` 表示观察到正常完成，`python-error` 表示观察到 Python 异常，`unverified` 表示没有观察到完成标记或有效的 Notebook 产物。CLI 退出码为零时，仍可能有 Python 异常。

组件同一时间只处理一项工具调用。本地 CLI 版本检查、用量查询和执行的时限分别是 8、15 和 120 秒；执行另有 90 秒的内核无响应时限。取消或超时会终止本地 CLI，远端代码可能仍在运行。确认本地进程退出后清理临时文件；无法确认时保留临时目录，重新启用前先检查本地 CLI 是否退出。产物和文本限制适用于 DSH 接收的数据，CLI 自身在结束前仍可能累计内核输出。
