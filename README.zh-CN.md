<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/monad-logo-dark.svg">
    <img src="apps/web/public/monad-logo-vector-solid.svg" alt="Monad" width="520">
  </picture>
</p>

<h1 align="center">Monad</h1>

<p align="center"><strong>Monad 是采用无头架构、以守护进程为核心的 Agent 团队运行时。</strong></p>

<p align="center">
  <a href="https://github.com/Monadix-AI/monad/actions/workflows/ci.yml"><img src="https://github.com/Monadix-AI/monad/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2563eb.svg" alt="MIT 许可证"></a>
  <img src="https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-6e56cf.svg" alt="支持 macOS、Linux 和 Windows">
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#monad-agent-与-monad-mesh">Agent 与 Mesh</a> ·
  <a href="#workspace-experience">Workspace Experience</a> ·
  <a href="#核心能力">核心能力</a> ·
  <a href="#文档导航">文档导航</a> ·
  <a href="README.md">English</a>
</p>

**模型能够推理，Agent 能够行动，而一支团队需要运行时。**

Monad 通过一个长期运行的本地守护进程承载 Agent：既可以专注使用单个 Agent，
也可以组织一支协同工作的 Agent 团队。守护进程统一管理它们的身份、能力、权限、
任务、协作状态、产物、审批和审计记录。Web UI、CLI、TUI、编辑器、API、即时通讯
渠道与定制工作空间，都是操作同一套持久运行时的不同方式。

Monad 默认把自身状态保存在你的设备上，并且只监听本机回环地址。发送给你所配置
模型服务商的请求仍会离开设备，但围绕这些请求的运行环境与数据由你掌控。启用远程
访问前，请先阅读[运行时安全模型](docs/internals/runtime.md#security-model)。

## 快速开始

### macOS 和 Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Monadix-AI/monad/main/scripts/install.sh | bash
monad
```

### Windows

请在 PowerShell 5.1 或更高版本中运行：

```powershell
irm https://raw.githubusercontent.com/Monadix-AI/monad/main/scripts/install.ps1 | iex
monad
```

安装程序会自动下载适合当前平台的发行版、校验 SHA256、把 `monad` 加入 `PATH`，
并启动本地守护进程。直接运行 `monad` 会在需要时启动或更新守护进程，然后打开
Web UI。

希望检查每个安装步骤或离线部署？请参阅[手动安装](#手动安装)。

## Agent 团队背后的运行时

一支 Agent 团队会带来模型或聊天窗口本身无法回答的运行问题：

- **谁持续运行这些 Agent？** Monad 守护进程不依赖任何客户端窗口，并能在重新连接
  或重启后恢复持久任务。
- **谁给它们身份、能力与权限？** 运行时为每个 Agent 解析角色、模型、Skills、工具、
  凭据和策略边界。
- **谁分配和恢复任务？** 任务与会话归运行时所有，因此可以委派、暂停、恢复、分支
  和检查。
- **谁保存协作状态、产物与审计记录？** Agent 与人类共享同一份本地事实来源，而不是
  各自停留在孤立的聊天记录中。
- **谁让人类介入审批？** 高风险动作会在工具执行前停在明确的审批门上。
- **谁把同一支 Agent 团队投射成不同工作体验？** Workspace Experience 根据具体任务
  呈现同一支团队及其共享状态。

这就是 Monad 所说的 daemon-first 与 headless：客户端负责呈现和控制运行时，但不
拥有 Agent 或它们的工作。

## Monad Agent 与 Monad Mesh

Monad 在同一套运行时上提供两种产品形态：

| 产品形态 | 面向的工作方式 |
|---|---|
| **Monad Agent** | 与单个 Agent 专注协作，同时拥有持久上下文、受控能力、审批、恢复和全部客户端入口。 |
| **Monad Mesh** | 让多个 Agent 组成团队，通过明确角色、任务委派、并行执行、共享上下文与产物、人类审批和可恢复协作状态共同工作。 |

Monad Agent 并不是位于 Monad Mesh 旁边的一套轻量运行时。二者共享同一个守护进程、
策略、能力、任务状态、存储与审计记录。你可以从一个 Agent 开始，再直接组成团队，
不需要把工作迁移到另一套系统。

## Workspace Experience

**Workspace Experience** 是同一组 Agent、任务、产物、审批和协作状态针对具体场景的
交互投影。编码工作空间可以围绕代码仓库、diff 和终端组织；研究工作空间可以围绕
来源、证据与报告组织；运维和内容生产也可以使用各自的信息结构与操作方式。

Workspace Experience 可以组合和切换，也可以由 Atom pack 扩展。底层事实始终由
守护进程持有；切换体验改变的是团队如何使用状态，而不是状态保存在哪里。

## 为什么选择 Monad

**从本地优先出发。** 会话、配置、凭据、审批和历史记录都保存在 `~/.monad/`。
守护进程监听本机回环地址或 Unix-domain socket，而不是向局域网暴露未认证服务。

**一个守护进程，承载每种体验。** 你可以在浏览器中使用 Monad Agent，通过 CLI
检查工作，在 Monad Mesh 中协调团队，也可以从编辑器、API 或即时通讯渠道连接同一
套运行时。所有界面共享同一份事实来源。

**逐步释放自主性。** Monad 会清楚呈现 Agent 的动作、工具调用与审批请求。你可以
从严格监督开始，只在任务和环境允许时逐步扩大自主权限。

**开放扩展，同时保持约束。** Skills、Atom packs、Workspace Experiences、MCP
servers、外部 Agent 运行时和节点间委派能够持续扩展 Agent 的工作方式；审批门与
操作系统原生沙箱则约束这些能力如何执行。

## 核心能力

| 能力 | 你可以做什么 |
|---|---|
| [会话](docs/usage/sessions.md) | 在多个客户端之间持续同步对话，并从任意轮次创建分支或恢复状态。 |
| [模型](docs/usage/model-providers.md) | 通过统一网关连接云端或本地模型，并使用模型配置与按角色选择。 |
| [Skills](docs/usage/skills.md) | 让 Agent 发现并遵循可移植的 `SKILL.md` 能力包。 |
| [Atom packs](docs/internals/atoms.md) | 安装可贡献渠道、模型服务商、Skills、MCP、命令和 Hooks 的扩展包。 |
| [Workspace Experiences](docs/concepts.md#workspace-experience) | 针对编码、研究、运维、内容生产等场景定制工作界面，同时复用运行时状态。 |
| [Monad Mesh](docs/concepts.md#monad-mesh) | 让多个 Agent 通过共享任务、产物、审批与协作状态组成团队。 |
| [消息渠道](docs/usage/channels.md) | 通过 Telegram、Discord、Slack 等适配器连接同一个 Agent 或团队。 |
| [沙箱](docs/usage/sandbox-backends.md) | 在 macOS、Linux 和 Windows 上使用原生进程隔离和受控网络出口。 |
| [编辑器 Agent](docs/internals/acp.md) | 在编辑器中把 Monad 作为 ACP Agent，或把任务委派给其他 ACP 运行时。 |
| [节点协作](docs/internals/peer-federation.md) | 把任务交给另一台 Monad 节点，并使用该节点自己的工具和凭据执行。 |

## 工作方式

```text
 Web UI      CLI      TUI      Editors      APIs      IM channels
    │         │        │          │          │             │
    └─────────┴────────┴──────────┴──────────┴─────────────┘
                                │
               Workspace Experiences
              编码 · 研究 · 运维 · 内容
                                │
                  ┌─────────────▼─────────────┐
                  │       Monad Runtime       │
                  │       长期运行的守护进程      │
                  ├───────────────────────────┤
                  │ Monad Agent │ Monad Mesh  │
                  ├───────────────────────────┤
                  │ 身份、能力与权限              │
                  │ 任务、协作状态与产物           │
                  │ 审批与审计记录                │
                  │ 模型、Skills 与工具           │
                  │ 本地存储                     │
                  └─────────────┬─────────────┘
                                │
                         已配置的模型服务商
```

守护进程是运行时状态的唯一所有者。各客户端和 Workspace Experience 通过 REST、
SSE、WebSocket 或本地 Unix-domain socket 连接；守护进程负责运行 Agent、协调任务、
推送事件、执行策略，并调用用户选择的模型服务商。

完整启动流程与传输边界请参阅[守护进程架构](docs/internals/daemon-architecture.md)
以及[运行时、配置与安全](docs/internals/runtime.md)。

## 安装

### 推荐安装方式

[快速开始](#快速开始)中的安装程序会检测当前平台、校验发行包、在支持的平台创建
应用快捷方式，并在升级时保留现有配置。

预构建发行版是自包含的，运行时不需要 Bun 或 Node.js。你也可以从
[GitHub Releases](https://github.com/Monadix-AI/monad/releases) 页面直接下载发行包。

### 手动安装

选择名为 `monad-<version>-<os>-<arch>.tar.gz` 的文件，并同时下载对应的
`.sha256`。以下示例适用于 Apple Silicon Mac：

```bash
VERSION=<version>
ASSET="monad-${VERSION}-darwin-arm64"

curl -fSLO "https://github.com/Monadix-AI/monad/releases/download/v${VERSION}/${ASSET}.tar.gz"
curl -fSLO "https://github.com/Monadix-AI/monad/releases/download/v${VERSION}/${ASSET}.tar.gz.sha256"
shasum -a 256 -c "${ASSET}.tar.gz.sha256"
tar -xzf "${ASSET}.tar.gz"

"./${ASSET}/bin/monad" --help
```

如果 Linux 没有 `shasum`，可使用 `sha256sum -c`。在 Windows 上，可使用
`Get-FileHash -Algorithm SHA256` 对照校验文件，然后通过当前 Windows 自带的
`tar` 解压。

Linux 同时提供 glibc 和 musl 发行包。Debian、Ubuntu、Fedora 等发行版使用普通
`linux-<arch>` 构建；Alpine 或其他基于 musl 的系统使用
`linux-<arch>-musl`。

### 系统要求

- **macOS：** Apple Silicon（`arm64`）或 Intel（`x64`）。
- **Linux：** `arm64` 或 `x64`，同时提供 glibc 与 musl 发行包。
- **Windows：** 64 位 Windows 10 1803 或更高版本；Windows on ARM 当前通过
  操作系统模拟层运行 `windows-x64` 发行版。
- **网络：** 能够通过 HTTPS 访问你选择的模型服务商。

Monad 负责调用和编排模型服务商，本身不包含本地推理引擎。

## 使用 Monad

```bash
# 启动守护进程并打开 Web UI
monad

# 检查运行状态
monad status
monad doctor

# 创建会话并发送任务
monad session new "my session"
monad session send <sessionId> "hello"
monad session watch <sessionId>

# 查看模型并选择本地客户端传输方式
monad model list
monad config set network.transport uds   # 或 tcp
```

命令支持脚本友好的输出、稳定退出码，以及 `--json` 等结构化格式。完整命令组、
别名、全局参数、流式行为与配置示例请参阅 [CLI 参考](docs/usage/cli.md)。

## 参与开发

Monad 使用 Bun workspaces 和 Turbo。在源码目录中运行：

```bash
bun install
bun run dev
```

`bun install` 会执行可重复运行的 worktree 初始化。`bun run dev` 将开发状态隔离在
`.dev/` 下，不会修改你日常使用的 `~/.monad/` 数据。

```bash
bun run dev:doctor      # 只读环境诊断
bun run quality:check   # 统一的只读质量门
```

提交修改前请阅读[贡献指南](CONTRIBUTING.md)。工程架构、代码约定、测试、安全与
DX 指南位于 [`docs/engineering/`](docs/engineering/)。

## 文档导航

| 从这里开始 | 内容 |
|---|---|
| [文档地图](docs/README.md) | 汇总用户指南、内部实现、工程和设计文档。 |
| [概念](docs/concepts.md) | 按层梳理 Runtime、Agent、Mesh、Workspace Experience、能力与节点协作。 |
| [产品](docs/product.md) | Agent 团队运行时定位、产品形态、体验原则、边界、用户与品牌方向。 |
| [CLI 参考](docs/usage/cli.md) | 命令、参数、别名、输出和脚本契约。 |
| [运行时内部机制](docs/internals/runtime.md) | 传输、配置、远程访问与安全边界。 |
| [变更记录](CHANGELOG.md) | 各发行版本的重要变化。 |

## 社区与安全

- [贡献指南](CONTRIBUTING.md)
- [安全策略与漏洞报告](SECURITY.md)
- [行为准则](CODE_OF_CONDUCT.md)
- [问题追踪](https://github.com/Monadix-AI/monad/issues)

## 许可证

[MIT](LICENSE) © Monadix Labs, Inc.

打包的第三方组件保留各自许可证。请参阅
[`packages/sandbox-vm/vendor/THIRD_PARTY_LICENSES.md`](packages/sandbox-vm/vendor/THIRD_PARTY_LICENSES.md)，
或运行 `monad licenses` 查看自动生成的运行时依赖许可证清单。
