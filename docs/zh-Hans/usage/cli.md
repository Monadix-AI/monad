---
title: "CLI 参考"
sidebarTitle: "CLI"
description: "使用 Monad CLI 操作守护进程、会话、项目、模型、渠道、审批、扩展与自动化。"
keywords: ["Monad CLI", "命令行", "JSON 输出", "自动化", "退出码"]
---
`monad` 命令是本地守护进程的轻量客户端：需要时启动守护进程，通过所选传输连接，并以适合脚本的形式暴露操作。

## 快速开始

```sh
monad
monad chat "hello"
monad status
monad stop
```

裸 `monad` 会启动或更新守护进程并打开 Web UI。`monad chat` 在终端创建或继续会话。

## 全局参数

| 参数 | 含义 |
|---|---|
| `-h, --help` | 显示根命令或子命令帮助 |
| `-V, --version` | 输出版本 |
| `-v, --verbose` | 增加详细程度；可重复使用 |
| `--debug` | 使用最高日志级别 |
| `-q, --quiet` | 隐藏非必要输出，错误仍会打印 |
| `--json` | JSON 输出，即 `-o json` |
| `-o, --output <fmt>` | `table`、`json` 或 `yaml` |
| `--no-color` | 禁用 ANSI 颜色；也支持 `NO_COLOR` |
| `-y, --yes` | 对确认问题回答 yes |
| `--no-input` | 禁止交互提示，适合自动化 |
| `--port <n>` / `--host <h>` | 本次调用覆盖守护进程连接 |
| `--token <token>` | 远程 bearer token；优先使用 token 文件 |
| `--token-file <path>` | 从文件读取远程 token，避免出现在 argv |
| `--force` | 远程连接时绕过客户端/守护进程版本拒绝 |

人类输出会本地化；`--json`、NDJSON、字段名和退出码保持稳定且不翻译。

## 守护进程生命周期

```text
monad start
monad stop
monad restart
monad status
monad logs [-f] [-n <lines>]
monad doctor
monad version
monad update [--check] [--channel <stable|beta|nightly>] [--tag <version>] [--force]
monad remote tls <renew|show|trust>
```

`status` 显示当前传输、端口、版本以及 developer mode 下的本地 Scalar URL。`doctor` 诊断配置、连接和版本问题。

## 初始化与配置

```text
monad init
monad config <get|set|list|path|edit> [key] [value]
monad import settings|doctor --from <source> --path <path> [--apply]
monad purge <sessions|config|auth|all>
monad completion <bash|zsh|fish|install>
monad license list
```

设置响应会隐藏密钥。`purge` 是破坏性操作，其中 `all` 删除会话、配置、认证和用量；完整清空主目录需要双重确认。

```sh
monad config set network.transport tcp
monad purge sessions --keep-last 5
```

## 聊天与会话

```text
monad chat [text|-] [--session <id>] [--no-stream]
monad tui

monad session new <title>
monad session list [state] [--attention]
monad session show <sessionId>
monad session send <sessionId> <text|-> [--file <path>] [--no-stream] [--detach]
monad session messages <sessionId> [--limit <n>] [--before <messageId>] [--include-inactive]
monad session watch <sessionId> [--until <eventType>] [--timeout <seconds>]
monad session search [--mode <keyword|semantic|hybrid>] <query>
monad session branch <sessionId> [title] [atMessageId]
monad session restore <sessionId> <toMessageId>
monad session reset <sessionId>
monad session abort <sessionId>
monad session rm <sessionId>
```

无消息运行 `monad chat` 时，在 TTY 中进入交互循环。`-` 从 stdin 读取。`--detach` 只提交工作，之后可用 `watch` 等待明确事件：

```sh
monad session send "$ID" "run the migration" --detach
monad session watch "$ID" --until session.message.completed --timeout 300 --json | tail -1
```

Branch 复制历史到新会话，Restore 原地回退并丢弃检查点后的内容。

## 模型、服务商与凭据

```text
monad model <list|set|rm|use|test> [arg]
monad provider <list|set|rm|models> [arg]
monad credential <list|add|rm|test> <providerId> [arg]
```

`model use` 查看或设置默认模型配置；`provider models` 读取服务商模型目录；`credential test` 在保存后验证凭据。凭据列表只返回掩码预览。

## Skills、Atom 与 MCP

```text
monad skill <list|search|install|update|remove|enable|disable|new|validate> [arg]
monad atom <list|install|update|remove|scaffold|pack> [arg]
monad mcp <list|status|add|remove|enable|disable|authorize|reconnect|search> [arg]
monad command list
```

安装 Skill、Atom Pack 或 MCP 服务器等同于安装第三方软件。先检查来源、manifest、权限和将要执行的命令。

## 渠道、对等节点与 Monadix

```text
monad channel <list|status|add|token|enable|disable|rm> [arg]
monad peer <list|add|token|enable|disable|rm> [arg]
monad monadix <login|enable|disable|status>
```

渠道新建后默认禁用。Peer federation 只面向同一操作者拥有的守护进程；跨所有者协作使用 Monadix。

## Agent 团队

```text
monad agent list
monad agent show <agentId|name>
monad agent new <name> [--model <alias>] [--framework <framework>] [--prompt <text>]
monad agent set <agentId|name> [--name <name>] [--model <alias>] [--framework <framework>]
monad agent prompt <agentId|name> [text|-]
monad agent use [agentId|name]
monad agent rm <agentId|name>
```

Agent 定义名称、提示词、模型、Skills、Atoms、沙箱和限制。会话创建时绑定 Agent；已有会话不会因默认 Agent 改变而迁移。

## 第三方 Agent 运行时

```text
monad mesh list
monad mesh agents
monad mesh auth <agentName>
monad mesh start <agentName> --session <sessionId> [--cwd <path>]
monad mesh show <meshSessionId>
monad mesh watch <meshSessionId> [--raw]
monad mesh input <meshSessionId> <text|->
monad mesh steer <meshSessionId> <text|->
monad mesh interrupt <meshSessionId>
monad mesh stop <meshSessionId>
monad mesh approve|deny <meshSessionId> <requestId> [--reason <text>]
monad mesh usage [meshSessionId]
```

控制能力取决于活动运行时报告，不能仅按服务商名称推断。

## Memory

```text
monad memory status
monad memory facts --scope <kind>:<id>
monad memory graph [--scope <kind>:<id>]
monad memory laws [--scope <kind>:<id>]
```

Facts、graph 和 laws 是不同投射。Scope 必须明确，避免把一个 Agent、会话或项目的记忆误当成全局状态。

## 审批

```text
monad approval list [--session <sessionId>]
monad approval allow <requestId> [--scope <once|session|agent|global>] [--reason <text>]
monad approval deny <requestId> [--scope <scope>] [--reason <text>]
monad approval answer <interactionId> [--value key=value]
monad approval rules
monad approval revoke <ruleId>
monad approval clear [--scope <scope>] [--agent <id>]
```

Host-control 权限不会全局持久化。无人回答时高风险调用超时并关闭失败。

## 用量

```text
monad usage show [--by-day] [--by-category]
monad usage reset
```

用量账本记录解析后的服务商、模型、token 和已知费用。`reset` 会清空本地账本，不影响服务商侧账单。

## 别名

| 别名 | 标准命令 |
|---|---|
| `monad up` | 裸 `monad` |
| `monad down` | `monad stop` |
| `monad ps` / `monad ls` | `monad session list` |
| `monad new <title>` | `monad session new` |
| `monad rm <id>` | `monad session rm` |
| `monad ask <text\|->` | `monad chat --no-stream` |
| `monad models` | `monad model list` |
| `s` / `m` | `session` / `model` |
| `cred` / `creds` | `credential` |
| `prov` | `provider` |
| `chan` | `channel` |

脚本应优先使用标准命令，别名只用于交互便利。

## 密钥

不要把 token 直接放在 argv，因为其他本地进程和 shell 历史可能看到它。优先使用 stdin 或 token 文件：

```sh
monad credential add openrouter - < credential.json
monad model test - < probe.json
monad status --host monad.example.com --token-file ~/.monad/remote-token
```

明文显示选项只允许交互终端，重定向、管道和 `--json` 捕获不会静默泄露密钥。

## 重试与幂等

CLI 只在操作满足幂等规则时安全重试。支持的写请求可携带 `Idempotency-Key`；去重范围是当前守护进程生命周期。共享可变记录使用期望版本实现 compare-and-swap，版本冲突会明确失败。

## 错误格式

结构化错误包含稳定字段：

```json
{
  "error": "Human-readable message",
  "code": "VALIDATION",
  "retryable": false,
  "requestId": "req_example"
}
```

`requestId` 与响应头 `x-monad-request-id` 一致。自动化应按 `code`、`retryable` 和退出码处理，而不是解析本地化消息。

## 退出码

| 退出码 | 含义 |
|---|---|
| `0` | 成功 |
| `1` | 普通运行时错误 |
| `2` | 参数或请求错误，包括 400、404、405、422 |
| `3` | 配置无效，包括 409、412 |
| `4` | 守护进程不可达，或 502、503、504 |

## 脚本示例

```sh
monad session list --json | jq -r '.[].id'
monad session watch ses_abc123 --json | jq -c 'select(.type == "session.message.completed")'
monad status --host monad.example.com --token-file ~/.monad/remote-token --json
```

在 CI 中使用 `--no-input --json --no-color`，为 watch 命令设置超时，并检查退出码。
