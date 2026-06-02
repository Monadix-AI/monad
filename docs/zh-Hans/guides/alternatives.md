---
title: "Monad 与其他 Agent 工具的对比"
sidebarTitle: "对比"
description: "Monad 是 Monadix 推出的开源 Agent 团队运行时。本文对比 Monad 与 OpenClaw、LangGraph、CrewAI、AutoGen、Claude Code、Codex、AgentTeams、桌面 Agent 管理器、Agent 服务化平台以及企业 Agent 平台的区别。"
keywords: ["Monad 对比", "Monad vs LangGraph", "Monad vs Claude Code", "Agent 运行时对比", "Agent 框架选型", "多 Agent 运行时", "开源 Agent 团队运行时"]
---
Monad 是 Monadix 推出的开源 Agent 团队运行时：一个长期运行的本地 daemon，持有 Agent 的身份、能力、权限、任务、审批、产物和审计历史。本页提到的其他工具都属于另一类工具。它们大多在各自的位置上做得很好，其中不少可以和 Monad 组合，而不是替代关系。

有一条区分贯穿全文：

> 有些工具编排住在别处的 Agent。Monad 是 Agent 住的地方。

一个编排外部 Agent 进程（厂商 CLI Agent、其他运行时、托管服务）的工具是**控制面**。**运行时**是它下面那一层：赋予 Agent 身份、执行其权限、运行其工具、让工作持久。Monad 是运行时，同时也能通过 Agent Client Protocol（ACP）双向承载和委派外部 Agent，所以两种角色是组合关系。

本页的定位论证见 [Why Monad](/guides/comparison)（英文），术语见[核心概念](/zh-Hans/concepts)。

## Monad 与 OpenClaw

**一句话。** OpenClaw 是面向单个常驻 Agent 的个人网关；Monad 是为一支 Agent 团队持有身份、审批、沙箱和审计的运行时。

**OpenClaw 的长处。** 它让常驻本地 Agent 真正走进了一个庞大的社区：一个个人 Agent，从你的消息软件就能触达，跑在你自己的机器上。渠道生态和社区都很强。

**边界在哪。** 治理——逐操作审批门、操作系统级沙箱、出站控制、审计历史——不是它的重心，多 Agent 身份与共享任务状态也不是它的模型。

**什么时候需要运行时。** 你已经认同本地常驻 Agent，现在还想让每个操作受策略约束、每个 Agent 有自己的身份和权限，并且工作能活过单个对话循环。

**如何共存。** OpenClaw 确立的前提——你的 Agent，你的机器——正是 Monad 的前提。Monad 在其上补齐审批、沙箱、审计和团队。

## Monad 与编排框架（LangGraph、CrewAI、AutoGen、各家 Agent SDK）

**一句话。** 编排框架是运行在你进程内、用来表达 Agent 逻辑的库；Monad 是比你的脚本活得更久、并管住 Agent 能做什么的进程。

**它们的长处。** 用代码表达 Agent 逻辑：图、小队、交接、结构化工作流。如果你在构建一个 Agent 应用，框架往往是正确的编写工具。

**边界在哪。** 库不会比你的脚本活得更久，不持有凭据，不会把工具调用挡在人工审批之后，也不会给不同 Agent 不同的操作系统级权限。持久状态和可观测性通常来自外接的云平台。

**什么时候需要运行时。** 当 Agent 不再是你运行的代码，而变成你运维的工人：长期存在、可中断、可恢复、可审计、受治理。

**如何共存。** 框架构建的 Agent 可以通过 ACP 加入 Monad 团队，保留内部逻辑的同时获得运行时级别的身份、审批和持久化。

## Monad 与服务商原生 Agent（Claude Code、Codex、Gemini CLI）

**一句话。** 服务商原生 Agent 是绑定在自家厂商上的单个强力工人；Monad 是提供方中立的运行时，把这些工人变成一支共享任务、共用一套审批策略、共用一条审计链的团队。

**它们的长处。** 作为单个 Agent 能力很强，由模型厂商深度调校。多数时候，其中之一就是你能雇到的最好的个体工人。

**边界在哪。** 每一个都绑定自家厂商，每个会话基本属于它自己的窗口和厂商的云。三个并排跑，你得到三个优秀工人，但没有团队：没有共享任务，没有共享产物，没有统一审批策略，没有统一审计链。

**什么时候需要运行时。** 当你开始挨个切换 Agent 窗口，去确认每一个都对你的文件系统改了什么。

**如何共存。** 服务商原生 Agent 可以通过第三方 Agent 适配器成为 Monad 团队成员。Monad 编排模型提供方和外部 Agent，不与它们竞争。参见[使用第三方 Agent](/zh-Hans/usage/mesh-agents)。

## Monad 与 AgentTeams（agentscope-ai）

**一句话。** AgentTeams 通过一套需要部署的平台，协调住在其他运行时里的工人；Monad 让 Agent 本身住在一个本地 daemon 里。

**它的长处。** 有人在环的多 Agent 协调：Manager–Workers 模型，你、管理 Agent 和工人 Agent 共享 Matrix 房间，活动在聊天里可见。背后有扎实的工程投入和真实社区。

**边界在哪。** 工人是住在别处的 Agent，通过你要部署的基础设施来协调——Kubernetes 控制器、管凭据的 AI 网关、Matrix 服务器、对象存储。治理发生在平台层，而不是每台机器的操作系统层。

**什么时候需要运行时。** 当你想今天就把团队跑在自己的机器上——一个自包含二进制、一个只绑定回环的 daemon、不要集群——并且希望身份、权限、沙箱、记忆和任务住在运行时**内部**，而不是从外部被调度。

**如何共存。** 两者回答的是不同问题。控制面需要有运行时可控，而托管在 Monad 里的 Agent 恰好暴露了上层协调层需要的那些抓手：身份、策略、可审计的操作。

## Monad 与桌面 Agent 管理器

**一句话。** 桌面 Agent 管理器是一个监督外部 CLI Agent 的应用；Monad 是持有它们的 daemon，图形界面只是一个可替换的客户端。

**它们的长处。** 通过看板、逐操作审批、代码评审界面和多提供方支持，愉快地同时监督多个外部 Agent。

**边界在哪。** 应用本身就是那份体验：关掉它，运维视图也随之消失。隔离通常是 worktree 级而非操作系统沙箱级，Agent 状态仍分散在各个 CLI 工具自己的存储里。

**什么时候需要运行时。** 当持有你 Agent 的那一层应该是一个有明确安全模型的持久 daemon，而图形界面只是 Web、CLI、TUI、编辑器和消息渠道之中的一个客户端。

## Monad 与 Agent 服务化平台

**一句话。** 服务化平台把 Agent 应用部署成面向你客户的生产服务；Monad 是在你自己的机器上，为你运维一支 Agent 团队。

**它们的长处。** 把 Agent 应用部署成服务：沙箱化工具执行、流式 API、可观测性、Kubernetes 与 serverless 伸缩。

**边界在哪。** 这是给构建者把 Agent 应用发到云上的服务端基础设施。它们假定 Agent 逻辑由外部框架提供，部署由平台团队运维。

**什么时候需要运行时。** 当 Agent 的使用者和运维者是同一个人或同一支团队，而机器是你自己的。

## Monad 与企业 Agent 平台（Agentforce、Copilot Studio）

**一句话。** 企业 Agent 平台给你一支**租来的**受治理 Agent 团队；Monad 给你一支**自己拥有的**，审批、沙箱和审计都在你自己的机器上。

**它们的长处。** 在既有企业套件内开箱即用的 Agent，合规由厂商托管。

**边界在哪。** Agent、它们的记忆和审计链住在另一家公司的云上，挂在那家公司的套件里，按对方的条款。

**什么时候需要运行时。** 当"受治理"不能等于"交出去"。Monad 把审批、沙箱和审计留在你的机器上，按你的策略执行，不发送遥测。

## 对比表

| | Agent 住在里面 | 本机一个 daemon | 操作系统沙箱、审批门、审计 | 多 Agent 团队 | 提供方中立 | 客户端可替换 |
|---|---|---|---|---|---|---|
| **Monad** | 是 | 是 | 是 | 是 | 是 | Web、CLI、TUI、编辑器、消息渠道 |
| OpenClaw | 是，单个 Agent | 是 | 部分 | 否 | 是 | 部分 |
| LangGraph、CrewAI、AutoGen | 在你的代码里 | 否，是库 | 否 | 进程内 | 是 | 否 |
| Claude Code、Codex | 是，在厂商那边 | 部分 | 部分 | 否 | 否 | 否 |
| AgentTeams | 否，协调外部 Agent | 否，平台栈 | 网关层 | 是 | 部分 | 以 Matrix 为主 |
| 桌面 Agent 管理器 | 否，包装 CLI Agent | 否，桌面应用 | worktree 层 | 是 | 是 | 否 |
| Agent 服务化平台 | 部分，托管应用 | 否，Kubernetes 或 serverless | 容器层 | 部分 | 是 | 以 API 为主 |
| Agentforce、Copilot Studio | 是，在厂商云上 | 否 | 厂商托管 | 是 | 否 | 否 |

表中判断依据各项目 2026 年 8 月的公开文档。欢迎指正——[提交 issue](https://github.com/Monadix-AI/monad/issues)。

## 相关内容

- [常见问题](/zh-Hans/guides/faq)
- [核心概念](/zh-Hans/concepts)
- [Monad 是什么](/zh-Hans/product)
- [Why Monad](/guides/comparison)（英文，产品边界与运行时持有的东西）
