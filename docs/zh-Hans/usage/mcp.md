---
title: "MCP 服务器"
sidebarTitle: "MCP"
description: "连接和治理本地或远程 Model Context Protocol 服务器及其工具。"
keywords: ["MCP", "Model Context Protocol", "MCP 服务器", "工具审批", "OAuth"]
---
MCP（Model Context Protocol）让 Agent 调用外部进程或远程服务提供的工具。Monad 把所配置服务器的工具合并到 Agent 工具箱，并命名为 `<server>__<tool>`，例如 `github__create_issue`。MCP 跨越信任边界，因此默认属于高风险能力。

## 添加服务器

### CLI

`monad mcp` 是可脚本化的入口，添加后无需重启：

```bash
monad mcp search <query>                      # 搜索官方 registry、Glama、Smithery 与内置目录
monad mcp add github npx -y @modelcontextprotocol/server-github
monad mcp add linear --url https://mcp.linear.app/mcp
monad mcp list                                # 已安装的服务器（含所有来源）
monad mcp status [name]                       # 连接、认证与工具状态
monad mcp enable|disable|remove <name>
monad mcp authorize|reconnect <name>          # 作用于 agents.json 中的服务器（见下方 OAuth）
```

`mcp add` 把服务器安装为 `~/.monad/atoms/mcp/` 下的热加载 MCP atom；`reconnect` 在修复配置后立即重试；`search` 只查询 registry，不会自动安装结果。需要认证或信任控制的服务器请写进 `agents.json`。

### Web UI

**Studio → Capabilities → MCP servers** 显示每个已配置服务器的连接状态、已公布工具、固定哈希与认证状态，并可添加、编辑、启用或停用、授权、重连和移除。它与 `monad mcp` 读写同一份状态。

### `agents.json`

MCP 配置位于 `agents.json` 的 `mcpServers` 数组。stdio 由 Monad 拉起子进程，http 连接远程 URL：

```jsonc
{
  "mcpServers": [
    {
      "name": "filesystem",
      "transport": "stdio",
      "command": "bunx",
      "args": ["@example/filesystem-server", "/allowed/root"],
      "enabled": true
    },
    {
      "name": "remote",
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "enabled": true
    }
  ]
}
```

保存后立即生效：守护进程只连接新增项、断开被移除项、重连被修改项，未变动的服务器保持原有连接。把外部进程参数、工作目录、环境和网络端点视为不受信任配置，不要在 `args` 中放密钥。

## 协议协商与 Tasks

Monad 在连接时协商 MCP 协议版本和服务器能力，只调用双方共同支持的能力。服务器公布的 tools、resources、prompts 和补全能力会按协议注册。

支持 MCP Tasks 的服务器可以返回持久任务句柄，Monad 会轮询或订阅其状态并把最终结果关联回原始工具调用。没有 Tasks 能力时，普通工具调用仍按同步或流式结果处理。

Elicitation 请求会通过宿主交互服务转交给支持的客户端。URL 请求让用户在外部页面继续；表单请求会按服务器 schema 呈现。请求 ID 是一次性的，解决、拒绝或取消后不能重复使用。

## 密钥

MCP 是 Monad 原生功能，不使用 Agent Runtime Credentials。HTTP token、header、OAuth 状态和 stdio 环境变量直接存放在 `agents.json` 中对应的服务器上，`${secret:...}` 引用会被拒绝。密钥不应出现在命令参数、技能正文、聊天消息或日志中。设置 API 会脱敏响应，但用户仍需保护本地配置文件。

## HTTP 认证

远程 MCP 服务器可使用静态 header、bearer token 或 OAuth。只向明确允许的 HTTPS 主机发送凭据；重定向后的目标仍需通过网络与凭据边界检查。

### OAuth

运行 `monad mcp authorize <name>` 启动认证。交互式客户端通常使用本地回调；无头环境可使用 RFC 8628 device flow（服务器支持时）。授权状态由守护进程持有，客户端不应自行复制 token。

## 信任控制

- MCP 工具默认进入审批流程。
- `autoApproveTools` 必须使用完整 `<server>__<tool>` 名称。
- `trust.pinnedToolHash` 固定服务器公布的工具集合；集合变化时 Monad 拒绝注册，并在日志中给出新哈希供审查。
- 工具输入仍需经过 schema 校验，网络、文件和宿主边界不会因 MCP 审批而消失。
- 禁用或移除服务器会撤销其工具暴露并关闭连接。

不要仅因服务器名称熟悉就批准工具集合变化。检查新增、删除和修改的名称、描述与输入 schema。

## 浏览器与电脑 preset

Browser 和 computer preset 可以引用 MCP 服务器，把其工具映射成受约束的浏览器或宿主控制能力。browser-use 应优先使用域名限制；computer-use 属于真实宿主机逃逸能力，批准范围最多到当前会话。详见[浏览器与电脑操作](/zh-Hans/usage/computer-use)。

## 故障排查

- **启动失败**：查看 `monad logs -f`，修复命令、路径、URL 或环境后保存，或运行 `monad mcp reconnect <name>`。
- **工具集合变化**：审查日志中的差异和新哈希，再更新 `trust.pinnedToolHash`。
- **自动批准不生效**：确认使用 `<server>__<tool>` 完整名称。
- **远程服务器 401**：重新授权或更新凭据，不要把 token 粘贴进日志。
- **服务器反复断开**：检查进程退出码、网络、协议版本和服务端限流。
- **表单或 URL 请求无人处理**：确认当前客户端支持宿主交互；无客户端时请求会关闭失败。
