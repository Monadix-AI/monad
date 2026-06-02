---
title: "常见问题"
sidebarTitle: "常见问题"
description: "关于 Monad 的常见问题解答。Monad 是 Monadix 推出的开源 daemon 优先 Agent 团队运行时：它是什么、运行在哪些系统上、哪些数据会离开本机、哪些 Agent 运行时可以加入团队。"
keywords: ["Monad 是什么", "Agent 团队运行时", "daemon 优先", "本地 AI Agent", "Monad 常见问题", "多 Agent 运行时", "Monadix"]
---
下面是关于 Monad 最常被问到的问题。每条答案都可独立阅读，需要展开时再点链接。

## Monad 是什么？

Monad 是 Monadix 推出的开源 Agent 团队运行时。一个长期运行的本地 daemon 持有 Agent 的身份、能力、权限、记忆、会话、协作状态、审批与审计历史，并在客户端关闭、daemon 重启、以及更换某个成员背后的运行时之后继续保有这些状态。它以单个二进制安装，在你已经在用的机器上作为一个进程运行。参见[核心概念](/zh-Hans/concepts)。

## daemon 优先是什么意思？

daemon 优先意味着持久状态存放在后台进程里，而不是某个应用窗口里。Web 界面、命令行界面（CLI）、终端界面（TUI）、编辑器桥接、应用程序接口（API）和消息渠道都是客户端：它们渲染并控制这份状态，但都不拥有它，关掉其中任何一个都不会终止工作。

## Monad 和 LangGraph、CrewAI 这类 Agent 框架有什么区别？

框架是运行在你进程内的库，用来表达 Agent 逻辑。Monad 是一个比你的脚本活得更久的进程：它持有凭据、把工具调用挡在人工审批之后、用操作系统级沙箱约束子进程，并保留审计记录。框架构建的 Agent 可以通过 Agent Client Protocol 加入 Monad 团队。完整对比见[与其他 Agent 工具的对比](/zh-Hans/guides/alternatives)。

## Claude Code、Codex、Gemini CLI 能加入 Monad 团队吗？

可以。一个团队成员可以由第三方 Agent 提供方（如 Codex、Claude Code、Gemini CLI、Qwen Code）、通过 Agent Client Protocol 接入的 Agent、你自己拥有的对等 daemon，或 Monad 自带的第一方运行时 Monad Agent Runtime 来承载。由第三方运行时承载的成员保留该运行时自身的执行与权限模型；Monad 记录其活动，并在提供方暴露审批提示时代理这些提示。参见[使用第三方 Agent](/zh-Hans/usage/mesh-agents)。

## Monad 会把我的代码或数据传到云端吗？

Monad 不发送任何遥测、分析、崩溃报告或使用统计，状态存放在你自己的机器上。发往你所配置的模型提供方的请求仍然会离开本机，因为推理发生在那里。具体存了什么、什么会经过网络，参见[隐私](/zh-Hans/usage/privacy)。

## Monad 支持哪些操作系统？

macOS、Linux 和 Windows。daemon、CLI 和 Web 界面都面向这三个平台，持续集成会在每个平台上跑完整测试套件。参见[安装](/zh-Hans/usage/installation)。

## 需要 Kubernetes、消息队列或数据库服务器吗？

不需要。Monad 是运行时，不是需要部署的平台。它是你自己机器上的一个二进制、一个进程，不需要集群、消息服务器、网关或对象存储。

## Monad 是免费和开源的吗？

是。Monad 由 Monadix Labs, Inc. 以 MIT 许可证发布，源码在 [github.com/Monadix-AI/monad](https://github.com/Monadix-AI/monad)。

## Monad 如何防止 Agent 损坏我的机器？

在 Monad Agent Runtime 下，工具调用要经过审批门，子进程受操作系统级沙箱约束（macOS 用 Seatbelt，Linux 用 Landlock 与 seccomp 或 bwrap，Windows 用 AppContainer），网络出站被过滤，每一个决定都会被记录。完整说明见[沙箱后端](/usage/sandbox-backends)与[运行时安全模型](/internals/infra/runtime#security-model)（英文）。

## Monad 支持哪些模型提供方？

Monad 内置 24 种提供方类型。其中 8 种使用专用 SDK——Anthropic、OpenAI、OpenRouter、Vercel AI Gateway、Google Gemini、Mistral、Amazon Bedrock、Azure OpenAI；另外 16 种是基于内置 OpenAI 兼容适配器的预设，覆盖 Groq、xAI、DeepSeek、Together、Fireworks、Cerebras、Perplexity、Moonshot、Z.AI、MiniMax、NVIDIA、Novita、Ollama、Hugging Face、Cloudflare AI Gateway 以及任意其他 OpenAI 兼容端点。自定义提供方通过 Atom Pack 添加，无需改动 daemon。参见[模型提供方](/zh-Hans/usage/model-providers)。

## Monad 能连接 Model Context Protocol 服务器吗？

可以。MCP 服务器是 Monad Agent 获得能力的方式之一，此外还有技能、Atom Pack、钩子、渠道和 Agent 适配器。参见 [MCP](/zh-Hans/usage/mcp)。

## 可以从手机或聊天软件访问我的 Agent 吗？

可以。Monad 提供 17 个渠道适配器——包括 Telegram、Discord、Slack、WhatsApp、Signal、IRC、Microsoft Teams、Google Chat、飞书、企业微信、LINE、iMessage、邮件以及通用 webhook——一个会话可以从聊天里发起，再在浏览器、CLI 或终端界面中继续。参见[渠道](/zh-Hans/usage/channels)。

## 可以从另一台机器访问 daemon 吗？

只有你显式开启时才可以。Monad 默认只绑定本机接口。远程访问是显式选项，每个非回环请求都需要 bearer token，并且应当置于 TLS 之后——反向代理、SSH 隧道或 VPN。

## Monad 可以用于生产环境了吗？

Agent 团队运行时 Monad Mesh 处于 alpha：团队归属、会话绑定、策略、观察和协作状态可用。Monad Agent Runtime 仍是实验阶段——核心可用，但 Web 体验和细节功能仍在完善，接口可能在版本之间变化。

## 这个 Monad 和 Monad 区块链、函数式编程里的 monad 有关系吗？

没有关系。这里的 Monad 是 Monadix Labs, Inc. 以 MIT 许可证发布的 Agent 团队运行时，与 Monad 一层区块链、以及范畴论和函数式编程中的 monad 无关。

## Monadix 是什么？

Monadix Labs, Inc. 发布 Monad，并运营跨所有者 Agent 协作网络 Monadix。Monad 内的对等联邦用于在同一所有者的多个 daemon 之间委派工作；涉及不同所有者、需要独立信任与计费的协作属于 Monadix。

## 相关内容

- [快速开始](/zh-Hans/getting-started)
- [核心概念](/zh-Hans/concepts)
- [与其他 Agent 工具的对比](/zh-Hans/guides/alternatives)
- [故障排查](/zh-Hans/usage/troubleshooting)
