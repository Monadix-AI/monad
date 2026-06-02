---
title: "数据与网络"
sidebarTitle: "数据与网络"
description: "了解 Monad 在本地保存什么、哪些已配置操作会联网，以及如何删除数据。"
keywords: ["Monad 隐私", "本地优先", "遥测", "数据存储", "网络访问"]
---
本页说明 Monad 存储什么、什么会离开你的设备。每项陈述都以当前代码为准；若实际行为不一致，请报告为 bug。

## 简要结论

- **Monad 不发送遥测、分析、崩溃报告或使用 ping；没有退出选项，因为默认根本没有这类发送。**
- **无需账户。** Monad 没有注册、许可证检查，也不会主动连接自有服务器。
- 会话、记录、记忆、凭据和设置都保存在本地 `~/.monad`。
- 守护进程默认只绑定**回环地址**；绑定回环端口不等于开放公网端口。
- 真正离开设备的是你要求的流量：所选模型服务商以及你启用的工具。

## 什么会在何时离开设备

在你配置或调用之前，下表行为都不会发生。

| 目的地 | 触发条件 | 携带内容 |
|---|---|---|
| 模型服务商 API | 每个 Agent 回合 | 系统提示词、记录、注入的记忆和技能文本、工具结果 |
| `models.dev` | 模型设置、价格和分层解析 | 只获取公共目录，不含你的信息 |
| GitHub API、npm registry | 安装 Atom、技能或 MCP 二进制 | 你请求的软件包坐标 |
| Glama、Smithery、MCP registry | `monad mcp search` | 搜索词 |
| GitHub Releases | 仅在运行 `monad upgrade` 时 | 版本请求 |
| Qdrant GitHub release | 首次使用可选 `mem0` 后端 | 二进制下载 |
| 你配置的 MCP 服务器 | 工具调用 | 调用所含内容 |
| 你配置的渠道 | 收发消息 | 对应平台上的对话 |
| 对等节点或 Monadix | 配置后委派子任务 | 你委派的指令 |

没有后台更新检查。模型服务商是最重要的外部边界：一个回合会把上下文窗口内容发给模型。工具读入文件后，内容进入记录，并可能在下一回合发给服务商；请据此选择服务商。

## 可观察性默认关闭

Monad 集成 OpenTelemetry，但 exporter 默认没有端点：

```jsonc
"observability": { "endpoint": "" }
```

设置 OTLP 端点后，追踪和指标只会发往你指定的 collector。开发模式若未设置，会使用本机 `http://localhost:6006`，仍不离开设备。

## 数据存放位置

```text
~/.monad/
  configs/                 设置、Agent、服务商与 Mesh 配置
  credentials/auth.json   Agent 运行时凭据（0600）
  db/monad.sqlite          会话、消息与事件
  memory/                  持久事实、知识图谱与规则
  atoms/                   Pack、技能、MCP、locale 与服务商
  agents/<agentId>/        每个 Agent 的工作区
  workplace/<projectId>/   托管 Workplace Project 数据
  logs/                    守护进程日志
```

Linux 会按 XDG 目录拆分，`MONAD_HOME` 可统一覆盖。托管 Agent 只获得属于该运行时的 shared、member、session 和 runtime 四个具体目录，而不是整个项目目录；服务商沙箱仍取决于所选服务商和启动模式。会话工作区文件可由该会话所有托管 Agent 协作写入，产品规则可进一步收紧。

## 密钥

- API 不返回凭据，设置响应会脱敏，`monad credential list` 只显示预览
- 密钥不会写入日志、会话记录或结构化 CLI 输出，也不会经 argv 传递
- `auth.json` 使用 `0600`，并位于 Agent 文件系统工具禁止访问的 vault 内
- Agent Runtime Credentials 向生成代码提供每次运行的占位标记，真实值只在发往获准主机时替换
- Windows 无 `chmod`，依赖每用户配置目录 ACL

## 第三方代码

`monad license list` 会列出生产依赖及许可证。你安装的 Atom Pack、技能和 MCP 服务器是第三方代码，会使用你授予的访问权；请像对待已安装软件一样审查它们。

## 文档站点数据

本页以上内容描述 Monad 产品运行时。托管的 Mintlify 文档站是独立 Web 服务：只有在项目所有者于 Mintlify Dashboard 启用相应 Add-on 后，它才可能处理页面浏览、搜索、页面反馈或 AI 助手请求。文档站不会自动获得本地守护进程的会话、凭据或配置。提交反馈前，不要粘贴密钥、私人会话或敏感日志。

## 删除数据

```bash
monad purge sessions
monad purge all
monad purge
```

第一条清除记录并保留配置；第二条清除会话、配置、认证和用量；最后一条经双重确认后重建整个 `~/.monad`。卸载程序见[安装或移除 Monad](/zh-Hans/usage/installation)。
