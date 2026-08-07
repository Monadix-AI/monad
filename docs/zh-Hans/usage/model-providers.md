---
title: "设置模型服务商"
sidebarTitle: "模型服务商"
description: "连接模型服务商、保存凭据、测试访问，并选择 Monad 的默认模型配置。"
keywords: ["模型服务商", "OpenRouter", "Azure OpenAI", "Amazon Bedrock", "Ollama", "模型配置"]
---
模型服务商是 Monad 可以发送推理请求的一个去处。Monad 内置 24 种提供方类型——8 种使用专用 SDK，16 种是基于内置 OpenAI 兼容适配器的预设——此外任何服务商都可以通过 Atom Pack 接入。

本指南说明如何选择模型服务商、添加凭据和默认模型。服务商目录、两类策略和 OpenAI 兼容长尾服务商的实现见[模型服务商内部设计](/internals/infra/model-providers)。

## 你需要什么

- 服务商账户和 API 密钥；Ollama 等少数本地服务无需密钥
- Azure OpenAI、Ollama 等自托管或账户限定服务的端点基础 URL

内置服务商完整列表来自守护进程的服务商目录，所有设置界面读取同一目录，因此提供相同选项。

## 三种设置方式

### 1. 首次运行向导（推荐）

运行 `monad`（或 `monad up`）。新安装的 Web UI 会引导你选择服务商、输入 API 密钥和必要的基础 URL，再选默认模型。也可在终端运行：

```sh
monad init
```

交互向导会列出目录，询问基础 URL 和服务商特有字段（例如 Amazon Bedrock 的 AWS 区域），在保存前测试连接，再从模型列表选择默认模型。失败时可以换密钥重试或返回选择其他服务商。`monad init --no-input`（或 `-y`）可在脚本中无提示初始化主目录。

### 2. CLI

CLI 分为 `provider`、`credential` 和 `model` 三类命令，均支持全局 `--json`：

```sh
monad provider list
monad provider set '{"id":"openrouter-1","label":"OpenRouter","type":"openrouter"}'
monad provider models openrouter-1
monad provider rm openrouter-1

monad credential add openrouter-1 '{"label":"my key","authType":"api_key","accessToken":"sk-or-..."}'
monad credential list openrouter-1
monad credential test openrouter-1 <credId>
monad credential rm openrouter-1 <credId>
```

不保存服务商或密钥也可探测：

```sh
monad model test '{"provider":{"id":"p1","label":"OpenRouter","type":"openrouter"},"accessToken":"sk-or-..."}'
```

成功时守护进程返回模型目录，因此该命令也可用于发现模型。

### 3. Web UI

打开 **Studio → Models and providers**（`/studio/models`），使用 **Add provider** 添加服务商、管理凭据、浏览模型并编辑模型配置。

## 模型配置与默认模型

模型配置是把角色映射到具体模型的命名配方：必需的 `chat` 是默认路由，可选路由包括 `fast`、`vision`、`image`、`video`、`speech`、`transcription`、`embedding` 和 `memory`；配置还可携带生成参数和回退目标。请求未指定时使用固定的 `default` 配置。

```sh
monad model list
monad model use
monad model use <alias>
monad model set '<profile json>'
monad model rm <alias>
```

Web UI 的 **Studio → Models and providers** 编辑同一批配置。

## 存储位置

- 服务商、凭据和模型配置位于 Monad 配置目录的 `agents.json`。服务商凭据是原生设置，不使用 Agent Runtime Credentials 或 `${secret:...}` 引用。
- 密钥不会被返回。`monad credential list` 只显示掩码预览，添加命令只回显新凭据 ID。
- 用户负责保护原生设置文件；守护进程和设置 API 会继续从响应和日志中脱敏。

## 服务商特有说明

- **Azure OpenAI** 需要资源基础 URL（`https://{resource}.openai.azure.com/openai/v1`），模型 ID 是 Azure 的部署名称。
- **Amazon Bedrock** 需要 AWS 区域和 bearer API key（`ABSK…`）。
- Azure 和 Bedrock 都没有标准模型列表路由；连接测试无模型时，向导会改为手动输入模型或部署 ID。
- **Ollama** 等本地服务的 API 密钥可选，只需把基础 URL 指向服务器。

## 自定义服务商

目录之外的服务商可作为第三方 Atom Pack：把导出 `ModelProvider` 的模块放入 `~/.monad/atoms/providers/`，守护进程无需重启即可加载。协议见[模型服务商内部设计](/internals/infra/model-providers)。

## 贡献者设置

开发 Monad 时，将 `.env.example` 复制为 `.env.local` 并设置 `OPENROUTER_API_KEY`；开发环境会把它作为可用凭据。此路径仅用于开发，发行版只通过上述流程配置服务商。详见 [CONTRIBUTING.md](https://github.com/Monadix-AI/monad/blob/main/CONTRIBUTING.md)。
