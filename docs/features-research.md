# Google 功能接入范围

[返回主页](../README.md) · [配置](configuration.md) · [开发与验证](development.md)

本包把使用 Antigravity 代理账户的附属功能，与使用独立账号或凭据的 Google 服务分开。它们共用安装包，按各自的方式启用。

| 功能 | 入口 | 身份与范围 |
|---|---|---|
| `agy_image_generate` | 代理模式 → 高级 → 附属功能 | 使用当前 Antigravity 代理账户生成图片；输出经 DSH 附件返回 |
| [AI Studio](reference.md#ai-studio-独立-provider) | 设置 → AI Studio | 使用独立的 Gemini API key 提供文本模型；显示此 Host 的用量与限流 |
| [Vertex AI](reference.md#ai-studiovertex-ai-与-colab) | 设置 → Vertex AI | 使用指定 Google Cloud 项目、区域和 ADC 提供文本模型 |
| [Google Colab](colab.md) | 插件 → Google Colab | 使用本机官方 Colab CLI 与 ADC，查询 Compute Units 或经审批执行 Notebook |

附属功能只有在当前模式兼容且所需宿主服务可用时注册。图像生成不新增模型选择器条目。视频、音乐和 NotebookLM 未接入。
