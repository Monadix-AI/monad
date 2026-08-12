---
title: "安装或移除 Monad"
description: "在 macOS、Linux 或 Windows 上安装 Monad，并安全地升级或移除。"
keywords: ["安装 Monad", "macOS Linux Windows 安装", "卸载", "升级", "单个二进制"]
---
Monad 在 macOS、Linux 和 Windows 上作为本地守护进程运行。发行版安装器会下载对应构建并安装
`monad`；CLI 与 Web UI 共用内置的可信升级流程。

本指南涵盖系统要求、发行版安装器、手动安装、升级和移除。安装后按[开始使用](/zh-Hans/getting-started)连接模型并运行第一个会话。

## 检查系统要求

Monad 为以下平台发布自包含版本：

| 平台 | 支持目标 |
|---|---|
| macOS | Apple Silicon（`arm64`）和 Intel（`x64`） |
| Linux | `arm64` 和 `x64`，包含 glibc 与 musl 变体 |
| Windows | 面向 64 位 Windows 10 1803 或更高版本的原生 `arm64` 和 `x64` 构建 |

你需要能通过 HTTPS 访问所选模型服务商。Monad 不内置本地推理引擎。

## 安装发行版

运行对应平台的安装器。它会选择发行包，把 Monad 安装到 `~/.monad/bin`，然后更新 `PATH`。

macOS 或 Linux：

```bash
curl -fsSL https://release.monadix.ai/monad/install.sh | sh
```

如果没有 `curl`，可运行：

```bash
wget -qO- https://release.monadix.ai/monad/install.sh | sh
```

Windows PowerShell 5.1 或更高版本：

```powershell
irm https://github.com/Monadix-AI/monad/releases/latest/download/install.ps1 | iex
```

在交互式终端中，安装成功后会自动启动守护进程并打开 Web UI。自动化、JSON 或静默安装只安装二进制
文件；准备启动时运行 `monad up`。

交互式安装器会在终端宽度允许时显示下载大小、速度和预计剩余时间。自动化场景可设置
`MONAD_OUTPUT=json`，改为输出逐行 JSON 阶段与摘要事件；临时下载失败会自动重试三次。

## 手动安装压缩包

从 [GitHub Releases](https://github.com/Monadix-AI/monad/releases) 下载压缩包。文件名使用 dist target triple，例如 `monad-aarch64-apple-darwin.tar.gz`。GitHub 会为不可变 Release 签名，并在 Release attestation 中记录每个资产的摘要。

Apple Silicon macOS 最新不可变 Release 示例：

```bash
release_tag="$(gh release view --repo Monadix-AI/monad --json tagName --jq .tagName)"
asset="monad-aarch64-apple-darwin"
gh release download "${release_tag}" --repo Monadix-AI/monad --pattern "${asset}.tar.gz"
gh release verify-asset "${release_tag}" "${asset}.tar.gz" --repo Monadix-AI/monad
tar -xzf "${asset}.tar.gz"
"./${asset}/monad" --help
```

验证命令会同时检查 Release attestation 和已下载资产的摘要。同一条 `gh` 命令也可在 Windows 使用，验证后用 `tar` 解压。Debian、Ubuntu、Fedora 等 glibc 发行版使用常规 `linux-arch` 构建；Alpine 等 musl 发行版使用 `linux-arch-musl`。

## 升级

使用 `monad update` 或 Web UI 中的升级操作。发行通道与显式更新命令见[发行与升级](/zh-Hans/usage/releases)。

## 移除 Monad

先停止守护进程：

```bash
monad stop
```

仅当你也要删除 `~/.monad` 下的本地会话、配置、凭据、记忆和已安装扩展时，才运行 `monad purge`。

从 `command -v monad` 报告的目录删除 `monad` 二进制文件。macOS 删除 `~/Applications/Monad.app`，Linux 删除 `~/.local/share/applications/monad.desktop`。Windows 删除 `%APPDATA%` 下的 Monad 目录、开始菜单快捷方式和对应 `PATH` 项。

安装器写入 shell 配置的内容带有 `# Added by monad installer` 标记；不再需要该二进制目录时可删除这一项。
