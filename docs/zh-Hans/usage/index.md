---
title: "运行 Monad"
sidebarTitle: "总览"
description: "会话、客户端、模型服务商、扩展、安全与维护的操作指南。"
keywords: ["Monad 指南", "运行 Agent", "Agent 运维", "守护进程管理"]
---
先看[快速上手](/zh-Hans/getting-started)。这些指南把 Monad 当作守护进程优先的 Agent 团队运行时来讲：Monad Mesh 拥有团队，Agent 运行时——无论第一方还是外部——在这份权威之下完成工作。

每篇指南都先给出 `monad` 命令，因为 CLI 是完整且可脚本化的操作面。浏览器能做同样事情的地方，指南会在命令旁边标出对应的 Studio 界面；只有浏览器能做的少数几件事，列在 [Web 界面](/usage/web)（英文）里。

```mermaid
flowchart LR
  Install["安装守护进程"] --> Mesh["组建 mesh：成员 · 角色 · 观察"]
  Mesh --> Runtimes["接入 Agent 运行时：第一方 · 第三方 · ACP · 对等"]
  Runtimes --> Cap["扩展能力与触达：技能 · MCP · 渠道"]
  Cap --> Trust["调整信任：沙箱 · 凭据 · 审批"]
```

## 组建 mesh

Monad Mesh 是 Agent 团队运行时。先读这部分：它决定谁在团队里，以及他们的工作如何被绑定、观察和审批。

| 文档 | 内容 |
|---|---|
| [组建团队](/zh-Hans/guides/from-one-agent-to-team) | 从一个受监督的 Agent 成长为持久的多 Agent 项目 |
| [选择运行时](/zh-Hans/guides/choosing-runtime) | 某项工作应该由哪个 Agent 运行时执行 |
| [使用第三方 Agent](/zh-Hans/usage/mesh-agents) | 把服务商原生运行时作为团队成员运行并观察 |
| [原生 CLI 审批](/usage/native-cli-approvals)（英文） | 面向原生 CLI Agent 的按成员自动驾驶开关 |

## 运行第一方 Agent

Monad Agent Runtime 是 Monad 自己的 Agent 运行时，也是默认的 mesh 成员。这些指南配置它能调用什么、知道什么。

| 文档 | 内容 |
|---|---|
| [模型服务商](/zh-Hans/usage/model-providers) | 连接它调用的模型 |
| [技能](/zh-Hans/usage/skills) | `SKILL.md` 技能：使用、编写、门控、分叉执行与管理 |
| [MCP](/zh-Hans/usage/mcp) | MCP 服务器：stdio 与 HTTP、密钥、OAuth、信任控制 |
| [计算机操作](/zh-Hans/usage/computer-use) | 通过现成 MCP 服务器实现计算机操作与浏览器操作 |

## 运行守护进程

| 文档 | 内容 |
|---|---|
| [安装与卸载](/zh-Hans/usage/installation) | 系统要求、发行版安装器、手动安装、升级与移除 |
| [会话](/zh-Hans/usage/sessions) | 会话与 Agent：创建、分支、恢复、跨客户端观察 |
| [CLI](/zh-Hans/usage/cli) | 全部命令、全局标志、别名、退出码、脚本化模式 |
| [Web 界面](/usage/web)（英文） | 浏览器客户端：路由、Studio 地图，以及只有它能做的事 |
| [TUI](/zh-Hans/usage/tui) | 启动终端客户端及其按键 |
| [消息渠道](/zh-Hans/usage/channels) | IM 渠道：连接、群组规则与聊天内命令 |
| [API](/usage/api)（英文） | 守护进程 API：传输、认证、实时流、错误信封、OpenAPI |

## 调整信任

| 文档 | 内容 |
|---|---|
| [沙箱后端](/usage/sandbox-backends)（英文） | 选择与配置沙箱后端 |
| [Agent 运行时凭据](/usage/agent-runtime-credentials)（英文） | 面向生成代码与 shell 进程的只写凭据 |
| [隐私](/zh-Hans/usage/privacy) | 本地存了什么，什么会离开设备 |

## 维护

| 文档 | 内容 |
|---|---|
| [故障排查](/zh-Hans/usage/troubleshooting) | 症状 → 原因 → 命令，覆盖各个子系统 |
| [发行与升级](/zh-Hans/usage/releases) | 通道、升级、回滚、版本与兼容性 |

想理解运行时为什么这样设计，读 [Monad 架构](/zh-Hans/internals/index)。
