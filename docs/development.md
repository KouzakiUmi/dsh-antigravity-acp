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
| [`src/client.js`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/src/client.js) | 惰性 CommonJS 客户端、设置卡片与额度药丸；无 Node 原生导入 |
| [`src/settings.ts`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/src/settings.ts) | 完整 Config 与默认值 |
| [`cordis.patch.yml`](../cordis.patch.yml) | 仅插入本插件，不抢占默认模型 |
| [`tests/`](https://github.com/KouzakiUmi/dsh-antigravity-acp/tree/main/tests/) | 假 ACP / MCP、隔离 runtime、真实 React renderer 与回归测试 |

npm 包名为 `dsh-bundle-antigravity-host`，provider ID 为 `antigravity-acp`，内部插件名为 `llm-antigravity-acp`，三者不混用。工具执行权仍在 DSH；ACP `tool_call` 通知不是本机执行指令。

## 依赖与契约基准

以 [`package.json`](../package.json) 与 [`package-lock.json`](https://github.com/KouzakiUmi/dsh-antigravity-acp/blob/main/package-lock.json) 为准：

| 依赖 / 协议 | 当前基准 | 核验边界 |
|---|---|---|
| DSH `dsh-llm` / `dsh-subprocess` / `dsh-typert-protocol` | 开发依赖 `0.2.1-alpha.4` | 本地类型、调用链与测试；不是全部 peer 范围实机认证 |
| 可选 `dsh-attachment` | 开发依赖 `0.2.1-alpha.4` | Host 服务在场时读取图片，缺少时文本降级 |
| Cordis | 开发依赖 `4.0.5-alpha.2` | 生命周期与注入契约 |
| ACP SDK / wire protocol | SDK `1.4.0` / wire **v1** | 两者不是同一版本；v2 / RFD 草案不能替代 v1 |
| 默认官方 ACP server | `1.4.0` | 与 SDK 分别设置；厂商 `_meta.antigravity` 扩展不自动适用于任意上游版本 |
| MCP SDK | `1.32.1` | loopback 工具桥与结果内容 |
| undici | `8.11.2` | 本包直接依赖，HTTP / SOCKS 代理；SOCKS5 可能输出实验性 API 警告 |
| React / test renderer | `18.3.1` | Client 使用宿主 React；renderer 是测试开发依赖，不是生产私带的 UI 运行时 |

三个 `dsh-*` peer 当前均声明 `>=0.2.0-rc.1 <0.2.1-0 || >=0.2.1-0 <0.3.0-0`，Cordis peer 为 `~4.0.4 || 4.0.5-alpha.1 || 4.0.5-alpha.2`。宽范围只表达安装条件，不能推导全部版本通过运行验证。CLI、Desktop 壳与实际 Core 的版本应分别核对。

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

## 本次验证矩阵

0.1.29 本地检查日期：**2026-10-26**。

| 验证项 | 状态与范围 |
|---|---|
| TypeScript | `npm run typecheck` 通过 |
| 隔离回归 | `npm test`：37 个文件 / 625 项通过 |
| 构建 | `npm run build` 通过 |
| 工具 / runtime | 假 ACP / MCP、乱序工具结果、池所有权、续轮变更、取消、写入阻塞和回收 |
| 图片 | 附件引用校验、图片内容映射与跨 worker 能力；未调用真实视觉模型 |
| 设置交互 | React 18 renderer 覆盖 10 个即时字段的编辑、保存回读、草稿、冲突、只读与 namespace 恢复；不替代真实宿主设置服务或 GUI 验收 |
| 代理 | 合成依赖、动态变更与清空、不打断旧响应、卸载释放、失败不直连、本地 SOCKS 测试；不是 Google 网络可达性保证 |
| 真实上游 / GUI | 本次未验收 0.1.29 安装后的 GUI、真实生成或图片识别 |
| 非 Windows | 有平台映射与契约测试，未实机验收 |
| 生产依赖漏洞 | `check` 不包含漏洞审计；没有单独成功审计证据就不声明通过 |

历史 CLI 真实账号记录见[额度来源](reference.md#登录态与额度来源)。那些记录不是本次重新执行，也不能代替当前 npm 包安装后的验收。

### 离线界面预览

```console
node scripts/preview-ui.mjs
```

输出 `.local-preview/quota-ui.html`，使用当前真实 Client 组件和**模拟数据 / hooks**生成静态 HTML，不联网、不登录、不访问 DSH 页面。按钮不会执行真实操作。这是开发预览，不是当前 DSH 截图，也不是真实宿主 React 行为验收；真实状态交互另由 `tests/client-interaction.test.ts` 的 React 18 renderer 覆盖。

### 本次改动的补充验证

2026-10-26 的设置修复工作副本通过类型检查、**37 个文件 / 625 项测试**与构建。即时字段与卡片字段一致，使用实际 volatile 引用提交验证后端读取新值；真实 React renderer 覆盖全部控件编辑、保存回读及 namespace 缺失后的恢复。另覆盖普通输出期间修改偏好不影响当前轮、后续新轮读取新值，以及代理切换、清空与统一释放。

上述设置测试没有实例化完整 DSH settings / Loader 服务，不能当作真实宿主端到端验收；动态会话粘性切换、工具等待期间保存偏好也未新增直接回归。当前工具回合中的不兼容续轮重建仍沿用该回合快照，偏好更新可能延至后续空闲新轮。真实 Desktop GUI、官方账号与非 Windows 实机仍未重新验收。

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
