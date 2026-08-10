---
title: "故障排查"
description: "诊断守护进程、模型服务商、会话、审批、MCP、渠道、沙箱和升级问题。"
keywords: ["Monad 启动失败", "守护进程连不上", "Agent 报错", "常见问题排查"]
---
Monad 的问题大多来自少数几个地方：守护进程没在运行、没有配置模型凭据、会话或审批卡住、MCP 服务器或渠道连接失败，或者沙箱拦截了某个工具。

遇到问题从这里开始。三条命令可回答大多数问题：

```bash
monad status
monad doctor
monad logs -f
```

## 守护进程

**`monad` 提示无法连接守护进程。** 先运行 `monad status`，再运行 `monad doctor`。常见原因是配置错误导致退出（查看 `monad logs -n 200`），或客户端指向其他地址；`--port`、`--host` 和 `MONAD_PORT` 会覆盖单次调用使用的端口。

**端口已被占用。** 运行 `monad config set network.port <n>` 或设置 `MONAD_PORT`。源码工作区的每个 git worktree 会自动使用独立端口。

**CLI 可用但 Web UI 无法加载。** 浏览器不能访问 Unix socket，Web UI 只走 TCP。即使 `network.transport` 为 `uds`，两种传输仍会同时提供；请检查回环端口。

**守护进程启动后立刻退出。** 通常是设置校验失败；`auth.json` v1 会被直接拒绝，迁移见 [Agent Runtime Credentials](/usage/agent-runtime-credentials#breaking-migration-from-authjson-v1)。

## 模型与服务商

**模型调用立即失败。** 在 **Studio → Models and providers** 复查凭据，或运行 `monad provider models <id>` 验证连通性。401 通常是密钥问题，超时通常是基础 URL 问题。

**服务商不返回模型列表。** Azure OpenAI 和 Amazon Bedrock 没有标准 bearer `/models` 路由；向导会让你手动输入 Azure 部署名或 Bedrock 模型 ID。

**实际运行了哪个模型？** `monad usage --by-category` 和会话记录都会保存解析后的服务商与模型。

## 会话与审批

**Agent 操作一直不运行。** 它可能在等待审批。查看会话中的审批卡片；没有客户端回答时，高风险调用默认两分钟后关闭失败。

**同一审批反复出现。** 使用更大范围批准，或运行 `monad approval rules`、`monad approval revoke <id>` 检查规则。host-control 权限按设计最多保存到会话范围。

**长会话变慢或遗漏早期细节。** 这是上下文管理：淘汰可通过句柄无损恢复，摘要则不可逆；两者都可观察和调整，见[上下文管理](/internals/agent-runtime/context-management)。

## MCP 服务器

**服务器启动失败。** 原因在守护进程日志。修复并保存配置会触发重连，也可运行 `monad mcp reconnect <name>`。

**“tool set changed … refusing to register”。** 服务端工具与 `trust.pinnedToolHash` 不一致；审查变更后，把 pin 更新为日志中的新哈希。

**`autoApproveTools` 不生效。** 工具名必须是 `<server>__<tool>` 格式；日志会列出服务端公布的名称。完整列表见 [MCP 故障排查](/usage/mcp#troubleshooting)。

## 渠道

**机器人不回复私信。** 确认渠道已启用、凭据已配置，并且 `monad channel status` 显示已连接。

**机器人不回复群聊。** 默认只有被 @ 或被回复时才回答；也可将 `groupPolicy.requireMention` 设为 `false`。

**`monad channel status` 显示黄点或红点。** 黄点表示已有 token 但未连接，红点表示没有 token。`channel add` 创建的渠道默认禁用，设置 token 后运行 `monad channel enable <id>`。

## 沙箱与工具

**工具已批准仍被拒绝。** 审批门和沙箱是独立层。调用仍需通过路径根、SSRF 过滤、大小上限等实时守卫；拒绝消息会指出原因。

**沙箱内命令无法联网。** 检查后端网络模式。macOS 和 Linux 上 `net:'none'` 由内核强制；`filtered` 经本地出口代理并遵循域名允许/拒绝列表。

**后端激活失败。** 激活是事务性的；失败后旧后端继续服务，持久化选择不变，原因会直接返回。

## 升级

**升级后情况变差。** 使用对应历史 release 自带的 dist 安装器安装精确旧版本。

**`monad upgrade` 报告新版本，但运行的仍是旧版。** `PATH` 前面可能有旧二进制；运行 `which -a monad`。

## 仍未解决

- Bug 报告需要 `monad doctor` 输出和 `monad logs -n 200`
- 搜索或提交 [Issue](https://github.com/Monadix-AI/monad/issues)；问题与想法放到 [Discussions](https://github.com/Monadix-AI/monad/discussions)
- 疑似安全漏洞不要公开提交 Issue，请遵循 [SECURITY.md](https://github.com/Monadix-AI/monad/blob/main/SECURITY.md)
