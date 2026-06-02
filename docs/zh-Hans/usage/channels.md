---
title: "消息渠道"
sidebarTitle: "渠道"
description: "把 Telegram、Slack、Discord 等消息平台连接到 Monad。"
keywords: ["Monad channels", "Telegram", "Slack", "Discord"]
---
渠道把消息平台连接到 Monad。平台机器人账户成为守护进程的一个入口，消息会映射到持久会话，回复仍可从 Web、CLI 或 TUI 观察。

## 支持的平台

| 类型 | 平台 | 入站方式 | 凭据 |
|---|---|---|---|
| `telegram` | Telegram | 长轮询 | BotFather token |
| `discord` | Discord | Gateway WebSocket | Bot token |
| `slack` | Slack | Socket Mode | `xoxb` bot token 与 `xapp` app token |
| `irc` | IRC | TCP，默认 TLS | 可选服务器密码 |
| `signal` | Signal | 本地 `signal-cli` | 已注册账户 |
| `email` | Email | IMAP 入站、SMTP 出站 | 邮箱凭据 |
| `qq` | QQ 官方机器人 | Gateway WebSocket | App id 与 token |
| `webhook` | 通用 Webhook | HTTP listener | 共享密钥 |
| `line`、`twilio` | LINE、Twilio | 签名 Webhook | 平台密钥与 token |
| `whatsapp` | WhatsApp | WhatsApp Web 关联设备（Baileys） | 扫描二维码，无需 Meta 开发者账号 |
| `whatsapp-business` | WhatsApp Business Cloud API | Meta Graph 签名 Webhook | App secret 与 access token |
| `feishu`、`wecom`、`teams`、`gchat` | 企业消息平台 | 事件或 Bot Webhook | 应用凭据 |
| `imessage` | iMessage | BlueBubbles Webhook | BlueBubbles 凭据 |

具体平台是否可用还取决于相应 Atom Pack、外部程序和平台配置。

### WhatsApp 扫码连接

在 Studio → Channels 添加 WhatsApp 连接并选择“保存并配对”。然后在手机 WhatsApp 中进入
“设置 → 关联设备”，扫描 Monad 显示的二维码。关联设备凭据保存在 Monad 的凭据目录中，
daemon 重启后仍可复用；删除连接时会一并删除本地会话。首次配对成功后，Monad 会向该账号的
“给自己发消息”推送一次欢迎消息。直接在那里发送 `/project list`，再发送
`/project use <编号>` 选择 Project，即可继续对话；daemon 重连不会重复发送欢迎消息。

该适配器使用非官方 WhatsApp Web 协议，建议使用专用号码，避免批量或未经请求的自动消息。
需要 Meta 官方支持的企业场景应改用独立的 `whatsapp-business` 渠道。

## Telegram 快速开始

### 1. 创建机器人

在 Telegram 与 BotFather 对话，创建 bot 并保存 token。不要把 token 放进命令历史、聊天记录或源码。

### 2. 添加渠道

```sh
monad channel add telegram --label "My bot"
```

命令返回渠道 ID。通过安全输入设置 token，再启用渠道：

```sh
monad channel token chn_abc123 123456:ABC-your-bot-token
monad channel enable chn_abc123
```

渠道创建后默认禁用，避免凭据未完成时开始接收消息。

### 3. 验证

```sh
monad channel status
```

状态为已连接后，发给机器人的消息会直接进入 agent 会话。

## 配置结构

每个渠道包含稳定 ID、类型、标签、启用状态、平台配置和群组策略。敏感 token 通过渠道设置接口保存并从响应中脱敏。

```jsonc
{
  "id": "chn_abc123",
  "type": "telegram",
  "label": "My bot",
  "enabled": true,
  "groupPolicy": { "requireMention": true }
}
```

## 群聊行为

渠道不再按平台用户 ID 过滤入站消息；要停止接收消息，请禁用对应连接。群聊默认要求 @mention 或回复机器人。将 `groupPolicy.requireMention` 设为 `false` 才会改变这一行为。

## 聊天内命令

| 命令 | 效果 |
|---|---|
| `/new [label]` | 在当前聊天创建会话 |
| `/sessions` | 列出当前聊天的会话 |
| `/switch <number\|session-id>` | 切换活动会话 |
| `/end` | 结束当前会话并重新开始 |
| `/reset` | 清除当前会话历史 |
| `/compact` | 摘要并压缩上下文 |
| `/model [alias]` | 查看或切换会话模型 |
| `/help` | 列出可用命令 |

命令通过统一命令注册表执行；渠道适配器只负责平台 I/O，不拥有会话或项目路由逻辑。

## 管理渠道

```sh
monad channel list
monad channel status
monad channel enable <id>
monad channel disable <id>
monad channel rm <id>
```

删除渠道不会自动删除已有会话。轮换 token 时先禁用渠道、更新凭据、确认状态，再重新启用。

## 平台注意事项

Telegram、Discord 和 Slack 使用守护进程向外建立连接，不要求公开入站 URL。Webhook 平台需要可到达的 HTTPS 端点和平台签名校验。Signal 依赖本机 `signal-cli`；Email 同时涉及 IMAP 与 SMTP 权限。

## 故障排查

- 私信无回复：检查渠道启用状态、凭据和连接状态。
- 群聊无回复：确认机器人被提及或关闭 `requireMention`。
- 黄点表示已配置 token 但未连接；红点表示缺少 token。
- 查看 `monad logs -f` 获取适配器连接错误，但日志不会打印明文凭据。
