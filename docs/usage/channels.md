---
title: "Channels"
description: "Connect Telegram, Slack, Discord, and other messaging platforms to Monad."
keywords: ["Telegram bot", "Slack bot", "Discord bot", "messaging agent", "chat channel", "WhatsApp agent"]
---
A channel connects an IM platform (Telegram, Slack, Discord, …) to your Monad agent.
The platform's bot account becomes a front door: messages sent to the bot are routed
to an agent session, and the agent's replies go back to the chat. Each conversation
gets its own persistent session, so a Telegram DM and the web UI can watch the same
transcript. The behavioral contract every adapter follows (normalization, dedup,
mention gating) is documented in
[channel-conformance.md](/internals/infra/channel-conformance).

## Supported platforms

All first-party adapters ship with the daemon. They differ in how messages arrive:
**dial-out** adapters (long-poll, WebSocket, TCP) work behind NAT with no public URL;
**webhook** adapters need the platform to reach your machine over HTTP.

| Type | Platform | Inbound style | Credential |
| --- | --- | --- | --- |
| `telegram` | Telegram | Long-poll (`getUpdates`), no public URL | Bot token from BotFather |
| `discord` | Discord | Gateway WebSocket (dial-out) | Bot token |
| `slack` | Slack | Socket Mode WebSocket (dial-out) | Bot token (`xoxb-…`) plus app-level token (`xapp-…`) |
| `irc` | IRC | Raw TCP (dial-out, TLS by default) | Server password, if any |
| `signal` | Signal | Local `signal-cli` child process | Operator-registered signal-cli account |
| `email` | Email | IMAP poll in, SMTP out | Mailbox credentials |
| `qq` | QQ official bot | Gateway WebSocket (dial-out) | App id + token |
| `webhook` | Anything (generic) | Inbound HTTP listener | Shared secret |
| `line` | LINE | Signed webhook | Channel secret + access token |
| `whatsapp` | WhatsApp | WhatsApp Web linked device (Baileys) | QR pairing; no Meta account |
| `whatsapp-business` | WhatsApp Business Cloud API | Signed webhook (Meta Graph) | App secret + access token |
| `twilio` | SMS / WhatsApp via Twilio | Signed webhook | Auth token |
| `feishu` | Feishu / Lark | Event webhook | App credentials |
| `wecom` | WeCom | Encrypted callback webhook | App credentials |
| `teams` | Microsoft Teams | Bot Framework webhook | AAD app credentials |
| `gchat` | Google Chat | Event webhook | Service-account key |
| `imessage` | iMessage | BlueBubbles server webhook | BlueBubbles server credentials |

Third-party atom packs can add more platforms; the channel type is an open string.

### WhatsApp pairing

In Studio → Channels, add a WhatsApp connection and choose **Save and pair**. Open WhatsApp on your
phone, go to Settings → Linked Devices, and scan the QR code shown by Monad. The linked-device session
is stored under Monad's credentials directory and survives daemon restarts. Removing the connection
also removes that local session. After the first successful pairing, Monad sends one welcome message
to the account's self-chat. Reply there with `/project list`, then `/project use <number>` to select a
Project and continue the conversation. Reconnecting the daemon does not resend the welcome message.

This adapter uses the unofficial WhatsApp Web protocol. A dedicated number is recommended, and
automated bulk or unsolicited messaging can put the account at risk. Business deployments that need
Meta's supported API should use the separate `whatsapp-business` channel.

## Quick start: Telegram

Telegram is the simplest platform to try — long-polling means it works from a laptop
behind NAT with zero network setup.

### 1. Create a bot

Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, and follow
the prompts. BotFather replies with a bot token.

### 2. Add the channel

```sh
monad channel add telegram --label "My bot"
```

The channel is created **disabled** so it does not try to connect before its token is
set. The command prints the new channel id (`chn_…`).

```sh
monad channel token chn_abc123 123456:ABC-your-bot-token
monad channel enable chn_abc123
```

The token is stored directly beside the channel in `config.json`. Settings responses
redact it, but the user is responsible for protecting the file. You can do the same
in the web UI under Studio → Channels, which is also where channel editing with
secrets lives.

### 3. Verify

```sh
monad channel status
```

A green dot means the adapter is connected. Messages sent to the bot reach the agent,
and replies stream back into the chat.

### Configuration reference

Channels live in the `channels` array of `config.json`. The fields below are the
actual schema; everything except `id`, `type`, and `label` has a default.

```jsonc
{
  "channels": [
    {
      "id": "chn_abc123",
      "type": "telegram",
      "label": "My bot",
      "enabled": true,
      "agentId": "agt_…",                    // optional; falls back to the default agent
      "groupPolicy": { "requireMention": true },
      "agentHint": "IM surface — keep replies short",
      "mapping": {
        "granularity": "per-conversation",   // per-conversation | per-thread | per-user
        "reset": { "idleMinutes": 120, "daily": false }
      },
      "credential": {
        "token": "123456:ABC-your-bot-token",
        "extra": { "pollTimeoutSec": "30" }
      },
      "rateLimitPerMin": 20
    }
  ]
}
```

- `agentHint` (up to 2000 chars) is injected into the system prompt for this
  channel's sessions — use it to tell the agent it is talking on an IM surface.
- `mapping.granularity` decides what maps to one session: the whole chat
  (default), each thread, or each user.
- `rateLimitPerMin` caps messages per user per minute (default 20).

## Group behavior

Channels do not filter inbound messages by platform user id. Disable a connection to
stop it from receiving messages. In groups, the bot stays quiet unless it is @mentioned or replied to
(`groupPolicy.requireMention`, default `true`). Set it to `false` to answer every
message in the group.

## In-chat commands

Messages starting with `/` run Monad's slash commands instead of going to the agent.
Unknown `/words` are treated as normal text. The conversation commands:

| Command | Effect |
| --- | --- |
| `/new [label]` | Start a new session in this chat |
| `/sessions` | List this chat's sessions (the active one is marked) |
| `/switch <number\|session-id>` | Switch the chat to another session |
| `/archive` | Archive the current conversation |
| `/reset` | Clear the current session's history |
| `/compact` | Summarize and compact the context window now |
| `/handoff [task]` | Summarize this conversation and continue it in a new session |
| `/project <list\|current\|use\|leave>` | Inspect or switch the Project this chat works in |
| `/model [alias]` | Show or switch the model for this session |
| `/memory <consolidate\|why\|check>` | Inspect and maintain what the agent remembers |
| `/help` | List all available commands |

One chat can hold many sessions; `/new` and `/switch` move between them without
losing history. `/workdir` is the one built-in blocked on channels — it is only
available from the local UI or CLI. On platforms that support reactions, the bot acknowledges a command
with a ✅ on your message.

## Managing channels

- **CLI**: `monad channel <list|status|add|token|enable|disable|rm>`
  (alias `chan`). All subcommands support `--json`.
- **Web UI**: Studio → Channels, including connection and credential editing.
- **REST**: `GET/PUT/DELETE /v1/settings/channels/:id`, plus `/enable`, `/disable`,
  `/credential`, and `GET /v1/settings/channels/status`.
  Tokens are write-only: list and status responses never include them.

Platforms that need a second secret (for example Slack's app-level token) take it via
the credential endpoint's `extra` map — for Slack, `extra: { "appToken": "xapp-…" }`.

## Platform notes

- **Telegram** sends plain text (no Markdown) for robustness, and supports streaming
  replies by editing the message in place.
- **Slack** requires Socket Mode to be enabled on the app, and two tokens (see above).
- **Long replies** are split automatically at each platform's message length limit.
- **Edited messages** are ignored — only new messages start a turn.

## Troubleshooting

- **The bot never replies in a DM.** Confirm the channel is enabled, its credentials
  are configured, and `monad channel status` reports it as connected.
- **The bot never replies in a group.** It only answers when @mentioned or
  replied to unless you set `groupPolicy.requireMention` to `false`.
- **`monad channel status` shows a red or yellow dot.** Yellow means a token is set
  but the adapter is not connected; red means no token. The status line includes the
  last connection error. Remember that `channel add` creates the channel disabled —
  set the token, then `monad channel enable <id>`.
