---
title: "会话、Agent 与审批"
sidebarTitle: "会话与审批"
description: "创建、继续、分支、恢复和观察持久会话，并管理 Agent 与审批。"
keywords: ["Monad 会话", "Agent 审批", "会话分支", "会话恢复", "OperationSource"]
---
Monad 会话是一条持久的工作线程：它的消息、事件、审批和执行状态都存放在守护进程里，能在客户端关闭和守护进程重启之后继续存在。项目则把会话、成员和工作区根目录聚合成更长期的工作。

本指南说明如何日常使用 Monad 的核心对象：创建和继续会话、分支与恢复、回答审批请求，以及选择处理对话的 Agent。简要定义见[产品概念](/zh-Hans/concepts)。

## 什么是会话

会话是你与 Agent 之间的一条持久对话线程。它存在于守护进程，而非任何客户端；聊天记录、工具事件和恢复状态能跨守护进程重启保存，Web UI、CLI、TUI、编辑器和 IM 渠道看到的是同一会话。关闭浏览器标签或终端不会丢失对话。

每个会话都会记录不可变的 `OperationSource` 来源，描述创建它的界面、客户端和由服务器标记的语义传输，详见 [operation-source.md](/internals/agent-runtime/operation-source)。独立聊天与项目会话遵循同一协议；项目是持久工作区和成员环境，其中每段对话都是独立会话，拥有自己的记录、成员绑定、生命周期和可选计划。

## 创建和继续会话

**Web。** 运行 `monad`（或 `monad up`）启动守护进程并打开 Web UI。在首页编辑器创建会话，并可在首次发送前选择 Agent；已有会话会从上次位置继续。

**CLI。** `monad chat` 是对话入口：

```sh
monad chat "what changed in the repo today?"   # 单回合并流式输出
monad chat                                     # TTY 交互循环
monad chat --session <sessionId>               # 继续已有会话
echo "summarize this" | monad chat -           # 从 stdin 读取消息
```

脚本可使用更细粒度的命令：

```sh
monad session new <title>
monad session send <sessionId> <text|->
monad session list
monad session show <sessionId>
monad session watch <sessionId>
```

在任意对话输入 `/` 可打开命令与技能菜单：`/new` 新建会话，`/sessions` 列出会话，`/switch` 切换会话，`/handoff` 总结当前对话并在新会话继续。所有界面（包括 IM 渠道）使用相同命令；技能菜单见 [skills.md](/zh-Hans/usage/skills)。

## 分支与恢复

- **分支（Branch）**把截至所选消息的历史复制到一个独立新会话。源会话不变，之后两边互不影响。适合尝试不同方案、带完整上下文询问支线问题或比较方向。
- **恢复（Restore）**在原会话内回退到较早消息检查点，并丢弃其后内容。它会改写会话本身，因此 Web UI 会要求确认。

在 Web UI 中，将鼠标悬停在已结束的消息上可找到这些操作；新会话会显示可折叠的来源历史边界。CLI 命令：

```sh
monad session branch <sessionId> [title] [atMessageId]
monad session restore <sessionId> <toMessageId>
```

分支写入和普通会话写入遵循相同的服务端传输限制；持久化的 `OperationSource` 不是客户端可配置的权限列表。

## 审批

当 Agent 要运行高风险工具，例如 shell 命令、写入沙箱外文件或使用自行编写的技能时，调用会停在审批门，直到人作出决定；等待期间不会执行任何操作。

Web UI 会在记录中显示审批卡片及工具和输入。你可以：

- **仅批准一次**：只允许本次调用
- **本会话内批准**：在当前会话余下时间记住决定
- **始终允许**：全局记住决定；控制真实机器的 host-control 工具最多只能获准到会话范围
- **拒绝**：拒绝调用，并让 Agent 在不执行它的情况下继续

无人回答时，请求默认在 2 分钟后超时并自动拒绝。没有客户端可审批时，高风险调用会关闭失败，而不会静默运行。可检查和撤销已记住的规则：

```sh
monad approval rules
monad approval revoke <id>
monad approval clear [--scope <s>] [--agent <id>]
```

原生 CLI Agent 使用自身审批提示；Monad 只决定它们可否无人值守运行或是否把请求转交给你，见 [native-cli-approvals.md](/usage/native-cli-approvals)。

## Agent

Agent 是会话使用的配置角色，包括名称、系统提示词、模型配置、技能集、工具暴露、沙箱模式和限制。一个守护进程可定义多个 Agent，每个会话创建时绑定一个；未选择时使用 `agents.json` 中的 `agent.defaultAgentId`。

在 Web UI 的 Studio 中编辑 `agent.agents`，可设置：

- `modelAlias` 和按角色覆盖的模型
- `skills`：每个 Agent 的技能自动加载覆盖
- `atoms`：Agent 可使用的工具与能力
- `sandbox`、`maxTurns`、`maxBudgetUsd`：隔离和费用限制

创建会话时通过 Web Agent 选择器或 API 的 `agentId` 指定 Agent。会话创建后绑定固定；要换配置，请用 `/handoff`，或分支到由另一 Agent 创建的新会话。

## 跨客户端观察会话

会话属于守护进程，因此任一客户端都能观察另一客户端驱动的会话。Telegram 发起的对话会出现在 Web UI 中并实时流式显示，`monad session watch <id>` 也能跟踪同一批事件。部分写入和分支路径目前实施服务端语义传输限制，因此能观察不代表每个入口都能修改；这是明确的临时架构例外，不是可配置来源策略。

## 数据存放位置

所有数据都在本地。会话、配置、凭据、技能和记忆位于守护进程主目录：macOS 的 `~/.monad`、Linux 的 XDG 目录或 Windows 的 `%APPDATA%/monad`；`MONAD_HOME` 可覆盖。守护进程默认只监听回环地址，除你配置的模型调用外，不会把会话数据发出设备。传输与安全模型见 [runtime.md](/internals/infra/runtime)。
