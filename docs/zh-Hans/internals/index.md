---
title: "理解 Monad 的架构"
description: "理解 Monad 守护进程、Agent 团队运行时、客户端与执行引擎之间的架构边界。"
keywords: ["Monad 架构", "守护进程架构", "开发者文档", "扩展 Monad"]
---
English: [Architecture overview](/zh-Hans/internals/index)

这是面向开发者的架构入口。Monad 守护进程持有 Agent 团队运行时，客户端与执行引擎通过公开协议接入。Monad Agent Runtime 是随附的第一方执行路径。

这一页回答三个问题：

1. **系统由哪些部分组成？** 查看下面的分层图
2. **随附 Agent 如何执行一轮？** 查看请求时序图
3. **接下来读什么？** 选择一个内部机制分类

| 分类 | 回答什么 | 什么时候读 |
|---|---|---|
| [`infra/`](/internals/infra/index) | 进程怎么启动、监听、存储、加载扩展 | 改传输、配置、存储、atoms、hooks、模型网关 |
| [`agent-team-runtime/`](/internals/agent-team-runtime/index) | Monad 如何把多个 Agent 与运行时组织成团队 | 改团队身份、协作、委派、联邦或 Experience |
| [`agent-runtime/`](/internals/agent-runtime/index) | 随附的第一方引擎如何执行一轮 | 改它的工具、上下文、记忆或执行语义 |

面向用户的功能文档在 [`../usage/`](/usage/index)；仓库工程规范在
[`../engineering/`](/engineering/index)。

## 1. 分层图

Monad 的所有设计都服从一条规则：**守护进程持有状态，客户端只负责渲染与操控。**

```mermaid
flowchart TB
  subgraph Clients["客户端：无状态、可替换"]
    direction LR
    subgraph WebC["Web UI"]
      XP["Workplace Experience<br/>仅 Web 的渲染层<br/>coding · research · operations"]
    end
    CLI["CLI"]
    TUI["TUI"]
    Editor["编辑器 (ACP)"]
    IM["IM 通道"]
  end

  subgraph Daemon["Monad 守护进程：唯一的长生命周期状态持有者"]
    Transports["传输层：REST · SSE · 控制 WebSocket · Unix socket · stdio/ACP"]
    Handlers["Handlers：会话 · 设置 · 技能 · atoms · MCP"]
    TeamRT["Monad Mesh · Agent Team Runtime：身份 · 会话 · 协作 · 策略"]
    AgentRT["Monad Agent Runtime：模型 · 工具 · 上下文 · 记忆"]
    ExternalRT["外部运行时适配器：第三方 Agent · ACP · peer"]
    Infra["Infra：配置 · 存储 · atoms · hooks · 模型网关 · 沙箱"]
  end

  subgraph Host["本机"]
    Disk[("~/.monad：配置、会话库、记忆、atoms、凭据")]
    Sandbox["沙箱子进程"]
  end

  Providers["已配置的模型服务商"]
  External["外部 Agent 运行时"]

  Clients --> Transports
  Transports --> Handlers --> TeamRT
  TeamRT --> AgentRT
  TeamRT --> ExternalRT
  AgentRT --> Infra
  ExternalRT --> Infra
  TeamRT --> Infra
  Infra --> Disk
  Infra --> Sandbox
  AgentRT --> Providers
  ExternalRT --> External
```

由此推出三条必须先内化的结论：

- **没有权威客户端。** 关掉浏览器不会中断一轮生成；CLI、Telegram 消息、编辑器可以驱动同一个会话。
- **Workplace Experience 是 Web UI 的功能，不是运行时的一层。** 它活在 `apps/web` 里，只负责
  重绘项目页面；CLI、TUI、编辑器和通道都不经过它。任何需要在所有客户端都可用的能力，必须放在
  守护进程侧（工具、命令、hooks、protocol），不能放进 experience。
- **跨进程边界的一切都要解析，不能信任**：HTTP、WebSocket、磁盘、MCP、atom pack、模型输出
  一视同仁。见[运行时安全模型](/internals/infra/runtime#security-model)。

## 2. 第一方 Agent 如何执行请求

这段时序描述随附的第一方执行引擎。外部运行时使用各自的适配器与观察协议。

```mermaid
sequenceDiagram
  autonumber
  participant U as 客户端 (web/CLI/IM)
  participant D as 守护进程传输层
  participant S as 会话存储
  participant A as Agent 循环
  participant G as 审批门
  participant M as 模型服务商

  U->>D: POST /v1/sessions/:id/messages
  D->>S: 先落库（durable first）
  D-->>U: 控制面事件 session.message.created
  D->>A: 启动一轮
  A->>A: 组装上下文（系统提示 + 记录 + 技能 + 记忆）
  A->>M: 发起流式请求
  M-->>A: 文本 / 推理增量
  A-->>U: SSE session.message.delta.appended
  M-->>A: 工具调用
  A->>G: 门检查（highRisk？scopes？）
  G-->>U: 请求审批（本轮阻塞）
  U-->>G: 批准 / 拒绝
  G->>A: 决定
  A->>A: 在沙箱中执行工具，结果回喂
  A->>M: 继续流
  M-->>A: 结束
  A->>S: 落库最终消息
  A-->>U: session.message.completed（控制面 + SSE，同一 event id）
```

这张图编码了三条不变量：

- **先落库，再发布。** 状态先提交存储，事件后发出。重连的客户端不会看到一个取不到状态的事件。
- **两条平面，永不合并。** 低频生命周期走控制 WebSocket，token 增量走 per-message SSE。细节见
  [`infra/realtime-channels.md`](/internals/infra/realtime-channels)。
- **审批门 fail-closed。** 高风险工具在没有可用审批门时被拒绝，而不是放行。细节见
  [`agent-runtime/tools.md`](/internals/agent-runtime/tools)。

## 3. 进程怎么起来

```mermaid
flowchart LR
  A["Preflight<br/>flag · 路径 · 日志"] --> B["核心运行时<br/>存储 · 配置快照"]
  B --> C["网络运行时<br/>TCP · Unix socket · TLS"]
  C --> D["执行服务<br/>第一方运行时 · 外部适配器"]
  D --> E["Handlers<br/>会话 · 设置 · atoms · MCP"]
  E --> F["传输开始监听<br/>REST/SSE · WS · stdio/ACP · 通道"]
  F --> G["Ready"]
  W["文件监听"] -. 失效 .-> B
  B -. "ConfigManager.reload()" .-> D
```

启动是一张按拓扑排序的生命周期图，不是一坨 `main()`。热重载刻意保守：尾部去抖、单飞、提交成功
才接受。完整模块表见 [`infra/daemon-architecture.md`](/internals/infra/daemon-architecture)。

## 4. 状态存在哪

```mermaid
flowchart TB
  Home[("~/.monad")]
  Home --> C["configs/<br/>config.json · agents.json · mesh.json<br/>设置 + 原生凭据"]
  Home --> Auth["credentials/auth.json (0600)<br/>Agent Runtime Credentials"]
  Home --> DB[("db/monad.sqlite<br/>会话 · 消息 · 事件")]
  Home --> Mem["memory/<br/>事实 · 知识图谱 · laws"]
  Home --> Atoms["atoms/<br/>packs · skills · mcp · locales · providers"]
  Home --> Run["runtime/monad.sock (0600)<br/>本地控制套接字"]
  Home --> WS["agents/&lt;agentId&gt;/<br/>每个 agent 的工作目录"]
```

路径布局由 `@monad/environment` 统一定义，包括 Linux 上的 XDG 拆分。详细边界见[运行时架构](/internals/infra/runtime)。

## 5. 怎么扩展

扩展遵循「先声明、后注册」：清单声明能力种类，宿主展示给用户审计，运行时强制执行。

```mermaid
flowchart LR
  subgraph Sources["扩展来源"]
    Pack["Atom pack<br/>atom-pack.json 清单"]
    SkillDir["技能目录<br/>SKILL.md"]
    MCPSrv["MCP 服务器<br/>stdio / http"]
    HookCfg["Hooks<br/>agents.json"]
  end

  Gate["清单门<br/>声明 = 可审计 = 被强制"]
  Registries["守护进程注册表<br/>通道 · 命令 · 服务商 · 消息类型"]
  Agent["Agent 轮次"]

  Pack --> Gate --> Registries --> Agent
  SkillDir --> Registries
  MCPSrv --> Registries
  HookCfg --> Agent
```

内置**工具不是 atom kind**。它们随守护进程发布，安全防护保持第一方。见
[`infra/atoms.md`](/internals/infra/atoms)、[`../usage/skills.md`](/zh-Hans/usage/skills)、
[`infra/hooks.md`](/internals/infra/hooks)。

## 6. 约束层

```mermaid
flowchart TB
  Model["模型输出（不可信）"] --> Schema["1. Schema 校验<br/>每个边界 zod parse"]
  Schema --> GateL["2. 审批门<br/>高风险工具阻塞等人"]
  GateL --> Guards["3. 调用时守卫<br/>路径根 · SSRF · 大小上限"]
  Guards --> OS["4. OS 沙箱<br/>Seatbelt · bwrap/Landlock+seccomp · AppContainer"]
  OS --> Egress["5. 出网代理<br/>域名放行/拒绝 · 凭据替换"]
```

每一层都假设上一层已经失效。完整威胁模型见[运行时安全模型](/internals/infra/runtime#security-model)，各平台落地现状见[沙箱后端](/usage/sandbox-backends)。

## 继续阅读

各分类的完整文档清单见英文版 [README.md](/internals/index#read-next)，或直接进入
[`infra/`](/internals/infra/index)、[`agent-team-runtime/`](/internals/agent-team-runtime/index)、
[`agent-runtime/`](/internals/agent-runtime/index)。
