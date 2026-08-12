---
title: "Troubleshooting"
description: "Diagnose daemon, provider, session, approval, MCP, channel, sandbox, and upgrade problems."
keywords: ["Monad not starting", "daemon unreachable", "agent errors", "fix Monad", "common problems"]
---
Most Monad problems come from one of a few places: the daemon is not running, no model
credential is configured, a session or approval is stuck, an MCP server or channel failed to
connect, or the sandbox blocked a tool.

Start here when something does not work. Each entry names the symptom, the usual cause,
and the command that confirms it.

Three commands answer most questions:

```bash
monad status     # is the daemon running, and where
monad doctor     # diagnose configuration, connection, and version problems
monad logs -f    # follow the daemon log
```

## The daemon

**`monad` says the daemon is unreachable.**
Run `monad status`, then `monad doctor`. Common causes: the daemon exited on a config
error (check `monad logs -n 200`), or your client is pointed somewhere else — `--port` /
`--host` and `MONAD_PORT` override the configured port for a single invocation.

**A port is already taken.**
Run `monad config set network.port <n>`, or set `MONAD_PORT`. A source checkout assigns each Git worktree its own port; contributors can inspect its `.env.local` file or consult [CONTRIBUTING.md](https://github.com/Monadix-AI/monad/blob/main/CONTRIBUTING.md).

**The CLI works but the Web UI does not load.**
The Web UI is TCP-only — a browser cannot reach a Unix socket. If
`network.transport` is `uds`, the CLI is on the socket while the browser needs the
loopback port; both are always served, so check the port rather than the transport.

**The daemon starts, then immediately exits.**
Usually settings validation. `auth.json` version 1 is rejected outright — see
[agent-runtime-credentials.md](/usage/agent-runtime-credentials#breaking-migration-from-authjson-v1).

## Models and providers

**The model call fails immediately.**
Re-check the credential in **Studio → Models and providers**, or prove reachability with
`monad provider models <id>`. A 401 means the key; a timeout usually means the base URL.

**A provider returns no model list.**
Azure OpenAI and Amazon Bedrock have no standard bearer `/models` route. The wizard falls
back to manual model-id entry — type the Azure *deployment* name or the Bedrock model id
yourself. See [model-providers.md](/usage/model-providers#provider-specific-notes).

**Which model actually ran?**
`monad usage show --by-category` and the session transcript both record the resolved provider
and model. Role and profile resolution is explained in
[model-providers.md](/internals/infra/model-providers).

## Sessions and approvals

**An agent action never runs.**
It is probably waiting at an approval. Check the transcript, not the logs — the approval
card blocks the turn. With no client connected to answer, high-risk calls fail closed
after the timeout (2 minutes by default) rather than running.

**The agent keeps asking for the same approval.**
Approve with a broader scope, or inspect what is remembered: `monad approval rules`,
`monad approval revoke <id>`. Host-control (computer-use) grants can never persist beyond
the session by design — see [computer-use.md](/usage/computer-use#security-model-host-escape-the-sanctioned-exception).

**A long session gets slow or loses earlier detail.**
That is context management working. Eviction is lossless and recoverable by handle;
summarization is not. Both are observable and tunable:
[context-management.md](/internals/agent-runtime/context-management).

## MCP servers

**A server failed at boot.** The reason is in the daemon log. Fix the config and save —
the edit reconnects it — or force a retry with `monad mcp reconnect <name>`.

**"tool set changed … refusing to register".** The server's advertised tools no longer
match `trust.pinnedToolHash`. Review the change, then update the pin to the new hash
printed in the log.

**An `autoApproveTools` entry has no effect.** Tool names must use the `<server>__<tool>`
form; the daemon log lists the advertised names.

Full list: [mcp.md](/usage/mcp#troubleshooting).

## Channels

**The bot never replies in a DM.** Confirm the channel is enabled, its credentials are
configured, and `monad channel status` reports it as connected.

**The bot never replies in a group.** It only answers when @mentioned or replied to, unless
`groupPolicy.requireMention` is `false`.

**`monad channel status` shows a red or yellow dot.** Yellow: a token is set but the
adapter is not connected. Red: no token. Remember that `channel add` creates the channel
**disabled** — set the token, then `monad channel enable <id>`.

Full list: [channels.md](/usage/channels#troubleshooting).

## Sandbox and tools

**A tool is denied even though I approved it.** The approval gate and the sandbox are
separate layers. An approved call still has to pass call-time guards: path roots, SSRF
filtering, size caps. The denial message names which one.

**A command cannot reach the network inside the sandbox.** Check the backend's net mode.
`net:'none'` is kernel-enforced on macOS and Linux; `filtered` routes through the local
egress proxy and honours a domain allow/deny list. See
[sandbox-backends.md](/usage/sandbox-backends).

**Backend activation failed.** Activation is transactional — a failure leaves the previous
backend serving and the persisted selection unchanged. The reason is reported on the
activation attempt, not silently swallowed.

## Upgrades

**An upgrade made things worse.** Install an exact earlier release using that release's dist
installer. See [releases.md](/usage/releases).

**`monad update` reports a newer version than what runs.** A stale binary is probably
earlier on your `PATH`: `which -a monad`.

## Still stuck

- `monad doctor` output and `monad logs -n 200` are what a bug report needs.
- Search or open an [issue](https://github.com/Monadix-AI/monad/issues); questions and
  ideas belong in
  [Discussions](https://github.com/Monadix-AI/monad/discussions).
- Suspected vulnerability? Do **not** open a public issue — follow
  [SECURITY.md](https://github.com/Monadix-AI/monad/blob/main/SECURITY.md).
