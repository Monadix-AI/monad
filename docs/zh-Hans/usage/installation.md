---
title: "安装或移除 Monad"
description: "在 macOS、Linux 或 Windows 上安装 Monad，并安全地升级、回滚或移除。"
keywords: ["安装 Monad", "macOS Linux Windows 安装", "卸载", "升级", "单个二进制"]
---
Monad 在 macOS、Linux 和 Windows 上安装为单个二进制，并作为一个本地守护进程运行。发行版安装器会校验下载、把 `monad` 加入 `PATH`、启动守护进程并打开 Web 界面。

本指南涵盖系统要求、发行版安装器、手动安装、升级和移除。安装后按[开始使用](/zh-Hans/getting-started)连接模型并运行第一个会话。

## 检查系统要求

Monad 为以下平台发布自包含版本：

| 平台 | 支持目标 |
|---|---|
| macOS | Apple Silicon（`arm64`）和 Intel（`x64`） |
| Linux | `arm64` 和 `x64`，包含 glibc 与 musl 变体 |
| Windows | 64 位 Windows 10 1803 或更高版本；Windows on ARM 使用 `windows-x64` 模拟 |

你需要能通过 HTTPS 访问所选模型服务商。Monad 不内置本地推理引擎。

## 安装发行版

运行对应平台的安装器。它会选择发行包、校验 SHA256、在支持的平台安装启动器、更新 `PATH` 并启动守护进程。

macOS 或 Linux：

```bash
curl -fsSL https://release.monadix.ai/monad/install.sh | bash
```

如果没有 `curl`，可运行：

```bash
wget -qO- https://release.monadix.ai/monad/install.sh | bash
```

Windows PowerShell 5.1 或更高版本：

```powershell
irm https://release.monadix.ai/monad/install.ps1 | iex
```

macOS 和 Linux 安装器会启动守护进程并打开 Web UI。Windows 安装器只初始化 Monad；
随后运行 `monad up` 启动守护进程并打开 Web UI。

### 强制全新安装

仅在安装损坏或未完成、需要恢复时使用 `--force`。它会在解压发行包前删除整个安装目录，并跳过 SHA256 校验。默认安装目录是 `~/.monad`，因此继续前请备份需要保留的本地会话、配置、凭据、记忆和已安装扩展。常规安装与升级应使用不带 `--force` 的安装器。

macOS 或 Linux 需要在 `bash -s --` 后传入安装器参数：

```bash
curl -fsSL https://release.monadix.ai/monad/install.sh | bash -s -- --force
```

没有 `curl` 时：

```bash
wget -qO- https://release.monadix.ai/monad/install.sh | bash -s -- --force
```

Windows 需要先下载安装脚本，再传入 `--force`：

```powershell
$installer = Join-Path $env:TEMP "monad-install.ps1"
irm https://release.monadix.ai/monad/install.ps1 -OutFile $installer
& $installer --force
```

## 手动安装压缩包

从 [GitHub Releases](https://github.com/Monadix-AI/monad/releases) 下载压缩包和对应 `.sha256` 文件。文件名格式为 `monad-version-os-arch.tar.gz`。

Apple Silicon macOS 示例：

```bash
release_version=release_version_here
asset="monad-${release_version}-darwin-arm64"
release_url="https://github.com/Monadix-AI/monad/releases/download/v${release_version}"

curl -fSLO "${release_url}/${asset}.tar.gz"
curl -fSLO "${release_url}/${asset}.tar.gz.sha256"
shasum -a 256 -c "${asset}.tar.gz.sha256"
tar -xzf "${asset}.tar.gz"
"./${asset}/bin/monad" --help
```

没有 `curl` 时，可用以下命令下载压缩包和校验文件：

```bash
wget -q "${release_url}/${asset}.tar.gz"
wget -q "${release_url}/${asset}.tar.gz.sha256"
```

Linux 没有 `shasum` 时使用 `sha256sum -c`。Windows 可用 `Get-FileHash -Algorithm SHA256` 比对校验和，再用 `tar` 解压。Debian、Ubuntu、Fedora 等 glibc 发行版使用常规 `linux-arch` 构建；Alpine 等 musl 发行版使用 `linux-arch-musl`。

## 升级或回滚

当已安装客户端需要新版本时，运行 `monad` 会更新守护进程。发行通道、兼容性、显式升级命令与回滚方式见[发行与升级](/zh-Hans/usage/releases)。

## 移除 Monad

先停止守护进程：

```bash
monad stop
```

仅当你也要删除 `~/.monad` 下的本地会话、配置、凭据、记忆和已安装扩展时，才运行 `monad purge`。

从 `command -v monad` 报告的目录删除 `monad` 二进制文件。macOS 删除 `~/Applications/Monad.app`，Linux 删除 `~/.local/share/applications/monad.desktop`。Windows 删除 `%APPDATA%` 下的 Monad 目录、开始菜单快捷方式和对应 `PATH` 项。

安装器写入 shell 配置的内容带有 `# Added by monad installer` 标记；不再需要该二进制目录时可删除这一项。
