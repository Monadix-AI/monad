<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/monad-logo-dark.svg">
    <img src="apps/web/public/monad-logo-vector-solid.svg" alt="Monad" width="520">
  </picture>
</p>

<h1 align="center">Monad</h1>

<p align="center"><strong>你的本地 AI Agent 运行时——一个守护进程，连接每个界面，数据由你掌控。</strong></p>

<p align="center">
  <a href="https://github.com/Monadix-AI/monad/actions/workflows/ci.yml"><img src="https://github.com/Monadix-AI/monad/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2563eb.svg" alt="MIT 许可证"></a>
  <img src="https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-6e56cf.svg" alt="支持 macOS、Linux 和 Windows">
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#核心能力">核心能力</a> ·
  <a href="#文档导航">文档导航</a> ·
  <a href="README.md">English</a>
</p>

Monad 是运行在本地的 AI Agent 运行时。一个长期运行的守护进程统一保存会话、
配置、审批与历史记录；Web UI、CLI、TUI、编辑器和即时通讯渠道，则让你用不同
方式连接同一个 Agent。

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

## 为什么选择 Monad

**从本地优先出发。** 会话、配置、凭据、审批和历史记录都保存在 `~/.monad/`。
守护进程监听本机回环地址或 Unix-domain socket，而不是向局域网暴露未认证服务。

**一个守护进程，连接每个界面。** 你可以在浏览器中创建会话，通过 CLI 检查，
在 TUI 中继续，也可以从编辑器或即时通讯渠道联系同一个 Agent。所有界面共享同一
份运行状态。

**逐步释放自主性。** Monad 会清楚呈现 Agent 的动作、工具调用与审批请求。你可以
从严格监督开始，只在任务和环境允许时逐步扩大自主权限。

**开放扩展，同时保持约束。** Skills、Atom packs、MCP servers、外部 Agent 运行时
和节点间委派能够持续扩展能力；审批门与操作系统原生沙箱则约束这些能力如何执行。

## 核心能力

| 能力 | 你可以做什么 |
|---|---|
| [会话](docs/usage/sessions.md) | 在多个客户端之间持续同步对话，并从任意轮次创建分支或恢复状态。 |
| [模型](docs/usage/model-providers.md) | 通过统一网关连接云端或本地模型，并使用模型配置与按角色选择。 |
| [Skills](docs/usage/skills.md) | 让 Agent 发现并遵循可移植的 `SKILL.md` 能力包。 |
| [Atom packs](docs/internals/atoms.md) | 安装可贡献渠道、模型服务商、Skills、MCP、命令和 Hooks 的扩展包。 |
| [消息渠道](docs/usage/channels.md) | 通过 Telegram、Discord、Slack 等适配器联系同一个本地 Agent。 |
| [沙箱](docs/usage/sandbox-backends.md) | 在 macOS、Linux 和 Windows 上使用原生进程隔离和受控网络出口。 |
| [编辑器 Agent](docs/internals/acp.md) | 在编辑器中把 Monad 作为 ACP Agent，或把任务委派给其他 ACP 运行时。 |
| [节点协作](docs/internals/peer-federation.md) | 把任务交给另一台 Monad 节点，并使用该节点自己的工具和凭据执行。 |

## 工作方式

```text
 Web UI       CLI        TUI       Editors       IM channels
    │          │          │           │               │
    └──────────┴──────────┴───────────┴───────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  Local Monad      │
                    │  daemon           │
                    ├───────────────────┤
                    │ Sessions          │
                    │ Approvals & tools │
                    │ Models & skills   │
                    │ Local storage     │
                    └─────────┬─────────┘
                              │
                    Configured model provider
```

守护进程是运行时状态的唯一所有者。各客户端通过 REST、SSE、WebSocket 或本地
Unix-domain socket 连接；守护进程负责协调会话、推送事件、执行策略，并调用用户
选择的模型服务商。

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
| [概念](docs/concepts.md) | 按层梳理 Monad 中所有一等概念。 |
| [产品](docs/product.md) | 产品目标、用户、设计原则与品牌方向。 |
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
